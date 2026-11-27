import { describe, expect, test } from "bun:test";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

function fakeAgent() {
	const exited = Promise.withResolvers<number>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const written: unknown[] = [];
	const frameWaiters: Array<(frame: unknown) => void> = [];
	let output!: ReadableStreamDefaultController<Uint8Array>;
	const proc: RpcAgentProcess = {
		stdin: {
			write(data: string | Uint8Array) {
				const text = typeof data === "string" ? data : decoder.decode(data);
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					const frame: unknown = JSON.parse(line);
					written.push(frame);
					frameWaiters.shift()?.(frame);
				}
				return text.length;
			},
		},
		stdout: new ReadableStream<Uint8Array>({
			start(controller) {
				output = controller;
				controller.enqueue(encoder.encode('{"type":"ready"}\n'));
			},
		}),
		peekStderr: () => "",
		kill: () => exited.resolve(0),
		exited: exited.promise,
	};
	return {
		proc,
		written,
		nextFrame(): Promise<unknown> {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			frameWaiters.push(resolve);
			return promise;
		},
		emit(frame: unknown) {
			output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		},
	};
}

describe("RpcClient extension UI host surface", () => {
	test("delivers dialogs to subscribers and writes the host's answer back to the agent", async () => {
		const agent = fakeAgent();
		const client = new RpcClient({ spawn: () => agent.proc });
		try {
			await client.start();
			const received = Promise.withResolvers<{ id: string; method: string }>();
			const unsubscribe = client.onExtensionUIRequest(request => received.resolve(request));
			agent.emit({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Run?", message: "rm -rf" });
			const request = await received.promise;
			unsubscribe();
			expect(request).toMatchObject({ id: "dlg-1", method: "confirm" });

			const answer = agent.nextFrame();
			expect(client.respondExtensionUI({ type: "extension_ui_response", id: "dlg-1", confirmed: true })).toBe(true);
			expect(await answer).toEqual({ type: "extension_ui_response", id: "dlg-1", confirmed: true });
		} finally {
			await client.stop();
		}
		// A late answer after the agent stopped is dropped instead of throwing out of a detached UI callback.
		expect(client.respondExtensionUI({ type: "extension_ui_response", id: "dlg-2", cancelled: true })).toBe(false);
	});

	test("setAskDialog sends the opt-in and reports the agent's acknowledged state", async () => {
		const agent = fakeAgent();
		const client = new RpcClient({ spawn: () => agent.proc });
		try {
			await client.start();
			const sent = agent.nextFrame();
			const result = client.setAskDialog(true);
			const frame = (await sent) as { id: string; type: string; enabled: boolean };
			expect(frame).toMatchObject({ type: "set_ask_dialog", enabled: true });
			agent.emit({
				type: "response",
				id: frame.id,
				command: "set_ask_dialog",
				success: true,
				data: { enabled: true },
			});
			expect(await result).toBe(true);
		} finally {
			await client.stop();
		}
	});
});
