import type { ResolvedHubConfig } from "../config";
import { ContainerRuntime } from "./docker";
import { HostRuntime } from "./host";
import type { SandboxRuntime } from "./types";

export * from "./docker";
export * from "./host";
export * from "./types";

export function createRuntime(config: ResolvedHubConfig["runtime"]): SandboxRuntime {
	if (config.kind === "host") return new HostRuntime();
	return new ContainerRuntime({
		kind: config.kind,
		command: config.command,
		ociRuntime: config.ociRuntime,
		user: config.user,
	});
}
