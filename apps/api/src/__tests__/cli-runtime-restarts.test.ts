import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import type { AgentRuntime, CliToggleRuntimeId, PaneCliSession } from "@space/contracts";
import {
  restartAllCliRuntimes,
  restartCliRuntimeSessions,
  type CliRuntimeRestartContext
} from "../cli-runtime-restarts.js";

function runtime(id: CliToggleRuntimeId, displayName: string): AgentRuntime {
  const baseName = id.replace("cli:", "");
  return {
    id,
    providerId: "legacy",
    providerName: "Legacy",
    agentId: baseName,
    agentName: baseName,
    displayName,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: "NONE",
    authState: "READY",
    authReason: "Ready",
    canStartLogin: true,
    status: "ENABLED",
    statusReason: "",
    commandName: baseName,
    detectedCommandPath: "/usr/local/bin/node",
    defaultModelId: null,
    supportedReasoningEfforts: [],
    checkedAt: "2026-08-07T10:00:00.000Z"
  };
}

function setupSession(store: InMemorySpaceStore, runtimeId: string, purpose: PaneCliSession["purpose"] = "NORMAL") {
  const room = store.createRoom({ name: `${runtimeId} room`, initialPaneCount: 0 });
  const pane = store.createPane({
    roomId: room.id,
    title: `${runtimeId} pane`,
    mode: "TERMINAL",
    terminalRuntimeId: runtimeId,
    cwd: "/etc"
  });
  const session = store.createPaneCliSession({
    paneId: pane.id,
    roomId: room.id,
    runtimeId,
    providerId: "legacy",
    agentId: runtimeId.slice("cli:".length),
    modelId: null,
    reasoningEffort: "medium",
    launchMode: "FRESH",
    cwd: "/etc",
    purpose,
    status: "RUNNING",
    isActive: true
  });
  return { room, pane, session };
}

function restartContext(store: InMemorySpaceStore): CliRuntimeRestartContext {
  return {
    store,
    traceId: "trace:test",
    restarter: vi.fn(async (session: PaneCliSession, _runtime: AgentRuntime, _traceId: string) => {
      return store.createPaneCliSession({
        paneId: session.paneId,
        roomId: session.roomId,
        runtimeId: session.runtimeId,
        providerId: session.providerId,
        agentId: session.agentId,
        modelId: session.modelId,
        reasoningEffort: session.reasoningEffort,
        launchMode: "FRESH",
        cwd: session.cwd,
        status: "IDLE",
        statusReason: "CLI session restarted by explicit runtime restart request."
      });
    }),
    guardPane: vi.fn(async () => undefined)
  };
}

describe("restartCliRuntimeSessions", () => {
  it("restarts every NORMAL session and reports replacements", async () => {
    const store = new InMemorySpaceStore();
    const first = setupSession(store, "cli:opencode").session;
    const second = setupSession(store, "cli:opencode").session;
    const result = await restartCliRuntimeSessions(restartContext(store), "cli:opencode", runtime("cli:opencode", "OpenCode"));

    expect(result.runtimeId).toBe("cli:opencode");
    expect(result.requestedSessionIds).toEqual([first.sessionId, second.sessionId]);
    expect(result.restartedSessionIds).toEqual([first.sessionId, second.sessionId]);
    expect(result.replacementSessionIds).toHaveLength(2);
    expect(result.replacementSessionIds).not.toContain(first.sessionId);
    expect(result.replacementSessionIds).not.toContain(second.sessionId);
    expect(result.failedSessionIds).toEqual([]);
  });

  it("skips sessions that are not NORMAL and reports them as failed", async () => {
    const store = new InMemorySpaceStore();
    const normal = setupSession(store, "cli:codex").session;
    const login = setupSession(store, "cli:codex", "LOGIN").session;
    const result = await restartCliRuntimeSessions(restartContext(store), "cli:codex", runtime("cli:codex", "Codex"));

    expect(result.restartedSessionIds).toEqual([normal.sessionId]);
    expect(result.failedSessionIds).toEqual([login.sessionId]);
  });

  it("collects failed sessions when the restarter throws", async () => {
    const store = new InMemorySpaceStore();
    const session = setupSession(store, "cli:kimi").session;
    const context = restartContext(store);
    const restarter = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await restartCliRuntimeSessions(
      { ...context, restarter },
      "cli:kimi",
      runtime("cli:kimi", "Kimi")
    );

    expect(result.restartedSessionIds).toEqual([]);
    expect(result.failedSessionIds).toEqual([session.sessionId]);
  });

  it("fails sessions whose pane is no longer compatible", async () => {
    const store = new InMemorySpaceStore();
    const session = setupSession(store, "cli:deepseek").session;
    const context = restartContext(store);
    const guardPane = vi.fn(async () => {
      throw new Error("pane incompatible");
    });
    const result = await restartCliRuntimeSessions(
      { ...context, guardPane },
      "cli:deepseek",
      runtime("cli:deepseek", "DeepSeek")
    );

    expect(result.restartedSessionIds).toEqual([]);
    expect(result.failedSessionIds).toEqual([session.sessionId]);
  });
});

describe("restartAllCliRuntimes", () => {
  it("restarts all runtimes with CLI capability and aggregates results", async () => {
    const store = new InMemorySpaceStore();
    setupSession(store, "cli:opencode");
    setupSession(store, "cli:claude");
    const codexRuntime = runtime("cli:codex", "Codex");
    const context = restartContext(store);
    const result = await restartAllCliRuntimes(
      context,
      [codexRuntime, runtime("cli:opencode", "OpenCode"), runtime("cli:claude", "Claude")],
      () => true
    );

    expect(result.requestedRuntimes).toEqual(["cli:opencode", "cli:claude"]);
    expect(result.restartedSessionIds).toHaveLength(2);
    expect(result.failedSessionIds).toEqual([]);
    expect(result.checkedAt).toBeTruthy();
  });

  it("skips runtimes rejected by the restartable guard", async () => {
    const store = new InMemorySpaceStore();
    setupSession(store, "cli:opencode");
    const context = restartContext(store);
    const result = await restartAllCliRuntimes(
      context,
      [runtime("cli:opencode", "OpenCode")],
      () => false
    );

    expect(result.requestedRuntimes).toEqual([]);
    expect(result.restartedSessionIds).toEqual([]);
  });
});
