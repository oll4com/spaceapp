import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema, taskAcceptanceSchema } from "@space/contracts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import { runCodexAppServerTurn } from "../src/activities.js";
import { buildCodexAppServerTurnWorkflowId } from "../src/ids.js";

describe("Chat execution evidence", () => {
  it.each(["42", "Wrong answer"])("atomically records declared result checks at real activity completion: %s", async text => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Objective task", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Objective task",
      selectedModelConfigId: null, selectedProviderId: null, selectedProviderName: "Codex",
      selectedModelId: null, selectedModelName: null, selectedReasoningKey: null, selectedToolIds: [] });
    const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Calculate 6*7. Return only the number." });
    const assistant = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: user.content,
      agentSessionId: session.sessionId, agentUserMessageId: user.messageId, agentAssistantMessageId: assistant.messageId,
      selectedToolIds: [], traceId: "trace:objective-task" });
    const run = store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
      responseMessageId: assistant.messageId, execution: { traceId: input.traceId, modelConfigId: null,
        providerId: null, providerName: "Codex", requestedModel: null, requestedReasoning: null,
        acceptance: taskAcceptanceSchema.parse({ version: 1, checks: [{ id: "product", kind: "NUMBER_EQUALS", expected: 42 }] }) } });
    const completed = await runCodexAppServerTurn(input, { completionStore: store,
      env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true", SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true", SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true" },
      executeStdioTurn: async () => ({ threadId: "thread:objective", turnId: "turn:objective", turnStatus: "completed",
        notificationCount: 2, completedNotificationSeen: true, agentMessageText: text }) });
    expect(completed.status).toBe("COMPLETED");
    const saved = store.getLatestSpaceAgentRun(session.sessionId)!;
    expect(saved.ledger?.evaluation).toMatchObject({ status: "SCORED", qualityScore: text === "42" ? 100 : 0,
      criticalFailure: text !== "42", evidenceIds: [run.runId, assistant.messageId],
      validation: { scope: "DECLARED_CHECKS_ONLY", resultSha256: createHash("sha256").update(text).digest("hex"),
        checks: [{ id: "product", passed: text === "42" }] } });
    expect(saved.ledger?.cost.status).toBe("UNKNOWN");
    expect(store.listSpaceAgentMessages(session.sessionId).find(message => message.messageId === assistant.messageId)?.content).toBe(text);
  });
  it.each([null, "runtime-model", "x".repeat(201)])("persists only bounded reported runtime evidence (%s)", async (runtimeModelAtStart) => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Task evidence", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Task evidence",
      selectedModelConfigId: "codex-v1|selected|high", selectedProviderId: null, selectedProviderName: "Codex",
      selectedModelId: "selected", selectedModelName: "Selected", selectedReasoningKey: "high", selectedToolIds: [] });
    const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Answer once." });
    const assistant = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: "Answer once.",
      agentSessionId: session.sessionId, agentUserMessageId: user.messageId, agentAssistantMessageId: assistant.messageId,
      modelId: "selected", reasoningEffort: "high", selectedToolIds: [], traceId: "trace:task-evidence" });
    const run = store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
      responseMessageId: assistant.messageId, execution: { traceId: input.traceId,
        modelConfigId: session.selectedModelConfigId, providerId: null, providerName: "Codex",
        requestedModel: "selected", requestedReasoning: "high" } });
    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio", SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true" },
      executeStdioTurn: async () => ({ runtimeModelAtStart, threadId: "thread:evidence", turnId: "turn:evidence",
        turnStatus: "completed", notificationCount: 3, completedNotificationSeen: true, agentMessageText: "Done." })
    });
    expect(result.status).toBe("COMPLETED");
    const completed = store.getLatestSpaceAgentRun(session.sessionId)!;
    expect(completed).toMatchObject({ runId: run.runId, status: "COMPLETED", execution: run.execution,
      runtimeModelAtStart: runtimeModelAtStart && runtimeModelAtStart.length <= 200 ? runtimeModelAtStart : null });
    expect(completed.ledger).toMatchObject({ version: 1, usage: { status: "UNKNOWN" },
      cost: { status: "UNKNOWN", amountUsd: null }, evaluation: { status: "UNSCORABLE" },
      model: { scope: "STARTUP_ONLY", value: completed.runtimeModelAtStart } });
    expect(completed.ledger?.evaluation.reason).toContain("No task-specific");
    expect(completed.startedAt).toBeTruthy();
    expect(completed.completedAt).toBeTruthy();
    expect(Date.parse(completed.completedAt!)).toBeGreaterThanOrEqual(Date.parse(completed.startedAt!));
  });
  it.each([true, false])("records the turn's reported tokens and prices them only from the operator's list (%s)", async (priced) => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Task usage", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Task usage",
      selectedModelConfigId: null, selectedProviderId: null, selectedProviderName: "Codex",
      selectedModelId: null, selectedModelName: null, selectedReasoningKey: null, selectedToolIds: [] });
    const user = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Answer once." });
    const assistant = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: user.content,
      agentSessionId: session.sessionId, agentUserMessageId: user.messageId, agentAssistantMessageId: assistant.messageId,
      selectedToolIds: [], traceId: "trace:task-usage" });
    store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: user.messageId,
      responseMessageId: assistant.messageId, execution: { traceId: input.traceId, modelConfigId: null,
        providerId: null, providerName: "Codex", requestedModel: null, requestedReasoning: null } });
    const dir = mkdtempSync(join(tmpdir(), "space-prices-"));
    const catalog = join(dir, "prices.json");
    writeFileSync(catalog, JSON.stringify({ version: "prices-test", currency: "USD",
      prices: [{ model: priced ? "reported-model" : "other-model", inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }] }));
    const totals = (input: number, cached: number, output: number) => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output,
      reasoningOutputTokens: 0, totalTokens: input + output });
    try {
      await runCodexAppServerTurn(input, { completionStore: store,
        env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true", SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
          SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true", SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true", SPACE_MODEL_PRICE_CATALOG: catalog },
        executeStdioTurn: async () => ({ runtimeModelAtStart: "reported-model", threadId: "thread:usage", turnId: "turn:usage", turnStatus: "completed",
          notificationCount: 3, completedNotificationSeen: true, agentMessageText: "Done.",
          tokenUsage: { baseline: totals(5_000, 0, 300), latest: totals(17_000, 10_000, 1_300) } }) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const ledger = store.getLatestSpaceAgentRun(session.sessionId)!.ledger!;
    expect(ledger.usage).toMatchObject({ status: "MEASURED", inputTokens: 12_000, cachedInputTokens: 10_000, outputTokens: 1_000,
      totalTokens: 13_000, model: "reported-model", source: "codex-app-server:thread/tokenUsage/updated" });
    expect(ledger.cost).toMatchObject(priced
      ? { status: "ESTIMATED", amountUsd: 0.017, priceCatalogVersion: "prices-test" }
      : { status: "UNKNOWN", reason: "Price catalog prices-test has no price for reported-model." });
  });
});
