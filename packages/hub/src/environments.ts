/**
 * Sandbox environments: the image an agent runs in plus its limits, network,
 * variables, setup steps and omp settings.
 *
 * Two sources: `hub.yaml` (operator-owned, may use host mounts, host build
 * contexts and extra runtime flags) and the API (phone-owned, restricted to
 * what cannot widen the sandbox: an image or inline Dockerfile, named volumes,
 * allowlisted networks and secrets).
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { logger } from "@oh-my-pi/pi-utils";
import { ConfigError, EnvironmentDefinition, type ResolvedHubConfig, assertEnvironment } from "./config";
import { HubError } from "./errors";
import { KeyedSerial } from "./ids";
import type { SandboxRuntime } from "./sandbox";
import type { HubStore } from "./store";

export type EnvironmentSource = "config" | "api";

export interface BuildState {
	status: "idle" | "building" | "ready" | "error";
	error?: string;
	/** Most recent build output lines. */
	log: string[];
	finishedAt?: number;
}

export interface EnvironmentView {
	id: string;
	source: EnvironmentSource;
	definition: EnvironmentDefinition;
	image: string;
	build: BuildState;
}

const BUILD_LOG_LINES = 200;
const BUILD_TIMEOUT_MS = 60 * 60_000;

export class EnvironmentService {
	readonly #config: ResolvedHubConfig;
	readonly #store: HubStore;
	readonly #runtime: SandboxRuntime;
	readonly #builds = new Map<string, BuildState>();
	readonly #buildLocks = new KeyedSerial();

	constructor(config: ResolvedHubConfig, store: HubStore, runtime: SandboxRuntime) {
		this.#config = config;
		this.#store = store;
		this.#runtime = runtime;
	}

	list(): EnvironmentView[] {
		const views = Object.entries(this.#config.environments).map(([id, definition]) =>
			this.#view(id, "config", definition),
		);
		for (const row of this.#store.listEnvironments()) views.push(this.#view(row.id, "api", row.definition));
		return views;
	}

	get(id: string): EnvironmentView {
		const fromConfig = this.#config.environments[id];
		if (fromConfig) return this.#view(id, "config", fromConfig);
		const row = this.#store.listEnvironments().find(candidate => candidate.id === id);
		if (!row) throw new HubError(404, `environment ${id} not found`);
		return this.#view(id, "api", row.definition);
	}

	/** Create or replace an API-defined environment. */
	put(id: string, input: unknown): EnvironmentView {
		if (this.#config.environments[id])
			throw new HubError(409, `environment ${id} is defined in hub.yaml and is read-only`);
		const definition = this.#validateApiDefinition(id, input);
		this.#store.putEnvironment(id, definition, Date.now());
		this.#builds.delete(id);
		return this.get(id);
	}

	remove(id: string): void {
		if (this.#config.environments[id])
			throw new HubError(409, `environment ${id} is defined in hub.yaml and is read-only`);
		if (this.#store.sessionsForEnvironment(id).length > 0)
			throw new HubError(409, "delete the sessions using this environment first");
		if (!this.#store.deleteEnvironment(id)) throw new HubError(404, `environment ${id} not found`);
		this.#builds.delete(id);
	}

	/** The image for an environment, building it first when it is built locally and missing. */
	async ensureImage(id: string, onLog?: (line: string) => void): Promise<string> {
		const view = this.get(id);
		if (!this.#runtime.isolated) return view.image;
		if (!isBuilt(view.definition)) return view.image;
		if (await this.#runtime.imageExists(view.image)) return view.image;
		await this.build(id, onLog);
		return view.image;
	}

	/** (Re)build a locally built environment's image. Concurrent calls share one build. */
	build(id: string, onLog?: (line: string) => void): Promise<void> {
		return this.#buildLocks.run(id, async () => {
			const view = this.get(id);
			if (!isBuilt(view.definition))
				throw new HubError(422, `environment ${id} uses a prebuilt image; nothing to build`);
			const state: BuildState = { status: "building", log: [] };
			this.#builds.set(id, state);
			const record = (line: string) => {
				state.log.push(line);
				if (state.log.length > BUILD_LOG_LINES) state.log.shift();
				onLog?.(line);
			};
			try {
				const { context, dockerfile } = await this.#buildContext(id, view.definition);
				await this.#runtime.buildImage({
					tag: view.image,
					context,
					dockerfile,
					args: view.definition.build?.args,
					onLog: record,
					timeoutMs: BUILD_TIMEOUT_MS,
				});
				state.status = "ready";
			} catch (error) {
				state.status = "error";
				state.error = error instanceof Error ? error.message : String(error);
				logger.warn("hub: environment build failed", { environment: id, error: state.error });
				throw new HubError(502, `building environment ${id} failed: ${state.error}`);
			} finally {
				state.finishedAt = Date.now();
			}
		});
	}

	async #buildContext(
		id: string,
		definition: EnvironmentDefinition,
	): Promise<{ context: string; dockerfile?: string }> {
		if (definition.build) {
			return {
				context: definition.build.context,
				dockerfile: definition.build.dockerfile
					? path.resolve(definition.build.context, definition.build.dockerfile)
					: undefined,
			};
		}
		// Inline Dockerfiles build from an otherwise empty context, so a build cannot read host files.
		const context = path.join(this.#config.dataDir, "builds", id);
		await Bun.write(path.join(context, "Dockerfile"), definition.dockerfile ?? "");
		return { context };
	}

	#validateApiDefinition(id: string, input: unknown): EnvironmentDefinition {
		const definition = EnvironmentDefinition(input);
		if (definition instanceof type.errors) throw new HubError(422, definition.summary);
		const forbidden: string[] = [];
		if (definition.build) forbidden.push("build (host build contexts are config-only; use dockerfile)");
		// Building into a caller-chosen tag could overwrite an image a config environment (with host mounts) runs.
		if (definition.dockerfile !== undefined && definition.image !== undefined)
			forbidden.push("image together with dockerfile");
		if (definition.extraArgs.length > 0) forbidden.push("extraArgs");
		if (definition.mounts.some(mount => "source" in mount)) forbidden.push("host mounts (use named volumes)");
		if (!this.#config.runtime.allowedNetworks.includes(definition.network)) {
			forbidden.push(`network ${definition.network} (allowed: ${this.#config.runtime.allowedNetworks.join(", ")})`);
		}
		if (forbidden.length > 0)
			throw new HubError(422, `not allowed for API-defined environments: ${forbidden.join("; ")}`);
		try {
			assertEnvironment(id, definition, this.#config);
		} catch (error) {
			if (error instanceof ConfigError) throw new HubError(422, error.message);
			throw error;
		}
		return definition;
	}

	#view(id: string, source: EnvironmentSource, definition: EnvironmentDefinition): EnvironmentView {
		return {
			id,
			source,
			definition,
			image: imageTag(id, definition),
			build: this.#builds.get(id) ?? { status: "idle", log: [] },
		};
	}
}

function isBuilt(definition: EnvironmentDefinition): boolean {
	return definition.dockerfile !== undefined || definition.build !== undefined;
}

/**
 * The tag an environment runs. An inline Dockerfile's tag carries its content
 * hash, so editing the Dockerfile yields a new tag that is built on next use.
 */
export function imageTag(id: string, definition: EnvironmentDefinition): string {
	if (definition.image) return definition.image;
	if (definition.dockerfile !== undefined) {
		const digest = new Bun.CryptoHasher("sha256").update(definition.dockerfile).digest("hex").slice(0, 12);
		return `omp-hub-env-${id}:${digest}`;
	}
	return `omp-hub-env-${id}:latest`;
}
