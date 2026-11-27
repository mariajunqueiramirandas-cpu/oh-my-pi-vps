/**
 * Agents reach the embedded auth broker through the hub at `/sandbox-broker`,
 * as ordinary omp broker clients (`OMP_AUTH_BROKER_URL`), with a token issued
 * for their session and revoked when it stops.
 *
 * Only what a running agent needs passes: snapshots (access tokens and keys,
 * never refresh tokens), refresh requests, rate-limit blocks and usage. Writing
 * or disabling credentials is the hub's alone, so an agent cannot plant a
 * login of its choosing or wipe yours.
 */
import type { Context } from "hono";
import type { CredentialService } from "../credentials";

export const BROKER_PROXY_PREFIX = "/sandbox-broker";

const ALLOWED: Array<{ method: string; path: RegExp }> = [
	{ method: "GET", path: /^\/v1\/healthz$/ },
	{ method: "GET", path: /^\/v1\/snapshot$/ },
	{ method: "GET", path: /^\/v1\/snapshot\/stream$/ },
	{ method: "POST", path: /^\/v1\/credential\/\d+\/refresh$/ },
	{ method: "POST", path: /^\/v1\/credential\/\d+\/block$/ },
	{ method: "DELETE", path: /^\/v1\/credential\/\d+\/blocks?$/ },
	{ method: "GET", path: /^\/v1\/credentials\/disabled$/ },
	{ method: "GET", path: /^\/v1\/usage(\/history|\/clients)?$/ },
	{ method: "POST", path: /^\/v1\/usage\/(observed|stale)$/ },
];

/** Request headers the broker protocol uses; everything else (cookies, forwarding) stays behind. */
const FORWARD_REQUEST = ["accept", "content-type", "if-none-match", "omp-auth-broker-capabilities"];
const FORWARD_RESPONSE = ["content-type", "cache-control", "etag", "vary", "x-accel-buffering", "retry-after"];

function bearer(header: string | undefined): string {
	const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
	return match ? match[1] : "";
}

/**
 * Forward one agent request to the broker. Returns `null` when the caller is
 * not a live session, so the caller can apply its failed-credential policy.
 */
export async function proxyBrokerRequest(c: Context, credentials: CredentialService): Promise<Response | null> {
	if (!credentials.sessionForToken(bearer(c.req.header("Authorization")))) return null;
	const url = new URL(c.req.url);
	const path = url.pathname.slice(BROKER_PROXY_PREFIX.length);
	const method = c.req.method;
	if (!ALLOWED.some(rule => rule.method === method && rule.path.test(path))) {
		return c.json({ error: "agents may read and refresh credentials, not change them" }, 403);
	}
	const headers = new Headers({ Authorization: `Bearer ${credentials.broker.token}` });
	for (const name of FORWARD_REQUEST) {
		const value = c.req.header(name);
		if (value) headers.set(name, value);
	}
	const upstream = await fetch(`${credentials.broker.url}${path}${url.search}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer(),
		// An agent that disconnects (or a long poll it abandons) releases the broker request too.
		signal: c.req.raw.signal,
	});
	const responseHeaders = new Headers();
	for (const name of FORWARD_RESPONSE) {
		const value = upstream.headers.get(name);
		if (value) responseHeaders.set(name, value);
	}
	return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
