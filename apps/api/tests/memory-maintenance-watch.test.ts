import { describe, expect, it, vi } from "vitest";
import { createMemoryMaintenanceFailureWatch } from "../src/memory-maintenance-watch.js";

describe("memory maintenance failure watch", () => {
  it("raises one SYSTEM notification per admin for a failed run, once, and none for a running or missing run", async () => {
    const statuses: Record<string, string | null> = {
      "space-memory-maintenance:2026-10-19": "FAILED",
      "space-memory-maintenance:2026-10-18": "COMPLETED"
    };
    const status = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, statuses[id] ?? null])));
    const raise = vi.fn(async () => undefined);
    const watch = createMemoryMaintenanceFailureWatch({
      status, raise, admins: async () => ["user:a", "user:b"], log: { warn: vi.fn() },
      now: () => new Date("2026-10-19T07:00:00Z")
    });

    await watch.tick();
    expect(status).toHaveBeenCalledWith(["space-memory-maintenance:2026-10-19", "space-memory-maintenance:2026-10-18"]);
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "user:a", source: "SYSTEM", kind: "MEMORY_MAINTENANCE_FAILED", severity: "ATTENTION",
      dedupeKey: "memory-maintenance:space-memory-maintenance:2026-10-19"
    }));

    await watch.tick();
    expect(status).toHaveBeenLastCalledWith(["space-memory-maintenance:2026-10-18"]);
    expect(raise).toHaveBeenCalledTimes(2);
  });

  it("names runs after the Athens date", async () => {
    const status = vi.fn(async () => new Map<string, string | null>());
    const watch = createMemoryMaintenanceFailureWatch({
      status, raise: vi.fn(), admins: async () => [], log: { warn: vi.fn() },
      now: () => new Date("2026-10-18T22:30:00Z") // 01:30 on 10-19 in Athens
    });
    await watch.tick();
    expect(status).toHaveBeenCalledWith(["space-memory-maintenance:2026-10-19", "space-memory-maintenance:2026-10-18"]);
  });
});
