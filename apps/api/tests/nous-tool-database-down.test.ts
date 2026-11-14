import { describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousService } from "../src/nous/service.js";

// 13/11 Score lever "Daily Nous errors": 7 space_db_query calls failed with "Connection terminated unexpectedly" while Space's database was down
// (02:33-02:39) and each cost −2. Like a turn's, such a failure is Space's, not Nous's; a statement timeout stays Nous's slow query.
describe("a tool call Space's own database dropped", () => {
  it("is not counted as Nous's mistake; a statement timeout still is", async () => {
    const owner = "user:operator";
    const repository = new InMemoryNousRepository();
    const results = ["Connection terminated unexpectedly", "Postgres: canceling statement due to statement timeout (code 57014)"];
    const execute = vi.fn(async () => ({ ok: false, display: "Query failed", result: results.shift()! }));
    let settings = { enabled: true, maxTurnsPerHour: 20 };
    const late: { service?: ReturnType<typeof createNousService> } = {};
    let ran = false;
    const service = late.service = createNousService({
      repository,
      runner: async (input) => {
        if (!ran) { ran = true; for (const id of ["a", "b"]) await late.service!.callTool(owner, input.turnId, "space_db_query", { sql: "select 1" }, `toolu_${id}`); }
        return { text: "Done.", isError: false };
      },
      tools: { execute },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => settings,
      saveSettings: async (_owner, value) => { settings = value; return value; },
      notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => {}) } as never,
      executeAction: vi.fn(async () => "Sent."),
      limits: { inboxDebounceMs: 10 }
    } as never);
    await service.send(owner, "How is it going?");
    await service.idle(owner);
    const [facts] = await repository.listTurnFacts(owner, "2000-01-01T00:00:00.000Z");
    expect(facts!.tools.space_db_query).toEqual({ calls: 2, failed: 2, refused: 1, errors: ["Postgres: canceling statement due to statement timeout (code 57014)"] });
  });
});
