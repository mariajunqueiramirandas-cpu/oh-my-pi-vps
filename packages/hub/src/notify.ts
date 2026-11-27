/** Push notifications for "finished", "needs input" and "failed" moments. */
import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedHubConfig } from "./config";

export interface Notification {
	title: string;
	message: string;
	/** ntfy priority: 1 (min) … 5 (max). */
	priority?: 1 | 2 | 3 | 4 | 5;
	tags?: string[];
	/** URL opened when the notification is tapped. */
	click?: string;
}

export interface Notifier {
	notify(notification: Notification): Promise<void>;
}

export const nullNotifier: Notifier = { notify: async () => {} };

/** Publishes through ntfy's JSON API, which carries UTF-8 titles that headers cannot. */
export class NtfyNotifier implements Notifier {
	readonly #server: string;
	readonly #topic: string;
	readonly #token: string | undefined;

	constructor(options: { server: string; topic: string; token?: string }) {
		this.#server = options.server.replace(/\/+$/, "");
		this.#topic = options.topic;
		this.#token = options.token;
	}

	async notify(notification: Notification): Promise<void> {
		try {
			const response = await fetch(`${this.#server}/`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
				},
				body: JSON.stringify({ topic: this.#topic, ...notification }),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) logger.warn("hub: ntfy rejected a notification", { status: response.status });
		} catch (error) {
			logger.warn("hub: ntfy notification failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export function createNotifier(config: ResolvedHubConfig["notify"]): Notifier {
	const ntfy = config?.ntfy;
	if (!ntfy) return nullNotifier;
	const token = ntfy.tokenEnv ? process.env[ntfy.tokenEnv] : undefined;
	return new NtfyNotifier({ server: ntfy.server, topic: ntfy.topic, token });
}
