import { describe, expect, it } from "vitest";
import { cliResourceHealth } from "../src/cli-resource-health.js";

const now = 1_000_000;
const snapshot = { version: 1, sampledAt: now / 1000, status: "PROTECTED", sessions: [{
  cliSessionId: "cli_session:test", paneId: "pane:test", runtimeId: "cli:gemini", mode: "LIMITED", writeBps: 16000000
}], errors: [], events: [] };
describe("CLI resource health", () => {
  it("surfaces limiting to the existing health warnings with task identity", async () => {
    const result = await cliResourceHealth(async () => JSON.stringify(snapshot), now);
    expect(result.status).toBe("warning");
    expect(result.detail).toContain("1 CLI task");
    expect(result.values).toContainEqual({label: "Limited task", value: "cli:gemini · pane:test"});
  });
  it("does not claim protection when monitoring is stale, failed or malformed", async () => {
    for (const value of ["not json", JSON.stringify({...snapshot, sampledAt: 1}), JSON.stringify({...snapshot, status: "DEGRADED"})]) {
      expect((await cliResourceHealth(async () => value, now)).status).not.toBe("healthy");
    }
    expect((await cliResourceHealth(async () => { throw new Error("private path"); }, now)).detail).not.toContain("private path");
  });
  it("reports a healthy guard and rejects arbitrary text in task identifiers", async () => {
    expect((await cliResourceHealth(async () => JSON.stringify({...snapshot, sessions: []}), now)).status).toBe("healthy");
    const result = await cliResourceHealth(async () => JSON.stringify({...snapshot, sessions: [{...snapshot.sessions[0], paneId: "private content"}]}), now);
    expect(JSON.stringify(result)).not.toContain("private content");
    expect(result.status).toBe("unavailable");
  });
});
