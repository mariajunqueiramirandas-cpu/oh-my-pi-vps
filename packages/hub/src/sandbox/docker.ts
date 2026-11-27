/**
 * Docker/Podman sandbox: one container per agent, driven through the CLI.
 *
 * Defaults are deny-by-default: every capability dropped, no privilege
 * escalation, a pid limit, and the hub's uid so checkout files stay owned by
 * the hub.
 *
 * Sandbox variables travel in a 0600 `--env-file`, never in the CLI's own
 * environment: a variable such as `LD_PRELOAD` or `DOCKER_HOST` there would
 * act on the CLI running on the host, not on the sandbox.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { ptree, readLines } from "@oh-my-pi/pi-utils";
import type {
	BuildOptions,
	RunOptions,
	RunResult,
	SandboxLayout,
	SandboxPaths,
	SandboxRuntime,
	SandboxSpec,
} from "./types";

export const CONTAINER_PATHS: SandboxPaths = { work: "/work", home: "/home/agent", outbox: "/outbox" };
const DEFAULT_PIDS_LIMIT = 1024;
const CLI_TIMEOUT_MS = 60_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Image references: a leading `-` would be parsed as a run flag. */
export const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;

export interface ContainerRuntimeOptions {
	kind: "docker" | "podman";
	command?: string;
	ociRuntime?: string;
	/** `host`, `image`, or an explicit `uid:gid`. */
	user: string;
}

/** Map `user` to run flags for the runtime. */
export function userArgs(kind: "docker" | "podman", user: string): string[] {
	if (user === "image") return [];
	const value = user === "host" ? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` : user;
	// Rootless podman maps the invoking user to itself only under keep-id.
	return kind === "podman" && user === "host" ? ["--userns=keep-id", "--user", value] : ["--user", value];
}

export interface RunArgsOptions {
	interactive: boolean;
	name: string;
	user: string[];
	ociRuntime?: string;
	/** File holding the sandbox's variables, from {@link writeEnvFile}. */
	envFile?: string;
}

/** Serialize variables for `--env-file`, rejecting what that format cannot carry safely. */
export function formatEnvFile(env: Record<string, string>): string {
	let out = "";
	for (const [key, value] of Object.entries(env)) {
		if (!ENV_NAME.test(key)) throw new Error(`invalid sandbox variable name: ${key}`);
		if (/[\r\n\0]/.test(value)) throw new Error(`sandbox variable ${key} contains a line break`);
		out += `${key}=${value}\n`;
	}
	return out;
}

/** Write variables to a private file the CLI reads; remove it once the CLI exits. */
async function writeEnvFile(name: string, env: Record<string, string>): Promise<string> {
	const dir = path.join(os.tmpdir(), `omp-hub-${process.getuid?.() ?? "user"}`);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${name}-${crypto.randomUUID().slice(0, 8)}.env`);
	await fs.writeFile(file, formatEnvFile(env), { mode: 0o600, flag: "wx" });
	return file;
}

/** The `run` argv for a spec. Pure so the security contract is testable without a daemon. */
export function buildRunArgs(spec: SandboxSpec, argv: string[], options: RunArgsOptions): string[] {
	const args = ["run", "--rm", "--init"];
	if (options.interactive) args.push("-i");
	args.push("--name", options.name);
	for (const [key, value] of Object.entries(spec.labels)) args.push("--label", `${key}=${value}`);
	args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
	if (options.ociRuntime) args.push("--runtime", options.ociRuntime);
	args.push(...options.user);
	args.push("--network", spec.network);
	args.push("--pids-limit", String(spec.resources?.pids ?? DEFAULT_PIDS_LIMIT));
	if (spec.resources?.memory) args.push("--memory", spec.resources.memory);
	if (spec.resources?.cpus) args.push("--cpus", String(spec.resources.cpus));
	args.push(...layoutMounts(spec.layout));
	for (const mount of spec.mounts) {
		const source = "volume" in mount ? mount.volume : mount.source;
		args.push("-v", `${source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
	}
	args.push("-w", CONTAINER_PATHS.work);
	if (options.envFile) args.push("--env-file", options.envFile);
	args.push(...spec.extraArgs);
	if (!IMAGE_PATTERN.test(spec.image)) throw new Error(`invalid image reference: ${spec.image}`);
	// The hub's argv is the whole command. An image ENTRYPOINT (oh-my-pi/pi:dev has
	// `tini -- omp`) would otherwise receive it as arguments: `omp sh -c …`.
	const [program, ...rest] = argv;
	if (program === undefined) {
		args.push(spec.image);
		return args;
	}
	if (!program || program.startsWith("-")) throw new Error(`invalid sandbox command: ${program}`);
	args.push("--entrypoint", program, spec.image, ...rest);
	return args;
}

function layoutMounts(layout: SandboxLayout): string[] {
	const args = ["-v", `${layout.work}:${CONTAINER_PATHS.work}`, "-v", `${layout.home}:${CONTAINER_PATHS.home}`];
	if (layout.outbox) args.push("-v", `${layout.outbox}:${CONTAINER_PATHS.outbox}`);
	for (const hostPath of layout.readonlyPaths) args.push("-v", `${hostPath}:${hostPath}:ro`);
	return args;
}

export class ContainerRuntime implements SandboxRuntime {
	readonly kind: "docker" | "podman";
	readonly isolated = true;
	readonly #command: string;
	readonly #ociRuntime: string | undefined;
	readonly #user: string[];

	constructor(options: ContainerRuntimeOptions) {
		this.kind = options.kind;
		this.#command = options.command ?? options.kind;
		this.#ociRuntime = options.ociRuntime;
		this.#user = userArgs(options.kind, options.user);
	}

	pathsFor(): SandboxPaths {
		return CONTAINER_PATHS;
	}

	async startAgent(spec: SandboxSpec, argv: string[]): Promise<RpcAgentProcess> {
		const envFile = await writeEnvFile(spec.name, spec.env);
		try {
			const args = buildRunArgs(spec, argv, {
				interactive: true,
				name: spec.name,
				user: this.#user,
				ociRuntime: this.#ociRuntime,
				envFile,
			});
			const child = ptree.spawn([this.#command, ...args], { stdin: "pipe" });
			void child.exited.finally(() => fs.rm(envFile, { force: true }));
			return child;
		} catch (error) {
			await fs.rm(envFile, { force: true });
			throw error;
		}
	}

	async run(spec: SandboxSpec, argv: string[], options: RunOptions): Promise<RunResult> {
		const name = `${spec.name}-run-${crypto.randomUUID().slice(0, 8)}`;
		const envFile = await writeEnvFile(name, { ...spec.env, ...options.env });
		try {
			const args = buildRunArgs(spec, argv, {
				interactive: false,
				name,
				user: this.#user,
				ociRuntime: this.#ociRuntime,
				envFile,
			});
			const result = await ptree.exec([this.#command, ...args], {
				timeout: options.timeoutMs,
				allowNonZero: true,
				allowAbort: true,
			});
			const timedOut = result.exitError?.aborted === true;
			// A killed CLI does not stop its container; make sure nothing outlives the deadline.
			if (timedOut) await this.remove(name);
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut };
		} finally {
			await fs.rm(envFile, { force: true });
		}
	}

	async remove(name: string): Promise<void> {
		await this.#cli(["rm", "-f", name]);
	}

	async removeLabelled(label: string, value: string): Promise<number> {
		const listed = await this.#cli(["ps", "-aq", "--filter", `label=${label}=${value}`]);
		const ids = listed.stdout.split(/\s+/).filter(Boolean);
		if (ids.length > 0) await this.#cli(["rm", "-f", ...ids]);
		return ids.length;
	}

	async imageExists(image: string): Promise<boolean> {
		return (await this.#cli(["image", "inspect", image])).ok;
	}

	async buildImage(options: BuildOptions): Promise<void> {
		const args = ["build", "-t", options.tag];
		if (this.kind === "docker") args.push("--progress=plain");
		if (options.dockerfile) args.push("-f", options.dockerfile);
		for (const [key, value] of Object.entries(options.args ?? {})) args.push("--build-arg", `${key}=${value}`);
		args.push(options.context);
		// Streaming build output is a lifecycle the ptree helpers do not cover.
		const child = Bun.spawn([this.#command, ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: options.timeoutMs,
		});
		const tail: string[] = [];
		const decoder = new TextDecoder();
		const pump = async (stream: ReadableStream<Uint8Array>) => {
			for await (const bytes of readLines(stream)) {
				const line = decoder.decode(bytes).replace(/\r?\n?$/, "");
				tail.push(line);
				if (tail.length > 40) tail.shift();
				options.onLog?.(line);
			}
		};
		await Promise.all([pump(child.stdout), pump(child.stderr)]);
		const code = await child.exited;
		if (code !== 0) throw new Error(`image build failed (exit ${code}):\n${tail.slice(-15).join("\n")}`);
	}

	async #cli(args: string[]) {
		return ptree.exec([this.#command, ...args], { timeout: CLI_TIMEOUT_MS, allowNonZero: true, allowAbort: true });
	}
}
