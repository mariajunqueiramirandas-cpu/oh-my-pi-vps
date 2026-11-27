import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { createHubClient } from "../src/client";
import { type RunningHub, startHub } from "../src/server";
import { createOrigin, FakeAgentRuntime, RecordingNotifier, testConfig } from "./helpers";

let hub: RunningHub | undefined;
let temp: TempDir | undefined;

afterEach(async () => {
	await hub?.stop();
	await temp?.remove();
	hub = undefined;
	temp = undefined;
});

async function boot() {
	temp = await TempDir.create("@omp-hub-profile-");
	const config = testConfig(temp.join("data"), { listen: { host: "127.0.0.1", port: 1 } });
	const runtime = new FakeAgentRuntime();
	hub = await startHub(config, { runtime, notifier: new RecordingNotifier(), port: 0 });
	const token = hub.bootstrapToken;
	if (!token) throw new Error("expected a bootstrap token");
	return { hub, runtime, temp, client: createHubClient(hub.url, token) };
}

async function startSession(running: RunningHub, root: TempDir): Promise<string> {
	const repo = running.services.repos.add(await createOrigin(root.path()));
	await running.services.repos.settled(repo.id);
	const session = running.services.sessions.create({ repoId: repo.id });
	await running.services.sessions.settled(session.id);
	return session.id;
}

/** Run the exact launch command the hub produced, swapping omp for a listing of what it would see. */
async function launchAndInspect(runtime: FakeAgentRuntime, home: string): Promise<string> {
	const argv = runtime.last.argv;
	const env = runtime.specs.at(-1)?.env ?? {};
	const launcher = argv.slice(0, 4); // sh -c <script> omp-hub-launch
	const inspect = [
		"sh",
		"-c",
		'cd "$HOME/.omp/agent" && find . -type f | sort && echo --- && cat AGENTS.md rules/*.md',
	];
	const result = await $`${[...launcher, ...inspect]}`
		.env({ ...env, HOME: home, PATH: process.env.PATH ?? "" })
		.quiet();
	return result.text();
}

describe("agent profile", () => {
	test("a saved profile reaches the next agent: files, model selection and stored keys", async () => {
		const { hub: running, runtime, temp: root, client } = await boot();
		const saved = await client.api.profile.$put({
			json: {
				defaultModel: "anthropic/claude-sonnet-5-5",
				thinkingLevel: "medium",
				instructions: "Always write tests first.",
				stickyRules: "Never push to main.",
				rules: [{ name: "go-style", description: "Go code style", globs: ["**/*.go"], body: "Use gofmt." }],
				settings: "modelRoles:\n  smol: anthropic/claude-haiku-4-5\n",
			},
		});
		expect(saved.status).toBe(200);
		expect(
			(
				await client.api.secrets[":name"].$put({
					param: { name: "ANTHROPIC_API_KEY" },
					json: { value: "sk-ant-12345678" },
				})
			).status,
		).toBe(200);

		const id = await startSession(running, root);
		const spec = runtime.specs.at(-1);
		expect(spec?.env.ANTHROPIC_API_KEY).toBe("sk-ant-12345678");
		const configIndex = runtime.last.argv.indexOf("--config");
		const overlay = await Bun.file(runtime.last.argv[configIndex + 1]).json();
		expect(overlay).toEqual({
			modelRoles: { smol: "anthropic/claude-haiku-4-5", default: "anthropic/claude-sonnet-5-5" },
			defaultThinkingLevel: "medium",
		});

		const home = path.join(running.services.config.dataDir, "sessions", id, "home");
		const seen = await launchAndInspect(runtime, home);
		expect(seen).toContain("./AGENTS.md\n./APPEND_SYSTEM.md\n./RULES.md\n./rules/go-style.md");
		expect(seen).toContain("Always write tests first.");
		expect(seen).toContain('---\ndescription: "Go code style"\nglobs: ["**/*.go"]\n---\nUse gofmt.');
		expect(await Bun.file(path.join(home, ".omp/agent/RULES.md")).text()).toBe("Never push to main.");
	});

	test("a rule removed in settings is gone from the agent's next start", async () => {
		const { hub: running, runtime, temp: root, client } = await boot();
		await client.api.profile.$put({ json: { rules: [{ name: "old", body: "x" }] } });
		const id = await startSession(running, root);
		const home = path.join(running.services.config.dataDir, "sessions", id, "home");
		expect(await launchAndInspect(runtime, home)).toContain("./rules/old.md");

		await client.api.profile.$put({ json: { rules: [{ name: "new", body: "y" }] } });
		await running.services.sessions.stop(id);
		await running.services.sessions.start(id);
		const seen = await launchAndInspect(runtime, home);
		expect(seen).toContain("./rules/new.md");
		expect(seen).not.toContain("old.md");
	});

	test("extension packages shipped in the image are loaded by omp", async () => {
		const { hub: running, runtime, temp: root } = await boot();
		const id = await startSession(running, root);
		const home = path.join(running.services.config.dataDir, "sessions", id, "home");
		const image = root.join("image-extensions");
		await Bun.write(path.join(image, "rea", ".mcp.json"), "{}");
		await Bun.write(path.join(image, "re tools", "skills", "x", "SKILL.md"), "x");
		await Bun.write(path.join(image, "README.txt"), "not a package");
		const launcher = runtime.last.argv.slice(0, 4);
		const omp = ["sh", "-c", 'printf "%s\\n" "$@"', "omp", "--mode", "rpc"];
		const run = (env: Record<string, string>) =>
			$`${[...launcher, ...omp]}`
				.env({ ...runtime.specs.at(-1)?.env, ...env, HOME: home, PATH: process.env.PATH ?? "" })
				.quiet();

		expect((await run({ OMP_HUB_EXTENSIONS_DIR: image })).text()).toBe(
			`--mode\nrpc\n--extension\n${image}/re tools\n--extension\n${image}/rea\n`,
		);
		// An image without the directory starts omp with its arguments untouched.
		expect((await run({ OMP_HUB_EXTENSIONS_DIR: root.join("absent") })).text()).toBe("--mode\nrpc\n");
	});

	test("invalid settings are rejected before anything reaches a sandbox", async () => {
		const { client } = await boot();
		const put = (json: Record<string, unknown>) => client.api.profile.$put({ json });
		expect((await put({ settings: "a: [unclosed" })).status).toBe(422);
		expect((await put({ settings: "- just\n- a list\n" })).status).toBe(422);
		expect((await put({ defaultModel: "no-slash" })).status).toBe(422);
		expect((await put({ thinkingLevel: "ludicrous" })).status).toBe(422);
		expect(
			(
				await put({
					rules: [
						{ name: "a", body: "" },
						{ name: "a", body: "" },
					],
				})
			).status,
		).toBe(422);
		expect((await put({ rules: [{ name: "../escape", body: "" }] })).status).toBe(422);
		expect((await (await client.api.profile.$get()).json()).rules).toEqual([]);
	});
});

describe("secrets and catalog", () => {
	test("keys are write-only and mark their provider as configured", async () => {
		const { client } = await boot();
		const providers = async () =>
			(await (await client.api.catalog.providers.$get()).json()) as Array<{
				id: string;
				envVars: string[];
				configured: boolean;
			}>;
		const anthropic = (await providers()).find(provider => provider.id === "anthropic");
		expect(anthropic).toMatchObject({ envVars: ["ANTHROPIC_API_KEY"], configured: false });

		await client.api.secrets[":name"].$put({
			param: { name: "ANTHROPIC_API_KEY" },
			json: { value: "sk-ant-abcdefgh1234" },
		});
		const listed = await (await client.api.secrets.$get()).json();
		expect(listed).toEqual([expect.objectContaining({ name: "ANTHROPIC_API_KEY", preview: "…1234" })]);
		expect(JSON.stringify(listed)).not.toContain("abcdefgh");
		expect((await providers())[0]).toMatchObject({ id: "anthropic", configured: true });

		const models = await (
			await client.api.catalog.providers[":id"].models.$get({ param: { id: "anthropic" } })
		).json();
		expect(Array.isArray(models) && models.length).toBeGreaterThan(0);
		expect((await client.api.catalog.providers[":id"].models.$get({ param: { id: "nope" } })).status).toBe(404);
	});

	test("reserved or multi-line values are refused", async () => {
		const { client } = await boot();
		const put = (name: string, value: string) =>
			client.api.secrets[":name"].$put({ param: { name }, json: { value } });
		expect((await put("PATH", "/evil")).status).toBe(422);
		expect((await put("OMP_HUB_PROFILE", "/x")).status).toBe(422);
		expect((await put("TOKEN", "a\nLD_PRELOAD=/x.so")).status).toBe(422);
		expect((await put("bad-name", "x")).status).toBe(422);
	});
});
