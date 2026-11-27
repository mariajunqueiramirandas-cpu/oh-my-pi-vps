import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ConfigError, loadConfig, resolveConfig } from "../src/config";

describe("hub config", () => {
	test("an environment may forward only secrets the operator allowlisted", () => {
		const environments = { default: { image: "x", secrets: ["ANTHROPIC_API_KEY"] } };
		expect(() => resolveConfig({ environments }, null)).toThrow(ConfigError);
		const resolved = resolveConfig({ environments, secrets: { allow: ["ANTHROPIC_API_KEY"] } }, null);
		expect(resolved.environments.default.secrets).toEqual(["ANTHROPIC_API_KEY"]);
	});

	test("relative paths resolve against the config file, not the working directory", async () => {
		await using temp = await TempDir.create("@omp-hub-config-");
		const file = temp.join("hub.yaml");
		await Bun.write(
			file,
			[
				"dataDir: ./state",
				"environments:",
				"  rust:",
				"    build: { context: ./images/rust }",
				"    mounts: [{ source: ./cache, target: /cache }]",
			].join("\n"),
		);
		const config = await loadConfig(file);
		expect(config.dataDir).toBe(path.join(temp.path(), "state"));
		expect(config.environments.rust.build?.context).toBe(path.join(temp.path(), "images/rust"));
		expect(config.environments.rust.mounts[0]).toMatchObject({ source: path.join(temp.path(), "cache") });
	});

	test("unknown keys fail instead of being silently ignored", () => {
		expect(() => resolveConfig({ listen: { prot: 1 } }, null)).toThrow(/prot/);
		expect(() => resolveConfig({ environments: { default: { image: "x", netwrk: "none" } } }, null)).toThrow(
			/netwrk/,
		);
	});

	test("the shipped example config is valid", async () => {
		const config = await loadConfig(path.join(import.meta.dir, "..", "hub.example.yaml"));
		expect(Object.keys(config.environments)).toEqual(["default", "rust", "reverse-engineering"]);
	});
});
