import { afterEach, describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createHubClient, openSessionStream, type StreamFrame } from "../src/client";
import { type RunningHub, startHub } from "../src/server";
import { createOrigin, FakeAgentRuntime, RecordingNotifier, testConfig, until } from "./helpers";

let hub: RunningHub | undefined;
let temp: TempDir | undefined;

afterEach(async () => {
	await hub?.stop();
	await temp?.remove();
	hub = undefined;
	temp = undefined;
});

async function boot(overrides: Record<string, unknown> = {}) {
	temp = await TempDir.create("@omp-hub-app-");
	const config = testConfig(temp.join("data"), {
		listen: { host: "127.0.0.1", port: 1 },
		secrets: { allow: ["NPM_TOKEN"] },
		...overrides,
	});
	hub = await startHub(config, { runtime: new FakeAgentRuntime(), notifier: new RecordingNotifier(), port: 0 });
	const token = hub.bootstrapToken;
	if (!token) throw new Error("expected a bootstrap token on first start");
	return { hub, token, client: createHubClient(hub.url, token), temp };
}

/** Narrow a typed response body to its success shape. */
function unwrap<T>(value: T): Exclude<T, { error: string }> {
	// Error bodies are exactly `{ error }`; rows such as repositories carry their own `error` field.
	if (value && typeof value === "object" && "error" in value && Object.keys(value).length === 1) {
		throw new Error(String(value.error));
	}
	return value as Exclude<T, { error: string }>;
}

async function readySession(running: RunningHub, token: string, root: TempDir) {
	const client = createHubClient(running.url, token);
	const origin = await createOrigin(root.path());
	const repo = unwrap(await (await client.api.repos.$post({ json: { url: origin } })).json());
	await running.services.repos.settled(repo.id);
	const created = await client.api.sessions.$post({ json: { repoId: repo.id } });
	expect(created.status).toBe(202);
	const session = unwrap(await created.json());
	await running.services.sessions.settled(session.id);
	return session.id;
}

describe("hub API", () => {
	test("rejects requests without a valid bearer token but keeps health checks open", async () => {
		const { hub: running, token } = await boot();
		expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
		expect((await fetch(`${running.url}/api/info`)).status).toBe(401);
		expect((await fetch(`${running.url}/api/info`, { headers: { Authorization: "Bearer omph_wrong" } })).status).toBe(
			401,
		);
		const ok = await fetch(`${running.url}/api/info`, { headers: { Authorization: `Bearer ${token}` } });
		expect(await ok.json()).toMatchObject({ runtime: "host", sandboxed: false });
	});

	test("an address that keeps failing is throttled, but a valid token from it still works", async () => {
		const { hub: running, token } = await boot();
		const attempt = (value: string) =>
			fetch(`${running.url}/api/info`, { headers: { Authorization: `Bearer ${value}` } });
		for (let index = 0; index < 30; index++) expect((await attempt("omph_wrong")).status).toBe(401);
		const throttled = await attempt("omph_wrong");
		expect(throttled.status).toBe(429);
		expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect((await attempt(token)).status).toBe(200);
	});

	test("responses carry a same-origin-only content security policy", async () => {
		const { hub: running } = await boot();
		const headers = (await fetch(`${running.url}/healthz`)).headers;
		expect(headers.get("Content-Security-Policy")).toContain("script-src 'self'");
		expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("a revoked token stops working immediately", async () => {
		const { client, hub: running } = await boot();
		const minted = unwrap(await (await client.api.tokens.$post({ json: { name: "phone" } })).json());
		const phone = createHubClient(running.url, minted.token);
		expect((await phone.api.info.$get()).status).toBe(200);
		await client.api.tokens[":id"].$delete({ param: { id: minted.info.id } });
		expect((await phone.api.info.$get()).status).toBe(401);
	});

	test("invalid bodies are answered with 422 and the offending field; malformed JSON with 400", async () => {
		const { client, hub: running, token } = await boot();
		const response = await client.api.repos.$post({ json: { url: 42 } as unknown as { url: string } });
		expect(response.status).toBe(422);
		expect(((await response.json()) as { error: string }).error).toContain("url");
		const injected = await client.api.repos.$post({ json: { url: "ext::sh -c touch% /tmp/pwned" } });
		expect(injected.status).toBe(422);
		const malformed = await fetch(`${running.url}/api/repos`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: "{not json",
		});
		expect(malformed.status).toBe(400);
	});

	test("the stream replays the backlog, then follows live events, and tickets are single-use", async () => {
		const { client, hub: running, token, temp: root } = await boot();
		const id = await readySession(running, token, root);

		const frames: StreamFrame[] = [];
		const socket = await openSessionStream(running.url, token, id, { onFrame: frame => frames.push(frame) });
		await until(() => frames.some(frame => frame.type === "hello"));
		const statuses = () =>
			frames.flatMap(f => (f.type === "event" && f.event.kind === "status" ? [f.event.status] : []));
		expect(statuses()).toEqual(["provisioning", "starting", "idle"]);

		await client.api.sessions[":id"].prompt.$post({ param: { id }, json: { message: "go" } });
		await until(() => statuses().includes("busy") && statuses().at(-1) === "idle");
		socket.close();

		// Resuming from the last seen seq replays nothing old.
		const lastSeq = Math.max(...frames.flatMap(f => (f.type === "event" ? [f.event.seq] : [])));
		const resumed: StreamFrame[] = [];
		const again = await openSessionStream(running.url, token, id, { since: lastSeq, onFrame: f => resumed.push(f) });
		await until(() => resumed.some(frame => frame.type === "hello"));
		expect(resumed.filter(frame => frame.type === "event")).toEqual([]);
		again.close();

		const ticket = await (await client.api.sessions[":id"].ticket.$post({ param: { id } })).json();
		const url = `${running.url.replace("http", "ws")}/api/sessions/${id}/stream?ticket=${ticket.ticket}`;
		const first = new WebSocket(url);
		await new Promise(resolve => first.addEventListener("open", resolve));
		first.close();
		const reused = await fetch(url.replace("ws", "http"), {
			headers: { Upgrade: "websocket", Connection: "Upgrade" },
		});
		expect(reused.status).toBe(401);
	});

	test("answering a dialog through the API reaches the agent", async () => {
		const { client, hub: running, token, temp: root } = await boot();
		const runtime = running.services.runtime as FakeAgentRuntime;
		const id = await readySession(running, token, root);
		runtime.last.emit({
			type: "extension_ui_request",
			id: "q1",
			method: "select",
			title: "Pick",
			options: ["a", "b"],
		});
		await until(() => running.services.sessions.get(id).status === "waiting");

		const view = await (await client.api.sessions[":id"].$get({ param: { id } })).json();
		expect(view.pending.map(request => request.id)).toEqual(["q1"]);
		const answered = await client.api.sessions[":id"].respond.$post({
			param: { id },
			json: { requestId: "q1", answer: { value: "b" } },
		});
		expect(answered.status).toBe(200);
		expect(await runtime.last.waitFor(frame => frame.type === "extension_ui_response")).toMatchObject({
			id: "q1",
			value: "b",
		});
	});
});

describe("environments API", () => {
	test("phone-defined environments cannot widen the sandbox", async () => {
		const { client } = await boot();
		const put = (id: string, definition: Record<string, unknown>) =>
			client.api.environments[":id"].$put({ param: { id }, json: definition });

		const rejected: Array<[string, Record<string, unknown>, number]> = [
			["host-mount", { image: "alpine", mounts: [{ source: "/", target: "/host" }] }, 422],
			["host-network", { image: "alpine", network: "host" }, 422],
			["extra-args", { image: "alpine", extraArgs: ["--privileged"] }, 422],
			["retag", { image: "oh-my-pi/pi:dev", dockerfile: "FROM alpine" }, 422],
			["secret", { image: "alpine", secrets: ["AWS_SECRET_ACCESS_KEY"] }, 422],
			["flag-image", { image: "--privileged" }, 422],
			["mount-options", { image: "alpine", mounts: [{ volume: "v", target: "/x:rshared" }] }, 422],
			["default", { image: "alpine" }, 409],
		];
		for (const [id, definition, status] of rejected) {
			const response = await put(id, definition);
			expect({ id, status: response.status as number }).toEqual({ id, status });
		}

		const accepted = await put("node", {
			dockerfile: "FROM oven/bun:1.4.5-slim",
			secrets: ["NPM_TOKEN"],
			mounts: [{ volume: "bun-cache", target: "/home/agent/.bun" }],
		});
		expect(accepted.status).toBe(200);
		const listed = await (await client.api.environments.$get()).json();
		expect(listed.map(environment => [environment.id, environment.source])).toEqual([
			["default", "config"],
			["node", "api"],
		]);
	});
});
