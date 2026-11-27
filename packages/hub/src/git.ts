/**
 * Git operations the hub performs on the host.
 *
 * Exception to the repo-wide `pi-natives/vcs` rule: the hub needs bare mirrors,
 * `--shared` clones, bundle import, and leased pushes, none of which that
 * binding exposes, and it must run with hardening flags. All git the hub runs
 * goes through {@link runGit}.
 *
 * Trust boundary: the hub only runs git in repositories it owns (mirrors, and a
 * checkout before any sandbox has touched it). Once a sandbox has written to a
 * checkout, its `.git/config`, hooks and attributes are attacker-controlled, so
 * anything that reads the checkout afterwards runs inside a sandbox and hands
 * the result back as data (a bundle, a diff).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";

/** Applied to every invocation, even in trusted repositories. */
const HARDENING = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"credential.interactive=never",
	"-c",
	"protocol.ext.allow=never",
];

const DEFAULT_TIMEOUT_MS = 120_000;

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly stderr: string,
		readonly exitCode: number | null,
	) {
		super(message);
		this.name = "GitError";
	}
}

export interface GitOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string>;
}

/** Run git non-interactively and return stdout; throws {@link GitError} on failure or timeout. */
export async function runGit(args: string[], options: GitOptions = {}): Promise<string> {
	const argv = ["git", ...HARDENING, ...args];
	const result = await ptree.exec(argv, {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		allowNonZero: true,
		allowAbort: true,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_ASKPASS: "",
			SSH_ASKPASS: "",
			LC_ALL: "C",
			...options.env,
		},
	});
	if (!result.ok) {
		const stderr = result.stderr.trim();
		const reason = result.exitError?.aborted ? "timed out" : `exited with ${result.exitCode}`;
		throw new GitError(`git ${args[0]} ${reason}${stderr ? `: ${stderr}` : ""}`, args, stderr, result.exitCode);
	}
	return result.stdout;
}

const REMOTE_URL_PATTERN = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:|\/)/;

/** Accept only plain transport URLs: no option injection, no `ext::`/helper transports. */
export function assertRemoteUrl(url: string): void {
	if (url.startsWith("-") || /[\s\0]/.test(url) || !REMOTE_URL_PATTERN.test(url)) {
		throw new GitError(`unsupported repository URL: ${url}`, [], "", null);
	}
}

const REF_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![./])$/;

/** Branch, tag or commit names the hub accepts from clients. */
export function isSafeRefName(name: string): boolean {
	return name.length > 0 && name.length <= 200 && REF_PATTERN.test(name);
}

function assertRef(name: string): void {
	if (!isSafeRefName(name)) throw new GitError(`invalid ref name: ${name}`, [], "", null);
}

/** `owner/repo` for a URL, used as the repository's display name. */
export function repoNameFromUrl(url: string): string {
	const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
	const parts = trimmed.split(/[/:]/).filter(Boolean);
	return parts.slice(-2).join("/") || trimmed;
}

/** The remote's default branch, from its advertised `HEAD` symref. */
export async function remoteDefaultBranch(url: string, timeoutMs?: number): Promise<string | null> {
	assertRemoteUrl(url);
	const out = await runGit(["ls-remote", "--symref", "--", url, "HEAD"], { timeoutMs });
	const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out);
	return match ? match[1] : null;
}

async function isRepository(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(path.join(dir, "HEAD"))).isFile();
	} catch {
		return false;
	}
}

/**
 * Create (if needed) and refresh a bare mirror of branches and tags.
 * Auto-gc is off: `--shared` checkouts borrow the mirror's objects, so the
 * mirror must never prune objects a checkout may still reference.
 */
export async function ensureMirror(
	url: string,
	mirrorPath: string,
	timeoutMs?: number,
): Promise<{ defaultBranch: string | null }> {
	assertRemoteUrl(url);
	if (!(await isRepository(mirrorPath))) {
		await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
		await runGit(["init", "--bare", "--quiet", mirrorPath]);
		await runGit(["remote", "add", "origin", url], { cwd: mirrorPath });
		await runGit(["config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], {
			cwd: mirrorPath,
		});
		await runGit(["config", "--add", "remote.origin.fetch", "+refs/tags/*:refs/tags/*"], { cwd: mirrorPath });
		await runGit(["config", "gc.auto", "0"], { cwd: mirrorPath });
		await runGit(["config", "maintenance.auto", "false"], { cwd: mirrorPath });
	}
	await fetchMirror(mirrorPath, timeoutMs);
	const defaultBranch = await remoteDefaultBranch(url, timeoutMs).catch(() => null);
	if (defaultBranch) await runGit(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], { cwd: mirrorPath });
	return { defaultBranch };
}

export async function fetchMirror(mirrorPath: string, timeoutMs?: number): Promise<void> {
	await runGit(["fetch", "--prune", "--quiet", "origin"], { cwd: mirrorPath, timeoutMs });
}

/** Resolve a branch, tag or sha to a commit id in a repository the hub owns. */
export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
	assertRef(ref);
	const out = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
		cwd: repoPath,
	}).catch(() => "");
	const sha = out.trim();
	if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new GitError(`unknown ref: ${ref}`, [], "", null);
	return sha;
}

export interface CheckoutOptions {
	mirrorPath: string;
	checkoutPath: string;
	baseCommit: string;
	branch: string;
	author: { name: string; email: string };
	timeoutMs?: number;
}

/**
 * Clone a working checkout that borrows the mirror's objects (`--shared`) and
 * start the session branch at `baseCommit`. The mirror stays the checkout's
 * `origin`, so a sandbox that mounts it read-only can fetch but never push.
 */
export async function createCheckout(options: CheckoutOptions): Promise<void> {
	assertRef(options.branch);
	await fs.mkdir(path.dirname(options.checkoutPath), { recursive: true });
	await runGit(["clone", "--shared", "--no-checkout", "--quiet", "--", options.mirrorPath, options.checkoutPath], {
		timeoutMs: options.timeoutMs,
	});
	const cwd = options.checkoutPath;
	await runGit(["config", "user.name", options.author.name], { cwd });
	await runGit(["config", "user.email", options.author.email], { cwd });
	await runGit(["checkout", "--quiet", "-b", options.branch, options.baseCommit], {
		cwd,
		timeoutMs: options.timeoutMs,
	});
}

const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Import a sandbox-produced bundle into the mirror as `targetRef`. A bundle is
 * plain data: unlike fetching from the checkout, no sandbox-controlled config
 * or hook is consulted.
 */
export async function importBundle(
	mirrorPath: string,
	bundlePath: string,
	branch: string,
	targetRef: string,
): Promise<string> {
	assertRef(branch);
	const stat = await fs.lstat(bundlePath);
	if (!stat.isFile()) throw new GitError("publish bundle is not a regular file", [], "", null);
	if (stat.size > MAX_BUNDLE_BYTES) throw new GitError("publish bundle is too large", [], "", null);
	await runGit(
		["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", bundlePath, `+refs/heads/${branch}:${targetRef}`],
		{
			cwd: mirrorPath,
		},
	);
	return (await runGit(["rev-parse", "--verify", targetRef], { cwd: mirrorPath })).trim();
}

export interface PushOptions {
	mirrorPath: string;
	sourceRef: string;
	branch: string;
	/** Remote sha the hub last pushed; `null` requires the branch not to exist yet. */
	expectedRemoteSha: string | null;
	/** Overwrite whatever the remote branch holds. */
	force?: boolean;
	timeoutMs?: number;
}

/** Push a mirror ref to `origin`, refusing to clobber commits the hub has not seen. */
export async function pushBranch(options: PushOptions): Promise<void> {
	assertRef(options.branch);
	const target = `refs/heads/${options.branch}`;
	const lease = options.force ? "--force" : `--force-with-lease=${target}:${options.expectedRemoteSha ?? ""}`;
	await runGit(["push", "--quiet", "--no-verify", lease, "origin", `${options.sourceRef}:${target}`], {
		cwd: options.mirrorPath,
		timeoutMs: options.timeoutMs,
	});
}

/** `{ owner, repo }` for GitHub HTTPS/SSH URLs. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
	const match =
		/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
			url,
		);
	return match ? { owner: match[1], repo: match[2] } : null;
}
