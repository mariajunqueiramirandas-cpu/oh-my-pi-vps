import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/oauth";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createHubClient } from "../src/client";
import type { LoginView } from "../src/logins";
import { type RunningHub, startHub } from "../src/server";
import { createOrigin, FakeAgentRuntime, RecordingNotifier, testConfig, until } from "./helpers";

const CONSOLE = "https://console.mistral.ai";
const VIBE_KEY = "mistral-vibe-key-0123456789";

/** Mistral's console as the Vibe CLI sees it: start, one pending poll, approval, key exchange. */
function fakeMistralConsole() {
	let polls = 0;
	const calls: string[] = [];
	const respond = (body: unknown) =>
		new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === `${CONSOLE}/api/vibe/sign-in`) {
			return respond({
				process_id: "p1",
				sign_in_url: `${CONSOLE}/vibe/approve/p1`,
				poll_url: `${CONSOLE}/api/vibe/sign-in/p1`,
				expires_at: new Date(Date.now() + 600_000).toISOString(),
			});
		}
		if (url === `${CONSOLE}/api/vibe/sign-in/p1`) {
			return respond(++polls < 2 ? { status: "pending" } : { status: "completed", exchange_token: "xt" });
		}
		if (url === `${CONSOLE}/api/vibe/sign-in/p1/exchange`) {
			const body = JSON.parse(String(init?.body)) as { exchange_token?: string; code_verifier?: string };
			if (body.exchange_token !== "xt" || !body.code_verifier) return new Response("{}", { status: 400 });
			return respond({ api_key: VIBE_KEY });
		}
		return new Response("{}", { status: 404 });
	};
	return { fetch: fetchImpl as typeof fetch, calls };
}

/** A callback-style subscription: the phone pastes the localhost address the browser ended on. */
const PASTE_PROVIDER = "hub-test-subscription";
beforeAll(() => {
	registerOAuthProvider({
		id: PASTE_PROVIDER,
		name: "Test subscription",
		async login(callbacks) {
			callbacks.onAuth({ url: "https://auth.example.com/authorize?state=s1", instructions: "Approve the hub" });
			const pasted = await (callbacks.onManualCodeInput?.() ?? callbacks.onPrompt({ message: "paste" }));
			const code = new URL(pasted).searchParams.get("code");
			if (!code) throw new Error("no code in the pasted address");
			return {
				access: `access-${code}`,
				refresh: "refresh-secret-never-leaves-the-hub",
				expires: Date.now() + 3_600_000,
				email: "me@example.com",
			};
		},
		async refreshToken(credentials) {
			return { ...credentials, expires: Date.now() + 3_600_000 };
		},
	});
});
afterAll(() => unregisterOAuthProvider(PASTE_PROVIDER));

let hub: RunningHub | undefined;
let temp: TempDir | undefined;

afterEach(async () => {
	await hub?.stop();
	await temp?.remove();
	hub = undefined;
	temp = undefined;
});

async function boot(loginFetch?: typeof fetch) {
	temp = await TempDir.create("@omp-hub-subscriptions-");
	const config = testConfig(temp.join("data"), { listen: { host: "127.0.0.1", port: 1 } });
	const runtime = new FakeAgentRuntime();
	hub = await startHub(config, { runtime, notifier: new RecordingNotifier(), port: 0, loginFetch });
	const token = hub.bootstrapToken;
	if (!token) throw new Error("expected a bootstrap token");
	return { hub, runtime, temp, token, client: createHubClient(hub.url, token) };
}

async function login(client: ReturnType<typeof createHubClient>, id: string): Promise<LoginView> {
	return (await (await client.api.logins[":id"].$get({ param: { id } })).json()) as LoginView;
}

async function startSession(running: RunningHub, root: TempDir): Promise<string> {
	const repo = running.services.repos.add(await createOrigin(root.path()));
	await running.services.repos.settled(repo.id);
	const session = running.services.sessions.create({ repoId: repo.id });
	await running.services.sessions.settled(session.id);
	return session.id;
}

describe("subscription sign-in", () => {
	test("Mistral Vibe: approve on the phone, and the minted key reaches new sessions through the broker", async () => {
		const mistral = fakeMistralConsole();
		const { hub: running, runtime, temp: root, client } = await boot(mistral.fetch);
		const started = (await (await client.api.logins.$post({ json: { providerId: "mistral" } })).json()) as LoginView;
		expect(started.providerName).toBe("Mistral");

		const current = () => running.services.logins.get(started.id);
		await until(() => current().url !== null || current().status === "failed", 10_000);
		let view = await login(client, started.id);
		expect(view.url).toBe(`${CONSOLE}/vibe/approve/p1`);
		await until(() => current().status !== "waiting", 15_000);
		view = await login(client, started.id);
		// A Vibe sign-in mints a key; there is no account name to show.
		expect(view).toMatchObject({ status: "done", account: null, error: null });

		const providers = (await (await client.api.subscriptions.$get()).json()) as Array<{
			id: string;
			accounts: unknown[];
		}>;
		expect(providers.find(provider => provider.id === "mistral")?.accounts).toEqual([
			expect.objectContaining({ kind: "api_key", label: "Key from sign-in, ending 6789" }),
		]);
		expect(JSON.stringify(providers)).not.toContain(VIBE_KEY);

		// A session started now is a broker client; its token reads the key through the hub.
		const id = await startSession(running, root);
		const env = runtime.specs.at(-1)?.env ?? {};
		expect(env.OMP_AUTH_BROKER_URL).toBe(`${running.url}/sandbox-broker`);
		expect(env.MISTRAL_API_KEY).toBeUndefined();
		const snapshot = await fetch(`${env.OMP_AUTH_BROKER_URL}/v1/snapshot`, {
			headers: { Authorization: `Bearer ${env.OMP_AUTH_BROKER_TOKEN}` },
		});
		expect(snapshot.status).toBe(200);
		expect(await snapshot.text()).toContain(VIBE_KEY);
		expect(running.services.sessions.get(id).live).toBe(true);
	}, 30_000); // Vibe polls every 3 s, like the Vibe CLI.

	test("a localhost redirect pasted from the phone completes an OAuth login, and refresh tokens stay in the hub", async () => {
		const { hub: running, runtime, temp: root, client } = await boot();
		const started = (await (
			await client.api.logins.$post({ json: { providerId: PASTE_PROVIDER } })
		).json()) as LoginView;
		await until(() => running.services.logins.get(started.id).input !== null);
		const waiting = await login(client, started.id);
		expect(waiting).toMatchObject({ status: "waiting", url: "https://auth.example.com/authorize?state=s1" });
		expect(waiting.input?.kind).toBe("paste");

		const answered = await client.api.logins[":id"].input.$post({
			param: { id: started.id },
			json: { inputId: waiting.input?.id ?? "", value: "http://localhost:54545/callback?code=c0de&state=s1" },
		});
		expect(answered.status).toBe(200);
		await until(() => running.services.logins.get(started.id).status === "done");
		expect((await login(client, started.id)).account).toBe("me@example.com");

		await startSession(running, root);
		const env = runtime.specs.at(-1)?.env ?? {};
		const snapshot = await (
			await fetch(`${env.OMP_AUTH_BROKER_URL}/v1/snapshot`, {
				headers: { Authorization: `Bearer ${env.OMP_AUTH_BROKER_TOKEN}` },
			})
		).text();
		expect(snapshot).toContain("access-c0de");
		expect(snapshot).not.toContain("refresh-secret-never-leaves-the-hub");
	});

	test("cancelling withdraws the question and ends the sign-in", async () => {
		const { hub: running, client } = await boot();
		const started = (await (
			await client.api.logins.$post({ json: { providerId: PASTE_PROVIDER } })
		).json()) as LoginView;
		await until(() => running.services.logins.get(started.id).input !== null);
		await client.api.logins[":id"].$delete({ param: { id: started.id } });
		await until(() => running.services.logins.get(started.id).status === "cancelled");
		expect(await login(client, started.id)).toMatchObject({ status: "cancelled", input: null });
		expect(running.services.credentials.hasProvider(PASTE_PROVIDER)).toBe(false);
	});
});

describe("agent access to the broker", () => {
	test("agents may read and refresh, not write; their token dies with the session", async () => {
		const { hub: running, runtime, temp: root, client } = await boot();
		const started = (await (
			await client.api.logins.$post({ json: { providerId: PASTE_PROVIDER } })
		).json()) as LoginView;
		await until(() => running.services.logins.get(started.id).input !== null);
		const inputId = running.services.logins.get(started.id).input?.id ?? "";
		running.services.logins.answer(started.id, inputId, "http://localhost/cb?code=x");
		await until(() => running.services.logins.get(started.id).status === "done");

		const id = await startSession(running, root);
		const env = runtime.specs.at(-1)?.env ?? {};
		const call = (method: string, path: string, token = env.OMP_AUTH_BROKER_TOKEN ?? "") =>
			fetch(`${env.OMP_AUTH_BROKER_URL}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: method === "GET" ? undefined : "{}",
			});
		expect((await call("GET", "/v1/snapshot")).status).toBe(200);
		expect((await call("POST", "/v1/credential")).status).toBe(403);
		expect((await call("POST", "/v1/credential/1/disable")).status).toBe(403);
		expect((await call("GET", "/v1/snapshot", "omphs_not-a-session")).status).toBe(401);

		await running.services.sessions.stop(id);
		expect((await call("GET", "/v1/snapshot")).status).toBe(401);
		// The hub's own API token is not a broker token either.
		expect((await client.api.subscriptions.$get()).status).toBe(200);
	});

	test("sessions are not connected to the broker until a subscription is signed in", async () => {
		const { hub: running, runtime, temp: root } = await boot();
		await startSession(running, root);
		expect(runtime.specs.at(-1)?.env.OMP_AUTH_BROKER_URL).toBeUndefined();
	});
});
