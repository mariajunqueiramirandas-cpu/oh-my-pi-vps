/**
 * Talking to the hub from the browser. Types come from `contract.ts` only;
 * `contract-check.ts` proves on the server side that each route below answers
 * with the shape named here.
 */
import type {
	AgentProfile,
	CreateSessionInput,
	DialogAnswer,
	DiffResult,
	EnvironmentView,
	HubInfo,
	LoginView,
	MessagesResult,
	ModelInfo,
	ProfilePatch,
	PromptInput,
	ProviderInfo,
	PublishResult,
	PullRequestResult,
	RepoView,
	SecretInfo,
	SessionView,
	ShellResult,
	StreamFrame,
	SubscriptionProvider,
	TokenInfo,
} from "../contract";

const TOKEN_KEY = "omp-hub.token";

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

export function readToken(): string | null {
	return storage()?.getItem(TOKEN_KEY) ?? null;
}

export function clearToken(): void {
	storage()?.removeItem(TOKEN_KEY);
}

export function signInWith(token: string): void {
	storage()?.setItem(TOKEN_KEY, token);
}

/** A pairing link puts the token in the fragment (`#token=…`), which never reaches the server. */
export function takeTokenFromLocation(): string | null {
	const match = /^#token=([^&]+)/.exec(window.location.hash);
	if (!match) return null;
	const token = decodeURIComponent(match[1]);
	history.replaceState(null, "", `${window.location.pathname}#/`);
	return token;
}

let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(handler: () => void): void {
	onUnauthorized = handler;
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function request<T>(method: string, path: string, body?: unknown, token = readToken()): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers: {
				Authorization: `Bearer ${token ?? ""}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ApiError(0, "The hub is unreachable. Check your connection.");
	}
	if (response.status === 401 && token === readToken()) onUnauthorized();
	const data = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		const message =
			data && typeof data === "object" && "error" in data && typeof data.error === "string"
				? data.error
				: `${response.status} ${response.statusText}`;
		throw new ApiError(response.status, message);
	}
	return data as T;
}

const at = (...parts: string[]) => `/api/${parts.map(encodeURIComponent).join("/")}`;

export const api = {
	info: (token?: string) => request<HubInfo>("GET", at("info"), undefined, token),
	sessions: {
		list: () => request<SessionView[]>("GET", at("sessions")),
		get: (id: string) => request<SessionView>("GET", at("sessions", id)),
		create: (input: CreateSessionInput) => request<SessionView>("POST", at("sessions"), input),
		remove: (id: string) => request<{ deleted: boolean }>("DELETE", at("sessions", id)),
		start: (id: string) => request<SessionView>("POST", at("sessions", id, "start")),
		stop: (id: string) => request<SessionView>("POST", at("sessions", id, "stop")),
		prompt: (id: string, input: PromptInput) =>
			request<{ requestId: string }>("POST", at("sessions", id, "prompt"), input),
		abort: (id: string) => request<{ aborted: boolean }>("POST", at("sessions", id, "abort")),
		respond: (id: string, requestId: string, answer: DialogAnswer) =>
			request<{ answered: boolean }>("POST", at("sessions", id, "respond"), { requestId, answer }),
		shell: (id: string, command: string) => request<ShellResult>("POST", at("sessions", id, "bash"), { command }),
		messages: (id: string) => request<MessagesResult>("GET", at("sessions", id, "messages")),
		diff: (id: string) => request<DiffResult>("GET", at("sessions", id, "diff")),
		publish: (id: string, input: { message?: string; force?: boolean }) =>
			request<PublishResult>("POST", at("sessions", id, "publish"), input),
		pullRequest: (id: string, input: { title?: string; body?: string; message?: string }) =>
			request<PullRequestResult>("POST", at("sessions", id, "pull-request"), input),
		ticket: (id: string) => request<{ ticket: string; expiresAt: number }>("POST", at("sessions", id, "ticket")),
	},
	repos: {
		list: () => request<RepoView[]>("GET", at("repos")),
		add: (url: string) => request<RepoView>("POST", at("repos"), { url }),
		refresh: (id: string) => request<RepoView>("POST", at("repos", id, "refresh")),
		remove: (id: string) => request<{ deleted: boolean }>("DELETE", at("repos", id)),
	},
	environments: {
		list: () => request<EnvironmentView[]>("GET", at("environments")),
		put: (id: string, definition: Record<string, unknown>) =>
			request<EnvironmentView>("PUT", at("environments", id), definition),
		remove: (id: string) => request<{ deleted: boolean }>("DELETE", at("environments", id)),
		build: (id: string) => request<{ started: boolean }>("POST", at("environments", id, "build")),
	},
	profile: {
		get: () => request<AgentProfile>("GET", at("profile")),
		update: (patch: ProfilePatch) => request<AgentProfile>("PUT", at("profile"), patch),
		apply: () => request<{ stopped: number }>("POST", at("profile", "apply")),
	},
	secrets: {
		list: () => request<SecretInfo[]>("GET", at("secrets")),
		set: (name: string, value: string) => request<SecretInfo>("PUT", at("secrets", name), { value }),
		remove: (name: string) => request<{ deleted: boolean }>("DELETE", at("secrets", name)),
	},
	catalog: {
		providers: () => request<ProviderInfo[]>("GET", at("catalog", "providers")),
		models: (provider: string) => request<ModelInfo[]>("GET", at("catalog", "providers", provider, "models")),
	},
	subscriptions: {
		list: () => request<SubscriptionProvider[]>("GET", at("subscriptions")),
		remove: (provider: string, credentialId: number) =>
			request<{ deleted: boolean }>("DELETE", at("subscriptions", provider, String(credentialId))),
	},
	logins: {
		start: (providerId: string) => request<LoginView>("POST", at("logins"), { providerId }),
		get: (id: string) => request<LoginView>("GET", at("logins", id)),
		answer: (id: string, inputId: string, value: string) =>
			request<LoginView>("POST", at("logins", id, "input"), { inputId, value }),
		cancel: (id: string) => request<LoginView>("DELETE", at("logins", id)),
	},
	tokens: {
		list: () => request<TokenInfo[]>("GET", at("tokens")),
		create: (name: string) => request<{ token: string; info: TokenInfo }>("POST", at("tokens"), { name }),
		remove: (id: string) => request<{ deleted: boolean }>("DELETE", at("tokens", id)),
	},
};

/** Follow a session's events, reconnecting with backoff and resuming from the last seq seen. */
export function followSession(
	sessionId: string,
	since: number,
	handlers: { onFrame(frame: StreamFrame): void; onState(connected: boolean): void },
): () => void {
	let closed = false;
	let socket: WebSocket | null = null;
	let lastSeq = since;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const schedule = () => {
		if (closed) return;
		attempt++;
		clearTimeout(timer);
		timer = setTimeout(() => void connect(), Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)));
	};

	const connect = async () => {
		if (closed) return;
		try {
			// A one-shot ticket, so the token itself never travels in a URL.
			const { ticket } = await api.sessions.ticket(sessionId);
			const url = new URL(`${at("sessions", sessionId, "stream")}`, window.location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("ticket", ticket);
			if (lastSeq > 0) url.searchParams.set("since", String(lastSeq));
			const current = new WebSocket(url);
			socket = current;
			current.addEventListener("open", () => {
				attempt = 0;
				handlers.onState(true);
			});
			current.addEventListener("message", event => {
				if (typeof event.data !== "string" || event.data === "pong") return;
				const frame = JSON.parse(event.data) as StreamFrame;
				if (frame.type === "event") lastSeq = Math.max(lastSeq, frame.event.seq);
				handlers.onFrame(frame);
			});
			current.addEventListener("close", () => {
				if (socket !== current) return;
				handlers.onState(false);
				schedule();
			});
			if (closed) current.close();
		} catch {
			handlers.onState(false);
			schedule();
		}
	};

	const onVisible = () => {
		// Phones suspend sockets in the background; reconnect as soon as the page is visible again.
		if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) {
			attempt = 0;
			clearTimeout(timer);
			void connect();
		}
	};
	document.addEventListener("visibilitychange", onVisible);
	void connect();
	return () => {
		closed = true;
		clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisible);
		const current = socket;
		socket = null;
		current?.close();
	};
}
