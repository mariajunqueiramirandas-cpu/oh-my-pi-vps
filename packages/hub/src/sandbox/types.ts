import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/** Host directories a sandbox gets, by role. The runtime decides where they appear inside. */
export interface SandboxLayout {
	/** The session checkout (read-write). */
	work: string;
	/** The agent's `$HOME`: omp config, transcripts, caches (read-write). */
	home: string;
	/** Drop box for files the sandbox hands to the hub (read-write); one-shot runs only. */
	outbox?: string;
	/** Host paths mounted read-only at the same path, e.g. the mirror a `--shared` checkout borrows from. */
	readonlyPaths: string[];
}

export type SandboxMount =
	| { source: string; target: string; readonly?: boolean }
	| { volume: string; target: string; readonly?: boolean };

export interface SandboxSpec {
	/** Unique per sandbox; container name for container runtimes. */
	name: string;
	labels: Record<string, string>;
	image: string;
	layout: SandboxLayout;
	mounts: SandboxMount[];
	/** Variables set inside the sandbox. Never placed on a command line. */
	env: Record<string, string>;
	network: string;
	resources?: { memory?: string; cpus?: number; pids?: number };
	/** Operator-supplied runtime flags from `hub.yaml`. */
	extraArgs: string[];
}

/** Where the layout's directories appear inside the sandbox. */
export interface SandboxPaths {
	work: string;
	home: string;
	outbox: string;
}

export interface RunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface RunOptions {
	timeoutMs: number;
	/** Merged into `spec.env` for this run only. */
	env?: Record<string, string>;
}

export interface BuildOptions {
	tag: string;
	context: string;
	dockerfile?: string;
	args?: Record<string, string>;
	onLog?: (line: string) => void;
	timeoutMs: number;
}

export interface SandboxRuntime {
	readonly kind: "docker" | "podman" | "host";
	/** False for the host runtime: the agent runs with the hub's own privileges. */
	readonly isolated: boolean;
	pathsFor(layout: SandboxLayout): SandboxPaths;
	/** Start a long-lived process with piped stdio (the omp RPC agent). */
	startAgent(spec: SandboxSpec, argv: string[]): Promise<RpcAgentProcess>;
	/** Run a command to completion in a fresh sandbox. */
	run(spec: SandboxSpec, argv: string[], options: RunOptions): Promise<RunResult>;
	/** Force-remove a sandbox by name; succeeds when it is already gone. */
	remove(name: string): Promise<void>;
	/** Remove sandboxes carrying `label=value` left over from a previous hub process. */
	removeLabelled(label: string, value: string): Promise<number>;
	imageExists(image: string): Promise<boolean>;
	buildImage(options: BuildOptions): Promise<void>;
}
