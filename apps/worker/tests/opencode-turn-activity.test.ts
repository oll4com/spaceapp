import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { classifyOpenCodeExecutorFailure, runOpenCodeAgentTurn } from "../src/activities.js";
import { buildCodexAppServerTurnWorkflowId } from "../src/ids.js";

// The OpenCode activity sends a non-idempotent prompt and runs with Temporal
// maximumAttempts 1. These checks pin its fail-closed paths: every refusal
// records a FAILED durable run with a reason and never reaches the network.
let stateRoot: string;
beforeEach(async () => { stateRoot = await mkdtemp(join(tmpdir(), "space-opencode-turn-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(stateRoot, { recursive: true, force: true });
});

function executionFixture(providerSessionId: string | null = "ses_fixture123") {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "OpenCode turn fixture", initialPaneCount: 1 });
  const pane = store.listPanes(room.id)[0]!;
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "OpenCode turn",
    selectedProviderId: "cli:opencode", selectedProviderName: "OpenCode", selectedModelId: null,
    selectedModelName: null, selectedModelConfigId: null, selectedReasoningKey: null, selectedToolIds: [] });
  const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Fixture prompt" });
  const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: "Fixture prompt",
    providerId: "cli:opencode", ...(providerSessionId ? { providerSessionId } : {}),
    agentSessionId: session.sessionId, agentUserMessageId: user.messageId,
    agentAssistantMessageId: response.messageId, traceId: "trace:opencode-turn", selectedToolIds: [] });
  store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
    workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
    responseMessageId: response.messageId });
  return { store, session, input };
}

describe("OpenCode turn activity", () => {
  it("fails closed when OpenCode turns are disabled", async () => {
    const { store, session, input } = executionFixture();
    const fetchImpl = vi.fn();
    const result = await runOpenCodeAgentTurn(input, { env: {}, completionStore: store, fetchImpl: fetchImpl as never });
    expect(result.status).toBe("FAILED");
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({ status: "FAILED", errorCode: "OPENCODE_TURNS_DISABLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a provider session before any network request", async () => {
    const { store, session, input } = executionFixture(null);
    const fetchImpl = vi.fn();
    const result = await runOpenCodeAgentTurn(input, {
      env: { SPACE_ENABLE_OPENCODE_TURNS: "true", SPACE_OPENCODE_STATE_ROOT: stateRoot },
      completionStore: store, fetchImpl: fetchImpl as never
    });
    expect(result.status).toBe("FAILED");
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.errorCode).toBe("OPENCODE_SESSION_CONTROL_UNAVAILABLE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records missing live control as a failure instead of sending the prompt", async () => {
    const { store, session, input } = executionFixture();
    const fetchImpl = vi.fn();
    const result = await runOpenCodeAgentTurn(input, {
      env: { SPACE_ENABLE_OPENCODE_TURNS: "true", SPACE_OPENCODE_STATE_ROOT: stateRoot },
      completionStore: store, fetchImpl: fetchImpl as never
    });
    expect(result).toMatchObject({ status: "FAILED", traceId: input.traceId });
    expect(result.message).toContain("unavailable");
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({ status: "FAILED", errorCode: "OPENCODE_SESSION_CONTROL_UNAVAILABLE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs an OpenCode 2 turn: agent, prompt, wait, then the answer to that prompt with its usage", async () => {
    const { store, session, input } = executionFixture();
    const calls: string[] = [];
    const server = createServer((request, response) => {
      const route = `${request.method} ${request.url?.split("?")[0]}`;
      calls.push(route);
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Basic ${Buffer.from("opencode:fixture").toString("base64")}`) { response.statusCode = 401; return response.end("{}"); }
      if (route === "GET /api/info") return response.end(JSON.stringify({ version: "2.0.31" }));
      if (route === "GET /api/session/active") return response.end(JSON.stringify({ data: {} }));
      if (route === "POST /api/session/ses_native123/prompt") return response.end(JSON.stringify({ data: { id: "msg_prompt", type: "user" } }));
      if (route === "GET /api/session/ses_native123/message") return response.end(JSON.stringify({ data: [
        { id: "msg_answer", type: "assistant", time: { created: 3, completed: 4 }, model: { id: "big-pickle", providerID: "opencode" }, finish: "stop",
          content: [{ type: "text", text: "Done." }], tokens: { input: 1_200, output: 300, reasoning: 50, cache: { read: 8_000, write: 100 } } },
        { id: "msg_prompt", type: "user", time: { created: 2 }, text: "Fixture prompt" },
        { id: "msg_older", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "Earlier answer" }], tokens: { input: 1, output: 1 } }
      ] }));
      response.statusCode = request.method === "POST" ? 204 : 404;
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const controlDir = join(stateRoot, "opencode", "space-cli-control");
      await mkdir(controlDir, { recursive: true });
      await writeFile(join(controlDir, "ses_fixture123.json"), JSON.stringify({ version: 1, spaceSessionId: "ses_fixture123",
        nativeSessionId: "ses_native123", serverPort: (server.address() as AddressInfo).port, serverHost: "127.0.0.1",
        serverNetwork: "host", serverUsername: "space-opencode", serverPassword: "fixture" }));
      const result = await runOpenCodeAgentTurn(input, {
        env: { SPACE_ENABLE_OPENCODE_TURNS: "true", SPACE_OPENCODE_STATE_ROOT: stateRoot },
        completionStore: store, fetchImpl: fetch
      });
      expect(result).toMatchObject({ status: "COMPLETED", message: "Done." });
      expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
        "POST /api/session/ses_native123/agent", "POST /api/session/ses_native123/prompt", "POST /api/experimental/session/ses_native123/wait"
      ]);
      expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage).toMatchObject({
        status: "MEASURED", inputTokens: 9_300, outputTokens: 350, totalTokens: 9_650, model: "opencode/big-pickle"
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("classifies executor timeouts separately from other failures without leaking error objects", () => {
    expect(classifyOpenCodeExecutorFailure(new Error("request timed out after 60000ms"))).toMatchObject({
      reasonCode: "OPENCODE_TURN_TIMEOUT", metadata: { executorFailure: { kind: "timeout", name: "Error" } }
    });
    const generic = classifyOpenCodeExecutorFailure(new TypeError("socket hang up"));
    expect(generic).toMatchObject({ reasonCode: "OPENCODE_EXECUTOR_FAILED", message: "socket hang up",
      metadata: { executorFailure: { kind: "unknown", name: "TypeError" } } });
    expect(classifyOpenCodeExecutorFailure("not an error")).toMatchObject({
      reasonCode: "OPENCODE_EXECUTOR_FAILED", message: "OpenCode worker execution failed before completion."
    });
  });
});
