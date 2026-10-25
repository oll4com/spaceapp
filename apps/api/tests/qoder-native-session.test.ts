import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "@space/contracts";
import { buildCliSpawnArgs } from "../src/cli-terminal.js";
import { qoderNativeSessionId, qoderNativeSessionIdPattern } from "../src/qoder-native-session.js";

const qoder = { id: "cli:qoder", commandName: "qoder-vscode-parity" } as AgentRuntime;

describe("Qoder exact native sessions", () => {
  it("names one stable UUID per Space session", () => {
    const first = qoderNativeSessionId("cli_session:alpha");
    expect(first).toMatch(qoderNativeSessionIdPattern);
    expect(qoderNativeSessionId("cli_session:alpha")).toBe(first);
    expect(qoderNativeSessionId("cli_session:beta")).not.toBe(first);
  });

  it("starts fresh under that id and resumes the recorded or derived session exactly", () => {
    const sessionId = "cli_session:alpha";
    const derived = qoderNativeSessionId(sessionId);
    expect(buildCliSpawnArgs(qoder, { sessionId, codexThreadId: null, modelId: null, launchMode: "FRESH" }))
      .toEqual(["--session-id", derived]);
    expect(buildCliSpawnArgs(qoder, { sessionId, codexThreadId: null, modelId: null, launchMode: "RESUME" }))
      .toEqual(["-r", derived]);
    const recorded = qoderNativeSessionId("cli_session:source-task");
    expect(buildCliSpawnArgs(qoder, { sessionId, codexThreadId: null, modelId: null, launchMode: "RESUME", nativeTaskRef: recorded }))
      .toEqual(["-r", recorded]);
    expect(buildCliSpawnArgs(qoder, { sessionId, codexThreadId: null, modelId: null, launchMode: "RESUME", nativeTaskRef: "../etc" }))
      .toEqual(["-r", derived]);
  });
});
