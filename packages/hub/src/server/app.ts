/**
 * The hub's HTTP API. Routes are one chained, module-level definition so
 * `hono/client` can infer a typed client from {@link HubRoutes}; services
 * arrive through context variables and hold all behavior.
 *
 * Every `/api` route needs `Authorization: Bearer <token>`, except the
 * session stream, which also accepts a one-shot `?ticket=` because browsers
 * and WebViews cannot set headers on a WebSocket.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { sValidator } from "@hono/standard-validator";
import { RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getConnInfo, upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import type { AuthLimiter, TicketService, TokenInfo, TokenService } from "../auth";
import type { ResolvedHubConfig } from "../config";
import type { EnvironmentService } from "../environments";
import { HubError } from "../errors";
import type { HubEvent } from "../events";
import { listModels, listProviders } from "../catalog";
import { ProfilePatch, type ProfileService, type SecretService, THINKING_LEVELS } from "../profile";
import type { CredentialService } from "../credentials";
import type { LoginService } from "../logins";
import type { RepoService } from "../repos";
import { BROKER_PROXY_PREFIX, proxyBrokerRequest } from "./broker-proxy";
import type { SandboxRuntime } from "../sandbox";
import type { SessionManager } from "../sessions";
import { uiBundle, uiResponse } from "./ui";
import {
	AddRepoBody,
	BashBody,
	CreateSessionBody,
	CreateTokenBody,
	EnvironmentBody,
	PromptBody,
	PublishBody,
	PullRequestBody,
	LoginAnswerBody,
	RespondBody,
	SecretBody,
	StartLoginBody,
} from "./schemas";

export interface HubServices {
	config: ResolvedHubConfig;
	tokens: TokenService;
	tickets: TicketService;
	limiter: AuthLimiter;
	runtime: SandboxRuntime;
	repos: RepoService;
	environments: EnvironmentService;
	sessions: SessionManager;
	profile: ProfileService;
	secrets: SecretService;
	credentials: CredentialService;
	logins: LoginService;
	/** Serve the web UI at `/` (default true). */
	ui?: boolean;
}

type HubEnv = { Variables: { services: HubServices; token: TokenInfo } };

/** Frames on the session stream, server → client. */
export type StreamFrame = { type: "hello"; lastSeq: number; truncated: boolean } | { type: "event"; event: HubEvent };

/** Close a stream whose client stopped reading rather than buffer without bound; it resumes with `since`. */
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
const STREAM_PATH = /^\/api\/sessions\/[^/]+\/stream$/;

function bearer(header: string | undefined): string {
	const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
	return match ? match[1] : "";
}

function sinceParam(raw: string | undefined): number {
	const since = Number.parseInt(raw ?? "0", 10);
	return Number.isFinite(since) && since > 0 ? since : 0;
}

/** JSON body validation answering 422 with readable issues instead of the default 400 payload. */
function body<S extends StandardSchemaV1>(schema: S) {
	return sValidator("json", schema, (result, c) => {
		if (!result.success) {
			const issues = result.error.map(issue => {
				const at = issue.path
					?.map(segment => (typeof segment === "object" ? String(segment.key) : String(segment)))
					.join(".");
				return at ? `${at}: ${issue.message}` : issue.message;
			});
			return c.json({ error: issues.join("; ") }, 422);
		}
	});
}

/** The caller's address: the socket peer, or the hop a trusted reverse proxy appended. */
function clientAddress(c: Context<HubEnv>): string {
	if (c.var.services.config.listen.trustProxy) {
		const hops = c.req
			.header("X-Forwarded-For")
			?.split(",")
			.map(hop => hop.trim())
			.filter(Boolean);
		// The proxy appends the peer it saw; earlier entries are whatever the client claimed.
		if (hops?.length) return hops[hops.length - 1];
	}
	try {
		return getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** 401, or 429 once this address keeps failing. A valid credential is never refused for its address. */
function rejectCredential(c: Context<HubEnv>, message: string) {
	const { limiter } = c.var.services;
	const client = clientAddress(c);
	const wait = limiter.retryAfter(client);
	limiter.fail(client);
	if (wait > 0) {
		c.header("Retry-After", String(wait));
		return c.json({ error: "too many failed attempts; try again later" }, 429);
	}
	return c.json({ error: message }, 401);
}

const requireToken: MiddlewareHandler<HubEnv> = async (c, next) => {
	// The stream authenticates itself (ticket or bearer) before upgrading.
	if (STREAM_PATH.test(c.req.path)) return next();
	const info = c.var.services.tokens.verify(bearer(c.req.header("Authorization")));
	if (!info) return rejectCredential(c, "missing or invalid bearer token");
	c.set("token", info);
	await next();
};

const requireStreamAuth: MiddlewareHandler<HubEnv> = async (c, next) => {
	const { tokens, tickets, sessions } = c.var.services;
	const id = c.req.param("id") ?? "";
	const ticket = c.req.query("ticket");
	const tokenId =
		tokens.verify(bearer(c.req.header("Authorization")))?.id ?? (ticket ? tickets.redeem(ticket, id) : null);
	if (!tokenId) return rejectCredential(c, "missing or invalid ticket");
	sessions.get(id); // 404 before upgrading
	await next();
};

const repoRoutes = new Hono<HubEnv>()
	.get("/", c => c.json(c.var.services.repos.list()))
	.post("/", body(AddRepoBody), c => {
		const input = c.req.valid("json");
		return c.json(c.var.services.repos.add(input.url, input.name), 202);
	})
	.get("/:id", c => c.json(c.var.services.repos.get(c.req.param("id"))))
	.post("/:id/refresh", async c => c.json(await c.var.services.repos.refresh(c.req.param("id"))))
	.delete("/:id", async c => {
		await c.var.services.repos.remove(c.req.param("id"));
		return c.json({ deleted: true });
	});

const environmentRoutes = new Hono<HubEnv>()
	.get("/", c => c.json(c.var.services.environments.list()))
	.get("/:id", c => c.json(c.var.services.environments.get(c.req.param("id"))))
	.put("/:id", body(EnvironmentBody), c =>
		c.json(c.var.services.environments.put(c.req.param("id"), c.req.valid("json"))),
	)
	.delete("/:id", c => {
		c.var.services.environments.remove(c.req.param("id"));
		return c.json({ deleted: true });
	})
	.post("/:id/build", c => {
		const { environments } = c.var.services;
		const id = c.req.param("id");
		environments.get(id);
		// Builds run for minutes; poll GET /environments/:id for status and log.
		void environments.build(id).catch(() => {});
		return c.json({ started: true }, 202);
	});

const sessionRoutes = new Hono<HubEnv>()
	.get("/", c => c.json(c.var.services.sessions.list()))
	.post("/", body(CreateSessionBody), c => c.json(c.var.services.sessions.create(c.req.valid("json")), 202))
	.get("/:id", c => c.json(c.var.services.sessions.get(c.req.param("id"))))
	.delete("/:id", async c => {
		await c.var.services.sessions.delete(c.req.param("id"));
		return c.json({ deleted: true });
	})
	.post("/:id/start", async c => c.json(await c.var.services.sessions.start(c.req.param("id"))))
	.post("/:id/stop", async c => c.json(await c.var.services.sessions.stop(c.req.param("id"))))
	.post("/:id/prompt", body(PromptBody), async c =>
		c.json(await c.var.services.sessions.prompt(c.req.param("id"), c.req.valid("json"))),
	)
	.post("/:id/abort", async c => {
		await c.var.services.sessions.abort(c.req.param("id"));
		return c.json({ aborted: true });
	})
	.post("/:id/respond", body(RespondBody), c => {
		const input = c.req.valid("json");
		c.var.services.sessions.respond(c.req.param("id"), input.requestId, input.answer);
		return c.json({ answered: true });
	})
	.post("/:id/bash", body(BashBody), async c => {
		const input = c.req.valid("json");
		return c.json(await c.var.services.sessions.bash(c.req.param("id"), input.command, input.timeoutMs));
	})
	.get("/:id/messages", async c => c.json(await c.var.services.sessions.messages(c.req.param("id"))))
	.get("/:id/events", c => {
		const log = c.var.services.sessions.events(c.req.param("id"));
		const { events, truncated } = log.since(sinceParam(c.req.query("since")));
		return c.json({ events, truncated, lastSeq: log.lastSeq });
	})
	.get("/:id/diff", async c => c.json(await c.var.services.sessions.diff(c.req.param("id"))))
	.post("/:id/publish", body(PublishBody), async c =>
		c.json(await c.var.services.sessions.publish(c.req.param("id"), c.req.valid("json"))),
	)
	.post("/:id/pull-request", body(PullRequestBody), async c =>
		c.json(await c.var.services.sessions.pullRequest(c.req.param("id"), c.req.valid("json"))),
	)
	.post("/:id/ticket", c => {
		const { sessions, tickets } = c.var.services;
		const id = c.req.param("id");
		sessions.get(id);
		return c.json(tickets.issue(id, c.var.token.id));
	})
	.get(
		"/:id/stream",
		requireStreamAuth,
		upgradeWebSocket(c => {
			// The upgrade helper types its context loosely; restore the hub's types.
			const sessions: SessionManager = c.get("services").sessions;
			const id = c.req.param("id") ?? "";
			const since = sinceParam(c.req.query("since"));
			let unsubscribe: (() => void) | undefined;
			return {
				onOpen(_event, ws) {
					const log = sessions.events(id);
					const send = (frame: StreamFrame) => {
						const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
						if ((raw?.getBufferedAmount?.() ?? 0) > MAX_STREAM_BUFFER_BYTES) {
							unsubscribe?.();
							ws.close(1013, "client too slow; reconnect with since");
							return;
						}
						ws.send(JSON.stringify(frame));
					};
					// Backlog and subscription happen in one synchronous step, so no event falls between them.
					const backlog = log.since(since);
					send({ type: "hello", lastSeq: log.lastSeq, truncated: backlog.truncated });
					for (const event of backlog.events) send({ type: "event", event });
					unsubscribe = log.subscribe(event => send({ type: "event", event }));
				},
				onMessage(event, ws) {
					if (event.data === "ping") ws.send("pong");
				},
				onClose() {
					unsubscribe?.();
				},
			};
		}),
	);

const settingsRoutes = new Hono<HubEnv>()
	.get("/profile", c => c.json(c.var.services.profile.get()))
	.put("/profile", body(ProfilePatch), async c => c.json(await c.var.services.profile.update(c.req.valid("json"))))
	// Running agents keep the profile they started with; stopping idle ones makes their next prompt pick it up.
	.post("/profile/apply", async c => c.json({ stopped: await c.var.services.sessions.stopIdle("settings changed") }))
	.get("/secrets", c => c.json(c.var.services.secrets.list()))
	.put("/secrets/:name", body(SecretBody), c =>
		c.json(c.var.services.secrets.set(c.req.param("name"), c.req.valid("json").value)),
	)
	.delete("/secrets/:name", c => {
		c.var.services.secrets.remove(c.req.param("name"));
		return c.json({ deleted: true });
	})
	.get("/catalog/providers", c => {
		const { secrets, config, credentials } = c.var.services;
		const available = secrets.names();
		for (const name of config.secrets.allow) if (process.env[name]) available.add(name);
		return c.json(
			listProviders(
				provider => provider.envVars.some(name => available.has(name)) || credentials.hasProvider(provider.id),
			),
		);
	})
	.get("/subscriptions", c => c.json(c.var.services.credentials.providers()))
	.delete("/subscriptions/:provider/:credentialId", async c => {
		const credentialId = Number.parseInt(c.req.param("credentialId"), 10);
		if (!Number.isSafeInteger(credentialId)) throw new HubError(422, "invalid account id");
		await c.var.services.credentials.remove(c.req.param("provider"), credentialId);
		return c.json({ deleted: true });
	})
	.post("/logins", body(StartLoginBody), c => c.json(c.var.services.logins.start(c.req.valid("json").providerId), 202))
	.get("/logins/:id", c => c.json(c.var.services.logins.get(c.req.param("id"))))
	.post("/logins/:id/input", body(LoginAnswerBody), c => {
		const input = c.req.valid("json");
		return c.json(c.var.services.logins.answer(c.req.param("id"), input.inputId, input.value));
	})
	.delete("/logins/:id", c => c.json(c.var.services.logins.cancel(c.req.param("id"))))
	.get("/catalog/providers/:id/models", c => c.json(listModels(c.req.param("id"))));

const tokenRoutes = new Hono<HubEnv>()
	.get("/", c => c.json(c.var.services.tokens.list()))
	.post("/", body(CreateTokenBody), c => c.json(c.var.services.tokens.create(c.req.valid("json").name), 201))
	.delete("/:id", c => {
		if (!c.var.services.tokens.revoke(c.req.param("id"))) throw new HubError(404, "token not found");
		return c.json({ deleted: true });
	});

const apiRoutes = new Hono<HubEnv>()
	.use("*", requireToken)
	.get("/info", c => {
		const { config, runtime } = c.var.services;
		return c.json({
			version: VERSION,
			runtime: runtime.kind,
			sandboxed: runtime.isolated,
			publicUrl: config.publicUrl ?? null,
			github: config.github !== undefined,
			thinkingLevels: THINKING_LEVELS,
		});
	})
	.route("/repos", repoRoutes)
	.route("/environments", environmentRoutes)
	.route("/sessions", sessionRoutes)
	.route("/tokens", tokenRoutes)
	.route("/", settingsRoutes);

/** The route tree; `hc<HubRoutes>` derives the typed client from it. */
const routes = new Hono<HubEnv>().get("/healthz", c => c.json({ ok: true, version: VERSION })).route("/api", apiRoutes);

export type HubRoutes = typeof routes;

/** Bind the routes to live services. */
export function createApp(services: HubServices): Hono<HubEnv> {
	const app = new Hono<HubEnv>();
	app.use("*", async (c, next) => {
		c.set("services", services);
		await next();
	});
	app.use(
		"*",
		secureHeaders({
			// The UI is same-origin scripts and styles only; nothing it renders may load or run anything else.
			contentSecurityPolicy: {
				defaultSrc: ["'self'"],
				scriptSrc: ["'self'"],
				styleSrc: ["'self'"],
				imgSrc: ["'self'", "data:", "blob:"],
				connectSrc: ["'self'"],
				fontSrc: ["'self'"],
				objectSrc: ["'none'"],
				baseUri: ["'none'"],
				formAction: ["'self'"],
				frameAncestors: ["'none'"],
			},
			referrerPolicy: "no-referrer",
			crossOriginEmbedderPolicy: false,
		}),
	);
	if (services.config.cors.origins.length > 0) {
		app.use(
			"/api/*",
			cors({ origin: services.config.cors.origins, allowHeaders: ["Authorization", "Content-Type"], maxAge: 600 }),
		);
	}
	app.onError((error, c) => {
		if (error instanceof HubError) return c.json({ error: error.message }, error.status);
		if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
		if (error instanceof RpcCommandError) return c.json({ error: `agent: ${error.message}` }, 502);
		if (error instanceof SyntaxError) return c.json({ error: "request body is not valid JSON" }, 400);
		logger.error("hub: request failed", {
			path: c.req.path,
			error: error instanceof Error ? error.stack : String(error),
		});
		return c.json({ error: "internal error" }, 500);
	});
	app.notFound(c => c.json({ error: "not found" }, 404));
	app.route("/", routes);
	app.all(`${BROKER_PROXY_PREFIX}/*`, async c => {
		const response = await proxyBrokerRequest(c, services.credentials);
		return response ?? rejectCredential(c, "missing or invalid session token");
	});
	if (services.ui !== false) {
		app.get("/", async () => uiResponse((await uiBundle()).index, "revalidate"));
		app.get("/ui/:file", async c => {
			const file = (await uiBundle()).assets.get(c.req.param("file"));
			return file ? uiResponse(file, "immutable") : c.json({ error: "not found" }, 404);
		});
		for (const name of ["manifest.webmanifest", "icon.svg"]) {
			app.get(`/${name}`, async c => {
				const file = (await uiBundle()).root.get(name);
				return file ? uiResponse(file, "revalidate") : c.json({ error: "not found" }, 404);
			});
		}
	}
	return app;
}
