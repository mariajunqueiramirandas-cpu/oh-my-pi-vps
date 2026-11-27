/**
 * Hub configuration: one YAML file owned by the server operator.
 *
 * The file is the trust root. Anything that can widen what a sandbox reaches —
 * host bind mounts, extra runtime flags, which hub secrets may be forwarded,
 * which networks may be joined — is only settable here, never through the API.
 */
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

export const HUB_CONFIG_ENV = "OMP_HUB_CONFIG";
export const HUB_DATA_DIR_ENV = "OMP_HUB_DATA_DIR";
export const DEFAULT_PORT = 7480;

const MemorySize = type("/^[0-9]+[bkmg]?$/");

export const Resources = type({
	"memory?": MemorySize,
	"cpus?": "number > 0",
	"pids?": "number.integer > 0",
	"+": "reject",
});

/** Absolute container path with nothing a `-v` spec would read as an option (`:`, `,`). */
const MountTarget = type("/^\\/[A-Za-z0-9._\\/-]*$/");
const HostMount = type({ source: "string", target: MountTarget, "readonly?": "boolean", "+": "reject" });
const VolumeMount = type({
	volume: "/^[A-Za-z0-9][A-Za-z0-9_.-]*$/",
	target: MountTarget,
	"readonly?": "boolean",
	"+": "reject",
});
export const Mount = HostMount.or(VolumeMount);

const Build = type({
	context: "string",
	"dockerfile?": "string",
	"args?": "Record<string, string>",
	"+": "reject",
});

/** An environment as the operator writes it in `hub.yaml`. */
export const EnvironmentDefinition = type({
	"description?": "string",
	/** Image to run. Defaults to the image built from `dockerfile`/`build`. */
	"image?": "/^[A-Za-z0-9][A-Za-z0-9._\\/:@-]*$/",
	/** Inline Dockerfile, built with an empty context. */
	"dockerfile?": "string",
	/** Dockerfile build from a host directory (config only). */
	"build?": Build,
	network: "string = 'bridge'",
	"resources?": Resources,
	/** Non-secret variables set in the sandbox. */
	env: ["Record<string, string>", "=", () => ({})],
	/** Names of hub-process variables forwarded into the sandbox; must be in `secrets.allow`. */
	secrets: ["string[]", "=", () => []],
	mounts: [Mount.array(), "=", () => []],
	/** Shell commands run once in a throwaway sandbox after the checkout is created. */
	setup: ["string[]", "=", () => []],
	/** omp settings overlay (`config.yml` shape) applied to agents in this environment. */
	settings: ["Record<string, unknown>", "=", () => ({})],
	/** argv that launches omp inside the sandbox; defaults to `agent.command`. */
	"agentCommand?": "string[]",
	/** Extra runtime flags appended to `run` (config only). */
	extraArgs: ["string[]", "=", () => []],
	"+": "reject",
});
export type EnvironmentDefinition = typeof EnvironmentDefinition.infer;

export const HubConfig = type({
	listen: [
		type({
			host: "string = '127.0.0.1'",
			port: `number.integer > 0 = ${DEFAULT_PORT}`,
			/** Behind a reverse proxy (Caddy, nginx): take the client address from the last `X-Forwarded-For` hop. */
			trustProxy: "boolean = false",
			"+": "reject",
		}),
		"=",
		() => ({ host: "127.0.0.1", port: DEFAULT_PORT, trustProxy: false }),
	],
	"dataDir?": "string",
	/** Base URL the phone reaches the hub at; used for notification deep links. */
	"publicUrl?": "string",
	cors: [type({ origins: ["string[]", "=", () => []], "+": "reject" }), "=", () => ({ origins: [] })],
	runtime: [
		type({
			kind: "'docker' | 'podman' | 'host' = 'docker'",
			"command?": "string",
			/** OCI runtime such as `runsc` (gVisor). */
			"ociRuntime?": "string",
			/** `host` maps the sandbox user to the hub's uid:gid; `image` keeps the image user. */
			user: "string = 'host'",
			/** Networks API-defined environments may join. */
			allowedNetworks: ["string[]", "=", () => ["bridge", "none"]],
			"+": "reject",
		}),
		"=",
		() => ({ kind: "docker", user: "host", allowedNetworks: ["bridge", "none"] }),
	],
	agent: [
		type({
			command: ["string[]", "=", () => ["omp"]],
			args: ["string[]", "=", () => []],
			approvalMode: "'always-ask' | 'always-ask-cached' | 'write' | 'yolo' = 'yolo'",
			/** Host directory copied into each new session's `~/.omp/agent` (models.yml, config.yml, …). */
			"seedDir?": "string",
			"+": "reject",
		}),
		"=",
		() => ({ command: ["omp"], args: [], approvalMode: "yolo" }),
	],
	git: [
		type({
			author: [
				type({ name: "string = 'omp-hub'", email: "string = 'omp-hub@localhost'", "+": "reject" }),
				"=",
				() => ({ name: "omp-hub", email: "omp-hub@localhost" }),
			],
			timeoutMs: "number.integer > 0 = 600000",
			"+": "reject",
		}),
		"=",
		() => ({ author: { name: "omp-hub", email: "omp-hub@localhost" }, timeoutMs: 600_000 }),
	],
	"github?": type({
		tokenEnv: "string = 'GITHUB_TOKEN'",
		apiUrl: "string = 'https://api.github.com'",
		"+": "reject",
	}),
	secrets: [type({ allow: ["string[]", "=", () => []], "+": "reject" }), "=", () => ({ allow: [] })],
	subscriptions: [
		type({
			/**
			 * Base URL agent sandboxes use to reach this hub for subscription logins.
			 * Defaults to `publicUrl` for container runtimes and loopback for the host runtime.
			 */
			"sandboxUrl?": "string",
			"+": "reject",
		}),
		"=",
		() => ({}),
	],
	sessions: [
		type({
			idleStopMinutes: "number >= 0 = 30",
			eventBuffer: "number.integer > 0 = 5000",
			maxRunning: "number.integer > 0 = 4",
			"+": "reject",
		}),
		"=",
		() => ({ idleStopMinutes: 30, eventBuffer: 5000, maxRunning: 4 }),
	],
	"notify?": type({
		"ntfy?": type({ server: "string = 'https://ntfy.sh'", topic: "string", "tokenEnv?": "string", "+": "reject" }),
		"+": "reject",
	}),
	environments: ["Record<string, unknown>", "=", () => ({ default: { image: "oh-my-pi/pi:dev" } })],
	"+": "reject",
});

type RawHubConfig = typeof HubConfig.infer;

/** Validated configuration with resolved paths and parsed environments. */
export interface ResolvedHubConfig extends Omit<RawHubConfig, "environments" | "dataDir"> {
	dataDir: string;
	configPath: string | null;
	environments: Record<string, EnvironmentDefinition>;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/** Names a variable may have in a sandbox. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment ids double as image-tag components and URL segments. */
export const ENVIRONMENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

export function defaultDataDir(): string {
	const fromEnv = process.env[HUB_DATA_DIR_ENV]?.trim();
	return fromEnv ? path.resolve(expandHome(fromEnv)) : path.join(os.homedir(), ".omp-hub");
}

/** Check that an environment can produce an image and only uses what the config allows. */
export function assertEnvironment(
	id: string,
	definition: EnvironmentDefinition,
	config: Pick<ResolvedHubConfig, "secrets">,
): void {
	if (!ENVIRONMENT_ID_PATTERN.test(id))
		throw new ConfigError(`environment id "${id}" must match ${ENVIRONMENT_ID_PATTERN}`);
	const sources = [definition.image, definition.dockerfile, definition.build].filter(value => value !== undefined);
	if (definition.dockerfile !== undefined && definition.build !== undefined) {
		throw new ConfigError(`environment "${id}": set either dockerfile or build, not both`);
	}
	if (sources.length === 0) throw new ConfigError(`environment "${id}" needs an image, dockerfile, or build`);
	for (const name of definition.secrets) {
		if (!config.secrets.allow.includes(name)) {
			throw new ConfigError(`environment "${id}" forwards secret ${name}, which is not in secrets.allow`);
		}
	}
	for (const name of [...Object.keys(definition.env), ...definition.secrets]) {
		if (!ENV_NAME_PATTERN.test(name)) throw new ConfigError(`environment "${id}": invalid variable name ${name}`);
	}
	for (const mount of definition.mounts) {
		if ("source" in mount && /[:,]/.test(mount.source)) {
			throw new ConfigError(`environment "${id}": mount source ${mount.source} must not contain ':' or ','`);
		}
	}
}

/** Validate a parsed config document and resolve paths. */
export function resolveConfig(document: unknown, configPath: string | null): ResolvedHubConfig {
	const parsed = HubConfig(document ?? {});
	if (parsed instanceof type.errors) throw new ConfigError(`invalid hub config: ${parsed.summary}`);
	const base = configPath ? path.dirname(configPath) : process.cwd();
	const resolvePath = (value: string) => path.resolve(base, expandHome(value));
	const environments: Record<string, EnvironmentDefinition> = {};
	for (const [id, raw] of Object.entries(parsed.environments)) {
		const definition = EnvironmentDefinition(raw);
		if (definition instanceof type.errors)
			throw new ConfigError(`invalid environment "${id}": ${definition.summary}`);
		if (definition.build) {
			definition.build.context = resolvePath(definition.build.context);
		}
		for (const mount of definition.mounts) {
			if ("source" in mount) mount.source = resolvePath(mount.source);
		}
		environments[id] = definition;
	}
	const resolved: ResolvedHubConfig = {
		...parsed,
		dataDir: parsed.dataDir ? resolvePath(parsed.dataDir) : defaultDataDir(),
		configPath,
		environments,
		agent: { ...parsed.agent, seedDir: parsed.agent.seedDir ? resolvePath(parsed.agent.seedDir) : undefined },
	};
	for (const [id, definition] of Object.entries(environments)) assertEnvironment(id, definition, resolved);
	return resolved;
}

/**
 * Load `hub.yaml` from an explicit path, `OMP_HUB_CONFIG`, or `<dataDir>/hub.yaml`.
 * A missing default file yields the defaults; a missing explicit file is an error.
 */
export async function loadConfig(explicitPath?: string): Promise<ResolvedHubConfig> {
	const requested = explicitPath ?? process.env[HUB_CONFIG_ENV]?.trim();
	const configPath = path.resolve(expandHome(requested || path.join(defaultDataDir(), "hub.yaml")));
	let text: string;
	try {
		text = await Bun.file(configPath).text();
	} catch (error) {
		if (isEnoent(error) && !requested) return resolveConfig({}, null);
		if (isEnoent(error)) throw new ConfigError(`hub config not found: ${configPath}`);
		throw error;
	}
	let document: unknown;
	try {
		document = YAML.parse(text);
	} catch (error) {
		throw new ConfigError(
			`hub config ${configPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return resolveConfig(document, configPath);
}
