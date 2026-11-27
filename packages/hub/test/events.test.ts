import { describe, expect, test } from "bun:test";
import { EventLog } from "../src/events";

describe("event log", () => {
	test("resumes after any retained seq and flags a gap once the ring has wrapped past it", () => {
		const log = new EventLog(3);
		for (let index = 0; index < 5; index++) log.append({ kind: "settled" });

		expect(log.since(3)).toEqual({
			events: [expect.objectContaining({ seq: 4 }), expect.objectContaining({ seq: 5 })],
			truncated: false,
		});
		// seq 3 is the oldest retained event, so a client that saw seq 2 missed nothing.
		expect(log.since(2).truncated).toBe(false);
		expect(log.since(2).events.map(event => event.seq)).toEqual([3, 4, 5]);
		// A client that saw only seq 1 missed seq 2 and must reload the transcript.
		expect(log.since(1).truncated).toBe(true);
		expect(log.since(5).events).toEqual([]);
	});
});
