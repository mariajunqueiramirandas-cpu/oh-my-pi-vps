import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildRunArgs, ContainerRuntime, formatEnvFile, userArgs } from "../src/sandbox/docker";
import type { SandboxSpec } from "../src/sandbox/types";

const spec: SandboxSpec = {
	name: "omp-hub-ses_1-1",
	labels: { "omp-hub.session": "ses_1" },
	image: "oh-my-pi/pi:dev",
	layout: {
		work: "/data/sessions/ses_1/work",
		home: "/data/sessions/ses_1/home",
		readonlyPaths: ["/data/mirrors/repo_1.git"],
	},
	mounts: [{ volume: "cargo", target: "/home/agent/.cargo" }],
	env: { ANTHROPIC_API_KEY: "sk-secret-value", OMP_HUB_SESSION: "ses_1" },
	network: "bridge",
	extraArgs: [],
};

describe("container run arguments", () => {
	test("never put variables on the command line or in the CLI's own environment", async () => {
		await using temp = await TempDir.create("@omp-hub-sandbox-");
		// Stand-in CLI: records what it was given, including the env-file the hub wrote.
		const fake = temp.join("docker");
		await Bun.write(
			fake,
			[
				"#!/bin/sh",
				`env > "${temp.join("cli-env")}"`,
				`printf '%s\\n' "$@" > "${temp.join("cli-args")}"`,
				'while [ $# -gt 0 ]; do if [ "$1" = --env-file ]; then cat "$2" > "' +
					temp.join("env-file") +
					'"; fi; shift; done',
			].join("\n"),
		);
		await fs.chmod(fake, 0o755);
		const runtime = new ContainerRuntime({ kind: "docker", command: fake, user: "image" });
		const hostile = { ...spec, env: { ...spec.env, LD_PRELOAD: "/work/evil.so" } };
		await runtime.run(hostile, ["true"], { timeoutMs: 10_000 });

		const cliEnv = await Bun.file(temp.join("cli-env")).text();
		const cliArgs = await Bun.file(temp.join("cli-args")).text();
		expect(cliEnv).not.toContain("evil.so");
		expect(cliEnv).not.toContain("sk-secret-value");
		expect(cliArgs).not.toContain("sk-secret-value");
		expect(await Bun.file(temp.join("env-file")).text()).toContain("ANTHROPIC_API_KEY=sk-secret-value\n");
		expect(await Bun.file(temp.join("env-file")).text()).toContain("LD_PRELOAD=/work/evil.so\n");
	});

	test("refuse values that would smuggle flags or extra variables", () => {
		expect(() =>
			buildRunArgs({ ...spec, image: "--privileged" }, [], { interactive: false, name: "x", user: [] }),
		).toThrow();
		expect(() => formatEnvFile({ A: "1\nLD_PRELOAD=/x.so" })).toThrow();
		expect(() => formatEnvFile({ "BAD-NAME": "1" })).toThrow();
	});

	test("drop privileges and mount the borrowed mirror read-only", () => {
		const args = buildRunArgs(spec, ["true"], { interactive: false, name: spec.name, user: ["--user", "1000:1000"] });
		const flag = (name: string) => args[args.indexOf(name) + 1];
		expect(flag("--cap-drop")).toBe("ALL");
		expect(flag("--security-opt")).toBe("no-new-privileges");
		expect(flag("--pids-limit")).toBe("1024");
		expect(args).toContain("/data/mirrors/repo_1.git:/data/mirrors/repo_1.git:ro");
		expect(args).toContain("/data/sessions/ses_1/work:/work");
		expect(args).not.toContain("-i");
	});

	test("run the hub's command instead of handing it to the image's entrypoint", () => {
		const args = buildRunArgs(spec, ["sh", "-c", "exec omp --mode rpc", "launch"], {
			interactive: true,
			name: spec.name,
			user: [],
		});
		const image = args.indexOf(spec.image);
		expect(args.slice(image - 2, image)).toEqual(["--entrypoint", "sh"]);
		expect(args.slice(image + 1)).toEqual(["-c", "exec omp --mode rpc", "launch"]);
		expect(() => buildRunArgs(spec, ["--privileged"], { interactive: false, name: spec.name, user: [] })).toThrow();
	});

	test("keep the hub's uid under rootless podman", () => {
		expect(userArgs("podman", "host")[0]).toBe("--userns=keep-id");
		expect(userArgs("docker", "host")[0]).toBe("--user");
		expect(userArgs("docker", "image")).toEqual([]);
	});
});
