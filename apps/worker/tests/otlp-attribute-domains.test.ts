import { expect, it } from "vitest";
import { allowlistSpanAttributes } from "../src/tracing/span-attributes.js";
import { parseTraceparent } from "../src/workflows/trace-ids.js";
it("rejects values outside each attribute's domain", () => {
  expect(allowlistSpanAttributes({
    "space.room_id": true, "temporal.activity.attempt": -1,
    "space.duration_ms": 1.5, "space.queue_ms": Infinity,
    "space.outcome": "SECRET", "space.link.kind": "SECRET",
    prompt: "SECRET-PROMPT", filePath: "/home/x", url: "https://x",
    "error.code": "SECRET-ERR", "space.pane_id": "/home/x"
  })).toEqual({});
});
it("accepts only strict nonzero version-00 traceparents", () => {
  const valid = "00-11111111111111111111111111111111-2222222222222222-01";
  expect(parseTraceparent(valid)?.parentId).toBe("2222222222222222");
  for (const value of [null, valid + "-extra", " " + valid, valid.replace("00-", "01-"), valid.replace(/1/g, "0"), valid.replace(/2/g, "0")]) {
    expect(parseTraceparent(value)).toBeNull();
  }
});
