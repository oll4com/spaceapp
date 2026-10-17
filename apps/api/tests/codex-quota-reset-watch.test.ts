import { describe, expect, it } from "vitest";
import type { CodexUsageAccountList, NotificationRaiseInput } from "@space/contracts";
import { createCodexQuotaResetWatch } from "../src/gateway/gateway-codex-services.js";

const list = (accounts: Array<{ id: string; fiveHour: number | null; weekly: number | null }>, isStale = false): CodexUsageAccountList => ({
  data: accounts.map(({ id, fiveHour, weekly }) => ({ id, label: `${id}@example.com`, planType: "plus", fiveHourRemainingPercent: fiveHour,
    weeklyRemainingPercent: weekly, fiveHourResetAt: null, weeklyResetAt: null, sampledAt: null })),
  pagination: { page: 1, pageSize: 100, totalItems: accounts.length, totalPages: 1 }, source: "space-gateway", isStale, error: null,
  checkedAt: "2026-10-15T10:00:00.000Z"
} as CodexUsageAccountList);

describe("Codex quota reset watch", () => {
  it("notifies every admin once when an exhausted account is usable again", async () => {
    let current = list([{ id: "a", fiveHour: 94, weekly: 0 }, { id: "b", fiveHour: 0, weekly: null }, { id: "c", fiveHour: 50, weekly: 50 }]);
    const raised: NotificationRaiseInput[] = [];
    const watch = createCodexQuotaResetWatch({ usage: async () => current, admins: async () => ["user_admin"], raise: async (n) => { raised.push(n); }, log: { warn() {} } });

    await watch.tick(); // first read is the baseline
    current = list([{ id: "a", fiveHour: 100, weekly: 100 }, { id: "b", fiveHour: 0, weekly: null }, { id: "c", fiveHour: 40, weekly: 40 }], true);
    await watch.tick(); // stale reads change nothing
    expect(raised).toEqual([]);
    current = list([{ id: "a", fiveHour: 100, weekly: 100 }, { id: "b", fiveHour: 100, weekly: null }, { id: "c", fiveHour: 40, weekly: 40 }]);
    await watch.tick();
    await watch.tick();
    expect(raised.map((n) => [n.ownerUserId, n.source, n.kind, n.severity, n.payload.accountId])).toEqual([
      ["user_admin", "SYSTEM", "CODEX_QUOTA_RESET", "ATTENTION", "a"],
      ["user_admin", "SYSTEM", "CODEX_QUOTA_RESET", "ATTENTION", "b"]
    ]);
    expect(raised[1]!.body).toBe("b@example.com has quota again (5h 100% left, week no data).");
  });
});
