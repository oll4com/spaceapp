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

function processFixture(chunks: Buffer[], stderr = "", exitCode: number | null = 0, signal: NodeJS.Signals | null = null) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => true)
  });
  child.stdin.on("finish", () => {
    for (const chunk of chunks) child.stdout.write(chunk);
    child.stdout.end();
    child.stderr.write(stderr);
    child.stderr.end();
    child.emit("close", exitCode, signal);
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

const receiptPrefix = "SPACE_CLI_TURN_USAGE_V1 ";
const nativeUsage = { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 5 };
describe("Claude broker turn ledger", () => {
  it.each([
    { label: "nonzero exit", code: 7, signal: null },
    { label: "signal termination", code: null, signal: "SIGTERM" as const }
  ])("keeps $label usage UNKNOWN while preserving the existing answer fallback", async ({ code, signal }) => {
    processFixture([Buffer.from("Partial answer.")], receiptPrefix + JSON.stringify({ usage: nativeUsage }) + "\n", code, signal);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:claude";
    expect((await runCliAgentTurn(input, { env, completionStore: store })).status).toBe("COMPLETED");
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Partial answer.");
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage.status).toBe("UNKNOWN");
  });
  it.each([
    ["one reported model", { "claude-reported": {} }, "claude-reported"],
    ["multiple reported models", { "claude-a": {}, "claude-b": {} }, null],
    ["no reported model", {}, null]
  ])("records native usage with %s without changing the answer", async (_label, modelUsage, model) => {
    processFixture([Buffer.from("Answer unchanged.")], receiptPrefix + JSON.stringify({ usage: nativeUsage, modelUsage }) + "\n");
    const { store, session, input } = executionFixture();
    input.providerId = "cli:claude";
    input.modelId = "requested-model";
    expect((await runCliAgentTurn(input, { env, completionStore: store })).status).toBe("COMPLETED");
    const run = store.getLatestSpaceAgentRun(session.sessionId)!;
    expect(run.ledger?.usage).toMatchObject({ status: "MEASURED", inputTokens: 110, cachedInputTokens: 80,
      outputTokens: 5, totalTokens: 115, reasoningOutputTokens: 0, source: "claude-cli:result", model });
    expect(run.ledger?.cost.status).toBe("UNKNOWN");
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
  });
  it("ignores a Claude receipt from another runtime", async () => {
    processFixture([Buffer.from("Answer.")], receiptPrefix + JSON.stringify({ usage: nativeUsage }) + "\n");
    const { store, session, input } = executionFixture();
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage.status).toBe("UNKNOWN");
  });
  it.each([
    ["old wrapper", ""], ["malformed JSON", receiptPrefix + "{bad\n"],
    ["missing usage", receiptPrefix + "{}\n"],
    ["missing counters", receiptPrefix + JSON.stringify({ usage: { input_tokens: 1 } }) + "\n"],
    ["null counter", receiptPrefix + JSON.stringify({ usage: { ...nativeUsage, cache_read_input_tokens: null } }) + "\n"],
    ["zero usage", receiptPrefix + JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) + "\n"],
    ["truncated stderr after a receipt", receiptPrefix + JSON.stringify({ usage: nativeUsage }) + "\n" + "x".repeat(17_000)],
    ["negative usage", receiptPrefix + JSON.stringify({ usage: { ...nativeUsage, input_tokens: -1 } }) + "\n"],
    ["fractional usage", receiptPrefix + JSON.stringify({ usage: { ...nativeUsage, output_tokens: 1.5 } }) + "\n"],
    ["overflow", receiptPrefix + JSON.stringify({ usage: { ...nativeUsage, input_tokens: Number.MAX_SAFE_INTEGER } }) + "\n"],
    ["duplicate receipts", (receiptPrefix + JSON.stringify({ usage: nativeUsage }) + "\n").repeat(2)]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    processFixture([Buffer.from("Answer unchanged.")], stderr);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:claude";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage.status).toBe("UNKNOWN");
  });
});

describe("OpenCode broker turn ledger", () => {
  const receipt = { runtime: "cli:opencode", tokens: { input: 20, output: 5, reasoning: 3, cache: { read: 80, write: 10 } } };
  it("records complete native step usage without borrowing the requested model", async () => {
    processFixture([Buffer.from("Answer unchanged.\n")], receiptPrefix + JSON.stringify(receipt) + "\n");
    const { store, session, input } = executionFixture();
    input.providerId = "cli:opencode";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger).toMatchObject({
      usage: { status: "MEASURED", inputTokens: 110, cachedInputTokens: 80, outputTokens: 8,
        reasoningOutputTokens: 3, totalTokens: 118, model: null, source: "opencode-cli:step_finish" },
      cost: { status: "UNKNOWN" } });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
  });
  it("keeps native nonzero exit usage UNKNOWN while preserving the existing answer fallback", async () => {
    processFixture([Buffer.from("Partial answer.")], receiptPrefix + JSON.stringify(receipt) + "\n", 7);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:opencode";
    expect((await runCliAgentTurn(input, { env, completionStore: store })).status).toBe("COMPLETED");
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Partial answer.");
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage.status).toBe("UNKNOWN");
  });
  it.each([
    {}, { ...receipt, runtime: "cli:gemini" },
    { ...receipt, tokens: { ...receipt.tokens, input: -1 } },
    { ...receipt, tokens: { ...receipt.tokens, reasoning: 0.5 } },
    { ...receipt, tokens: { ...receipt.tokens, input: Number.MAX_SAFE_INTEGER } },
    { ...receipt, tokens: { input: 20, output: 5 } }
  ])("keeps an invalid receipt UNKNOWN", async invalid => {
    processFixture([Buffer.from("Answer.")], receiptPrefix + JSON.stringify(invalid) + "\n");
    const { store, session, input } = executionFixture();
    input.providerId = "cli:opencode";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.getLatestSpaceAgentRun(session.sessionId)?.ledger?.usage.status).toBe("UNKNOWN");
  });
});

// CTX-001: Antigravity's JSON result counters (agy 1.4.12), MEASURED only when its own total fixes how the cache reads are counted.
describe("Gemini broker turn ledger", () => {
  const usage = { input_tokens: 120, output_tokens: 7, thinking_tokens: 30, cache_read_tokens: 100, total_tokens: 157 };
  const receipt = (value: Record<string, unknown>, runtime = "cli:gemini") => receiptPrefix + JSON.stringify({ runtime, usage: value }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:gemini";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it.each([
    ["input counting the cache reads", usage, 120],
    ["input without the cache reads", { ...usage, input_tokens: 20 }, 120]
  ])("records %s without borrowing the requested model", async (_label, value, inputTokens) => {
    expect(await ledgerOf(receipt(value))).toMatchObject({
      usage: { status: "MEASURED", inputTokens, cachedInputTokens: 100, outputTokens: 37, reasoningOutputTokens: 30,
        totalTokens: inputTokens + 37, model: null, source: "gemini-cli:result" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["a total no reading explains", receipt({ ...usage, total_tokens: 999 })],
    ["another runtime's receipt", receipt(usage, "cli:opencode")],
    ["missing counters", receipt({ input_tokens: 1, output_tokens: 1 })],
    ["zero usage (agy's sign-in failure)", receipt({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 })],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt(usage), 7))?.usage.status).toBe("UNKNOWN");
  });
});

// CTX-001: Qwen Code's JSON result counters (0.26.6), per model; MEASURED only when the total fixes how thoughts are counted.
describe("Qwen broker turn ledger", () => {
  // The real binary's counters against a fake OpenAI endpoint (probe 4/11): two calls of 1200 prompt (1000 cached), 50 completion (30 reasoning).
  const tokens = { prompt: 2400, candidates: 100, total: 2500, cached: 2000, thoughts: 60 };
  const receipt = (models: unknown[], runtime = "cli:qwen") => receiptPrefix + JSON.stringify({ runtime, models }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:qwen";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it.each([
    ["an OpenAI-compatible provider's (reasoning inside the completion, thoughts possibly estimated)", [tokens], 100, 0],
    ["Gemini's own (thoughts outside the candidates)", [{ ...tokens, total: 2560 }], 160, 60],
    ["two models summed", [{ ...tokens, prompt: 1200, candidates: 50, total: 1250, cached: 1000, thoughts: 30 },
      { prompt: 1200, candidates: 50, total: 1250, cached: 1000, thoughts: 30 }], 100, 0]
  ])("records %s counters without borrowing the requested model", async (_label, models, outputTokens, reasoningOutputTokens) => {
    expect(await ledgerOf(receipt(models))).toMatchObject({
      usage: { status: "MEASURED", inputTokens: 2400, cachedInputTokens: 2000, outputTokens, reasoningOutputTokens,
        totalTokens: 2400 + outputTokens, model: null, source: "qwen-cli:result" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["a total no reading explains", receipt([{ ...tokens, total: 999 }])],
    ["more cache reads than prompt", receipt([{ ...tokens, cached: 2401 }])],
    ["another runtime's receipt", receipt([tokens], "cli:gemini")],
    ["missing counters", receipt([{ prompt: 1, candidates: 1 }])],
    ["no models", receipt([])],
    ["zero usage", receipt([{ prompt: 0, candidates: 0, total: 0, cached: 0, thoughts: 0 }])],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt([tokens]), 7))?.usage.status).toBe("UNKNOWN");
  });
});

// CTX-001: Reasonix's run summary (`run --metrics`, 2.57.0); MEASURED only when its cache hits and misses make up the prompt.
describe("DeepSeek broker turn ledger", () => {
  // The real binary's summary against a fake Anthropic endpoint (probe 4/11).
  const tokens = { prompt_tokens: 1200, completion_tokens: 50, cache_hit_tokens: 1000, cache_miss_tokens: 200 };
  const receipt = (value: Record<string, unknown>, runtime = "cli:deepseek") => receiptPrefix + JSON.stringify({ runtime, tokens: value }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:deepseek";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it("records Reasonix's counters without borrowing the requested model", async () => {
    expect(await ledgerOf(receipt(tokens))).toMatchObject({
      usage: { status: "MEASURED", inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 50, reasoningOutputTokens: 0,
        totalTokens: 1250, model: null, source: "deepseek-cli:metrics" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["hits and misses that are not the prompt", receipt({ ...tokens, cache_miss_tokens: 201 })],
    ["another runtime's receipt", receipt(tokens, "cli:qwen")],
    ["missing counters", receipt({ prompt_tokens: 1, completion_tokens: 1 })],
    ["zero usage", receipt({ prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 0 })],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt(tokens), 7))?.usage.status).toBe("UNKNOWN");
  });
});

// CTX-001: Kimi Code's session log (2.4.1), summed by the wrapper; MEASURED only when the turn's records equal its steps.
describe("Kimi broker turn ledger", () => {
  // The real binary's two-step turn against a fake endpoint (probe 4/11): 1200 prompt (1000 cached) + 20, then 1300 (1200 cached) + 10.
  const sums = { inputOther: 300, output: 30, inputCacheRead: 2200, inputCacheCreation: 0 };
  const receipt = (value: Record<string, unknown>, runtime = "cli:kimi") => receiptPrefix + JSON.stringify({ runtime, ...value }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:kimi";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it.each([
    ["the turn's own records", { all: sums, turn: sums, steps: sums }, 2500, 30],
    ["the run's other calls too (session scope)", { all: { ...sums, inputOther: 400, output: 40 }, turn: sums, steps: sums }, 2600, 40]
  ])("records %s without borrowing the requested model", async (_label, value, inputTokens, outputTokens) => {
    expect(await ledgerOf(receipt(value))).toMatchObject({
      usage: { status: "MEASURED", inputTokens, cachedInputTokens: 2200, outputTokens, reasoningOutputTokens: 0,
        totalTokens: inputTokens + outputTokens, model: null, source: "kimi-cli:usage.record" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["turn records that are not its steps (a partial log)", receipt({ all: sums, turn: sums, steps: { ...sums, output: 20 } })],
    ["a run that covers less than its turn", receipt({ all: { ...sums, output: 10 }, turn: sums, steps: sums })],
    ["another runtime's receipt", receipt({ all: sums, turn: sums, steps: sums }, "cli:qwen")],
    ["missing counters", receipt({ all: { inputOther: 1 }, turn: { inputOther: 1 }, steps: { inputOther: 1 } })],
    ["zero usage", receipt({ all: { ...sums, inputOther: 0, output: 0, inputCacheRead: 0 }, turn: { ...sums, inputOther: 0, output: 0, inputCacheRead: 0 },
      steps: { ...sums, inputOther: 0, output: 0, inputCacheRead: 0 } })],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt({ all: sums, turn: sums, steps: sums }), 7))?.usage.status).toBe("UNKNOWN");
  });
});

describe("Copilot broker turn ledger", () => {
  // The real binary's two-call turn against a fake endpoint (probe 4/11): 1200 input (1000 cached) + 40 (10 reasoning), a tool call,
  // then 1300 (1200 cached) + 20 (5 reasoning); its session.shutdown totals the same.
  const sums = { count: 2, inputTokens: 2500, outputTokens: 60, cacheReadTokens: 2200, cacheWriteTokens: 0, reasoningTokens: 15 };
  const receipt = (value: Record<string, unknown>, runtime = "cli:copilot") => receiptPrefix + JSON.stringify({ runtime, shutdowns: 1, ...value }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:copilot";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it("records the session's calls when its records and shutdown agree, without borrowing the requested model", async () => {
    expect(await ledgerOf(receipt({ records: sums, shutdown: sums }))).toMatchObject({
      usage: { status: "MEASURED", inputTokens: 2500, cachedInputTokens: 2200, outputTokens: 60, reasoningOutputTokens: 15,
        totalTokens: 2560, model: null, source: "copilot-cli:usage_record" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["records that are not the shutdown's totals (a partial log)", receipt({ records: { ...sums, count: 1, inputTokens: 1200, outputTokens: 40 }, shutdown: sums })],
    ["a call the records miss", receipt({ records: sums, shutdown: { ...sums, count: 3 } })],
    ["no shutdown (the run did not end cleanly)", receipt({ records: sums, shutdowns: 0, shutdown: { ...sums, count: 0 } })],
    ["two shutdowns (a resumed session)", receipt({ records: sums, shutdown: sums, shutdowns: 2 })],
    ["cache counters above the input", receipt({ records: { ...sums, cacheWriteTokens: 400 }, shutdown: { ...sums, cacheWriteTokens: 400 } })],
    ["reasoning above the output", receipt({ records: { ...sums, reasoningTokens: 70 }, shutdown: { ...sums, reasoningTokens: 70 } })],
    ["another runtime's receipt", receipt({ records: sums, shutdown: sums }, "cli:kimi")],
    ["zero usage", receipt({ records: { ...sums, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
      shutdown: { ...sums, count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } })],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt({ records: sums, shutdown: sums }), 7))?.usage.status).toBe("UNKNOWN");
  });
});

describe("Hermes broker turn ledger", () => {
  // The real binary's turn against a fake endpoint (probe 4/11): a tool call, 1100 prompt (900 cached) + 10 (1 reasoning), then
  // 1200 (900) + 20 (2), and the title call 1300 (900) + 30 (3); the usage report's main loop counts the cache in its input, its
  // auxiliary block and the session's state.db row leave it out.
  const main = { api_calls: 2, input_tokens: 2300, output_tokens: 30, cache_read_tokens: 1800, cache_write_tokens: 0, reasoning_tokens: 3, total_tokens: 2330 };
  const auxiliary = { api_calls: 1, input_tokens: 400, output_tokens: 30, cache_read_tokens: 900, cache_write_tokens: 0, reasoning_tokens: 3 };
  const stored = { api_calls: 2, input_tokens: 500, output_tokens: 30, cache_read_tokens: 1800, cache_write_tokens: 0, reasoning_tokens: 3 };
  const receipt = (value: Record<string, unknown> = {}, runtime = "cli:hermes") =>
    receiptPrefix + JSON.stringify({ runtime, main, auxiliary, stored, children: 0, ...value }) + "\n";
  const ledgerOf = async (stderr: string, code = 0) => {
    processFixture([Buffer.from("Answer unchanged.\n")], stderr, code);
    const { store, session, input } = executionFixture();
    input.providerId = "cli:hermes";
    input.modelId = "requested-model";
    await runCliAgentTurn(input, { env, completionStore: store });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)?.content).toBe("Answer unchanged.");
    return store.getLatestSpaceAgentRun(session.sessionId)?.ledger;
  };
  it("records the main loop and the auxiliary calls when the session row agrees, without borrowing the requested model", async () => {
    expect(await ledgerOf(receipt())).toMatchObject({
      usage: { status: "MEASURED", inputTokens: 3600, cachedInputTokens: 2700, outputTokens: 60, reasoningOutputTokens: 6,
        totalTokens: 3660, model: null, source: "hermes-cli:usage-file" },
      cost: { status: "UNKNOWN" } });
  });
  it.each([
    ["a subagent's calls (in neither source)", receipt({ children: 1 })],
    ["a session row that is not the main loop", receipt({ stored: { ...stored, output_tokens: 20 } })],
    ["a session row with another call count", receipt({ stored: { ...stored, api_calls: 1 } })],
    ["no session row", receipt({ stored: null })],
    ["a report without its auxiliary block", receipt({ auxiliary: null })],
    ["a main total that is not input + output", receipt({ main: { ...main, total_tokens: 4130 } })],
    ["reasoning above the output", receipt({ main: { ...main, reasoning_tokens: 31 }, stored: { ...stored, reasoning_tokens: 31 } })],
    ["another runtime's receipt", receipt({}, "cli:kimi")],
    ["old wrapper", ""]
  ])("keeps %s UNKNOWN", async (_label, stderr) => {
    expect((await ledgerOf(stderr))?.usage.status).toBe("UNKNOWN");
  });
  it("keeps a native nonzero exit UNKNOWN", async () => {
    expect((await ledgerOf(receipt(), 7))?.usage.status).toBe("UNKNOWN");
  });
});
