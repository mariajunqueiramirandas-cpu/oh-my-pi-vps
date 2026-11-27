/**
 * The JSON the hub sends to and accepts from its web UI.
 *
 * This module imports nothing, so the browser bundle type-checks against it
 * without pulling in the server's dependency graph (which targets Bun, not the
 * DOM). `contract-check.ts` asserts at compile time that every route's actual
 * response fits these shapes, so drift fails `bun check`, not the phone.
 */

export type SessionStatus =
	| "provisioning"
	| "starting"
	| "idle"
	| "busy"
	| "waiting"
	| "stopping"
	| "stopped"
	| "failed";

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	multi?: boolean;
	recommended?: number;
}

interface UiRequestBase {
	type: "extension_ui_request";
	id: string;
}

/** What the agent asks its host; the first six methods wait for an answer. */
export type DialogRequest =
	| (UiRequestBase & {
			method: "select";
			title: string;
			options: string[];
			optionDetails?: Array<{ description?: string }>;
			timeout?: number;
	  })
	| (UiRequestBase & { method: "confirm"; title: string; message: string; timeout?: number })
	| (UiRequestBase & { method: "input"; title: string; placeholder?: string; secret?: boolean; timeout?: number })
	| (UiRequestBase & { method: "editor"; title: string; prefill?: string })
	| (UiRequestBase & { method: "ask"; questions: AskQuestion[]; timeout?: number })
	| (UiRequestBase & { method: "form"; html: string; timeout?: number })
	| (UiRequestBase & { method: "cancel"; targetId: string })
	| (UiRequestBase & {
			method: "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | "open_url";
	  });

export type DialogAnswer =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true }
	| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
	| { data: Record<string, unknown> };

export interface SessionView {
	id: string;
	title: string | null;
	repoId: string;
	repoName: string;
	environmentId: string;
	baseRef: string;
	baseCommit: string | null;
	branch: string;
	model: string | null;
	status: SessionStatus;
	error: string | null;
	startCount: number;
	publishedSha: string | null;
	pullRequestUrl: string | null;
	createdAt: number;
	updatedAt: number;
	lastActivityAt: number;
	live: boolean;
	pending: DialogRequest[];
	lastSeq: number;
	activeModel: string | null;
}

/** A transcript message; renderers read the rest of its fields defensively. */
export interface WireMessage {
	role: string;
	timestamp?: number;
}

/** omp session events; the UI narrows them by `type` with runtime guards. */
export type WireAgentEvent = { type: string };

export type HubEventBody =
	| { kind: "status"; status: SessionStatus; error?: string | null }
	| { kind: "agent"; event: WireAgentEvent }
	| { kind: "ui_request"; request: DialogRequest }
	| { kind: "ui_resolved"; id: string }
	| { kind: "prompt_result"; result: { status: string; error?: { message: string } } }
	| { kind: "settled" }
	| { kind: "subagent_lifecycle"; payload: unknown }
	| { kind: "subagent_progress"; payload: unknown }
	| { kind: "log"; source: string; line: string };

export type HubEvent = HubEventBody & { seq: number; at: number };

export type StreamFrame = { type: "hello"; lastSeq: number; truncated: boolean } | { type: "event"; event: HubEvent };

export interface RepoView {
	id: string;
	name: string;
	url: string;
	defaultBranch: string | null;
	status: "cloning" | "ready" | "error";
	error: string | null;
	createdAt: number;
	fetchedAt: number | null;
}

export interface EnvironmentDefinitionView {
	description?: string;
	image?: string;
	dockerfile?: string;
	build?: unknown;
}

export interface EnvironmentView {
	id: string;
	source: "config" | "api";
	definition: EnvironmentDefinitionView;
	image: string;
	build: { status: "idle" | "building" | "ready" | "error"; error?: string; log: string[]; finishedAt?: number };
}

export interface RuleFile {
	name: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	body: string;
}

export interface AgentProfile {
	defaultModel: string | null;
	thinkingLevel: string | null;
	instructions: string;
	stickyRules: string;
	systemPromptAppend: string;
	rules: RuleFile[];
	settings: string;
	models: string;
	updatedAt: number;
}

export type ProfilePatch = Partial<Omit<AgentProfile, "updatedAt">>;

export interface SecretInfo {
	name: string;
	preview: string;
	updatedAt: number;
}

export interface ProviderInfo {
	id: string;
	label: string;
	envVars: string[];
	defaultModel: string | null;
	modelCount: number;
	configured: boolean;
}

export interface ModelInfo {
	id: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	vision: boolean;
	cost: { input: number; output: number } | null;
}

export interface TokenInfo {
	id: string;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface HubInfo {
	version: string;
	runtime: string;
	sandboxed: boolean;
	publicUrl: string | null;
	github: boolean;
	thinkingLevels: readonly string[];
}

export interface CreateSessionInput {
	repoId: string;
	environmentId?: string;
	baseRef?: string;
	branch?: string;
	title?: string;
	model?: string;
	prompt?: string;
}

export interface PromptInput {
	message: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	mode?: "steer" | "followUp";
}

export interface MessagesResult {
	source: "live" | "disk";
	messages: WireMessage[];
}

export interface DiffResult {
	status: string;
	diff: string;
	truncated: boolean;
}

export interface PublishResult {
	branch: string;
	sha: string;
	remote: string;
}

export interface PullRequestResult {
	url: string;
	number: number;
	created: boolean;
}

export interface ShellResult {
	exitCode?: number;
	output: string;
	cancelled: boolean;
}

export interface SubscriptionAccount {
	credentialId: number;
	kind: "oauth" | "api_key";
	label: string;
	disabled: boolean;
}

export interface SubscriptionProvider {
	id: string;
	name: string;
	provider: string;
	available: boolean;
	accounts: SubscriptionAccount[];
}

export interface LoginInput {
	id: string;
	kind: "paste" | "prompt" | "confirm";
	message: string;
	placeholder: string | null;
	secret: boolean;
}

export interface LoginView {
	id: string;
	providerId: string;
	providerName: string;
	status: "starting" | "waiting" | "done" | "failed" | "cancelled";
	url: string | null;
	instructions: string | null;
	input: LoginInput | null;
	progress: string[];
	error: string | null;
	account: string | null;
	startedAt: number;
}
