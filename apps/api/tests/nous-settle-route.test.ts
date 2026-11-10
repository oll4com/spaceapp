import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerNousRoutes } from "../src/nous/routes.js";
import type { NousService } from "../src/nous/service.js";

// Audit 6/11 (goal 84ba917a): the admin action nous-decision-settle marks the decisions the audit found done, through space_settle_decision's path.
describe("POST /api/nous/decisions/:id/settle", () => {
  it("settles an approved decision, answers 404 for none and 409 for one not approved, and needs a proof for done", async () => {
    const statuses: Record<string, string> = { "nous_decision:approved1": "APPROVED", "nous_decision:declined1": "DECLINED" };
    const settleDecision = vi.fn(async (_owner: string, id: string) => statuses[id] ? { id, status: statuses[id], outcome: "Failed: x" } as never : null);
    const app = Fastify();
    registerNousRoutes(app, {} as NousService, { routeOptions: {}, owner: async () => "user:operator", settleDecision,
      parseQuery: (schema, query) => schema.parse(query), parseBody: (schema, body) => schema.parse(body) } as Parameters<typeof registerNousRoutes>[2]);
    const settle = (id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/nous/decisions/${id}/settle`, payload });
    try {
      const done = await settle("nous_decision:approved1", { state: "DONE", proof: "https://x.com/1", reason: "6/11 audit" });
      expect(done.json()).toEqual({ id: "nous_decision:approved1", state: "DONE", previousOutcome: "Failed: x" });
      expect(settleDecision).toHaveBeenCalledWith("user:operator", "nous_decision:approved1", { state: "DONE", proof: "https://x.com/1", reason: "6/11 audit" });
      expect((await settle("nous_decision:missing1", { state: "VOID", reason: "gone" })).statusCode).toBe(404);
      expect((await settle("nous_decision:declined1", { state: "VOID", reason: "gone" })).statusCode).toBe(409);
      expect((await settle("nous_decision:approved1", { state: "DONE", reason: "no proof" })).statusCode).toBeGreaterThanOrEqual(400);
      expect(settleDecision).toHaveBeenCalledTimes(3);
    } finally { await app.close(); }
  });
});
