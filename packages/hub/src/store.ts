/**
 * Durable hub state in one SQLite file: tokens, repositories, API-defined
 * environments, and sessions. Live state (agent processes, event buffers,
 * pending dialogs) is in memory and rebuilt from here on restart.
 */
import { Database } from "bun:sqlite";
import type { EnvironmentDefinition } from "./config";

export type RepoStatus = "cloning" | "ready" | "error";

export interface RepoRow {
	id: string;
	name: string;
	url: string;
	defaultBranch: string | null;
	status: RepoStatus;
	error: string | null;
	createdAt: number;
	fetchedAt: number | null;
}

export type SessionStatus =
	| "provisioning"
	| "starting"
	| "idle"
	| "busy"
	| "waiting"
	| "stopping"
	| "stopped"
	| "failed";

/** Statuses that mean a sandbox is (or is about to be) running. */
export const LIVE_STATUSES: readonly SessionStatus[] = [
	"provisioning",
	"starting",
	"idle",
	"busy",
	"waiting",
	"stopping",
];

export interface SessionRow {
	id: string;
	title: string | null;
	repoId: string;
	environmentId: string;
	baseRef: string;
	baseCommit: string | null;
	branch: string;
	model: string | null;
	status: SessionStatus;
	error: string | null;
	/** Number of times an agent has been started; >0 means a transcript exists to continue. */
	startCount: number;
	publishedSha: string | null;
	pullRequestUrl: string | null;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
}

export interface TokenRow {
	id: string;
	name: string;
	hash: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface EnvironmentRow {
	id: string;
	definition: EnvironmentDefinition;
	createdAt: number;
	updatedAt: number;
}

const MIGRATIONS: string[] = [
	`
	CREATE TABLE tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		hash TEXT NOT NULL UNIQUE,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	);
	CREATE TABLE repos (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		url TEXT NOT NULL,
		default_branch TEXT,
		status TEXT NOT NULL,
		error TEXT,
		created_at INTEGER NOT NULL,
		fetched_at INTEGER
	);
	CREATE TABLE environments (
		id TEXT PRIMARY KEY,
		definition TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		title TEXT,
		repo_id TEXT NOT NULL REFERENCES repos(id),
		environment_id TEXT NOT NULL,
		base_ref TEXT NOT NULL,
		base_commit TEXT,
		branch TEXT NOT NULL,
		model TEXT,
		status TEXT NOT NULL,
		error TEXT,
		start_count INTEGER NOT NULL DEFAULT 0,
		published_sha TEXT,
		pull_request_url TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		last_activity_at INTEGER NOT NULL
	);
	CREATE INDEX sessions_by_activity ON sessions(last_activity_at DESC);
	`,
	`
	CREATE TABLE settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE secrets (
		name TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
	`,
];

export interface SecretRow {
	name: string;
	value: string;
	updatedAt: number;
}

interface RawRepo {
	id: string;
	name: string;
	url: string;
	default_branch: string | null;
	status: RepoStatus;
	error: string | null;
	created_at: number;
	fetched_at: number | null;
}

interface RawSession {
	id: string;
	title: string | null;
	repo_id: string;
	environment_id: string;
	base_ref: string;
	base_commit: string | null;
	branch: string;
	model: string | null;
	status: SessionStatus;
	error: string | null;
	start_count: number;
	published_sha: string | null;
	pull_request_url: string | null;
	created_at: number;
	updated_at: number;
	last_activity_at: number;
}

interface RawToken {
	id: string;
	name: string;
	hash: string;
	created_at: number;
	last_used_at: number | null;
}

interface RawEnvironment {
	id: string;
	definition: string;
	created_at: number;
	updated_at: number;
}

function toRepo(row: RawRepo): RepoRow {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		defaultBranch: row.default_branch,
		status: row.status,
		error: row.error,
		createdAt: row.created_at,
		fetchedAt: row.fetched_at,
	};
}

function toSession(row: RawSession): SessionRow {
	return {
		id: row.id,
		title: row.title,
		repoId: row.repo_id,
		environmentId: row.environment_id,
		baseRef: row.base_ref,
		baseCommit: row.base_commit,
		branch: row.branch,
		model: row.model,
		status: row.status,
		error: row.error,
		startCount: row.start_count,
		publishedSha: row.published_sha,
		pullRequestUrl: row.pull_request_url,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastActivityAt: row.last_activity_at,
	};
}

function toToken(row: RawToken): TokenRow {
	return { id: row.id, name: row.name, hash: row.hash, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** Columns a session update may change, keyed by their row field name. */
const SESSION_COLUMNS = {
	title: "title",
	baseCommit: "base_commit",
	model: "model",
	status: "status",
	error: "error",
	startCount: "start_count",
	publishedSha: "published_sha",
	pullRequestUrl: "pull_request_url",
	lastActivityAt: "last_activity_at",
} as const satisfies Partial<Record<keyof SessionRow, string>>;

export type SessionPatch = Partial<Pick<SessionRow, keyof typeof SESSION_COLUMNS>>;

const REPO_COLUMNS = {
	defaultBranch: "default_branch",
	status: "status",
	error: "error",
	fetchedAt: "fetched_at",
} as const satisfies Partial<Record<keyof RepoRow, string>>;

export type RepoPatch = Partial<Pick<RepoRow, keyof typeof REPO_COLUMNS>>;

export class HubStore {
	readonly db: Database;

	constructor(file: string) {
		this.db = new Database(file, { create: true, strict: true });
		this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
		this.#migrate();
	}

	close(): void {
		this.db.close();
	}

	#migrate(): void {
		const { user_version: version } = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get() ?? {
			user_version: 0,
		};
		for (let index = version; index < MIGRATIONS.length; index++) {
			this.db.transaction(() => {
				this.db.exec(MIGRATIONS[index]);
				this.db.exec(`PRAGMA user_version = ${index + 1}`);
			})();
		}
	}

	// ── tokens ──────────────────────────────────────────────────────────────

	insertToken(row: TokenRow): void {
		this.db
			.query(
				"INSERT INTO tokens (id, name, hash, created_at, last_used_at) VALUES ($id, $name, $hash, $createdAt, NULL)",
			)
			.run({ id: row.id, name: row.name, hash: row.hash, createdAt: row.createdAt });
	}

	tokenByHash(hash: string): TokenRow | null {
		const row = this.db.query<RawToken, { hash: string }>("SELECT * FROM tokens WHERE hash = $hash").get({ hash });
		return row ? toToken(row) : null;
	}

	listTokens(): TokenRow[] {
		return this.db.query<RawToken, []>("SELECT * FROM tokens ORDER BY created_at").all().map(toToken);
	}

	touchToken(id: string, at: number): void {
		this.db.query("UPDATE tokens SET last_used_at = $at WHERE id = $id").run({ id, at });
	}

	deleteToken(id: string): boolean {
		return this.db.query("DELETE FROM tokens WHERE id = $id").run({ id }).changes > 0;
	}

	// ── repos ───────────────────────────────────────────────────────────────

	insertRepo(row: RepoRow): void {
		this.db
			.query(
				`INSERT INTO repos (id, name, url, default_branch, status, error, created_at, fetched_at)
				 VALUES ($id, $name, $url, $defaultBranch, $status, $error, $createdAt, $fetchedAt)`,
			)
			.run({ ...row });
	}

	repo(id: string): RepoRow | null {
		const row = this.db.query<RawRepo, { id: string }>("SELECT * FROM repos WHERE id = $id").get({ id });
		return row ? toRepo(row) : null;
	}

	repoByName(name: string): RepoRow | null {
		const row = this.db.query<RawRepo, { name: string }>("SELECT * FROM repos WHERE name = $name").get({ name });
		return row ? toRepo(row) : null;
	}

	listRepos(): RepoRow[] {
		return this.db.query<RawRepo, []>("SELECT * FROM repos ORDER BY name").all().map(toRepo);
	}

	updateRepo(id: string, patch: RepoPatch): void {
		this.#update("repos", REPO_COLUMNS, id, patch);
	}

	deleteRepo(id: string): void {
		this.db.query("DELETE FROM repos WHERE id = $id").run({ id });
	}

	// ── environments (API-defined only; config environments live in hub.yaml) ──

	putEnvironment(id: string, definition: EnvironmentDefinition, at: number): void {
		this.db
			.query(
				`INSERT INTO environments (id, definition, created_at, updated_at) VALUES ($id, $definition, $at, $at)
				 ON CONFLICT(id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
			)
			.run({ id, definition: JSON.stringify(definition), at });
	}

	listEnvironments(): EnvironmentRow[] {
		return this.db
			.query<RawEnvironment, []>("SELECT * FROM environments ORDER BY id")
			.all()
			.map(row => ({
				id: row.id,
				definition: JSON.parse(row.definition) as EnvironmentDefinition,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}));
	}

	deleteEnvironment(id: string): boolean {
		return this.db.query("DELETE FROM environments WHERE id = $id").run({ id }).changes > 0;
	}

	// ── sessions ────────────────────────────────────────────────────────────

	insertSession(row: SessionRow): void {
		this.db
			.query(
				`INSERT INTO sessions (id, title, repo_id, environment_id, base_ref, base_commit, branch, model, status, error,
					start_count, published_sha, pull_request_url, created_at, updated_at, last_activity_at)
				 VALUES ($id, $title, $repoId, $environmentId, $baseRef, $baseCommit, $branch, $model, $status, $error,
					$startCount, $publishedSha, $pullRequestUrl, $createdAt, $updatedAt, $lastActivityAt)`,
			)
			.run({ ...row });
	}

	session(id: string): SessionRow | null {
		const row = this.db.query<RawSession, { id: string }>("SELECT * FROM sessions WHERE id = $id").get({ id });
		return row ? toSession(row) : null;
	}

	listSessions(): SessionRow[] {
		return this.db
			.query<RawSession, []>("SELECT * FROM sessions ORDER BY last_activity_at DESC")
			.all()
			.map(toSession);
	}

	sessionsForRepo(repoId: string): SessionRow[] {
		return this.db
			.query<RawSession, { repoId: string }>("SELECT * FROM sessions WHERE repo_id = $repoId")
			.all({ repoId })
			.map(toSession);
	}

	sessionsForEnvironment(environmentId: string): SessionRow[] {
		return this.db
			.query<RawSession, { environmentId: string }>("SELECT * FROM sessions WHERE environment_id = $environmentId")
			.all({ environmentId })
			.map(toSession);
	}

	updateSession(id: string, patch: SessionPatch, at = Date.now()): void {
		this.#update("sessions", SESSION_COLUMNS, id, { ...patch, updatedAt: at }, { updatedAt: "updated_at" });
	}

	deleteSession(id: string): void {
		this.db.query("DELETE FROM sessions WHERE id = $id").run({ id });
	}

	// ── settings (JSON documents by key) ────────────────────────────────────

	setting<T>(key: string): { value: T; updatedAt: number } | null {
		const row = this.db
			.query<{ value: string; updated_at: number }, { key: string }>(
				"SELECT value, updated_at FROM settings WHERE key = $key",
			)
			.get({ key });
		return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
	}

	putSetting(key: string, value: unknown, at: number): void {
		this.db
			.query(
				`INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $at)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run({ key, value: JSON.stringify(value), at });
	}

	// ── secrets (values never leave the hub except into sandboxes) ──────────

	listSecrets(): SecretRow[] {
		return this.db
			.query<{ name: string; value: string; updated_at: number }, []>("SELECT * FROM secrets ORDER BY name")
			.all()
			.map(row => ({ name: row.name, value: row.value, updatedAt: row.updated_at }));
	}

	putSecret(name: string, value: string, at: number): void {
		this.db
			.query(
				`INSERT INTO secrets (name, value, updated_at) VALUES ($name, $value, $at)
				 ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.run({ name, value, at });
	}

	deleteSecret(name: string): boolean {
		return this.db.query("DELETE FROM secrets WHERE name = $name").run({ name }).changes > 0;
	}

	#update(
		table: "repos" | "sessions",
		columns: Record<string, string>,
		id: string,
		patch: Record<string, unknown>,
		extra: Record<string, string> = {},
	): void {
		const allowed = { ...columns, ...extra };
		const sets: string[] = [];
		const params: Record<string, string | number | null> = { id };
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			const column = allowed[key];
			if (!column) throw new Error(`unknown ${table} column ${key}`);
			sets.push(`${column} = $${key}`);
			params[key] = value as string | number | null;
		}
		if (sets.length === 0) return;
		this.db.query(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = $id`).run(params);
	}
}
