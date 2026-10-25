import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { runCliAgentTurn } from "../src/activities.js";
import { buildCodexAppServerTurnWorkflowId } from "../src/ids.js";

const spawn = vi.hoisted(() => vi.fn());
// Only the privileged process boundary is replaced. Parsing, byte accounting,
// workflow result, durable run and response persistence all execute real code.
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn
}));

function processFixture(chunks: Buffer[]) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => true)
  });
  child.stdin.on("finish", () => {
    for (const chunk of chunks) child.stdout.write(chunk);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
  });
  spawn.mockReturnValue(child);
  return child;
}

function executionFixture(prompt = "Answer the fixture question.") {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Offline output budget", initialPaneCount: 1 });
  const pane = store.listPanes(room.id)[0]!;
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Output budget",
    selectedProviderId: "cli:deepseek", selectedProviderName: "DeepSeek", selectedModelId: null,
    selectedModelName: null, selectedModelConfigId: null, selectedReasoningKey: null, selectedToolIds: [] });
  const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: prompt });
  const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt,
    providerId: "cli:deepseek", agentSessionId: session.sessionId, agentUserMessageId: user.messageId,
    agentAssistantMessageId: response.messageId, traceId: "trace:output-budget", selectedToolIds: [] });
  store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
    workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
    responseMessageId: response.messageId });
  return { store, session, input, response };
}

const env = { SPACE_ENABLE_CLI_CHAT_TURNS: "true", SPACE_CLI_CHAT_TURN_MAX_OUTPUT_BYTES: "5000" };
beforeEach(() => spawn.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("CLI chat output admission", () => {
  it.each([
    ["ASCII", [Buffer.from("x".repeat(5001))]],
    ["multibyte text", [Buffer.from("α".repeat(2501))]],
    ["several output chunks", [Buffer.from("x".repeat(2500)), Buffer.from("x".repeat(2500)), Buffer.from("9")]]
  ])("fails oversized %s instead of persisting a truncated success", async (_name, chunks) => {
    const child = processFixture(chunks);
    const { store, session, input, response } = executionFixture();
    const result = await runCliAgentTurn(input, { env, completionStore: store });
    expect(result.status).toBe("FAILED");
    const run = store.getLatestSpaceAgentRun(session.sessionId)!;
    expect(run).toMatchObject({ status: "FAILED", errorCode: "CLI_CHAT_TURN_OUTPUT_TOO_LARGE" });
    expect(store.listSpaceAgentMessages(session.sessionId).find(item => item.messageId === response.messageId)?.status)
      .not.toBe("COMPLETED");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("preserves an exact-byte-limit answer across split UTF-8 chunks", async () => {
    const bytes = Buffer.from("α".repeat(2500));
    processFixture([bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)]);
    const { store, session, input, response } = executionFixture();
    expect((await runCliAgentTurn(input, { env, completionStore: store })).status).toBe("COMPLETED");
    const message = store.listSpaceAgentMessages(session.sessionId).find(item => item.messageId === response.messageId)!;
    expect(message.content).toBe("α".repeat(2500));
    expect(Buffer.byteLength(message.content)).toBe(5000);
  });

  it("rejects an oversized Unicode prompt before dispatching a privileged process", async () => {
    const { store, session, input } = executionFixture("α".repeat(2501));
    const result = await runCliAgentTurn(input, { env: { ...env, SPACE_CLI_CHAT_TURN_MAX_PROMPT_BYTES: "5000" }, completionStore: store });
    expect(result.status).toBe("FAILED");
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.errorCode).toBe("CLI_CHAT_TURN_PROMPT_TOO_LARGE");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["before dispatch", "during workspace resolution"])("does not launch a cancelled turn %s", async timing => {
    processFixture([Buffer.from("answer")]);
    const { store, session, input } = executionFixture();
    const controller = new AbortController();
    const reason = new Error("Owned fixture cancelled");
    if (timing === "before dispatch") controller.abort(reason);
    else {
      const getPane = store.getPane.bind(store);
      vi.spyOn(store, "getPane").mockImplementation(paneId => {
        controller.abort(reason);
        return getPane(paneId);
      });
    }
    await expect(runCliAgentTurn(input, { env, completionStore: store, abortSignal: controller.signal }))
      .rejects.toBe(reason);
    expect(spawn).not.toHaveBeenCalled();
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.status).toBe("INTERRUPTED");
  });

  it("correlates worker execution logs without exporting prompts or responses", async () => {
    processFixture([Buffer.from("PRIVATE_RESPONSE")]);
    const { store, input } = executionFixture("PRIVATE_PROMPT");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await runCliAgentTurn(input, { env, completionStore: store });
    const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(records).toEqual([
      expect.objectContaining({ event: "turn.activity", phase: "STARTED", adapter: "CLI_BROKER",
        traceId: input.traceId, workflowId: buildCodexAppServerTurnWorkflowId(input), roomId: input.roomId, paneId: input.paneId }),
      expect.objectContaining({ event: "turn.activity", phase: "FINISHED", status: "COMPLETED",
        traceId: input.traceId, elapsedMs: expect.any(Number), rssBytes: expect.any(Number) })
    ]);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_PROMPT|PRIVATE_RESPONSE/);
  });

  it("correlates cancellation without logging a private abort reason", async () => {
    const { store, input } = executionFixture();
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await expect(runCliAgentTurn(input, { env, completionStore: store, abortSignal: controller.signal })).rejects.toThrow();
    const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(records).toEqual([
      expect.objectContaining({ phase: "STARTED", traceId: input.traceId }),
      expect.objectContaining({ phase: "CANCELLED", traceId: input.traceId, elapsedMs: expect.any(Number) })
    ]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE_ABORT_REASON");
  });

  it("reports a best-effort workflow-row error without exporting database details", async () => {
    processFixture([Buffer.from("answer")]);
    const { store, input } = executionFixture();
    vi.spyOn(store, "recordTurnQueued").mockImplementation(() => { throw new Error("PRIVATE_DATABASE_DETAIL"); });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(JSON.stringify([...info.mock.calls, ...error.mock.calls])).not.toContain("PRIVATE_DATABASE_DETAIL");
    expect(info.mock.calls.map(([value]) => JSON.parse(String(value)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "STATE_RECORD_FAILED", traceId: input.traceId })
    ]));
  });
});
