/**
 * Subscription credentials (Claude Pro/Max, ChatGPT, Copilot, Mistral Vibe, …).
 *
 * The hub embeds omp's own auth broker over a private credential store. Logins
 * run in the hub (see `logins.ts`); agents reach the broker through the hub
 * with a per-session token (see `server/broker-proxy.ts`). The broker is the
 * only holder of refresh tokens: OAuth refresh tokens rotate, so copies in
 * several sandboxes would invalidate each other, and an agent must never be
 * able to keep a login alive on its own.
 */
import * as path from "node:path";
import { type AuthStorage, getOAuthProviders, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { createBrokerAuthStorage } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { VERSION } from "@oh-my-pi/pi-utils";
import { HubError } from "./errors";
import { hashSecret, newSecret } from "./ids";

export interface SubscriptionAccount {
	credentialId: number;
	kind: "oauth" | "api_key";
	/** Who the login belongs to, as far as the provider said. */
	label: string;
	disabled: boolean;
}

export interface SubscriptionProvider {
	/** Login id, e.g. `anthropic` or `openai-codex-device`. */
	id: string;
	name: string;
	/** Model provider the credentials authenticate, e.g. `openai-codex`. */
	provider: string;
	available: boolean;
	accounts: SubscriptionAccount[];
}

export class CredentialService {
	readonly storage: AuthStorage;
	readonly #broker: AuthBrokerServerHandle;
	readonly #brokerToken: string;
	/** Session tokens by digest; a token dies with the agent it was issued to. */
	readonly #sessionTokens = new Map<string, string>();
	readonly #tokenBySession = new Map<string, string>();

	private constructor(storage: AuthStorage, broker: AuthBrokerServerHandle, brokerToken: string) {
		this.storage = storage;
		this.#broker = broker;
		this.#brokerToken = brokerToken;
	}

	static async open(dataDir: string): Promise<CredentialService> {
		const store = await SqliteAuthCredentialStore.open(path.join(dataDir, "credentials", "agent.db"));
		const storage = createBrokerAuthStorage(store);
		await storage.credentials.reload();
		const brokerToken = newSecret("brk");
		// Loopback only: agents never talk to the broker directly, only through the hub.
		const broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [brokerToken], version: VERSION });
		return new CredentialService(storage, broker, brokerToken);
	}

	/** The embedded broker and the bearer the hub uses with it. */
	get broker(): { url: string; token: string } {
		return { url: this.#broker.url, token: this.#brokerToken };
	}

	providers(): SubscriptionProvider[] {
		return getOAuthProviders()
			.map(info => {
				const provider = info.storeCredentialsAs ?? info.id;
				return {
					id: info.id,
					name: info.name,
					provider,
					available: info.available,
					accounts: this.accounts(provider),
				};
			})
			.sort((a, b) => Number(b.accounts.length > 0) - Number(a.accounts.length > 0) || a.name.localeCompare(b.name));
	}

	accounts(provider: string): SubscriptionAccount[] {
		return this.storage.credentials.list(provider).map(row => {
			const credential = row.credential;
			const label =
				credential.type === "oauth"
					? (credential.email ?? credential.orgName ?? credential.accountId ?? "Signed in")
					: credential.source === "login"
						? `Key from sign-in, ending ${credential.key.slice(-4)}`
						: `Key ending ${credential.key.slice(-4)}`;
			return { credentialId: row.id, kind: credential.type, label, disabled: row.disabledCause !== null };
		});
	}

	/** Some provider has a usable credential, so agents should be connected to the broker. */
	hasAny(): boolean {
		return getOAuthProviders().some(info => this.hasProvider(info.storeCredentialsAs ?? info.id));
	}

	hasProvider(provider: string): boolean {
		return this.storage.credentials.list(provider).some(row => row.disabledCause === null);
	}

	async remove(provider: string, credentialId: number): Promise<void> {
		if (!(await this.storage.credentials.removeById(provider, credentialId))) {
			throw new HubError(404, `no ${provider} account ${credentialId}`);
		}
	}

	/** A broker token for one agent start; issuing again replaces the previous one. */
	issueSessionToken(sessionId: string): string {
		this.revokeSession(sessionId);
		const token = newSecret("omphs");
		const digest = hashSecret(token);
		this.#sessionTokens.set(digest, sessionId);
		this.#tokenBySession.set(sessionId, digest);
		return token;
	}

	revokeSession(sessionId: string): void {
		const digest = this.#tokenBySession.get(sessionId);
		if (digest) this.#sessionTokens.delete(digest);
		this.#tokenBySession.delete(sessionId);
	}

	sessionForToken(token: string): string | null {
		return this.#sessionTokens.get(hashSecret(token)) ?? null;
	}

	async close(): Promise<void> {
		await this.#broker.close();
		this.storage.close();
	}
}
