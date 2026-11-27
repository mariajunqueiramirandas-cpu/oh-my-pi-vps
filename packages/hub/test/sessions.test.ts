import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { EnvironmentService } from "../src/environments";
import { HubError } from "../src/errors";
import { RepoService } from "../src/repos";
import { ProfileService, SecretService } from "../src/profile";
import { SessionManager } from "../src/sessions";
import { HubStore } from "../src/store";
import { createOrigin, FakeAgentRuntime, RecordingNotifier, testConfig, until } from "./helpers";

async function harness(temp: TempDir, overrides: Record<string, unknown> = {}) {
	const config = testConfig(temp.join("data"), overrides);
	const store = new HubStore(path.join(temp.path(), "hub.db"));
	const runtime = new FakeAgentRuntime();
	const notifier = new RecordingNotifier();
	const repos = new RepoService(store, config.dataDir, 60_000);
	const environments = new EnvironmentService(config, store, runtime);
	const profile = new ProfileService(store, config.dataDir);
	const secrets = new SecretService(store);
	const sessions = new SessionManager({ config, store, runtime, repos, environments, notifier, profile, secrets });
	const origin = await createOrigin(temp.path());
	const repo = repos.add(origin);
	await repos.settled(repo.id);
	const createSession = async (input: { title?: string } = {}) => {
		const view = sessions.create({ repoId: repo.id, ...input });
		await sessions.settled(view.id);
		return view.id;
	};
	const close = async () => {
		await sessions.shutdown();
		store.close();
	};
	return { config, store, runtime, notifier, repos, sessions, origin, repo, createSession, close, profile, secrets };
}

function statuses(sessions: SessionManager, id: string): string[] {
	return sessions
		.events(id)
		.since(0)
		.events.flatMap(event => (event.kind === "status" ? [event.status] : []));
}

describe("session lifecycle", () => {
	test("a prompt runs a turn, returns the session to idle, and notifies that it finished", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, notifier, createSession, close } = await harness(temp);
		const id = await createSession({ title: "Fix login" });
		expect(sessions.get(id).status).toBe("idle");
		expect(sessions.get(id).branch).toStartWith("omp/fix-login-");

		await sessions.prompt(id, { message: "fix it" });
		const finished = await notifier.waitFor(n => n.title.startsWith("Finished"));

		expect(finished.title).toBe("Finished: Fix login");
		expect(sessions.get(id).status).toBe("idle");
		expect(statuses(sessions, id)).toEqual(["provisioning", "starting", "idle", "busy", "idle"]);
		expect(await runtime.last.waitFor(frame => frame.type === "prompt")).toMatchObject({ message: "fix it" });
		await close();
	});

	test("a dialog puts the session in waiting until the phone answers it", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, notifier, createSession, close } = await harness(temp);
		const id = await createSession();
		runtime.last.holdPrompts = true;
		await sessions.prompt(id, { message: "deploy" });
		await until(() => sessions.get(id).status === "busy");

		runtime.last.emit({
			type: "extension_ui_request",
			id: "dlg",
			method: "confirm",
			title: "Push?",
			message: "to main",
		});
		await until(() => sessions.get(id).status === "waiting");
		expect(sessions.get(id).pending.map(request => request.id)).toEqual(["dlg"]);
		expect((await notifier.waitFor(n => n.title.startsWith("Needs your input"))).message).toBe("Push?: to main");

		sessions.respond(id, "dlg", { confirmed: true });
		expect(await runtime.last.waitFor(frame => frame.type === "extension_ui_response")).toEqual({
			type: "extension_ui_response",
			id: "dlg",
			confirmed: true,
		});
		expect(sessions.get(id).status).toBe("busy");
		expect(() => sessions.respond(id, "dlg", { confirmed: true })).toThrow(HubError);

		runtime.last.finishTurn();
		await until(() => sessions.get(id).status === "idle");
		await close();
	});

	test("after the agent crashes, the next prompt restarts it continuing the same transcript", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, notifier, createSession, close } = await harness(temp);
		const id = await createSession();
		expect(runtime.last.argv).not.toContain("--continue");

		runtime.last.exit(137);
		await until(() => sessions.get(id).status === "stopped");
		expect(sessions.get(id).error).toContain("code 137");
		expect(sessions.get(id).live).toBe(false);
		await notifier.waitFor(n => n.title.startsWith("Session stopped"));

		await sessions.prompt(id, { message: "carry on" });
		expect(runtime.agents).toHaveLength(2);
		expect(runtime.last.argv).toContain("--continue");
		// The dead agent's sandbox may still be removed under its name; a reused name would collide or kill the new one.
		expect(runtime.specs[0].name).not.toBe(runtime.specs[1].name);
		await until(() => sessions.get(id).status === "idle");
		await close();
	});

	test("an idle session stops itself and resumes on the next prompt", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, createSession, close } = await harness(temp, {
			sessions: { idleStopMinutes: 0.002 },
		});
		const id = await createSession();
		await sessions.prompt(id, { message: "one" });
		await until(() => sessions.get(id).status === "stopped");
		expect(sessions.get(id).error).toBeNull();

		await sessions.prompt(id, { message: "two" });
		expect(runtime.agents).toHaveLength(2);
		await close();
	});

	test("starting past maxRunning stops the longest-idle session, or refuses when none is idle", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, createSession, close } = await harness(temp, {
			sessions: { idleStopMinutes: 0, maxRunning: 1 },
		});
		const first = await createSession();
		const second = await createSession();
		expect(sessions.get(first).status).toBe("stopped");
		expect(sessions.get(second).status).toBe("idle");

		runtime.last.holdPrompts = true;
		await sessions.prompt(second, { message: "busy" });
		await until(() => sessions.get(second).status === "busy");
		await expect(sessions.start(first)).rejects.toMatchObject({ status: 429 });
		await close();
	});

	test("a restarted hub marks interrupted sessions stopped and half-provisioned ones failed", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, store, createSession, config, repos, repo, close } = await harness(temp);
		const running = await createSession();
		const provisioning = sessions.create({ repoId: repo.id }).id;
		await sessions.settled(provisioning);
		store.updateSession(provisioning, { status: "provisioning", baseCommit: null });

		const restarted = new SessionManager({
			config,
			store,
			runtime: new FakeAgentRuntime(),
			repos,
			environments: new EnvironmentService(config, store, new FakeAgentRuntime()),
			notifier: new RecordingNotifier(),
			profile: new ProfileService(store, config.dataDir),
			secrets: new SecretService(store),
		});
		await restarted.recover();
		expect(restarted.get(running).status).toBe("stopped");
		expect(restarted.get(provisioning).status).toBe("failed");
		await expect(restarted.start(provisioning)).rejects.toMatchObject({ status: 409 });
		await close();
	});
});

describe("event stream", () => {
	test("streaming updates are coalesced to the latest message without deltas, in order", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, runtime, createSession, close } = await harness(temp);
		const id = await createSession();
		runtime.last.holdPrompts = true;
		await sessions.prompt(id, { message: "write" });
		const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
		runtime.last.emit({ type: "message_start", message: message("") });
		for (let index = 1; index <= 50; index++) {
			runtime.last.emit({
				type: "message_update",
				message: message("x".repeat(index)),
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			});
		}
		runtime.last.emit({ type: "message_end", message: message("x".repeat(50)) });
		await until(() =>
			sessions
				.events(id)
				.since(0)
				.events.some(event => event.kind === "agent" && event.event.type === "message_end"),
		);

		const agentEvents = sessions
			.events(id)
			.since(0)
			.events.flatMap(event => (event.kind === "agent" ? [event.event] : []));
		const types = agentEvents.map(event => event.type).filter(type => type.startsWith("message_"));
		const updates = agentEvents.filter(event => event.type === "message_update");
		expect(updates.length).toBeLessThanOrEqual(2);
		expect(types.at(0)).toBe("message_start");
		expect(types.at(-1)).toBe("message_end");
		expect(types.at(-2)).toBe("message_update");
		expect(updates.at(-1) as unknown).toEqual({ type: "message_update", message: message("x".repeat(50)) });
		await close();
	});
});

describe("session changes", () => {
	test("diff reports uncommitted and committed work since the base commit", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, createSession, config, close } = await harness(temp);
		const id = await createSession();
		const work = path.join(config.dataDir, "sessions", id, "work");
		await Bun.write(path.join(work, "notes.txt"), "hello\n");
		await Bun.write(path.join(work, "README.md"), "# changed\n");

		const { status, diff } = await sessions.diff(id);
		expect(status).toContain("?? notes.txt");
		expect(status).toContain(" M README.md");
		expect(diff).toContain("+# changed");
		await close();
	});

	test("publish commits pending work, pushes the branch, and refuses to clobber a moved remote", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, createSession, config, origin, close } = await harness(temp);
		const id = await createSession();
		const { branch } = sessions.get(id);
		const work = path.join(config.dataDir, "sessions", id, "work");
		await Bun.write(path.join(work, "feature.txt"), "v1\n");

		const first = await sessions.publish(id, { message: "add feature" });
		expect((await $`git -C ${origin} rev-parse refs/heads/${branch}`.text()).trim()).toBe(first.sha);
		expect(await $`git -C ${origin} show ${branch}:feature.txt`.text()).toBe("v1\n");
		expect((await $`git -C ${origin} log -1 --format=%s ${branch}`.text()).trim()).toBe("add feature");

		// Someone else pushes to the session branch.
		const other = temp.join("other");
		await $`git clone --quiet --branch ${branch} ${origin} ${other}`.quiet();
		await Bun.write(path.join(other, "theirs.txt"), "x\n");
		await $`git -C ${other} add theirs.txt`.quiet();
		await $`git -C ${other} -c user.name=o -c user.email=o@o commit --quiet -m theirs`.quiet();
		await $`git -C ${other} push --quiet origin ${branch}`.quiet();

		await Bun.write(path.join(work, "feature.txt"), "v2\n");
		await expect(sessions.publish(id, { message: "v2" })).rejects.toMatchObject({ status: 409 });
		const forced = await sessions.publish(id, { force: true });
		expect(await $`git -C ${origin} show ${branch}:feature.txt`.text()).toBe("v2\n");
		expect((await $`git -C ${origin} rev-parse refs/heads/${branch}`.text()).trim()).toBe(forced.sha);
		await close();
	});

	test("publishing a branch with no commits beyond the base is a conflict, not a push", async () => {
		await using temp = await TempDir.create("@omp-hub-sessions-");
		const { sessions, createSession, origin, close } = await harness(temp);
		const id = await createSession();
		await expect(sessions.publish(id)).rejects.toMatchObject({ status: 409 });
		const remoteBranches = await $`git -C ${origin} branch --list ${sessions.get(id).branch}`.text();
		expect(remoteBranches.trim()).toBe("");
		await close();
	});
});
