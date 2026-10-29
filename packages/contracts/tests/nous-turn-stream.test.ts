import { describe, expect, it } from "vitest";
import { createNousTurnReader, NOUS_TURN_MAX_OUTPUT_BYTES, type NousTurnEvent } from "../src/nous-turn-stream.js";

const result = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", result: "Done.", num_turns: 3, total_cost_usd: 0.42, modelUsage: { "claude-sonnet-5-5": { inputTokens: 10 } }, ...extra });
const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });

describe("a Nous turn's output, read the same in the worker and from the CLI container", () => {
  it("streams the draft and gives the result record, across chunk borders", () => {
    const events: NousTurnEvent[] = [];
    const reader = createNousTurnReader(true, (event) => events.push(event));
    const out = [JSON.stringify({ type: "stream_event", event: { type: "message_start" } }), delta("Όλα "), delta("κινούνται."), result()].join("\n") + "\n";
    for (let at = 0; at < out.length; at += 7) expect(reader.push(out.slice(at, at + 7))).toBeNull();
    expect(events).toEqual([{ start: true }, { text: "Όλα " }, { text: "κινούνται." }]);
    expect(reader.finish(0, "")).toEqual({ text: "Done.", isError: false, turns: 3, costUsd: 0.42, tokens: { "claude-sonnet-5-5": { inputTokens: 10 } } });
  });

  it("reads a plain JSON answer, and stops one over the limit", () => {
    const plain = createNousTurnReader(false);
    expect(plain.push(`${result({ is_error: true, subtype: "error_max_turns", result: "" })}\n`)).toBeNull();
    expect(plain.finish(1, "")).toMatchObject({ text: "Claude Code stopped (error_max_turns).", isError: true });
    expect(createNousTurnReader(false).push("x".repeat(NOUS_TURN_MAX_OUTPUT_BYTES + 1))).toBe("Claude Code's answer exceeded the output limit.");
  });

  it("drops an oversized tool line but fails on an oversized result record", () => {
    const reader = createNousTurnReader(true);
    expect(reader.push(`{"type":"user","image":"${"A".repeat(NOUS_TURN_MAX_OUTPUT_BYTES)}"}\n${result()}\n`)).toBeNull();
    expect(reader.finish(0, "").text).toBe("Done.");
    expect(createNousTurnReader(true).push(`{"type":"result","result":"${"B".repeat(NOUS_TURN_MAX_OUTPUT_BYTES)}"}\n`)).toBe("Claude Code's answer exceeded the output limit.");
  });

  it("names a quota stop, else the first line that says something", () => {
    const quota = createNousTurnReader(true);
    quota.push(`${result()}\n`);
    expect(() => quota.finish(1, "warn\nClaude Code has no available tokens/quota right now: the account quota is exhausted.\n")).toThrow(/^Claude Code has no available tokens\/quota/);
    // A finished turn may quote a quota report: only a failed run is a quota stop.
    const done = createNousTurnReader(true);
    done.push(`${result()}\n`);
    expect(done.finish(0, "no available tokens/quota").text).toBe("Done.");
    expect(() => createNousTurnReader(true).finish(77, "sudo: unable to mkdir /run/sudo\nClaude Code is not signed in.\n")).toThrow("Claude Code is not signed in.");
    expect(() => createNousTurnReader(false).finish(9, "")).toThrow("Claude Code exited with code 9.");
  });
});
