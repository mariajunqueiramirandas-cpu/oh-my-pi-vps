/** Lowercase Crockford-style alphabet: no `i`, `l`, `o`, `u`, so ids read back unambiguously. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A short random id such as `ses_4k2n9x0q7mbz`; 12 symbols carry 60 bits. */
export function newId(prefix: string, length = 12): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = `${prefix}_`;
	for (const byte of bytes) out += ALPHABET[byte & 31];
	return out;
}

/** A 256-bit bearer secret such as `omph_…`, safe to embed in URLs. */
export function newSecret(prefix: string): string {
	return `${prefix}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}

/** Hex SHA-256 of a secret; tokens are stored and looked up only by this digest. */
export function hashSecret(secret: string): string {
	return new Bun.CryptoHasher("sha256").update(secret).digest("hex");
}

/** Per-key serialization: operations on one key run in call order, other keys run freely. */
export class KeyedSerial {
	#tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, op: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const result = previous.then(op, op);
		const tail = result.catch(() => {});
		this.#tails.set(key, tail);
		void tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		return result;
	}
}
