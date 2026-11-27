#!/usr/bin/env bun
/**
 * `omp-hub` command line. A standalone process (no TUI), so it prints to the
 * terminal directly; runtime diagnostics go through the shared logger.
 */
import { parseArgs } from "node:util";
import { encodeQr, qrHalfBlocks } from "@oh-my-pi/pi-coding-agent/ui/transcript/figures/qr";
import { logger } from "@oh-my-pi/pi-utils";
import { TokenService } from "./auth";
import { ConfigError, loadConfig, type ResolvedHubConfig } from "./config";
import { openStore, startHub } from "./server";

const HELP = `omp-hub — run sandboxed omp sessions on this server and drive them from your phone

Usage:
  omp-hub serve [--config <file>] [--port <n>]   Start the hub
  omp-hub pair [--name <device>]                 Mint a device token and show a pairing QR
  omp-hub token create <name>                    Mint a token (printed once)
  omp-hub token list                             List tokens
  omp-hub token revoke <id>                      Revoke a token
  omp-hub config                                 Validate and print the resolved config

Options:
  --config <file>   hub.yaml (default: $OMP_HUB_CONFIG or ~/.omp-hub/hub.yaml)
`;

function out(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function baseUrl(config: ResolvedHubConfig, port = config.listen.port): string {
	if (config.publicUrl) return config.publicUrl.replace(/\/+$/, "");
	const host = config.listen.host === "0.0.0.0" || config.listen.host === "::" ? "localhost" : config.listen.host;
	return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** Print a token with a sign-in link and its QR code; the token rides in the URL fragment, which is never sent. */
function printPairing(config: ResolvedHubConfig, token: string, port?: number): void {
	const link = `${baseUrl(config, port)}/#token=${encodeURIComponent(token)}`;
	out(`  token: ${token}`);
	out(`  link:  ${link}`);
	out();
	for (const row of qrHalfBlocks(encodeQr(link, "L"), "dark")) out(`  ${row}`);
	out();
	out("  Shown once. Revoke with `omp-hub token revoke <id>`.");
}

async function serve(config: ResolvedHubConfig, port: number | undefined): Promise<void> {
	const hub = await startHub(config, { port });
	out(`omp-hub listening on ${hub.url}`);
	out(`  data:     ${config.dataDir}`);
	out(
		`  runtime:  ${hub.services.runtime.kind}${hub.services.runtime.isolated ? "" : " (UNSANDBOXED: agents run with this user's privileges)"}`,
	);
	if (
		config.listen.host !== "127.0.0.1" &&
		config.listen.host !== "localhost" &&
		!config.publicUrl?.startsWith("https://")
	) {
		out(
			"  warning:  listening beyond localhost without HTTPS; put the hub behind an HTTPS reverse proxy such as Caddy",
		);
	}
	if (hub.bootstrapToken) {
		out();
		out("No tokens existed, so one was created. Pair your phone:");
		printPairing(config, hub.bootstrapToken, hub.server.port);
	}
	const shutdown = (signal: string) => {
		logger.info("hub: shutting down", { signal });
		void hub.stop().finally(() => process.exit(0));
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
}

async function tokens(config: ResolvedHubConfig, args: string[]): Promise<number> {
	const store = await openStore(config);
	try {
		const service = new TokenService(store);
		const [action, value] = args;
		switch (action) {
			case "create": {
				if (!value) throw new ConfigError("usage: omp-hub token create <name>");
				const { token, info } = service.create(value);
				out(`created ${info.id} (${info.name})`);
				printPairing(config, token);
				return 0;
			}
			case "list":
				for (const info of service.list()) {
					const used = info.lastUsedAt ? new Date(info.lastUsedAt).toISOString() : "never";
					out(
						`${info.id}  ${info.name.padEnd(20)}  created ${new Date(info.createdAt).toISOString()}  last used ${used}`,
					);
				}
				return 0;
			case "revoke":
				if (!value) throw new ConfigError("usage: omp-hub token revoke <id>");
				if (!service.revoke(value)) {
					out(`no token ${value}`);
					return 1;
				}
				out(`revoked ${value}`);
				return 0;
			default:
				out(HELP);
				return 1;
		}
	} finally {
		store.close();
	}
}

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			config: { type: "string" },
			port: { type: "string" },
			name: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		out(HELP);
		return command ? 0 : 1;
	}
	const config = await loadConfig(values.config);
	switch (command) {
		case "serve":
			await serve(config, values.port ? Number.parseInt(values.port, 10) : undefined);
			return -1; // keep running
		case "pair":
			return tokens(config, ["create", values.name ?? "phone"]);
		case "token":
			return tokens(config, rest);
		case "config":
			out(JSON.stringify(config, null, 2));
			return 0;
		default:
			out(HELP);
			return 1;
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		code => {
			if (code >= 0) process.exit(code);
		},
		error => {
			process.stderr.write(`omp-hub: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(error instanceof ConfigError ? 2 : 1);
		},
	);
}
