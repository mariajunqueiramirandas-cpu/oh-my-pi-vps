/** Wire services together and listen. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { Server } from "bun";
import { websocket } from "hono/bun";
import { AuthLimiter, TicketService, TokenService } from "./auth";
import { CredentialService } from "./credentials";
import { LoginService } from "./logins";
import type { ResolvedHubConfig } from "./config";
import { EnvironmentService } from "./environments";
import { createNotifier, type Notifier } from "./notify";
import { ProfileService, SecretService } from "./profile";
import { RepoService } from "./repos";
import { createRuntime, type SandboxRuntime } from "./sandbox";
import { createApp, type HubServices } from "./server/app";
import { SessionManager } from "./sessions";
import { HubStore } from "./store";

export interface StartHubOptions {
	/** Override the runtime (tests). */
	runtime?: SandboxRuntime;
	notifier?: Notifier;
	/** Listen port override; `0` picks a free port. */
	port?: number;
	/** Serve the web UI (default true). */
	ui?: boolean;
	/** Replaces `fetch` for sign-in providers (tests). */
	loginFetch?: FetchImpl;
}

export interface RunningHub {
	url: string;
	server: Server<unknown>;
	services: HubServices;
	store: HubStore;
	/** Plaintext token minted because none existed yet; shown once. */
	bootstrapToken: string | null;
	stop(): Promise<void>;
}

export function hubDatabasePath(dataDir: string): string {
	return path.join(dataDir, "hub.db");
}

export async function openStore(config: ResolvedHubConfig): Promise<HubStore> {
	await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
	return new HubStore(hubDatabasePath(config.dataDir));
}

export async function startHub(config: ResolvedHubConfig, options: StartHubOptions = {}): Promise<RunningHub> {
	const store = await openStore(config);
	const tokens = new TokenService(store);
	const tickets = new TicketService();
	const runtime = options.runtime ?? createRuntime(config.runtime);
	const repos = new RepoService(store, config.dataDir, config.git.timeoutMs);
	const environments = new EnvironmentService(config, store, runtime);
	const profile = new ProfileService(store, config.dataDir);
	const secrets = new SecretService(store);
	const credentials = await CredentialService.open(config.dataDir);
	const logins = new LoginService(credentials, { fetch: options.loginFetch });
	// Known once the server listens; agents on the host runtime reach the hub over loopback.
	let listeningPort = 0;
	const sandboxHubUrl = () =>
		config.subscriptions.sandboxUrl ??
		(runtime.isolated ? (config.publicUrl ?? null) : listeningPort ? `http://127.0.0.1:${listeningPort}` : null);
	const sessions = new SessionManager({
		config,
		store,
		runtime,
		repos,
		environments,
		notifier: options.notifier ?? createNotifier(config.notify),
		profile,
		secrets,
		credentials,
		sandboxHubUrl,
	});
	await sessions.recover();
	repos.resumePending();
	const bootstrapToken = tokens.count() === 0 ? tokens.create("bootstrap").token : null;
	const services: HubServices = {
		config,
		tokens,
		tickets,
		limiter: new AuthLimiter(),
		runtime,
		repos,
		environments,
		sessions,
		profile,
		secrets,
		credentials,
		logins,
		ui: options.ui,
	};
	const app = createApp(services);
	const server = Bun.serve({
		hostname: config.listen.host,
		port: options.port ?? config.listen.port,
		fetch: app.fetch,
		websocket,
		// Broker long polls hold a request open for up to 30 s; Bun's default idle limit is 10 s.
		idleTimeout: 120,
	});
	listeningPort = server.port ?? 0;
	let stopped: Promise<void> | null = null;
	return {
		url: `http://${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${server.port}`,
		server,
		services,
		store,
		bootstrapToken,
		stop() {
			stopped ??= (async () => {
				await server.stop(true);
				await logins.shutdown();
				await sessions.shutdown();
				await credentials.close();
				store.close();
			})();
			return stopped;
		},
	};
}
