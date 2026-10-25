import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildCodexAppServerProcessEnv, runCodexAppServerStdioTurnSession, type CodexAppServerStdioProcess } from "../src/index.js";

const threadId = "thread:dot";
class DotProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly responses: unknown[] = [];
  killed = false;
  readonly stdin = { write: (chunk: string) => {
    for (const line of chunk.trim().split("\n")) {
      const message = JSON.parse(line);
      if (message.method) this.requests.push({ method: message.method, params: message.params });
      else if (message.id === "server-call") { this.responses.push(message.result); this.finish(); continue; }
      if (message.id === undefined) continue;
      const result = message.method === "thread/start" || message.method === "thread/resume" ? { thread: { id: threadId }, model: "gpt-test" }
        : message.method === "turn/start" ? { turn: { id: "turn:1", status: "inProgress" } } : {};
      this.send({ id: message.id, result });
      if (message.method === "turn/start") {
        this.send({ method: "turn/started", params: { threadId, turn: { id: "turn:1", status: "inProgress" } } });
        this.send({ id: "server-call", method: "item/tool/call", params: { threadId, turnId: "turn:1", callId: "call-1", tool: "space_search_tools", arguments: { query: "pane" } } });
      }
    }
    return true;
  } };
  kill() { this.killed = true; return true; }
  private send(value: unknown) { queueMicrotask(() => this.stdout.emit("data", JSON.stringify(value) + "\n")); }
  private finish() {
    this.send({ method: "item/completed", params: { threadId, turnId: "turn:1", item: { type: "agentMessage", text: "Done" } } });
    this.send({ method: "turn/completed", params: { threadId, turn: { id: "turn:1", status: "completed" } } });
  }
}

function run(fake: DotProcess, options: Record<string, unknown>) {
  return runCodexAppServerStdioTurnSession({
    command: "codex", prompt: "Open a pane", timeoutMs: 2_000, spawnProcess: () => fake,
    env: buildCodexAppServerProcessEnv({ baseEnv: {}, codexHome: "/tmp/dot-thread-context-test", credential: null }),
    ...options
  });
}

describe("Dot thread context", () => {
  it("starts a new thread with dynamic tools, developer instructions and config, then answers tool calls in-turn", async () => {
    const fake = new DotProcess();
    const onThreadStarted = vi.fn();
    const handler = vi.fn(async () => ({ contentItems: [{ type: "inputText", text: "{\"tools\":[]}" }], success: true }));
    const session = await run(fake, {
      threadConfig: { "mcp_servers.mcp_dispatcher.env": { SPACE_AGENT_RUNTIME_ID: "native:dot" } },
      developerInstructions: "You are Orbit.",
      dynamicTools: [{ type: "function", name: "space_search_tools", description: "Search", inputSchema: { type: "object" } }],
      serverRequestHandler: handler, onThreadStarted
    });
    const start = fake.requests.find((request) => request.method === "thread/start")!;
    expect(start.params).toMatchObject({ developerInstructions: "You are Orbit.",
      config: { "mcp_servers.mcp_dispatcher.env": { SPACE_AGENT_RUNTIME_ID: "native:dot" } },
      dynamicTools: [expect.objectContaining({ name: "space_search_tools" })] });
    expect(onThreadStarted).toHaveBeenCalledWith({ threadId, dynamicTools: true });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ method: "item/tool/call" }));
    expect(fake.responses).toEqual([{ contentItems: [{ type: "inputText", text: "{\"tools\":[]}" }], success: true }]);
    expect(session).toMatchObject({ threadId, agentMessageText: "Done" });
  });

  it("resumes with instructions and config but never re-sends dynamic tools", async () => {
    const fake = new DotProcess();
    const onThreadStarted = vi.fn();
    await run(fake, { threadId, developerInstructions: "You are Nova.", threadConfig: { "a.b": 1 },
      dynamicTools: [{ type: "function", name: "space_call_tool", description: "Call", inputSchema: { type: "object" } }],
      serverRequestHandler: async () => ({ contentItems: [], success: true }), onThreadStarted });
    const resume = fake.requests.find((request) => request.method === "thread/resume")!;
    expect(resume.params).toMatchObject({ threadId, developerInstructions: "You are Nova.", config: { "a.b": 1 } });
    expect(resume.params).not.toHaveProperty("dynamicTools");
    expect(fake.requests.some((request) => request.method === "thread/start")).toBe(false);
    expect(onThreadStarted).not.toHaveBeenCalled();
  });

  it("omits empty thread context so ordinary turns are unchanged", async () => {
    const fake = new DotProcess();
    await run(fake, { serverRequestHandler: async () => ({ contentItems: [], success: true }) });
    const start = fake.requests.find((request) => request.method === "thread/start")!;
    expect(start.params).not.toHaveProperty("config");
    expect(start.params).not.toHaveProperty("developerInstructions");
    expect(start.params).not.toHaveProperty("dynamicTools");
  });

  it("runs proactive work in a read-only sandbox that never asks, on start and on resume", async () => {
    for (const threadOption of [{}, { threadId }]) {
      const fake = new DotProcess();
      await run(fake, { ...threadOption, readOnly: true, serverRequestHandler: async () => ({ contentItems: [], success: true }) });
      const opened = fake.requests.find((request) => request.method === "thread/start" || request.method === "thread/resume")!;
      expect(opened.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never" });
    }
    const normal = new DotProcess();
    await run(normal, { serverRequestHandler: async () => ({ contentItems: [], success: true }) });
    expect(normal.requests.find((request) => request.method === "thread/start")!.params).not.toHaveProperty("sandbox");
  });
});

describe("turn token usage", () => {
  it("measures the turn's growth of thread totals and ignores other turns", async () => {
    const { reduceCodexAppServerTurnSessionState, codexTurnTokenUsage } = await import("../src/index.js");
    const totals = (input: number, cached: number, output: number, reasoning: number) => ({ inputTokens: input, cachedInputTokens: cached,
      outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output });
    const options = { threadStartRequestId: 1, turnStartRequestId: 2 };
    let state = { threadId: "t", turnId: "turn:2", turnStatus: "inProgress", notificationCount: 0, completedNotificationSeen: false, agentMessageText: "" } as never;
    const report = (turnId: string, total: ReturnType<typeof totals>, last: ReturnType<typeof totals>) =>
      ({ method: "thread/tokenUsage/updated", params: { threadId: "t", turnId, tokenUsage: { total, last } } });
    // Earlier turns already used 5,000 input and 300 output tokens.
    state = reduceCodexAppServerTurnSessionState(state, report("turn:2", totals(6_000, 4_000, 400, 50), totals(1_000, 800, 100, 50)), options);
    state = reduceCodexAppServerTurnSessionState(state, report("turn:other", totals(99_000, 0, 9_000, 0), totals(1, 0, 1, 0)), options);
    state = reduceCodexAppServerTurnSessionState(state, report("turn:2", totals(8_000, 5_500, 700, 120), totals(2_000, 1_500, 300, 70)), options);
    expect(codexTurnTokenUsage(state)).toEqual({ inputTokens: 3_000, cachedInputTokens: 2_300, outputTokens: 400, reasoningOutputTokens: 120, totalTokens: 3_400 });
    expect(codexTurnTokenUsage({ tokenUsage: null })).toBeNull();
    // Before the turn is known, reports cannot set its baseline; totals never move backwards.
    let early = { threadId: "t", turnId: null, turnStatus: "inProgress", notificationCount: 0, completedNotificationSeen: false, agentMessageText: "" } as never;
    early = reduceCodexAppServerTurnSessionState(early, report("turn:2", totals(6_000, 0, 400, 0), totals(1_000, 0, 100, 0)), options);
    expect(codexTurnTokenUsage(early)).toBeNull();
    state = reduceCodexAppServerTurnSessionState(state, report("turn:2", totals(7_000, 5_000, 600, 100), totals(1, 0, 1, 0)), options);
    expect(codexTurnTokenUsage(state)?.totalTokens).toBe(3_400);
  });
});
