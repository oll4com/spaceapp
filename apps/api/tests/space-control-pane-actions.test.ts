import { describe, expect, it, vi } from "vitest";
import { createSpaceControlPaneActions } from "../src/space-control-pane-actions.js";
import { InMemoryControlRepository } from "@space/db";
import { createHeldDispatch } from "../src/nous/held-dispatch.js";

const codexPane = { id: "pane:quota-codex", roomId: "room:one", mode: "TERMINAL", terminalRuntimeId: "cli:codex", title: "Codex", isClosed: false };
// A pane id no real Gemini process carries: the verification scans /proc read-only and falls back to the session's profile.
const geminiPane = { ...codexPane, id: "pane:quota-gemini-test", terminalRuntimeId: "cli:gemini", title: "Gemini" };

function fixture(options: { session?: unknown; rateLimits?: unknown; accounts?: unknown[]; observed?: Record<string, unknown>; startTurn?: ReturnType<typeof vi.fn>; holdPanePrompt?: (pane: unknown, text: string) => Promise<unknown> } = {}) {
  const cleared: string[] = [];
  const observationCache = new Map<string, never>([["pane:quota-codex", {} as never]]);
  const actions = createSpaceControlPaneActions({
    store: {
      getActivePaneCliSession: async () => options.session ?? null,
      listPaneCliSessions: async () => []
    } as never,
    cliTerminalManager: {
      activeSessionPids: async () => new Map(),
      runSerializedTerminalMutation: async (_id: string, run: () => Promise<unknown>) => run()
    } as never,
    spaceAgentAdapter: { sendMessage: vi.fn() } as never,
    antigravityUsageProvider: async () => ({ data: options.accounts ?? [] }) as never,
    dashboardAgentsCache: { delete: (roomId: string) => cleared.push(roomId) },
    nousRef: { current: options.holdPanePrompt ? { holdPanePrompt: options.holdPanePrompt } as never : null },
    roomOwner: async () => "user:operator",
    inspectRoomCli: async () => ({ state: "IDLE", ...options.observed }) as never,
    roomCliSession: async () => (options.session ?? { sessionId: "cli:one", runtimeId: "cli:claude" }) as never,
    roomCliObservationCache: observationCache,
    readPaneCliModelSettings: async () => ({ settings: { threadId: "thread:one" }, directControl: { readRateLimits: options.rateLimits, startTurn: options.startTurn } }) as never,
    resolveOpenCodeServerControl: vi.fn() as never
  });
  return { actions, cleared, observationCache };
}

describe("Space Control pane actions", () => {
  it("holds a fresh Codex brief behind its requested model, including across startup and failed switches", async () => {
    const target = { roomId: codexPane.roomId, roomName: "Cleo", paneId: codexPane.id, paneName: "Finn" };
    const owner = "user:operator";
    let activeModel = "gpt-6.1-sol";
    const startTurn = vi.fn(async () => ({ turnId: "turn:one", status: "inProgress" }));
    const deliver = vi.fn(async (item) => {
      if (item.model) activeModel = item.model.modelId;
      else { expect(activeModel).toBe("gpt-6-astra"); await actions.controlSend(codexPane as never, item.text, "trace:held"); }
      return { ok: true, result: "applied" };
    });
    const held = createHeldDispatch({ repository: new InMemoryControlRepository(), level: async () => "CALM", deliver, notice: vi.fn() });
    const { actions } = fixture({ session: { sessionId: "cli:one", runtimeId: "cli:codex" }, startTurn,
      holdPanePrompt: (_pane, text) => held.holdPromptBehindModel(owner, target, text) });
    const select = () => held.hold(owner, target, "Select Astra high", "light", { modelId: "gpt-6-astra", reasoningEffort: "high" });
    await select();
    await expect(actions.controlSend(codexPane as never, "First code brief", "trace:first")).resolves.toMatchObject({ status: "PENDING", submitted: false });
    expect(startTurn).not.toHaveBeenCalled();
    deliver.mockResolvedValueOnce({ ok: false, result: "Pane has no active session." });
    await held.tick();
    expect(startTurn).not.toHaveBeenCalled();
    await held.tick(); // The model is confirmed before the brief can leave.
    await held.tick();
    expect(startTurn).toHaveBeenCalledTimes(1);
    await select();
    await actions.controlSend(codexPane as never, "Must not run after a failed switch", "trace:second");
    deliver.mockResolvedValue({ ok: false, result: "Codex rejected the requested pre-thread model settings." });
    await held.tick(); await held.tick(); await held.tick();
    expect(await held.summary(owner)).toBeNull();
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("runs a prompt queued between two model changes on the first (A → prompt → B; 15/11 Andy: it ran on B)", async () => {
    const target = { roomId: codexPane.roomId, roomName: "Cleo", paneId: codexPane.id, paneName: "Finn" };
    const owner = "user:operator";
    let activeModel = "gpt-6.1-sol";
    const ranOn: string[] = [];
    const startTurn = vi.fn(async () => { ranOn.push(activeModel); return { turnId: "turn:one", status: "inProgress" }; });
    const deliver = vi.fn(async (item) => {
      if (item.model) activeModel = item.model.modelId;
      else await actions.controlSend(codexPane as never, item.text, "trace:held");
      return { ok: true, result: "applied" };
    });
    const held = createHeldDispatch({ repository: new InMemoryControlRepository(), level: async () => "CALM", deliver, notice: vi.fn() });
    const { actions } = fixture({ session: { sessionId: "cli:one", runtimeId: "cli:codex" }, startTurn,
      holdPanePrompt: (_pane, text) => held.holdPromptBehindModel(owner, target, text) });
    await held.hold(owner, target, "Select A", "light", { modelId: "model-a" });
    await expect(actions.controlSend(codexPane as never, "Brief for A ", "trace:a")).resolves.toMatchObject({ status: "PENDING", submitted: false });
    await held.hold(owner, target, "Select B", "light", { modelId: "model-b" });
    for (let tick = 0; tick < 4; tick++) await held.tick();
    expect(ranOn).toEqual(["model-a"]);
    expect(activeModel).toBe("model-b");
    expect(await held.summary(owner)).toBeNull();
    // A fresh prompt after that still waits behind a change held for the pane.
    await held.hold(owner, target, "Select A", "light", { modelId: "model-a" });
    await expect(actions.controlSend(codexPane as never, "Brief for A ", "trace:again")).resolves.toMatchObject({ status: "PENDING" });
  });

  it("passes only an explicit HTTP source id into native Codex turn metadata", async () => {
    const startTurn=vi.fn(async()=>({turnId:"turn:one",status:"inProgress"}));
    const c=fixture({session:{sessionId:"cli:one",runtimeId:"cli:codex"},startTurn});
    await c.actions.controlSend(codexPane as never,"Fixed prompt","command:distinct","req:http-original");
    expect(startTurn).toHaveBeenLastCalledWith(expect.objectContaining({sourceRequestId:"req:http-original",clientUserMessageId:expect.stringContaining("command:distinct")}));
    await c.actions.controlSend(codexPane as never,"Fixed prompt","command:internal");
    expect(startTurn.mock.calls.at(-1)?.[0]).not.toHaveProperty("sourceRequestId");
  });

  it("reads native quota only on a Codex or Gemini pane with a session and a quota source", async () => {
    await expect(fixture().actions.controlQuota({ ...codexPane, terminalRuntimeId: "cli:claude" } as never)).rejects.toThrow("Native quota requires a Codex or Gemini CLI pane.");
    await expect(fixture().actions.controlQuota(codexPane as never)).rejects.toThrow("Codex session identity is unavailable.");
    const session = { sessionId: "cli:codex-one", runtimeId: "cli:codex" };
    await expect(fixture({ session }).actions.controlQuota(codexPane as never)).rejects.toThrow("Native quota source is unavailable for this runtime.");
    const exhausted = await fixture({ session, rateLimits: async () => ({ windows: [{ window: "5h" }], blocked: true }) }).actions.controlQuota(codexPane as never);
    expect(exhausted).toMatchObject({ allowed: false, reason: "Native account quota is exhausted.", nativeTaskRef: "thread:one", sessionId: "cli:codex-one" });
    const unknown = await fixture({ session, rateLimits: async () => ({ windows: [], blocked: false }) }).actions.controlQuota(codexPane as never);
    expect(unknown).toMatchObject({ allowed: false, reason: "Native quota windows are unknown." });
  });

  it("says why a Gemini pane's Google account may not run", async () => {
    const session = { sessionId: "cli:gemini-one", paneId: geminiPane.id, runtimeId: "cli:gemini", accountProfileId: "work", status: "RUNNING", isActive: true };
    const missing = await fixture({ session }).actions.controlQuota(geminiPane as never);
    expect(missing).toMatchObject({ runtimeId: "cli:gemini", accountProfileId: "work", allowed: false, blocked: true, reason: 'Google account profile "work" has no quota data.' });
    const spent = await fixture({ session, accounts: [{ id: "work", status: "CONNECTED", gemini: { fiveHourRemainingPercent: 0, fiveHourResetAt: "2026-11-01T06:00:00.000Z" } }] })
      .actions.controlQuota(geminiPane as never);
    expect(spent).toMatchObject({ allowed: false, reason: "Google Gemini 5-hour quota is exhausted.", windows: [{ window: "5h", remainingPercent: 0, resetAt: "2026-11-01T06:00:00.000Z" }] });
  });

  it("refuses an oversized prompt and a busy CLI, and clears the pane's cached views either way", async () => {
    const long = fixture();
    await expect(long.actions.controlSend(codexPane as never, "x".repeat(20_001), "trace:one")).rejects.toThrow("CLI prompts support at most 20,000 characters per turn.");
    expect(long.cleared).toEqual(["room:one"]);
    expect(long.observationCache.has(codexPane.id)).toBe(false);
    const busy = fixture({ observed: { state: "RUNNING" } });
    await expect(busy.actions.controlSend({ ...codexPane, terminalRuntimeId: "cli:claude" } as never, "hello", "trace:one")).rejects.toThrow("CLI already has an active turn.");
    expect(busy.cleared).toEqual(["room:one"]);
  });
});
