import { describe, expect, it } from "vitest";
import { SessionRecordParser } from "../src/sync/session-parser.js";
import { shouldResetCursor, splitCompleteLines } from "../src/sync/session-sync.js";

describe("desktop session parsing", () => {
  it("keeps a partially written JSONL record until the newline arrives", () => {
    const first = splitCompleteLines("", '{"type":"session_meta"');
    expect(first.lines).toEqual([]);
    const second = splitCompleteLines(first.remainder, ',"payload":{"id":"t1"}}\nnext');
    expect(second.lines).toEqual(['{"type":"session_meta","payload":{"id":"t1"}}']);
    expect(second.remainder).toBe("next");
  });

  it("resets the incremental cursor after rotation or truncation", () => {
    expect(shouldResetCursor("1:2:3", "1:2:3", 100, 80)).toBe(false);
    expect(shouldResetCursor("1:2:3", "1:9:10", 100, 80)).toBe(true);
    expect(shouldResetCursor("1:2:3", "1:2:3", 20, 80)).toBe(true);
  });

  it("maps session metadata, turns and messages while ignoring unknown records", () => {
    const parser = new SessionRecordParser();
    const meta = parser.parse(JSON.stringify({ timestamp: "2026-07-25T10:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "D:\\repo" } }));
    expect(meta[0]?.thread?.id).toBe("thread-1");

    parser.parse(JSON.stringify({ timestamp: "2026-07-25T10:00:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: "D:\\repo", model: "gpt-test", effort: "high" } }));
    const started = parser.parse(JSON.stringify({ timestamp: "2026-07-25T10:00:02Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }));
    expect(started[0]?.thread?.state).toBe("running");

    const message = parser.parse(JSON.stringify({ timestamp: "2026-07-25T10:00:03Z", type: "event_msg", payload: { type: "user_message", message: "Fix the test" } }));
    expect(message.find((entry) => entry.item)?.item?.kind).toBe("user-message");
    expect(message.find((entry) => entry.thread)?.thread?.title).toBe("Fix the test");

    expect(parser.parse(JSON.stringify({ type: "future_record", payload: { anything: true } }))).toEqual([]);
  });

  it("deduplicates equivalent event and response messages", () => {
    const parser = new SessionRecordParser();
    parser.parse(JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd: "D:\\repo" } }));
    parser.parse(JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1" } }));
    const first = parser.parse(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Done" } }));
    const second = parser.parse(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } }));
    expect(first.some((entry) => entry.item?.kind === "agent-message")).toBe(true);
    expect(second).toEqual([]);
  });
});
