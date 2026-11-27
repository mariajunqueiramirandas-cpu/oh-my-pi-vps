/**
 * Bearer tokens for devices and scripts, plus one-shot tickets for WebSocket
 * upgrades (browsers and WebViews cannot set `Authorization` on a WebSocket).
 *
 * Tokens are 256-bit secrets stored only as SHA-256 digests, so a leaked
 * database does not leak usable credentials.
 */
import { hashSecret, newId, newSecret } from "./ids";
import type { HubStore, TokenRow } from "./store";

export const TOKEN_PREFIX = "omph";
const TICKET_TTL_MS = 30_000;
/** `last_used_at` is informational; writing it at most once a minute keeps reads write-free. */
const TOUCH_INTERVAL_MS = 60_000;

export type TokenInfo = Omit<TokenRow, "hash">;

export class TokenService {
	readonly #store: HubStore;

	constructor(store: HubStore) {
		this.#store = store;
	}

	/** Mint a token; the plaintext is returned once and never stored. */
	create(name: string): { token: string; info: TokenInfo } {
		const token = newSecret(TOKEN_PREFIX);
		const row: TokenRow = {
			id: newId("tok"),
			name,
			hash: hashSecret(token),
			createdAt: Date.now(),
			lastUsedAt: null,
		};
		this.#store.insertToken(row);
		return { token, info: publicToken(row) };
	}

	verify(token: string): TokenInfo | null {
		if (!token.startsWith(`${TOKEN_PREFIX}_`)) return null;
		const row = this.#store.tokenByHash(hashSecret(token));
		if (!row) return null;
		const now = Date.now();
		if (row.lastUsedAt === null || now - row.lastUsedAt > TOUCH_INTERVAL_MS) this.#store.touchToken(row.id, now);
		return publicToken(row);
	}

	list(): TokenInfo[] {
		return this.#store.listTokens().map(publicToken);
	}

	revoke(id: string): boolean {
		return this.#store.deleteToken(id);
	}

	count(): number {
		return this.#store.listTokens().length;
	}
}

function publicToken(row: TokenRow): TokenInfo {
	return { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

interface Ticket {
	sessionId: string;
	tokenId: string;
	expiresAt: number;
}

/** Single-use, short-lived WebSocket tickets bound to one session. */
export class TicketService {
	readonly #tickets = new Map<string, Ticket>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	issue(sessionId: string, tokenId: string): { ticket: string; expiresAt: number } {
		this.#sweep();
		const ticket = newSecret("tkt");
		const expiresAt = this.#now() + TICKET_TTL_MS;
		this.#tickets.set(ticket, { sessionId, tokenId, expiresAt });
		return { ticket, expiresAt };
	}

	/** Consume a ticket; it is gone afterwards whether or not it matched. */
	redeem(ticket: string, sessionId: string): string | null {
		const entry = this.#tickets.get(ticket);
		this.#tickets.delete(ticket);
		if (!entry || entry.sessionId !== sessionId || entry.expiresAt < this.#now()) return null;
		return entry.tokenId;
	}

	#sweep(): void {
		const now = this.#now();
		for (const [ticket, entry] of this.#tickets) if (entry.expiresAt < now) this.#tickets.delete(ticket);
	}
}

const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 30;

/**
 * Throttles clients that keep presenting bad credentials. Tokens are 256-bit,
 * so this is not what stops guessing; it keeps a public endpoint from being
 * used to burn CPU and fill logs.
 */
export class AuthLimiter {
	readonly #failures = new Map<string, { count: number; resetAt: number }>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Seconds until `client` may try again, or 0 when it is not blocked. */
	retryAfter(client: string): number {
		const entry = this.#failures.get(client);
		if (!entry) return 0;
		const now = this.#now();
		if (entry.resetAt <= now) {
			this.#failures.delete(client);
			return 0;
		}
		return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - now) / 1000) : 0;
	}

	fail(client: string): void {
		const now = this.#now();
		const entry = this.#failures.get(client);
		if (!entry || entry.resetAt <= now) this.#failures.set(client, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
		else entry.count++;
		if (this.#failures.size > 10_000) {
			for (const [key, value] of this.#failures) if (value.resetAt <= now) this.#failures.delete(key);
		}
	}
}
