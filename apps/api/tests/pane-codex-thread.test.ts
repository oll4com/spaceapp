import { describe, expect, it, vi } from "vitest";
import { SpaceConflictError } from "@space/runtime";
import { CodexParityNotFoundError } from "../src/codex-parity.js";
import { availableNativeCodexThreadId, paneTitleFromCliTaskTitle, resolvePaneCodexThreadId } from "../src/pane-codex-thread.js";

const codexSession = { sessionId: "cli:s1", paneId: "pane:p1", runtimeId: "cli:codex", cwd: "/w", codexThreadId: null } as any;
const freeStore = (claim: () => Promise<void>) => ({
  getPaneCliCodexThreadOwnership: async () => null,
  getActivePaneCliSessionByCodexThreadId: async () => null,
  claimPaneCliCodexThread: vi.fn(claim)
}) as any;

describe("pane Codex thread helpers", () => {
  it("keeps a native thread only while Codex still has it", async () => {
    const parity = (error?: Error) => ({ getHistoryThread: async () => { if (error) throw error; } }) as any;
    await expect(availableNativeCodexThreadId(parity(), null)).resolves.toBeNull();
    await expect(availableNativeCodexThreadId(parity(), "t1")).resolves.toBe("t1");
    await expect(availableNativeCodexThreadId(parity(new CodexParityNotFoundError("gone")), "t1")).resolves.toBeNull();
    await expect(availableNativeCodexThreadId(parity(new Error("io")), "t1")).rejects.toThrow("io");
  });

  it("titles a resumed pane from its task, trimmed to 120 characters", () => {
    expect(paneTitleFromCliTaskTitle("  Fix login  ")).toBe("Fix login");
    expect(paneTitleFromCliTaskTitle("x".repeat(130))).toHaveLength(120);
    expect(paneTitleFromCliTaskTitle("   ")).toBe("Resumed CLI task");
  });

  it("claims a found thread for the session; another pane's claim wins", async () => {
    const findThreadId = async () => "thread-1";
    await expect(resolvePaneCodexThreadId({ store: {} as any, session: { ...codexSession, codexThreadId: "own" }, traceId: "t" })).resolves.toBe("own");
    await expect(resolvePaneCodexThreadId({ store: {} as any, session: { ...codexSession, runtimeId: "cli:claude" }, traceId: "t" })).resolves.toBeNull();
    const store = freeStore(async () => undefined);
    await expect(resolvePaneCodexThreadId({ store, session: codexSession, traceId: "t", findThreadId })).resolves.toBe("thread-1");
    expect(store.claimPaneCliCodexThread).toHaveBeenCalledWith("cli:s1", "thread-1", "AUTO", "t");
    const taken = freeStore(async () => { throw new SpaceConflictError("claimed"); });
    await expect(resolvePaneCodexThreadId({ store: taken, session: codexSession, traceId: "t", findThreadId })).resolves.toBeNull();
  });
});
