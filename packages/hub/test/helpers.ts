import * as path from "node:path";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { $ } from "bun";
import { resolveConfig, type ResolvedHubConfig } from "../src/config";
import type { Notification, Notifier } from "../src/notify";
import { HostRuntime, type SandboxSpec } from "../src/sandbox";

type Frame = Record<string, unknown> & { type: string; id?: string };

/**
 * A scripted omp RPC agent. It acknowledges every command, and a `prompt`
 * plays one agent turn (`agent_start` … `agent_end`, `prompt_result`,
 * `session_settled`) unless `holdPrompts` keeps the turn open for the test.
 */
export class FakeAgent {
	readonly argv: string[];
	readonly frames: Frame[] = [];
	holdPrompts = false;
	readonly #encoder = new TextEncoder();
	readonly #decoder = new TextDecoder();
	readonly #exited = Promise.withResolvers<number>();
	readonly #waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
	#output!: ReadableStreamDefaultController<Uint8Array>;
	#closed = false;

	constructor(argv: string[]) {
		this.argv = argv;
	}

	process(): RpcAgentProcess {
		return {
			stdin: { write: data => this.#onInput(data) },
			stdout: new ReadableStream<Uint8Array>({
				start: controller => {
					this.#output = controller;
					this.emit({ type: "ready" });
				},
			}),
			peekStderr: () => "fake agent stderr",
			kill: () => this.exit(0),
			exited: this.#exited.promise,
		};
	}

	/** Messages the agent finished, returned by `get_messages` like a real transcript. */
	readonly transcript: unknown[] = [];

	emit(frame: Record<string, unknown>): void {
		if (frame.type === "message_end") this.transcript.push(frame.message);
		if (!this.#closed) this.#output.enqueue(this.#encoder.encode(`${JSON.stringify(frame)}\n`));
	}

	/** Simulate the agent process dying. */
	exit(code: number): void {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.#output.close();
		} catch {
			// Already closed by the reader.
		}
		this.#exited.resolve(code);
	}

	waitFor(match: (frame: Frame) => boolean): Promise<Frame> {
		const seen = this.frames.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.push({ match, resolve });
		return promise;
	}

	/** Finish a held prompt turn. */
	finishTurn(text = "done"): void {
		this.emit({ type: "agent_end", messages: [] });
		this.emit({ type: "prompt_result", id: "p", agentInvoked: true, status: "completed" });
		this.#lastText = text;
		this.emit({ type: "session_settled" });
	}

	#lastText: string | null = null;

	#onInput(data: string | Uint8Array): number {
		const text = typeof data === "string" ? data : this.#decoder.decode(data);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line) as Frame;
			this.frames.push(frame);
			for (const waiter of this.#waiters.splice(0)) {
				if (waiter.match(frame)) waiter.resolve(frame);
				else this.#waiters.push(waiter);
			}
			queueMicrotask(() => this.#respond(frame));
		}
		return text.length;
	}

	#respond(frame: Frame): void {
		if (frame.type === "extension_ui_response" || !frame.id) return;
		const data: Record<string, unknown> =
			{
				set_ask_dialog: { enabled: frame.enabled },
				set_subagent_subscription: { level: frame.level },
				get_last_assistant_text: { text: this.#lastText },
				get_messages: { messages: this.transcript },
				get_state: { model: { provider: "fake", id: "scripted" }, isStreaming: false },
			}[frame.type] ?? {};
		this.emit({ type: "response", id: frame.id, command: frame.type, success: true, data });
		if (frame.type === "prompt") {
			this.emit({ type: "agent_start" });
			if (!this.holdPrompts) this.finishTurn();
		}
	}
}

/**
 * Host runtime whose agents are {@link FakeAgent}s; one-shot runs (setup,
 * diff, publish) execute for real on the host.
 */
export class FakeAgentRuntime extends HostRuntime {
	readonly agents: FakeAgent[] = [];
	readonly specs: SandboxSpec[] = [];
	configure?: (agent: FakeAgent) => void;

	override async startAgent(spec: SandboxSpec, argv: string[]): Promise<RpcAgentProcess> {
		const agent = new FakeAgent(argv);
		this.configure?.(agent);
		this.agents.push(agent);
		this.specs.push(spec);
		return agent.process();
	}

	get last(): FakeAgent {
		const agent = this.agents.at(-1);
		if (!agent) throw new Error("no agent started");
		return agent;
	}
}

export class RecordingNotifier implements Notifier {
	readonly sent: Notification[] = [];
	readonly #waiters: Array<{ match: (n: Notification) => boolean; resolve: (n: Notification) => void }> = [];

	async notify(notification: Notification): Promise<void> {
		this.sent.push(notification);
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.match(notification)) waiter.resolve(notification);
			else this.#waiters.push(waiter);
		}
	}

	waitFor(match: (n: Notification) => boolean): Promise<Notification> {
		const seen = this.sent.find(match);
		if (seen) return Promise.resolve(seen);
		const { promise, resolve } = Promise.withResolvers<Notification>();
		this.#waiters.push({ match, resolve });
		return promise;
	}
}

/** A bare "remote" with one commit on `main`, standing in for GitHub. */
export async function createOrigin(root: string): Promise<string> {
	const origin = path.join(root, "origin.git");
	const seed = path.join(root, "seed");
	await $`git init --quiet --bare --initial-branch=main ${origin}`.quiet();
	await $`git init --quiet --initial-branch=main ${seed}`.quiet();
	await Bun.write(path.join(seed, "README.md"), "# demo\n");
	await $`git -C ${seed} add README.md`.quiet();
	await $`git -C ${seed} -c user.name=t -c user.email=t@t commit --quiet -m initial`.quiet();
	await $`git -C ${seed} push --quiet ${origin} main`.quiet();
	return origin;
}

export function testConfig(dataDir: string, overrides: Record<string, unknown> = {}): ResolvedHubConfig {
	return resolveConfig(
		{
			dataDir,
			runtime: { kind: "host" },
			sessions: { idleStopMinutes: 0 },
			environments: { default: { image: "unused-on-host" } },
			...overrides,
		},
		null,
	);
}

/** Poll until `check` holds; the hub's background work has no completion hook to await. */
export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await Bun.sleep(10);
	}
}
