/**
 * Subscription sign-ins driven from the phone.
 *
 * omp's login flows expect someone at a terminal: open a URL, maybe type a
 * device code, maybe paste the address a browser was redirected to. Here each
 * step becomes state the phone polls and answers. Flows whose browser redirect
 * targets `localhost` on the server cannot complete on a phone by themselves,
 * so the address the phone ends on is accepted as a pasted answer.
 */
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import type { OAuthLoginIdentity } from "@oh-my-pi/pi-ai/auth/types";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { CredentialService } from "./credentials";
import { HubError } from "./errors";
import { newId } from "./ids";

export type LoginStatus = "starting" | "waiting" | "done" | "failed" | "cancelled";

export interface LoginInput {
	id: string;
	/** `paste`: the address the browser ended on; `confirm`: yes or no; `prompt`: free text. */
	kind: "paste" | "prompt" | "confirm";
	message: string;
	placeholder: string | null;
	secret: boolean;
}

export interface LoginView {
	id: string;
	providerId: string;
	providerName: string;
	status: LoginStatus;
	/** Page to open to sign in. */
	url: string | null;
	/** Provider instructions, e.g. a device code to enter. */
	instructions: string | null;
	input: LoginInput | null;
	/** Latest progress messages, oldest first. */
	progress: string[];
	error: string | null;
	/** Account the login stored, once done, when the provider names one. */
	account: string | null;
	startedAt: number;
}

const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long a finished login stays readable for the phone that started it. */
const RETAIN_MS = 10 * 60_000;
const MAX_PROGRESS = 20;
const PASTE_MESSAGE =
	"If the page you end on after approving does not load, copy its full address from the browser and paste it here.";

interface Pending {
	input: LoginInput;
	resolve(value: string): void;
	reject(error: Error): void;
}

interface Flow {
	view: LoginView;
	abort: AbortController;
	pending: Pending | null;
}

export interface LoginServiceOptions {
	/** Replaces `fetch` for the provider's HTTP calls (tests). */
	fetch?: FetchImpl;
}

/** The account a login stored, when the provider names one (key-type sign-ins such as Mistral Vibe do not). */
function describe(identity: OAuthLoginIdentity | undefined): string | null {
	if (!identity || identity.type === "api_key") return null;
	return identity.email ?? identity.orgName ?? identity.accountId ?? null;
}

export class LoginService {
	readonly #credentials: CredentialService;
	readonly #fetch: FetchImpl | undefined;
	readonly #flows = new Map<string, Flow>();

	constructor(credentials: CredentialService, options: LoginServiceOptions = {}) {
		this.#credentials = credentials;
		this.#fetch = options.fetch;
	}

	/** Start a sign-in, or return the one already running for this provider. */
	start(providerId: string): LoginView {
		const info = getOAuthProviders().find(provider => provider.id === providerId);
		if (!info) throw new HubError(404, `unknown sign-in provider ${providerId}`);
		if (!info.available) throw new HubError(422, `${info.name} sign-in is paused`);
		for (const flow of this.#flows.values()) {
			if (
				flow.view.providerId === providerId &&
				(flow.view.status === "starting" || flow.view.status === "waiting")
			) {
				return { ...flow.view };
			}
		}
		const flow: Flow = {
			view: {
				id: newId("login"),
				providerId,
				providerName: info.name,
				status: "starting",
				url: null,
				instructions: null,
				input: null,
				progress: [],
				error: null,
				account: null,
				startedAt: Date.now(),
			},
			abort: new AbortController(),
			pending: null,
		};
		this.#flows.set(flow.view.id, flow);
		void this.#run(flow);
		return { ...flow.view };
	}

	get(id: string): LoginView {
		return { ...this.#flow(id).view };
	}

	/** Answer the question a sign-in is waiting on. */
	answer(id: string, inputId: string, value: string): LoginView {
		const flow = this.#flow(id);
		const pending = flow.pending;
		if (!pending || pending.input.id !== inputId)
			throw new HubError(409, "this sign-in is not waiting for that answer");
		flow.pending = null;
		flow.view.input = null;
		pending.resolve(value);
		return { ...flow.view };
	}

	cancel(id: string): LoginView {
		const flow = this.#flow(id);
		flow.abort.abort(new Error("cancelled from the app"));
		return { ...flow.view };
	}

	async shutdown(): Promise<void> {
		for (const flow of this.#flows.values()) flow.abort.abort(new Error("hub shutting down"));
	}

	#flow(id: string): Flow {
		const flow = this.#flows.get(id);
		if (!flow) throw new HubError(404, `sign-in ${id} not found`);
		return flow;
	}

	async #run(flow: Flow): Promise<void> {
		const { view, abort } = flow;
		const timeout = setTimeout(() => abort.abort(new Error("sign-in took longer than 15 minutes")), LOGIN_TIMEOUT_MS);
		timeout.unref();
		try {
			const identity = await this.#credentials.storage.oauth.login(view.providerId, {
				signal: abort.signal,
				fetch: this.#fetch,
				onAuth: info => {
					view.url = info.url;
					view.instructions = info.instructions ?? null;
					view.status = "waiting";
				},
				onProgress: message => {
					view.progress = [...view.progress, message].slice(-MAX_PROGRESS);
				},
				onPrompt: (prompt: OAuthPrompt) =>
					this.#ask(flow, {
						kind: prompt.riskAcknowledgement ? "confirm" : "prompt",
						message: prompt.message,
						placeholder: prompt.placeholder ?? null,
						secret: prompt.secret === true,
					}),
				onManualCodeInput: signal =>
					this.#ask(
						flow,
						{ kind: "paste", message: PASTE_MESSAGE, placeholder: "http://localhost:…", secret: false },
						signal,
					),
			});
			view.status = "done";
			view.account = describe(identity);
		} catch (error) {
			view.status = abort.signal.aborted ? "cancelled" : "failed";
			view.error = abort.signal.aborted
				? String((abort.signal.reason as Error | undefined)?.message ?? "cancelled")
				: error instanceof Error
					? error.message
					: String(error);
			if (view.status === "failed")
				logger.warn("hub: sign-in failed", { provider: view.providerId, error: view.error });
		} finally {
			clearTimeout(timeout);
			flow.pending?.reject(new Error("sign-in ended"));
			flow.pending = null;
			view.input = null;
			setTimeout(() => this.#flows.delete(view.id), RETAIN_MS).unref();
		}
	}

	/** Show a question and wait for {@link answer}; withdrawn if `signal` aborts first. */
	#ask(flow: Flow, input: Omit<LoginInput, "id">, signal?: AbortSignal): Promise<string> {
		flow.pending?.reject(new Error("superseded by another question"));
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const pending: Pending = { input: { id: newId("ask", 8), ...input }, resolve, reject };
		flow.pending = pending;
		flow.view.input = pending.input;
		const withdraw = () => {
			if (flow.pending !== pending) return;
			flow.pending = null;
			flow.view.input = null;
			// Rejecting (not resolving empty) stops a callback race from asking again in a loop.
			reject(new Error("question withdrawn"));
		};
		signal?.addEventListener("abort", withdraw, { once: true });
		flow.abort.signal.addEventListener("abort", withdraw, { once: true });
		return promise;
	}
}
