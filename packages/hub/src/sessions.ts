/**
 * Session lifecycle: provision a checkout, start omp in a sandbox, bridge its
 * RPC stream into the event log, and tear it down.
 *
 * ```
 * provisioning ─▶ starting ─▶ idle ⇄ busy
 *                    ▲         │  ▲    │
 *                    │         ▼  │    ▼
 *    stopped ◀── stopping ◀── waiting (a dialog needs an answer)
 * ```
 * `failed` means provisioning failed; the session cannot start. A stopped
 * session restarts on demand with `--continue`, so its transcript survives
 * idle stops, crashes and hub restarts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isEnoent, logger, parseJsonlLenient, slugify } from "@oh-my-pi/pi-utils";
import type { ResolvedHubConfig } from "./config";
import type { EnvironmentService, EnvironmentView } from "./environments";
import { HubError } from "./errors";
import { EventLog, type HubEventBody, type StreamedAgentEvent } from "./events";
import {
	createCheckout,
	fetchMirror,
	GitError,
	importBundle,
	isSafeRefName,
	parseGithubRepo,
	pushBranch,
	resolveCommit,
} from "./git";
import { openPullRequest } from "./github";
import { hashSecret, KeyedSerial, newId } from "./ids";
import type { Notification, Notifier } from "./notify";
import type { CredentialService } from "./credentials";
import type { ProfileService, SecretService } from "./profile";
import { BROKER_PROXY_PREFIX } from "./server/broker-proxy";
import type { RepoService } from "./repos";
import type { SandboxRuntime, SandboxSpec } from "./sandbox";
import { type HubStore, LIVE_STATUSES, type SessionRow, type SessionStatus } from "./store";

/** UI requests the agent blocks on until the host answers. */
const DIALOG_METHODS = new Set<RpcExtensionUIRequest["method"]>([
	"select",
	"confirm",
	"input",
	"editor",
	"ask",
	"form",
]);
const ACTIVITY_WRITE_INTERVAL_MS = 10_000;
/**
 * Streaming `message_update` events each carry the whole partial message;
 * forwarding every token delta would resend a growing message many times a
 * second over mobile data. At most one update per interval goes out.
 */
const UPDATE_INTERVAL_MS = 150;
const AGENT_STOP_GRACE_MS = 5_000;
const TASK_TIMEOUT_MS = 10 * 60_000;
const SETUP_TIMEOUT_MS = 30 * 60_000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const HUB_STATE_DIR = ".omp-hub";

/**
 * Runs inside the sandbox before omp: copies the read-only profile into the
 * agent directory. The copy happens with the sandbox's own privileges, so a
 * symlink the agent planted there can only redirect writes within the sandbox.
 * Writes nothing to stdout, which carries the RPC protocol.
 *
 * Each directory under {@link IMAGE_EXTENSIONS_DIR} in the image is loaded as an
 * omp extension package (its `skills/`, `.mcp.json`, `rules/`, ...), so a
 * toolkit image carries its own MCP servers and skills. An image may move the
 * directory with `OMP_HUB_EXTENSIONS_DIR`.
 */
const IMAGE_EXTENSIONS_DIR = "/opt/omp/extensions";
const LAUNCH_SCRIPT = [
	"set -e",
	'agent="$HOME/.omp/agent"',
	'mkdir -p "$agent"',
	'rm -rf "$agent/rules"',
	"for f in AGENTS.md RULES.md APPEND_SYSTEM.md models.yml; do",
	'  rm -f "$agent/$f"',
	'  if [ -f "$OMP_HUB_PROFILE/$f" ]; then cp "$OMP_HUB_PROFILE/$f" "$agent/$f"; fi',
	"done",
	'cp -R "$OMP_HUB_PROFILE/rules" "$agent/rules"',
	`for ext in "\${OMP_HUB_EXTENSIONS_DIR:-${IMAGE_EXTENSIONS_DIR}}"/*; do`,
	'  if [ -d "$ext" ]; then set -- "$@" --extension "$ext"; fi',
	"done",
	'exec "$@"',
].join("\n");

export interface SessionView extends SessionRow {
	repoName: string;
	/** An agent process is attached. */
	live: boolean;
	/** Dialogs waiting for an answer. */
	pending: RpcExtensionUIRequest[];
	/** Last event sequence number; pass as `since` to follow from here. */
	lastSeq: number;
	/** `provider/model-id` the running agent uses, as omp reports it. */
	activeModel: string | null;
}

export interface CreateSessionInput {
	repoId: string;
	environmentId?: string;
	baseRef?: string;
	branch?: string;
	title?: string;
	model?: string;
	/** First prompt, sent as soon as the agent is ready. */
	prompt?: string;
}

export interface PromptInput {
	message: string;
	images?: ImageContent[];
	/** How to deliver while the agent is busy; defaults to `followUp`. */
	mode?: "steer" | "followUp";
}

/** An answer to a pending dialog, without the frame envelope. */
export type DialogAnswer = RpcExtensionUIResponse extends infer R
	? R extends { type: "extension_ui_response"; id: string }
		? Omit<R, "type" | "id">
		: never
	: never;

export interface PublishResult {
	branch: string;
	sha: string;
	remote: string;
}

export interface SessionDeps {
	config: ResolvedHubConfig;
	store: HubStore;
	runtime: SandboxRuntime;
	repos: RepoService;
	environments: EnvironmentService;
	notifier: Notifier;
	profile: ProfileService;
	secrets: SecretService;
	/** Subscription logins; agents connect to its broker when it holds credentials. */
	credentials?: CredentialService;
	/** How sandboxes reach the hub, or null when they cannot. */
	sandboxHubUrl?: () => string | null;
}

interface LiveSession {
	client: RpcClient;
	container: string;
	pending: Map<string, RpcExtensionUIRequest>;
	busy: boolean;
	/** The agent ran since the last settle, so settling is worth a "finished" notification. */
	worked: boolean;
	stopping: boolean;
	idleTimer?: NodeJS.Timeout;
	lastActivityWrite: number;
	disposers: (() => void)[];
	model: string | null;
}

interface SessionLayout {
	root: string;
	work: string;
	home: string;
	outbox: string;
	/** Hub-owned files for the sandbox (settings overlay); mounted read-only, never sandbox-writable. */
	hub: string;
}

export class SessionManager {
	readonly #config: ResolvedHubConfig;
	readonly #store: HubStore;
	readonly #runtime: SandboxRuntime;
	readonly #repos: RepoService;
	readonly #environments: EnvironmentService;
	readonly #notifier: Notifier;
	readonly #profile: ProfileService;
	readonly #secrets: SecretService;
	readonly #credentials: CredentialService | undefined;
	readonly #sandboxHubUrl: () => string | null;
	#warnedUnreachable = false;
	readonly #logs = new Map<string, EventLog>();
	readonly #live = new Map<string, LiveSession>();
	readonly #locks = new KeyedSerial();
	readonly #provisioning = new Map<string, Promise<void>>();
	/** Latest unsent `message_update` per session, flushed by timer or before any other event. */
	readonly #pendingUpdates = new Map<string, { event: StreamedAgentEvent; timer: NodeJS.Timeout }>();
	/** Removal of a crashed agent's sandbox, awaited before the session starts again. */
	readonly #reaping = new Map<string, Promise<void>>();
	/** Labels this hub's sandboxes so a restart only reaps its own. */
	readonly ownerLabel: string;

	constructor(deps: SessionDeps) {
		this.#config = deps.config;
		this.#store = deps.store;
		this.#runtime = deps.runtime;
		this.#repos = deps.repos;
		this.#environments = deps.environments;
		this.#notifier = deps.notifier;
		this.#profile = deps.profile;
		this.#secrets = deps.secrets;
		this.#credentials = deps.credentials;
		this.#sandboxHubUrl = deps.sandboxHubUrl ?? (() => null);
		this.ownerLabel = hashSecret(deps.config.dataDir).slice(0, 16);
	}

	// ── queries ─────────────────────────────────────────────────────────────

	list(): SessionView[] {
		return this.#store.listSessions().map(row => this.#view(row));
	}

	get(id: string): SessionView {
		return this.#view(this.#row(id));
	}

	events(id: string): EventLog {
		this.#row(id);
		return this.#log(id);
	}

	/** The transcript: live from the agent, else read from the session file on disk. */
	async messages(id: string): Promise<{ source: "live" | "disk"; messages: AgentMessage[] }> {
		this.#row(id);
		const live = this.#live.get(id);
		if (live && !live.stopping) return { source: "live", messages: await live.client.getMessages() };
		return { source: "disk", messages: await this.#messagesFromDisk(id) };
	}

	// ── lifecycle ───────────────────────────────────────────────────────────

	/** Register a session and provision it in the background; follow progress on its event log. */
	create(input: CreateSessionInput): SessionView {
		const repo = this.#repos.get(input.repoId);
		if (repo.status !== "ready")
			throw new HubError(409, `repository ${repo.name} is ${repo.status}${repo.error ? `: ${repo.error}` : ""}`);
		const environmentId = input.environmentId ?? "default";
		this.#environments.get(environmentId);
		const baseRef = input.baseRef ?? repo.defaultBranch ?? "main";
		if (!isSafeRefName(baseRef)) throw new HubError(422, `invalid base ref: ${baseRef}`);
		const id = newId("ses");
		const short = id.slice(4, 10);
		const branch =
			input.branch ??
			(input.title ? `omp/${slugify(input.title, { maxLength: 40 }) || short}-${short}` : `omp/${short}`);
		if (!isSafeRefName(branch)) throw new HubError(422, `invalid branch name: ${branch}`);
		const now = Date.now();
		const row: SessionRow = {
			id,
			title: input.title ?? null,
			repoId: repo.id,
			environmentId,
			baseRef,
			baseCommit: null,
			branch,
			model: input.model ?? null,
			status: "provisioning",
			error: null,
			startCount: 0,
			publishedSha: null,
			pullRequestUrl: null,
			createdAt: now,
			updatedAt: now,
			lastActivityAt: now,
		};
		this.#store.insertSession(row);
		this.#emit(id, { kind: "status", status: "provisioning" });
		const work = this.#locks.run(id, () => this.#provision(id, input.prompt));
		this.#provisioning.set(id, work);
		void work.finally(() => this.#provisioning.delete(id));
		return this.#view(row);
	}

	/** Wait for background provisioning, if any. */
	async settled(id: string): Promise<void> {
		await this.#provisioning.get(id)?.catch(() => {});
	}

	/** Start (or resume) the agent. No-op while it runs. */
	start(id: string): Promise<SessionView> {
		return this.#locks.run(id, async () => {
			await this.#startUnlocked(id);
			return this.get(id);
		});
	}

	stop(id: string, reason = "requested"): Promise<SessionView> {
		return this.#locks.run(id, async () => {
			await this.#stopUnlocked(id, reason);
			return this.get(id);
		});
	}

	/** Stop the agent and delete the checkout, home and transcript. */
	delete(id: string): Promise<void> {
		return this.#locks.run(id, async () => {
			this.#row(id);
			await this.#stopUnlocked(id, "deleted");
			await this.#removeTree(id);
			this.#store.deleteSession(id);
			this.#logs.delete(id);
		});
	}

	// ── interaction ─────────────────────────────────────────────────────────

	async prompt(id: string, input: PromptInput): Promise<{ requestId: string }> {
		const live = await this.#ensureLive(id);
		this.#clearIdle(live);
		const mode = input.mode ?? (live.busy ? "followUp" : undefined);
		const requestId = await live.client.prompt(input.message, input.images, mode);
		this.#touch(id, live, true);
		return { requestId };
	}

	async abort(id: string): Promise<void> {
		const live = this.#live.get(id);
		if (!live) throw new HubError(409, "session is not running");
		await live.client.abort();
	}

	/** Answer a pending dialog. */
	respond(id: string, requestId: string, answer: DialogAnswer): void {
		const live = this.#live.get(id);
		if (!live?.pending.has(requestId)) throw new HubError(404, `no pending request ${requestId}`);
		live.client.respondExtensionUI({
			type: "extension_ui_response",
			id: requestId,
			...answer,
		} as RpcExtensionUIResponse);
		live.pending.delete(requestId);
		this.#emit(id, { kind: "ui_resolved", id: requestId });
		this.#refreshStatus(id, live);
	}

	/** Run a user shell command in the agent's session; output joins the agent's context. */
	async bash(id: string, command: string, timeoutMs = TASK_TIMEOUT_MS): Promise<BashResult> {
		const live = await this.#ensureLive(id);
		this.#touch(id, live, true);
		return live.client.bash(command, { timeoutMs });
	}

	/** Changes since the session's base commit, computed inside the sandbox. */
	async diff(id: string): Promise<{ status: string; diff: string; truncated: boolean }> {
		const row = this.#row(id);
		if (!row.baseCommit) throw new HubError(409, "session has no checkout yet");
		const { spec, paths } = await this.#taskSpec(row);
		const script =
			'cd "$1" && git status --porcelain=v1 --untracked-files=all && printf "\\0" && git diff --no-color --no-ext-diff --no-textconv "$2" --';
		const result = await this.#runtime.run(spec, ["sh", "-c", script, "sh", paths.work, row.baseCommit], {
			timeoutMs: TASK_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) throw new HubError(502, `diff failed: ${result.stderr.trim().slice(0, 2000)}`);
		const split = result.stdout.indexOf("\0");
		const status = split >= 0 ? result.stdout.slice(0, split) : "";
		const diff = split >= 0 ? result.stdout.slice(split + 1) : result.stdout;
		const truncated = diff.length > MAX_DIFF_BYTES;
		return { status, diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
	}

	/**
	 * Push the session branch to the repository's remote.
	 *
	 * The sandbox writes a git bundle (optionally committing first); the hub
	 * imports that bundle into its own mirror and pushes from there, so no
	 * sandbox-controlled git config ever runs on the host. Pushes are leased
	 * against the last published sha.
	 */
	publish(id: string, options: { message?: string; force?: boolean } = {}): Promise<PublishResult> {
		return this.#locks.run(id, async () => {
			const row = this.#row(id);
			if (!row.baseCommit) throw new HubError(409, "session has no checkout yet");
			const repo = this.#repos.get(row.repoId);
			const layout = this.#layout(id);
			await fs.rm(layout.outbox, { recursive: true, force: true });
			await fs.mkdir(layout.outbox, { recursive: true });
			const { spec, paths } = await this.#taskSpec(row, { outbox: true });
			const bundle = path.join(paths.outbox, "publish.bundle");
			const script = [
				"set -e",
				'cd "$1"',
				'if [ -n "$OMP_HUB_COMMIT_MESSAGE" ]; then',
				'  [ "$(git symbolic-ref --quiet --short HEAD)" = "$2" ] || { echo "HEAD is not on $2; switch back before committing" >&2; exit 3; }',
				"  git add -A",
				'  git diff --cached --quiet || git commit --quiet --no-verify -m "$OMP_HUB_COMMIT_MESSAGE"',
				"fi",
				'git bundle create "$3" "refs/heads/$2" --not --remotes=origin',
			].join("\n");
			const result = await this.#runtime.run(spec, ["sh", "-c", script, "sh", paths.work, row.branch, bundle], {
				timeoutMs: TASK_TIMEOUT_MS,
				env: options.message ? { OMP_HUB_COMMIT_MESSAGE: options.message } : {},
			});
			if (result.exitCode !== 0) {
				const stderr = result.stderr.trim();
				if (/empty bundle/i.test(stderr))
					throw new HubError(
						409,
						`no commits on ${row.branch} to publish; pass a message to commit pending changes`,
					);
				throw new HubError(502, `preparing the publish failed: ${stderr.slice(0, 2000)}`);
			}
			const mirror = this.#repos.mirrorPath(repo.id);
			const ref = `refs/hub/sessions/${id}`;
			try {
				const sha = await this.#repos.locks.run(repo.id, async () => {
					const imported = await importBundle(mirror, path.join(layout.outbox, "publish.bundle"), row.branch, ref);
					await pushBranch({
						mirrorPath: mirror,
						sourceRef: ref,
						branch: row.branch,
						expectedRemoteSha: row.publishedSha,
						force: options.force,
						timeoutMs: this.#config.git.timeoutMs,
					});
					return imported;
				});
				this.#store.updateSession(id, { publishedSha: sha });
				this.#emit(id, { kind: "log", source: "publish", line: `pushed ${row.branch} at ${sha.slice(0, 12)}` });
				return { branch: row.branch, sha, remote: repo.url };
			} catch (error) {
				if (error instanceof GitError && /stale info|rejected|fetch first|non-fast-forward/.test(error.stderr)) {
					throw new HubError(
						409,
						`the remote ${row.branch} changed since the last publish; pass force to overwrite it`,
					);
				}
				if (error instanceof GitError) throw new HubError(502, error.message);
				throw error;
			} finally {
				await fs.rm(layout.outbox, { recursive: true, force: true });
			}
		});
	}

	/** Publish, then open (or find) a GitHub pull request against the base branch. */
	async pullRequest(
		id: string,
		input: { title?: string; body?: string; draft?: boolean; message?: string },
	): Promise<{ url: string; number: number; created: boolean }> {
		const github = this.#config.github;
		if (!github) throw new HubError(422, "configure github in hub.yaml to open pull requests");
		const token = process.env[github.tokenEnv];
		if (!token) throw new HubError(422, `set ${github.tokenEnv} in the hub's environment to open pull requests`);
		const row = this.#row(id);
		const repo = this.#repos.get(row.repoId);
		const coordinates = parseGithubRepo(repo.url);
		if (!coordinates) throw new HubError(422, `${repo.url} is not a GitHub repository`);
		await this.publish(id, { message: input.message });
		const pull = await openPullRequest({
			apiUrl: github.apiUrl,
			token,
			...coordinates,
			head: row.branch,
			base: row.baseRef,
			title: input.title ?? row.title ?? row.branch,
			body: input.body,
			draft: input.draft,
		});
		this.#store.updateSession(id, { pullRequestUrl: pull.url });
		return pull;
	}

	// ── hub lifecycle ───────────────────────────────────────────────────────

	/** After a restart: reap our leftover sandboxes and mark interrupted sessions. */
	async recover(): Promise<void> {
		const reaped = await this.#runtime.removeLabelled("omp-hub.owner", this.ownerLabel).catch(error => {
			logger.warn("hub: could not reap leftover sandboxes", { error: String(error) });
			return 0;
		});
		if (reaped > 0) logger.info("hub: removed leftover sandboxes", { count: reaped });
		for (const row of this.#store.listSessions()) {
			if (!LIVE_STATUSES.includes(row.status)) continue;
			if (row.status === "provisioning" || (row.status === "starting" && !row.baseCommit)) {
				this.#store.updateSession(row.id, { status: "failed", error: "the hub restarted while provisioning" });
			} else {
				this.#store.updateSession(row.id, { status: "stopped" });
			}
		}
	}

	/** Stop every running session that is idle; returns how many were stopped. */
	async stopIdle(reason: string): Promise<number> {
		const idle = [...this.#live.keys()].filter(id => this.#store.session(id)?.status === "idle");
		await Promise.allSettled(idle.map(id => this.stop(id, reason)));
		return idle.length;
	}

	async shutdown(): Promise<void> {
		await Promise.allSettled([...this.#live.keys()].map(id => this.stop(id, "hub shutting down")));
	}

	// ── internals ───────────────────────────────────────────────────────────

	async #provision(id: string, initialPrompt: string | undefined): Promise<void> {
		const row = this.#row(id);
		const repo = this.#repos.get(row.repoId);
		const layout = this.#layout(id);
		const say = (line: string) => this.#emit(id, { kind: "log", source: "setup", line });
		try {
			const mirror = this.#repos.mirrorPath(repo.id);
			say(`fetching ${repo.name}`);
			await this.#repos.locks
				.run(repo.id, () => fetchMirror(mirror, this.#config.git.timeoutMs))
				.catch(error => {
					say(
						`fetch failed, using the last mirrored state: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			const baseCommit = await resolveCommit(mirror, row.baseRef);
			say(`checking out ${row.branch} from ${row.baseRef} (${baseCommit.slice(0, 12)})`);
			await createCheckout({
				mirrorPath: mirror,
				checkoutPath: layout.work,
				baseCommit,
				branch: row.branch,
				author: this.#config.git.author,
				timeoutMs: this.#config.git.timeoutMs,
			});
			const environment = this.#environments.get(row.environmentId);
			await this.#prepareHome(layout);
			const image = await this.#environments.ensureImage(row.environmentId, line =>
				this.#emit(id, { kind: "log", source: "build", line }),
			);
			for (const command of environment.definition.setup) {
				say(`$ ${command}`);
				const { spec } = await this.#taskSpec(this.#row(id), {
					image,
					network: environment.definition.network,
					secrets: true,
				});
				const result = await this.#runtime.run(spec, ["sh", "-c", command], { timeoutMs: SETUP_TIMEOUT_MS });
				for (const line of `${result.stdout}${result.stderr}`.split("\n").filter(Boolean).slice(-200)) say(line);
				if (result.exitCode !== 0)
					throw new HubError(502, `setup command failed (exit ${result.exitCode}): ${command}`);
			}
			// Recorded last: a base commit marks provisioning complete, so a failed setup can never be started.
			this.#store.updateSession(id, { baseCommit });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn("hub: provisioning failed", { session: id, error: message });
			this.#setStatus(id, "failed", message);
			void this.#notify(id, { title: "Session failed to start", message, priority: 4, tags: ["x"] });
			return;
		}
		try {
			await this.#startUnlocked(id);
		} catch {
			return; // #startUnlocked recorded the failure.
		}
		if (initialPrompt) {
			// The prompt waits for the start lock this provisioning holds, so send it detached.
			void this.prompt(id, { message: initialPrompt }).catch(error => {
				this.#emit(id, { kind: "log", source: "agent", line: `initial prompt failed: ${String(error)}` });
			});
		}
	}

	/** Runs before any sandbox has touched the session, so writing into its home is safe here only. */
	async #prepareHome(layout: SessionLayout): Promise<void> {
		await fs.mkdir(path.join(layout.home, HUB_STATE_DIR, "sessions"), { recursive: true });
		const seed = this.#config.agent.seedDir;
		if (seed) await fs.cp(seed, path.join(layout.home, ".omp", "agent"), { recursive: true, errorOnExist: false });
	}

	async #ensureLive(id: string): Promise<LiveSession> {
		await this.settled(id);
		await this.start(id);
		const live = this.#live.get(id);
		if (!live || live.stopping) throw new HubError(409, "session stopped while starting");
		return live;
	}

	async #startUnlocked(id: string): Promise<void> {
		if (this.#live.has(id)) return;
		const row = this.#row(id);
		if (row.status === "failed")
			throw new HubError(409, `session failed to provision: ${row.error ?? "unknown error"}`);
		if (!row.baseCommit) throw new HubError(409, "session is still provisioning");
		await this.#reaping.get(id);
		await this.#makeRoom(id);
		this.#setStatus(id, "starting");
		const environment = this.#environments.get(row.environmentId);
		let image: string;
		try {
			image = await this.#environments.ensureImage(row.environmentId, line =>
				this.#emit(id, { kind: "log", source: "build", line }),
			);
		} catch (error) {
			this.#setStatus(id, "stopped", error instanceof Error ? error.message : String(error));
			throw error;
		}
		// Settings and profile are re-read on every start, so edits apply when a session next starts.
		const profileDir = await this.#profile.currentDir();
		const { hub } = this.#layout(id);
		// JSON is valid YAML, so the overlay needs no YAML writer.
		await Bun.write(path.join(hub, "overlay.yml"), `${JSON.stringify(environment.definition.settings, null, 2)}\n`);
		const spec = this.#spec(row, environment, image, {
			secrets: true,
			network: environment.definition.network,
			// Unique per start: a crashed agent's sandbox may still be on its way out under the old name.
			name: `omp-hub-${row.id}-${row.startCount + 1}`,
			agent: true,
			profileDir,
		});
		Object.assign(spec.env, this.#brokerEnv(id));
		const paths = this.#runtime.pathsFor(spec.layout);
		const command = environment.definition.agentCommand ?? this.#config.agent.command;
		let agentProcess: RpcAgentProcess | null = null;
		const args = [
			"--approval-mode",
			this.#config.agent.approvalMode,
			// Later overlays win: the environment's settings refine the profile's.
			"--config",
			path.join(profileDir, "config.yml"),
			"--config",
			path.join(hub, "overlay.yml"),
			...(row.startCount > 0 ? ["--continue"] : []),
			...this.#config.agent.args,
		];
		const client = new RpcClient({
			spawn: async agentArgs => {
				agentProcess = await this.#runtime.startAgent(spec, [
					"sh",
					"-c",
					LAUNCH_SCRIPT,
					"omp-hub-launch",
					...command,
					...agentArgs,
				]);
				return agentProcess;
			},
			sessionDir: path.posix.join(paths.home, HUB_STATE_DIR, "sessions"),
			model: row.model ?? undefined,
			args,
			terminationGraceMs: AGENT_STOP_GRACE_MS,
		});
		const live: LiveSession = {
			client,
			container: spec.name,
			pending: new Map(),
			busy: false,
			worked: false,
			stopping: false,
			lastActivityWrite: 0,
			disposers: [],
			model: null,
		};
		this.#live.set(id, live);
		this.#wire(id, live);
		try {
			await client.start();
			await client
				.setAskDialog(true)
				.catch(error => logger.debug("hub: ask dialog opt-in failed", { error: String(error) }));
			await client
				.setSubagentSubscription("progress")
				.catch(error => logger.debug("hub: subagent subscription failed", { error: String(error) }));
			await this.#readModel(live);
		} catch (error) {
			const stderr = client.getStderr().trim().split("\n").slice(-20).join("\n");
			this.#detach(id, live);
			await client.stop().catch(() => {});
			await this.#runtime.remove(spec.name).catch(() => {});
			const message = `agent failed to start: ${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`;
			this.#setStatus(id, "stopped", message);
			throw new HubError(502, message);
		}
		const exited = agentProcess as RpcAgentProcess | null;
		void exited?.exited.then(code => this.#onExit(id, live, code));
		this.#store.updateSession(id, { startCount: row.startCount + 1, error: null, lastActivityAt: Date.now() });
		this.#refreshStatus(id, live, true);
		this.#armIdle(id, live);
	}

	/** Enforce `sessions.maxRunning`, stopping the longest-idle session when one is idle. */
	async #makeRoom(startingId: string): Promise<void> {
		const running = [...this.#live.keys()].filter(id => id !== startingId);
		if (running.length < this.#config.sessions.maxRunning) return;
		const idle = running
			.map(id => this.#row(id))
			.filter(row => row.status === "idle")
			.sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
		if (!idle) throw new HubError(429, `${running.length} sessions are running and none is idle; stop one first`);
		await this.stop(idle.id, "making room for another session");
	}

	#wire(id: string, live: LiveSession): void {
		const { client } = live;
		live.disposers.push(
			client.onSessionEvent(event => {
				this.#emitAgentEvent(id, event);
				if (event.type === "agent_start") {
					live.busy = true;
					live.worked = true;
					this.#clearIdle(live);
					this.#refreshStatus(id, live);
				} else if (event.type === "agent_end") {
					live.busy = false;
					this.#refreshStatus(id, live);
				} else if (event.type === "model_changed") {
					void this.#readModel(live);
				}
				this.#touch(id, live);
			}),
			client.onExtensionUIRequest(request => {
				this.#emit(id, { kind: "ui_request", request });
				if (DIALOG_METHODS.has(request.method)) {
					live.pending.set(request.id, request);
					this.#refreshStatus(id, live);
					void this.#notify(id, {
						title: "Needs your input",
						message: dialogSummary(request),
						priority: 4,
						tags: ["question"],
					});
				} else if (request.method === "cancel" && live.pending.delete(request.targetId)) {
					this.#emit(id, { kind: "ui_resolved", id: request.targetId });
					this.#refreshStatus(id, live);
				}
			}),
			client.onPromptResult(result => {
				this.#emit(id, { kind: "prompt_result", result });
				if (result.status === "error") {
					void this.#notify(id, {
						title: "Agent error",
						message: result.error?.message ?? "the prompt failed",
						priority: 4,
						tags: ["warning"],
					});
				}
			}),
			client.onSessionSettled(() => {
				this.#emit(id, { kind: "settled" });
				live.busy = false;
				this.#refreshStatus(id, live);
				this.#armIdle(id, live);
				if (live.worked) {
					live.worked = false;
					void this.#notifyFinished(id, live);
				}
			}),
			client.onSubagentLifecycle(payload => this.#emit(id, { kind: "subagent_lifecycle", payload })),
			client.onSubagentProgress(payload => this.#emit(id, { kind: "subagent_progress", payload })),
		);
	}

	async #readModel(live: LiveSession): Promise<void> {
		try {
			const { model } = await live.client.getState();
			live.model = model ? `${model.provider}/${model.id}` : null;
		} catch (error) {
			logger.debug("hub: reading the agent's model failed", { error: String(error) });
		}
	}

	/** Connect the agent to the subscription broker, when there is a login and a way to reach it. */
	#brokerEnv(id: string): Record<string, string> {
		if (!this.#credentials?.hasAny()) return {};
		const base = this.#sandboxHubUrl();
		if (!base) {
			if (!this.#warnedUnreachable) {
				this.#warnedUnreachable = true;
				logger.warn(
					"hub: subscription logins are not available to sandboxes; set publicUrl or subscriptions.sandboxUrl",
				);
			}
			return {};
		}
		return {
			OMP_AUTH_BROKER_URL: `${base.replace(/\/+$/, "")}${BROKER_PROXY_PREFIX}`,
			OMP_AUTH_BROKER_TOKEN: this.#credentials.issueSessionToken(id),
		};
	}

	#detach(id: string, live: LiveSession): void {
		this.#credentials?.revokeSession(id);
		this.#clearIdle(live);
		for (const dispose of live.disposers.splice(0)) dispose();
		for (const requestId of live.pending.keys()) this.#emit(id, { kind: "ui_resolved", id: requestId });
		live.pending.clear();
		if (this.#live.get(id) === live) this.#live.delete(id);
	}

	async #stopUnlocked(id: string, reason: string): Promise<void> {
		const live = this.#live.get(id);
		if (!live) {
			const row = this.#store.session(id);
			if (row && LIVE_STATUSES.includes(row.status) && row.status !== "provisioning") this.#setStatus(id, "stopped");
			return;
		}
		live.stopping = true;
		this.#setStatus(id, "stopping");
		this.#emit(id, { kind: "log", source: "agent", line: `stopping: ${reason}` });
		this.#detach(id, live);
		await live.client.stop().catch(() => {});
		await this.#runtime.remove(live.container).catch(() => {});
		this.#setStatus(id, "stopped");
	}

	#onExit(id: string, live: LiveSession, code: number): void {
		if (live.stopping || this.#live.get(id) !== live) return;
		const stderr = live.client.getStderr().trim().split("\n").slice(-10).join("\n");
		this.#detach(id, live);
		const reap = this.#runtime.remove(live.container).catch(() => {});
		this.#reaping.set(id, reap);
		void reap.finally(() => {
			if (this.#reaping.get(id) === reap) this.#reaping.delete(id);
		});
		const message = `agent exited unexpectedly (code ${code})${stderr ? `: ${stderr}` : ""}`;
		try {
			this.#setStatus(id, "stopped", message);
		} catch (error) {
			// Runs detached from any request; a failure here must not surface as an unhandled rejection.
			logger.warn("hub: recording an agent exit failed", { session: id, error: String(error) });
			return;
		}
		void this.#notify(id, { title: "Session stopped", message, priority: 4, tags: ["x"] });
	}

	#armIdle(id: string, live: LiveSession): void {
		this.#clearIdle(live);
		const minutes = this.#config.sessions.idleStopMinutes;
		if (minutes <= 0) return;
		live.idleTimer = setTimeout(() => {
			if (live.busy || live.pending.size > 0 || live.stopping) return;
			void this.stop(id, `idle for ${minutes} minutes`).catch(() => {});
		}, minutes * 60_000);
		live.idleTimer.unref();
	}

	#clearIdle(live: LiveSession): void {
		if (live.idleTimer) clearTimeout(live.idleTimer);
		live.idleTimer = undefined;
	}

	#refreshStatus(id: string, live: LiveSession, force = false): void {
		if (live.stopping) return;
		const status: SessionStatus = live.pending.size > 0 ? "waiting" : live.busy ? "busy" : "idle";
		const row = this.#store.session(id);
		if (!row) return;
		if (force || row.status !== status) this.#setStatus(id, status);
	}

	#setStatus(id: string, status: SessionStatus, error?: string | null): void {
		if (!this.#store.session(id)) return;
		this.#store.updateSession(id, error === undefined ? { status } : { status, error });
		this.#emit(id, { kind: "status", status, error });
	}

	#touch(id: string, live: LiveSession, force = false): void {
		const now = Date.now();
		if (!force && now - live.lastActivityWrite < ACTIVITY_WRITE_INTERVAL_MS) return;
		live.lastActivityWrite = now;
		this.#store.updateSession(id, { lastActivityAt: now }, now);
	}

	async #notifyFinished(id: string, live: LiveSession): Promise<void> {
		const text = await live.client.getLastAssistantText().catch(() => null);
		await this.#notify(id, {
			title: "Finished",
			message: text ? truncate(text, 280) : "The agent is done and waiting for you.",
			tags: ["white_check_mark"],
		});
	}

	async #notify(id: string, notification: Notification): Promise<void> {
		const row = this.#store.session(id);
		if (!row) return;
		const repo = this.#store.repo(row.repoId);
		const name = row.title ?? `${repo?.name ?? "session"} · ${row.branch}`;
		const click = this.#config.publicUrl
			? `${this.#config.publicUrl.replace(/\/+$/, "")}/#/sessions/${id}`
			: undefined;
		await this.#notifier.notify({ ...notification, title: `${notification.title}: ${name}`, click });
	}

	#emitAgentEvent(id: string, event: AgentSessionEvent): void {
		if (event.type !== "message_update") {
			this.#emit(id, { kind: "agent", event });
			return;
		}
		// The full message supersedes the delta, which clients never need.
		const slim: StreamedAgentEvent = { type: "message_update", message: event.message };
		const pending = this.#pendingUpdates.get(id);
		if (pending) {
			pending.event = slim;
			return;
		}
		const timer = setTimeout(() => this.#flushUpdate(id), UPDATE_INTERVAL_MS);
		timer.unref();
		this.#pendingUpdates.set(id, { event: slim, timer });
	}

	#flushUpdate(id: string): void {
		const pending = this.#pendingUpdates.get(id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.#pendingUpdates.delete(id);
		this.#log(id).append({ kind: "agent", event: pending.event });
	}

	/** Every event goes through here, so a held update is always delivered before what follows it. */
	#emit(id: string, body: HubEventBody): void {
		this.#flushUpdate(id);
		this.#log(id).append(body);
	}

	#log(id: string): EventLog {
		let log = this.#logs.get(id);
		if (!log) {
			log = new EventLog(this.#config.sessions.eventBuffer);
			this.#logs.set(id, log);
		}
		return log;
	}

	#row(id: string): SessionRow {
		const row = this.#store.session(id);
		if (!row) throw new HubError(404, `session ${id} not found`);
		return row;
	}

	#view(row: SessionRow): SessionView {
		const live = this.#live.get(row.id);
		return {
			...row,
			repoName: this.#store.repo(row.repoId)?.name ?? row.repoId,
			live: live !== undefined && !live.stopping,
			pending: live ? [...live.pending.values()] : [],
			lastSeq: this.#logs.get(row.id)?.lastSeq ?? 0,
			activeModel: live?.model ?? null,
		};
	}

	#layout(id: string): SessionLayout {
		const root = path.join(this.#config.dataDir, "sessions", id);
		return {
			root,
			work: path.join(root, "work"),
			home: path.join(root, "home"),
			outbox: path.join(root, "outbox"),
			hub: path.join(root, "hub"),
		};
	}

	#spec(
		row: SessionRow,
		environment: EnvironmentView,
		image: string,
		options: {
			secrets: boolean;
			network: string;
			name?: string;
			outbox?: boolean;
			agent?: boolean;
			/** Current profile version; agents get it read-only plus the session's hub dir. */
			profileDir?: string;
		},
	): SandboxSpec {
		const layout = this.#layout(row.id);
		const definition = environment.definition;
		const env: Record<string, string> = { ...definition.env, OMP_HUB_SESSION: row.id };
		if (options.secrets) {
			// Keys from the settings page first; an environment's forwarded hub secrets refine them.
			Object.assign(env, this.#secrets.values());
			for (const name of definition.secrets) {
				const value = process.env[name];
				if (value === undefined) logger.warn("hub: secret is not set in the hub environment", { name });
				else env[name] = value;
			}
		}
		const sandboxLayout = {
			work: layout.work,
			home: layout.home,
			outbox: options.outbox ? layout.outbox : undefined,
			readonlyPaths: [
				this.#repos.mirrorPath(row.repoId),
				...(options.profileDir ? [options.profileDir, layout.hub] : []),
			],
		};
		env.HOME = this.#runtime.pathsFor(sandboxLayout).home;
		if (options.profileDir) env.OMP_HUB_PROFILE = path.join(options.profileDir, "agent");
		return {
			name: options.name ?? `omp-hub-${row.id}-task`,
			labels: {
				"omp-hub.owner": this.ownerLabel,
				"omp-hub.session": row.id,
				"omp-hub.role": options.agent ? "agent" : "task",
			},
			image,
			layout: sandboxLayout,
			mounts: definition.mounts,
			env,
			network: options.network,
			resources: definition.resources,
			extraArgs: definition.extraArgs,
		};
	}

	/** A spec for short tasks (diff, publish, setup): no network and no secrets unless asked. */
	async #taskSpec(
		row: SessionRow,
		options: { outbox?: boolean; image?: string; network?: string; secrets?: boolean } = {},
	): Promise<{ spec: SandboxSpec; paths: { work: string; home: string; outbox: string } }> {
		const environment = this.#environments.get(row.environmentId);
		const image = options.image ?? (await this.#environments.ensureImage(row.environmentId));
		const spec = this.#spec(row, environment, image, {
			secrets: options.secrets ?? false,
			network: options.network ?? "none",
			outbox: options.outbox,
		});
		return { spec, paths: this.#runtime.pathsFor(spec.layout) };
	}

	async #removeTree(id: string): Promise<void> {
		const { root } = this.#layout(id);
		try {
			await fs.rm(root, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!this.#runtime.isolated) throw error;
			logger.warn("hub: removing a session tree failed, retrying inside a sandbox", {
				session: id,
				error: String(error),
			});
		}
		// Files written under the image's own user can be unremovable by the hub's uid.
		const row = this.#row(id);
		const { spec, paths } = await this.#taskSpec(row);
		await this.#runtime.run(spec, ["sh", "-c", 'find "$1" "$2" -mindepth 1 -delete', "sh", paths.work, paths.home], {
			timeoutMs: TASK_TIMEOUT_MS,
		});
		await fs.rm(root, { recursive: true, force: true });
	}

	async #messagesFromDisk(id: string): Promise<AgentMessage[]> {
		const dir = path.join(this.#layout(id).home, HUB_STATE_DIR, "sessions");
		let newest: { file: string; mtime: number } | null = null;
		try {
			for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const file = path.join(entry.parentPath, entry.name);
				const { mtimeMs } = await fs.stat(file);
				if (!newest || mtimeMs > newest.mtime) newest = { file, mtime: mtimeMs };
			}
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		if (!newest) return [];
		const file = Bun.file(newest.file);
		if (file.size > MAX_TRANSCRIPT_BYTES)
			throw new HubError(422, "transcript is too large to read from disk; start the session to page it");
		const messages: AgentMessage[] = [];
		// The agent may be mid-write; skip a torn final line instead of failing the read.
		for (const entry of parseJsonlLenient<unknown>(await file.text())) {
			if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "message") {
				messages.push((entry as { message: AgentMessage }).message);
			}
		}
		return messages;
	}
}

function dialogSummary(request: RpcExtensionUIRequest): string {
	switch (request.method) {
		case "select":
		case "input":
		case "editor":
			return request.title;
		case "confirm":
			return `${request.title}: ${request.message}`;
		case "ask":
			return request.questions.map(question => question.question).join(" · ");
		case "form":
			return "The agent is asking a question.";
		default:
			return "The agent needs a decision.";
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
