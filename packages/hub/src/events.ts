/**
 * Per-session event log: a bounded ring of everything the phone may render,
 * numbered so a reconnecting client resumes from the last `seq` it saw.
 *
 * Durable history is the omp transcript; this buffer only bridges gaps. A
 * client whose `since` predates the ring gets `truncated: true` and reloads
 * the transcript before following live events.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	RpcExtensionUIRequest,
	RpcPromptResultFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SessionStatus } from "./store";

/** omp session events as forwarded: `message_update` keeps the full message and drops the token delta. */
export type StreamedAgentEvent =
	| Exclude<AgentSessionEvent, { type: "message_update" }>
	| { type: "message_update"; message: AgentMessage };

export type HubEventBody =
	| { kind: "status"; status: SessionStatus; error?: string | null }
	| { kind: "agent"; event: StreamedAgentEvent }
	| { kind: "ui_request"; request: RpcExtensionUIRequest }
	| { kind: "ui_resolved"; id: string }
	| { kind: "prompt_result"; result: RpcPromptResultFrame }
	| { kind: "settled" }
	| { kind: "subagent_lifecycle"; payload: RpcSubagentLifecycleFrame["payload"] }
	| { kind: "subagent_progress"; payload: RpcSubagentProgressFrame["payload"] }
	| { kind: "log"; source: "setup" | "build" | "publish" | "agent"; line: string };

export type HubEvent = HubEventBody & { seq: number; at: number };

export class EventLog {
	readonly #capacity: number;
	readonly #ring: (HubEvent | undefined)[];
	readonly #listeners = new Set<(event: HubEvent) => void>();
	#next = 1;

	constructor(capacity: number) {
		this.#capacity = capacity;
		this.#ring = Array.from({ length: capacity });
	}

	get lastSeq(): number {
		return this.#next - 1;
	}

	append(body: HubEventBody): HubEvent {
		const event = { ...body, seq: this.#next++, at: Date.now() } as HubEvent;
		this.#ring[event.seq % this.#capacity] = event;
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// A broken subscriber must not stop delivery to the others.
			}
		}
		return event;
	}

	/** Events after `since`, oldest first; `truncated` when some were already overwritten. */
	since(since: number): { events: HubEvent[]; truncated: boolean } {
		const oldest = Math.max(1, this.#next - this.#capacity);
		const from = Math.max(since + 1, oldest);
		const events: HubEvent[] = [];
		for (let seq = from; seq < this.#next; seq++) {
			const event = this.#ring[seq % this.#capacity];
			if (event?.seq === seq) events.push(event);
		}
		return { events, truncated: since + 1 < oldest };
	}

	subscribe(listener: (event: HubEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	get subscriberCount(): number {
		return this.#listeners.size;
	}
}
