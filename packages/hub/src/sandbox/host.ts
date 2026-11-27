/**
 * Unsandboxed runtime: the agent runs as a plain child process with the hub's
 * privileges. Only a `$HOME` and working-directory switch separate sessions.
 * Meant for local development and for hosts that are themselves disposable.
 */
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree } from "@oh-my-pi/pi-utils";
import type { RunOptions, RunResult, SandboxLayout, SandboxPaths, SandboxRuntime, SandboxSpec } from "./types";

/** Variables carried over from the hub so tools resolve; everything else comes from the spec. */
const PASSTHROUGH_ENV = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
];

function hostEnv(spec: SandboxSpec, extra?: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of PASSTHROUGH_ENV) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...spec.env, ...extra, HOME: spec.layout.home };
}

export class HostRuntime implements SandboxRuntime {
	readonly kind = "host";
	readonly isolated = false;
	readonly #agents = new Map<string, ptree.ChildProcess<"pipe">>();

	pathsFor(layout: SandboxLayout): SandboxPaths {
		return { work: layout.work, home: layout.home, outbox: layout.outbox ?? layout.home };
	}

	async startAgent(spec: SandboxSpec, argv: string[]): Promise<RpcAgentProcess> {
		const child = ptree.spawn(argv, { cwd: spec.layout.work, env: hostEnv(spec), stdin: "pipe" });
		this.#agents.set(spec.name, child);
		void child.exited.finally(() => {
			if (this.#agents.get(spec.name) === child) this.#agents.delete(spec.name);
		});
		return child;
	}

	async run(spec: SandboxSpec, argv: string[], options: RunOptions): Promise<RunResult> {
		const result = await ptree.exec(argv, {
			cwd: spec.layout.work,
			env: hostEnv(spec, options.env),
			timeout: options.timeoutMs,
			allowNonZero: true,
			allowAbort: true,
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: result.exitError?.aborted === true,
		};
	}

	async remove(name: string): Promise<void> {
		this.#agents.get(name)?.kill();
	}

	async removeLabelled(): Promise<number> {
		// Host agents are children of this process and die with it.
		return 0;
	}

	async imageExists(): Promise<boolean> {
		return true;
	}

	async buildImage(): Promise<void> {
		throw new Error("the host runtime cannot build images; environments with a dockerfile need docker or podman");
	}
}
