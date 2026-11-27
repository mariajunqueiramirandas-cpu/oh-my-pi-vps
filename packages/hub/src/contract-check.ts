/**
 * Compile-time proof that the routes answer with what `contract.ts` promises
 * and accept what the web UI sends. Nothing here runs; `bun check` fails when
 * a route's response stops fitting the contract.
 */
import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import type * as Wire from "./contract";
import type { StreamFrame } from "./server/app";
import type { HubRoutes } from "./server/app";

/** Compiles only when `Actual` can be used where `Promised` is expected. */
type Fits<Actual extends Promised, Promised> = Actual;
type Ok<Endpoint> = InferResponseType<Endpoint, 200>;
type Body<Endpoint> = InferRequestType<Endpoint> extends { json: infer Json } ? Json : never;

/** Never called: it exists so the type checker evaluates the assertions below. */
export function assertContractConformance() {
	const client = hc<HubRoutes>("");
	const session = client.api.sessions[":id"];
	return [] as unknown as [
		Fits<Ok<typeof client.api.info.$get>, Wire.HubInfo>,
		Fits<Ok<typeof client.api.sessions.$get>, Wire.SessionView[]>,
		Fits<InferResponseType<typeof client.api.sessions.$post, 202>, Wire.SessionView>,
		Fits<Ok<typeof session.$get>, Wire.SessionView>,
		Fits<Ok<typeof session.start.$post>, Wire.SessionView>,
		Fits<Ok<typeof session.stop.$post>, Wire.SessionView>,
		Fits<Ok<typeof session.messages.$get>, Wire.MessagesResult>,
		Fits<Ok<typeof session.events.$get>, { events: Wire.HubEvent[]; truncated: boolean; lastSeq: number }>,
		Fits<Ok<typeof session.diff.$get>, Wire.DiffResult>,
		Fits<Ok<typeof session.publish.$post>, Wire.PublishResult>,
		Fits<Ok<(typeof session)["pull-request"]["$post"]>, Wire.PullRequestResult>,
		Fits<Ok<typeof session.bash.$post>, Wire.ShellResult>,
		Fits<Ok<typeof session.ticket.$post>, { ticket: string; expiresAt: number }>,
		Fits<Ok<typeof client.api.repos.$get>, Wire.RepoView[]>,
		Fits<InferResponseType<typeof client.api.repos.$post, 202>, Wire.RepoView>,
		Fits<Ok<typeof client.api.environments.$get>, Wire.EnvironmentView[]>,
		Fits<Ok<(typeof client.api.environments)[":id"]["$put"]>, Wire.EnvironmentView>,
		Fits<Ok<typeof client.api.profile.$get>, Wire.AgentProfile>,
		Fits<Ok<typeof client.api.profile.$put>, Wire.AgentProfile>,
		Fits<Ok<typeof client.api.profile.apply.$post>, { stopped: number }>,
		Fits<Ok<typeof client.api.secrets.$get>, Wire.SecretInfo[]>,
		Fits<Ok<(typeof client.api.secrets)[":name"]["$put"]>, Wire.SecretInfo>,
		Fits<Ok<typeof client.api.catalog.providers.$get>, Wire.ProviderInfo[]>,
		Fits<Ok<(typeof client.api.catalog.providers)[":id"]["models"]["$get"]>, Wire.ModelInfo[]>,
		Fits<Ok<typeof client.api.tokens.$get>, Wire.TokenInfo[]>,
		Fits<InferResponseType<typeof client.api.tokens.$post, 201>, { token: string; info: Wire.TokenInfo }>,
		Fits<Ok<typeof client.api.subscriptions.$get>, Wire.SubscriptionProvider[]>,
		Fits<InferResponseType<typeof client.api.logins.$post, 202>, Wire.LoginView>,
		Fits<Ok<(typeof client.api.logins)[":id"]["$get"]>, Wire.LoginView>,
		Fits<Ok<(typeof client.api.logins)[":id"]["input"]["$post"]>, Wire.LoginView>,
		Fits<Ok<(typeof client.api.logins)[":id"]["$delete"]>, Wire.LoginView>,
		// What the UI sends must be what the routes accept.
		Fits<Wire.CreateSessionInput, Body<typeof client.api.sessions.$post>>,
		Fits<Wire.PromptInput, Body<typeof session.prompt.$post>>,
		Fits<{ requestId: string; answer: Wire.DialogAnswer }, Body<typeof session.respond.$post>>,
		Fits<Wire.ProfilePatch, Body<typeof client.api.profile.$put>>,
		// The stream is not a typed route; its frames are checked directly.
		Fits<StreamFrame, Wire.StreamFrame>,
	];
}
