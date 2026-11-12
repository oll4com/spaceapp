import { describe, expect, it } from "vitest";
import { unknownRefs, unknownRefsLine } from "../src/nous/named-refs.js";

describe("unknownRefs (12/11 REVIEW 1041: Bob's card that never existed)", () => {
  it("names the notification ids and workspace paths that do not exist, once each", async () => {
    // Only paths under the agent workspace are mentions; this made-up one is missing.
    const real = "/var/lib/spaceapp-user/agent-workspace/reports/nonexistent-20261113/report.json";
    const text = `Card notification:real000001 and notification:gone000001 (again notification:gone000001); see ${real} and artifact:abcdef12.`;
    const refs = await unknownRefs(text, async (id) => id === "notification:real000001");
    expect(refs).toEqual(["notification:gone000001", real]);
    expect(unknownRefsLine(refs)).toBe(`⚠ Not found in Space: notification:gone000001, ${real}. Check these before acting on this answer.`);
    expect(await unknownRefs("Nothing named here.", async () => false)).toEqual([]);
    // A lookup that fails is not called missing.
    expect(await unknownRefs("notification:err0000001", async () => { throw new Error("db down"); })).toEqual([]);
  });
});
