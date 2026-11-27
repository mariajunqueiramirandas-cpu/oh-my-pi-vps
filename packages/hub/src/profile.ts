/**
 * The agent profile: what every session's omp is told and allowed to use,
 * edited from the settings page.
 *
 * | Field                | Lands in the sandbox as                          |
 * | -------------------- | ------------------------------------------------ |
 * | `instructions`       | `~/.omp/agent/AGENTS.md` (user-level context)    |
 * | `stickyRules`        | `~/.omp/agent/RULES.md` (always-apply rule)      |
 * | `rules`              | `~/.omp/agent/rules/<name>.md` (scoped rules)    |
 * | `systemPromptAppend` | `~/.omp/agent/APPEND_SYSTEM.md`                  |
 * | `models`             | `~/.omp/agent/models.yml` (custom providers)     |
 * | `defaultModel`, `thinkingLevel`, `settings` | a `--config` overlay        |
 *
 * The hub never writes into a sandbox-writable directory: each version is
 * materialized into a hub-owned directory, mounted read-only, and copied into
 * the agent directory by a launch wrapper running inside the sandbox.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ENV_NAME_PATTERN } from "./config";
import { HubError } from "./errors";
import type { HubStore } from "./store";

export const THINKING_LEVELS: readonly string[] = [...THINKING_EFFORTS, "auto"];
const MAX_TEXT = 256 * 1024;
const MAX_RULES = 100;
const MAX_SECRET = 16 * 1024;
const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Variables the launch itself depends on; a stored secret must not shadow them. */
const RESERVED_SECRETS = new Set([
	"HOME",
	"PATH",
	"OMP_HUB_PROFILE",
	"OMP_HUB_SESSION",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
]);
/** How long a superseded profile version stays on disk for sandboxes still copying from it. */
const VERSION_GRACE_MS = 10 * 60_000;
const SETTING_KEY = "agentProfile";

export const RuleFile = type({
	name: "string",
	"description?": "string",
	"globs?": "string[]",
	"alwaysApply?": "boolean",
	body: "string",
	"+": "reject",
});
export type RuleFile = typeof RuleFile.infer;

export const ProfilePatch = type({
	"defaultModel?": "string | null",
	"thinkingLevel?": "string | null",
	"instructions?": "string",
	"stickyRules?": "string",
	"systemPromptAppend?": "string",
	"rules?": RuleFile.array(),
	"settings?": "string",
	"models?": "string",
	"+": "reject",
});
export type ProfilePatch = typeof ProfilePatch.infer;

export interface AgentProfile {
	/** `provider/model-id`; null lets omp choose from the available credentials. */
	defaultModel: string | null;
	thinkingLevel: string | null;
	instructions: string;
	stickyRules: string;
	systemPromptAppend: string;
	rules: RuleFile[];
	/** YAML merged into the `--config` overlay (any omp setting). */
	settings: string;
	/** YAML written as `models.yml` (custom providers and models). */
	models: string;
	updatedAt: number;
}

const EMPTY_PROFILE: AgentProfile = {
	defaultModel: null,
	thinkingLevel: null,
	instructions: "",
	stickyRules: "",
	systemPromptAppend: "",
	rules: [],
	settings: "",
	models: "",
	updatedAt: 0,
};

function parseYamlObject(field: string, text: string): Record<string, unknown> {
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (error) {
		throw new HubError(422, `${field} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) throw new HubError(422, `${field} must be a YAML mapping`);
	return parsed as Record<string, unknown>;
}

function ruleMarkdown(rule: RuleFile): string {
	// JSON scalars are valid YAML, so no quoting rules of our own are needed.
	const front: string[] = [];
	if (rule.description) front.push(`description: ${JSON.stringify(rule.description)}`);
	if (rule.globs?.length) front.push(`globs: ${JSON.stringify(rule.globs)}`);
	if (rule.alwaysApply !== undefined) front.push(`alwaysApply: ${rule.alwaysApply}`);
	const body = rule.body.endsWith("\n") ? rule.body : `${rule.body}\n`;
	return front.length > 0 ? `---\n${front.join("\n")}\n---\n${body}` : body;
}

export class ProfileService {
	readonly #store: HubStore;
	readonly #root: string;
	#current: Promise<string> | null = null;

	constructor(store: HubStore, dataDir: string) {
		this.#store = store;
		this.#root = path.join(dataDir, "profile");
	}

	get(): AgentProfile {
		const stored = this.#store.setting<Omit<AgentProfile, "updatedAt">>(SETTING_KEY);
		return stored ? { ...EMPTY_PROFILE, ...stored.value, updatedAt: stored.updatedAt } : { ...EMPTY_PROFILE };
	}

	/** Validate, store, and publish a new profile version for sessions started from now on. */
	async update(input: unknown): Promise<AgentProfile> {
		const patch = ProfilePatch(input);
		if (patch instanceof type.errors) throw new HubError(422, patch.summary);
		const next = { ...this.get(), ...patch };
		this.#validate(next);
		const { updatedAt: _ignored, ...value } = next;
		this.#store.putSetting(SETTING_KEY, value, Date.now());
		this.#current = this.#materialize();
		await this.#current;
		return this.get();
	}

	/** The directory holding the current profile version, materializing it on first use. */
	currentDir(): Promise<string> {
		this.#current ??= this.#materialize();
		return this.#current;
	}

	#validate(profile: AgentProfile): void {
		if (profile.defaultModel !== null && !/^[^\s/]+\/\S+$/.test(profile.defaultModel)) {
			throw new HubError(422, "defaultModel must look like provider/model-id");
		}
		if (profile.thinkingLevel !== null && !THINKING_LEVELS.includes(profile.thinkingLevel)) {
			throw new HubError(422, `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		for (const field of ["instructions", "stickyRules", "systemPromptAppend", "settings", "models"] as const) {
			if (profile[field].length > MAX_TEXT)
				throw new HubError(422, `${field} is larger than ${MAX_TEXT / 1024} KiB`);
		}
		if (profile.rules.length > MAX_RULES) throw new HubError(422, `at most ${MAX_RULES} rules`);
		const names = new Set<string>();
		for (const rule of profile.rules) {
			if (!RULE_NAME.test(rule.name)) throw new HubError(422, `rule name "${rule.name}" must match ${RULE_NAME}`);
			// The sticky RULES.md is named RULES; a scoped rule with that name would shadow it.
			if (rule.name === "RULES" || names.has(rule.name))
				throw new HubError(422, `duplicate rule name "${rule.name}"`);
			if (rule.body.length > MAX_TEXT) throw new HubError(422, `rule "${rule.name}" is too large`);
			names.add(rule.name);
		}
		parseYamlObject("settings", profile.settings);
		parseYamlObject("models", profile.models);
	}

	async #materialize(): Promise<string> {
		const profile = this.get();
		const dir = path.join(this.#root, `v${profile.updatedAt}-${crypto.randomUUID().slice(0, 8)}`);
		const overlay = parseYamlObject("settings", profile.settings);
		if (profile.defaultModel) {
			const roles = typeof overlay.modelRoles === "object" && overlay.modelRoles !== null ? overlay.modelRoles : {};
			overlay.modelRoles = { ...roles, default: profile.defaultModel };
		}
		if (profile.thinkingLevel) overlay.defaultThinkingLevel = profile.thinkingLevel;
		await Bun.write(path.join(dir, "config.yml"), `${JSON.stringify(overlay, null, 2)}\n`);
		const agent = path.join(dir, "agent");
		await Bun.write(path.join(agent, "AGENTS.md"), profile.instructions);
		await Bun.write(path.join(agent, "RULES.md"), profile.stickyRules);
		await Bun.write(path.join(agent, "APPEND_SYSTEM.md"), profile.systemPromptAppend);
		if (profile.models.trim()) await Bun.write(path.join(agent, "models.yml"), profile.models);
		await fs.mkdir(path.join(agent, "rules"), { recursive: true });
		for (const rule of profile.rules)
			await Bun.write(path.join(agent, "rules", `${rule.name}.md`), ruleMarkdown(rule));
		await this.#prune(dir);
		return dir;
	}

	async #prune(keep: string): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.#root);
		} catch {
			return;
		}
		const now = Date.now();
		for (const entry of entries) {
			const dir = path.join(this.#root, entry);
			if (dir === keep) continue;
			try {
				const { mtimeMs } = await fs.stat(dir);
				if (now - mtimeMs > VERSION_GRACE_MS) await fs.rm(dir, { recursive: true, force: true });
			} catch (error) {
				logger.debug("hub: pruning a profile version failed", { dir, error: String(error) });
			}
		}
	}
}

export interface SecretInfo {
	name: string;
	/** Enough to recognize a key without revealing it. */
	preview: string;
	updatedAt: number;
}

/** API keys and tokens entered on the settings page, forwarded into every agent sandbox. */
export class SecretService {
	readonly #store: HubStore;

	constructor(store: HubStore) {
		this.#store = store;
	}

	list(): SecretInfo[] {
		return this.#store.listSecrets().map(row => ({
			name: row.name,
			preview: row.value.length >= 12 ? `…${row.value.slice(-4)}` : "set",
			updatedAt: row.updatedAt,
		}));
	}

	names(): Set<string> {
		return new Set(this.#store.listSecrets().map(row => row.name));
	}

	values(): Record<string, string> {
		return Object.fromEntries(this.#store.listSecrets().map(row => [row.name, row.value]));
	}

	set(name: string, value: string): SecretInfo {
		if (!ENV_NAME_PATTERN.test(name)) throw new HubError(422, `invalid variable name: ${name}`);
		if (RESERVED_SECRETS.has(name) || name.startsWith("OMP_HUB_") || name.startsWith("OMP_AUTH_BROKER_")) {
			throw new HubError(422, `${name} is reserved`);
		}
		if (!value) throw new HubError(422, "value is empty");
		if (value.length > MAX_SECRET) throw new HubError(422, "value is too long");
		if (/[\r\n\0]/.test(value)) throw new HubError(422, "value must be a single line");
		this.#store.putSecret(name, value, Date.now());
		const info = this.list().find(secret => secret.name === name);
		if (!info) throw new HubError(500, "secret was not stored");
		return info;
	}

	remove(name: string): void {
		if (!this.#store.deleteSecret(name)) throw new HubError(404, `${name} is not set`);
	}
}
