import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { runCliAgentTurn, runOpenCodeAgentTurn, singleAttemptTurnOutcomeUnknownMessage } from "../src/activities.js";
import { buildCodexAppServerTurnWorkflowId } from "../src/ids.js";

// CLI chat and OpenCode turns send a non-idempotent prompt and run with
// maximumAttempts 1. When their worker shuts down (or the attempt expires),
// Temporal cancels the attempt and no later attempt follows. The turn must end
// with an operator-visible unknown outcome, never RUNNING forever and never
// described as an operator stop. Only the process/HTTP boundaries are faked.
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn
}));
const control = vi.hoisted(() => ({
  readOpenCodeServerControl: vi.fn(), openCodeServerIsHealthy: vi.fn(), readOpenCodeSessionTurnActive: vi.fn()
}));
vi.mock("@space/opencode-control", async (importOriginal) => ({
  ...await importOriginal<typeof import("@space/opencode-control")>(), ...control
}));

beforeEach(() => {
  spawn.mockReset();
  control.readOpenCodeServerControl.mockResolvedValue({ serverHost: "127.0.0.1", serverPort: 4999, serverUsername: "fixture",
    serverPassword: "fixture", nativeSessionId: "ses_fixture123" });
  control.openCodeServerIsHealthy.mockResolvedValue(true);
  control.readOpenCodeSessionTurnActive.mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

function fixture(providerId: string) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Single-attempt turn shutdown", initialPaneCount: 1 });
  const pane = store.listPanes(room.id)[0]!;
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Shutdown",
    selectedProviderId: providerId, selectedProviderName: providerId, selectedModelId: null,
    selectedModelName: null, selectedModelConfigId: null, selectedReasoningKey: null, selectedToolIds: [] });
  const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Fixture prompt" });
  const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: "Fixture prompt", providerId,
    ...(providerId === "opencode" ? { providerSessionId: "ses_fixture123" } : {}),
    agentSessionId: session.sessionId, agentUserMessageId: user.messageId, agentAssistantMessageId: response.messageId,
    traceId: `trace:shutdown-${providerId.replace(/[^a-z]/g, "")}`, selectedToolIds: [] });
  store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
    workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
    responseMessageId: response.messageId });
  const state = () => ({
    run: store.getLatestSpaceAgentRun(session.sessionId),
    response: store.listSpaceAgentMessages(session.sessionId).find((message) => message.messageId === response.messageId),
    session: store.getSpaceAgentSession(session.sessionId)
  });
  return { store, input, state };
}

/** A CLI process that only ends when the activity kills it. */
function hangingProcess(onSpawn: () => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => {
      child.stdout.end(); child.stderr.end();
      queueMicrotask(() => child.emit("close", null));
      return true;
    })
  });
  spawn.mockImplementation(() => { queueMicrotask(onSpawn); return child; });
  return child;
}

describe("single-attempt turns after a worker shutdown", () => {
  it("pins maximumAttempts 1 for the CLI chat and OpenCode turn activities", () => {
    // The activity code below relies on this: no attempt follows a shutdown.
    const source = readFileSync(new URL("../src/workflows.ts", import.meta.url), "utf8");
    for (const proxy of ["openCodeAgentTurnActivities", "cliChatTurnActivities"]) {
      expect(source).toMatch(new RegExp(`const ${proxy} = proxyActivities<typeof activities>\\(\\{[^}]*retry: \\{\\s*maximumAttempts: 1\\s*\\}`));
    }
  });

  it.each(["WORKER_SHUTDOWN", "TIMED_OUT"])("records an unknown CLI chat outcome on %s instead of an operator stop", async (reason) => {
    const { store, input, state } = fixture("cli:deepseek");
    const controller = new AbortController();
    const child = hangingProcess(() => controller.abort(new Error(reason)));
    await expect(runCliAgentTurn(input, { env: { SPACE_ENABLE_CLI_CHAT_TURNS: "true" }, completionStore: store, abortSignal: controller.signal }))
      .rejects.toThrow(reason);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(state()).toMatchObject({
      run: { status: "INTERRUPTED", errorCode: "TURN_OUTCOME_UNKNOWN", errorMessage: singleAttemptTurnOutcomeUnknownMessage },
      response: { status: "INTERRUPTED", content: singleAttemptTurnOutcomeUnknownMessage },
      session: { status: "READY" }
    });
  });

  it("keeps an operator cancellation of a CLI chat turn recorded as a stop", async () => {
    const { store, input, state } = fixture("cli:deepseek");
    const controller = new AbortController();
    hangingProcess(() => controller.abort(new Error("CANCELLED")));
    await expect(runCliAgentTurn(input, { env: { SPACE_ENABLE_CLI_CHAT_TURNS: "true" }, completionStore: store, abortSignal: controller.signal }))
      .rejects.toThrow("CANCELLED");
    expect(state().run).toMatchObject({ status: "INTERRUPTED", errorCode: "ROOM_AGENT_STOPPED", errorMessage: "Stopped." });
  });

  it("records an unknown OpenCode outcome after the prompt was sent and the worker shut down", async () => {
    const { store, input, state } = fixture("opencode");
    const controller = new AbortController();
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(new URL(url).pathname);
      if (url.endsWith("/interrupt")) return new Response(JSON.stringify({ interrupted: true }), { status: 200 });
      if (url.endsWith("/agent")) return new Response("{}", { status: 200 });
      // The prompt reached the OpenCode server; then the worker shuts down mid-turn.
      controller.abort(new Error("WORKER_SHUTDOWN"));
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(runOpenCodeAgentTurn(input, {
      env: { SPACE_ENABLE_OPENCODE_TURNS: "true" }, completionStore: store, fetchImpl: fetchImpl as never, abortSignal: controller.signal
    })).rejects.toThrow("WORKER_SHUTDOWN");
    // The agent pick, one prompt send, then the bounded server-side interrupt; no second send.
    expect(requests).toEqual(["/api/session/ses_fixture123/agent", "/api/session/ses_fixture123/prompt", "/api/session/ses_fixture123/interrupt"]);
    expect(state()).toMatchObject({
      run: { status: "INTERRUPTED", errorCode: "TURN_OUTCOME_UNKNOWN", errorMessage: singleAttemptTurnOutcomeUnknownMessage },
      response: { status: "INTERRUPTED" },
      session: { status: "READY" }
    });
  });
});
