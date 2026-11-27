/**
 * Typed client for the hub API, for the phone app and scripts.
 *
 * ```ts
 * const hub = createHubClient("https://vps.tailnet.ts.net:7480", token);
 * const res = await hub.api.sessions.$post({ json: { repoId, prompt: "fix the flaky test" } });
 * const session = await res.json();
 * const socket = await openSessionStream("https://vps.tailnet.ts.net:7480", token, session.id, {
 * 	onFrame: frame => render(frame),
 * });
 * ```
 */
import { hc } from "hono/client";
import type { HubRoutes, StreamFrame } from "./server/app";

export type { HubRoutes, StreamFrame } from "./server/app";
export type { HubEvent, HubEventBody } from "./events";
export type { SessionView } from "./sessions";

function trimBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

export function createHubClient(baseUrl: string, token: string) {
	return hc<HubRoutes>(trimBase(baseUrl), { headers: { Authorization: `Bearer ${token}` } });
}

export interface SessionStreamOptions {
	/** Resume after this sequence number. */
	since?: number;
	onFrame(frame: StreamFrame): void;
	onClose?(code: number, reason: string): void;
}

/** Open a session's event stream with a one-shot ticket, so the token never travels in a URL. */
export async function openSessionStream(
	baseUrl: string,
	token: string,
	sessionId: string,
	options: SessionStreamOptions,
): Promise<WebSocket> {
	const client = createHubClient(baseUrl, token);
	const response = await client.api.sessions[":id"].ticket.$post({ param: { id: sessionId } });
	if (!response.ok) throw new Error(`could not get a stream ticket (${response.status})`);
	const { ticket } = await response.json();
	const url = new URL(`${trimBase(baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/stream`);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	if (options.since) url.searchParams.set("since", String(options.since));
	const socket = new WebSocket(url);
	socket.addEventListener("message", event => {
		if (typeof event.data === "string" && event.data !== "pong")
			options.onFrame(JSON.parse(event.data) as StreamFrame);
	});
	socket.addEventListener("close", event => options.onClose?.(event.code, event.reason));
	return socket;
}
