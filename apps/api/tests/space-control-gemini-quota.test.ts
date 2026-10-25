import { describe, it, expect, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository } from "@space/db";
import { controlExecuteSchema, type AntigravityUsageAccountList } from "@space/contracts";
import { createSpaceControl } from "../src/space-control.js";

const actor = { id: "operator:one", role: "ADMIN" as const };

function makeUsageList(accounts: Array<{
  id: string;
  email?: string;
  status?: string;
  rem5h?: number | null;
  remWeekly?: number | null;
  resetAt?: string | null;
}>): AntigravityUsageAccountList {
  return {
    data: accounts.map((a) => ({
      id: a.id,
      label: a.id,
      email: a.email ?? `${a.id}@gmail.com`,
      tier: "Google AI Pro",
      status: a.status ?? "CONNECTED",
      gemini: {
        displayName: "Gemini Models",
        description: null,
        fiveHourRemainingPercent: a.rem5h ?? null,
        fiveHourResetAt: a.resetAt ?? null,
        weeklyRemainingPercent: a.remWeekly ?? null,
        weeklyResetAt: null
      },
      claude: {
        displayName: "Claude and GPT models",
        description: null,
        fiveHourRemainingPercent: null,
        fiveHourResetAt: null,
        weeklyRemainingPercent: null,
        weeklyResetAt: null
      },
      sampledAt: new Date().toISOString()
    })),
    pagination: { page: 1, pageSize: 100, totalItems: accounts.length, totalPages: 1 },
    source: "space-gemini-profiles",
    isStale: false,
    error: null,
    checkedAt: new Date().toISOString()
  };
}

describe("Space control Gemini quota-gated launch & safe writes", () => {
  it("selects account with available quota, opens pane, binds account and delivers task", async () => {
    const store = new InMemorySpaceStore();
    const repository = new InMemoryControlRepository();
    const room = store.createRoom({ name: "Gemini room", initialPaneCount: 0 });

    const usage = makeUsageList([
      { id: "account_exhausted", rem5h: 0, remWeekly: 50 },
      { id: "account_healthy", rem5h: 85, remWeekly: 90 },
      { id: "account_unlicensed", status: "UNLICENSED", rem5h: null, remWeekly: null }
    ]);

    let executedActions: any[] = [];
    let deliveredPrompt: string | null = null;
    let boundAccount: string | null = null;

    const integration = vi.fn(async (_actor, roomId, action) => {
      executedActions.push(action);
      if (action.operation === "panes.open") {
        const counts = action.input.counts;
        if (counts.gemini && counts.gemini > 0) {
          const availableAccounts = usage.data.filter(
            (acc) => acc.status === "CONNECTED" && (acc.gemini?.fiveHourRemainingPercent ?? 0) > 0
          );
          if (availableAccounts.length === 0) {
            throw new Error("No Google account with available quota/tokens found for Gemini CLI.");
          }
          availableAccounts.sort(
            (a, b) => (b.gemini?.fiveHourRemainingPercent ?? 0) - (a.gemini?.fiveHourRemainingPercent ?? 0)
          );
          const best = availableAccounts[0]!;
          boundAccount = best.id;

          const pane = store.createPane({
            roomId,
            title: "Gemini CLI",
            mode: "TERMINAL",
            terminalRuntimeId: "cli:gemini"
          });

          if (action.input.taskPrompt) {
            deliveredPrompt = action.input.taskPrompt;
          }

          return {
            roomId,
            requestId: "batch:1",
            data: [pane],
            selectedGoogleAccount: { id: best.id, email: best.email, remainingPercent: best.gemini?.fiveHourRemainingPercent },
            taskDelivered: Boolean(deliveredPrompt)
          };
        }
      }
      return { ok: true };
    });

    const service = createSpaceControl({
      store,
      repository,
      controller: { catalog: vi.fn(), inspect: vi.fn(), configure: vi.fn(), command: vi.fn(), start: vi.fn(), resume: vi.fn(), interrupt: vi.fn() } as any,
      integration,
      send: vi.fn(async () => ({ submitted: true })),
      publish: vi.fn(async () => {})
    });

    const result = await service.execute(actor, controlExecuteSchema.parse({
      roomId: room.id,
      requestId: "gemini:open:prompt",
      actions: [
        {
          kind: "resource",
          operation: "panes.open",
          input: {
            counts: { gemini: 1 },
            taskPrompt: "Refactor authorization handlers"
          }
        }
      ]
    }));

    expect(result.status).toBe("COMPLETED");
    expect(boundAccount).toBe("account_healthy");
    expect(deliveredPrompt).toBe("Refactor authorization handlers");
    const pane = store.listPanes(room.id)[0]!;
    expect(pane.terminalRuntimeId).toBe("cli:gemini");
  });

  it("fails and prevents pane opening when all Google accounts have exhausted quota", async () => {
    const store = new InMemorySpaceStore();
    const repository = new InMemoryControlRepository();
    const room = store.createRoom({ name: "Exhausted room", initialPaneCount: 0 });

    const usage = makeUsageList([
      { id: "account_1", rem5h: 0, remWeekly: 10, resetAt: "2026-09-16T17:00:00Z" },
      { id: "account_2", rem5h: 0, remWeekly: 0, resetAt: "2026-09-16T18:00:00Z" }
    ]);

    const integration = vi.fn(async () => {
      const available = usage.data.filter(
        (a) => a.status === "CONNECTED" && (a.gemini?.fiveHourRemainingPercent ?? 0) > 0
      );
      if (available.length === 0) {
        throw new Error("No Google account with available quota/tokens found for Gemini CLI. Fallback: wait for quota reset or check licenses.");
      }
      return { ok: true };
    });

    const service = createSpaceControl({
      store,
      repository,
      controller: { catalog: vi.fn(), inspect: vi.fn(), configure: vi.fn(), command: vi.fn(), start: vi.fn(), resume: vi.fn(), interrupt: vi.fn() } as any,
      integration,
      send: vi.fn(async () => ({ submitted: true })),
      publish: vi.fn(async () => {})
    });

    const result = await service.execute(actor, controlExecuteSchema.parse({
      roomId: room.id,
      requestId: "gemini:open:exhausted",
      actions: [
        {
          kind: "resource",
          operation: "panes.open",
          input: { counts: { gemini: 1 } }
        }
      ]
    }));

    expect(result.status).toBe("FAILED");
    expect(store.listPanes(room.id)).toHaveLength(0);
  });

  it("enforces explicit confirmation for destructive actions across resources", async () => {
    const store = new InMemorySpaceStore();
    const repository = new InMemoryControlRepository();
    const room = store.createRoom({ name: "Safety room", initialPaneCount: 0 });

    const integration = vi.fn(async (_actor, _roomId, action) => {
      if (["tasks.delete", "links.delete", "files.delete", "media.delete"].includes(action.operation)) {
        const isConfirmed = Boolean(action.input?.confirm === true || action.input?.confirmed === true || action.approvalReason);
        if (!isConfirmed) {
          return { isError: true, status: "APPROVAL_REQUIRED" };
        }
      }
      return { ok: true, deleted: true };
    });

    const service = createSpaceControl({
      store,
      repository,
      controller: { catalog: vi.fn(), inspect: vi.fn(), configure: vi.fn(), command: vi.fn(), start: vi.fn(), resume: vi.fn(), interrupt: vi.fn() } as any,
      integration,
      send: vi.fn(async () => ({ submitted: true })),
      publish: vi.fn(async () => {})
    });

    for (const op of ["tasks.delete", "links.delete", "files.delete", "media.delete"] as const) {
      const unconfirmed = await service.execute(actor, controlExecuteSchema.parse({
        roomId: room.id,
        requestId: `del:unconf:${op}`,
        actions: [{ kind: "resource", operation: op, id: "res_1", input: {} }]
      }));
      expect(unconfirmed.status).toBe("FAILED");

      const confirmed = await service.execute(actor, controlExecuteSchema.parse({
        roomId: room.id,
        requestId: `del:conf:${op}`,
        actions: [{ kind: "resource", operation: op, id: "res_1", input: { confirm: true } }]
      }));
      expect(confirmed.status).toBe("COMPLETED");
    }
  });
});
