import Fastify, { type FastifyInstance } from "fastify";
import { InMemorySpaceStore, SpaceEventBus } from "@space/runtime";
import type { Event } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerReviewRoutes } from "../src/review-routes.js";
import { recordAudit, type AuditRecorder } from "../src/request-audit.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

function fixture() {
  const app = Fastify();
  apps.push(app);
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Owned review fixture", initialPaneCount: 0 });
  const other = store.createRoom({ name: "Other review room", initialPaneCount: 0 });
  const events: Event[] = [];
  const eventBus = new SpaceEventBus();
  eventBus.subscribe(event => events.push(event));
  const audit = vi.fn<AuditRecorder>((request, input) => recordAudit(store, request, input));
  app.addHook("onRequest", async request => {
    request.user = { id: "user:review", email: "review@example.test", role: "ADMIN" };
    request.requestIdForSpace = "req:review-domain";
  });
  registerReviewRoutes(app, { store, eventBus, recordAudit: audit, routeOptions: { config: {} } });
  return { app, store, room, other, events, audit };
}

describe("Standalone review domain", () => {
  it.each([
    [[], "EMPTY"],
    [["PASS"], "PASS"],
    [["PASS", "WARN"], "WARN"],
    [["PASS", "SKIPPED"], "WARN"],
    [["PASS", "RUNNING"], "WARN"],
    [["PASS", "WARN", "FAIL"], "FAIL"]
  ] as const)("reports %j as %s without treating incomplete checks as success", async (statuses, expected) => {
    const f = fixture();
    for (const status of statuses) {
      const response = await f.app.inject({ method: "POST", url: "/api/review-checks", payload: {
        roomId: f.room.id, name: `Check ${status}`, status, summary: `Fixture ${status}`
      } });
      expect(response.statusCode).toBe(200);
    }
    // A check from another room must not affect this room's aggregate gate.
    await f.store.createReviewCheck({ roomId: f.other.id, name: "Other failure", status: "FAIL",
      summary: "Unrelated room", artifactIds: [], metadata: {} }, "req:other");
    const state = await f.app.inject(`/api/reviews/state?roomId=${encodeURIComponent(f.room.id)}`);
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ gateStatus: expected, checks: expect.arrayContaining(statuses.map(status => expect.objectContaining({ status }))) });
    expect(state.json().checks).toHaveLength(statuses.length);
    expect(state.json().checks.every((check: { roomId: string }) => check.roomId === f.room.id)).toBe(true);
    expect(f.events).toHaveLength(statuses.length);
    expect(f.audit).toHaveBeenCalledTimes(statuses.length);
  });

  it("persists redacted decisions, publishes their trace, and retains room-scoped pagination", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      const response = await f.app.inject({ method: "POST", url: "/api/reviews", payload: {
        roomId: f.room.id, decision: "BLOCK", summary: `Check ${i}: token=owned-fixture-secret`,
        evidenceArtifactIds: ["artifact:proof", "artifact:proof"], rollbackNote: "Rollback tested patch"
      } });
      expect(response.statusCode).toBe(200);
      expect(response.json().evidenceArtifactIds).toEqual(["artifact:proof"]);
      expect(response.body).not.toContain("owned-fixture-secret");
    }
    await f.store.createReviewDecision({ roomId: f.other.id, decision: "SHIP", summary: "Other room",
      evidenceArtifactIds: [], rollbackNote: "" }, "req:other");
    const page = await f.app.inject(`/api/reviews?roomId=${encodeURIComponent(f.room.id)}&page=2&pageSize=2`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ data: [expect.objectContaining({ roomId: f.room.id, decision: "BLOCK" })],
      pagination: { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 } });
    expect(f.events).toHaveLength(3);
    expect(f.events.every(event => event.traceId === "req:review-domain" && event.type === "REVIEW_DECISION_CREATED")).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain("owned-fixture-secret");
    expect(f.audit).toHaveBeenCalledTimes(3);
    expect(f.audit).toHaveBeenLastCalledWith(expect.objectContaining({ requestIdForSpace: "req:review-domain" }),
      expect.objectContaining({ action: "review.decision.create", metadata: expect.objectContaining({ evidenceArtifactCount: 1 }) }));
  });

  it("lists checks and diffs with decision filters and independent pagination", async () => {
    const f = fixture();
    const { decision } = await f.store.createReviewDecision({ roomId: f.room.id, decision: "NEEDS_HUMAN",
      summary: "Needs verification", evidenceArtifactIds: [], rollbackNote: "" }, "req:seed");
    for (let i = 0; i < 3; i++) {
      const check = await f.app.inject({ method: "POST", url: "/api/review-checks", payload: {
        roomId: f.room.id, reviewDecisionId: decision.id, name: `Check ${i}`, status: "PASS", summary: "Verified fixture"
      } });
      expect(check.statusCode).toBe(200);
      const diff = await f.app.inject({ method: "POST", url: "/api/review-diffs", payload: {
        roomId: f.room.id, reviewDecisionId: decision.id, title: `Diff ${i}`, filePath: `src/file-${i}.ts`,
        status: "MODIFIED", additions: 3, deletions: 2, patchArtifactId: "artifact:patch"
      } });
      expect(diff.statusCode).toBe(200);
    }
    for (const endpoint of ["review-checks", "review-diffs"]) {
      const page = await f.app.inject(`/api/${endpoint}?reviewDecisionId=${encodeURIComponent(decision.id)}&page=2&pageSize=2`);
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({ data: [expect.objectContaining({ reviewDecisionId: decision.id })],
        pagination: { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 } });
    }
    expect(f.events.map(event => event.type)).toEqual(Array.from({ length: 3 }, () => ["REVIEW_CHECK_RECORDED", "REVIEW_DIFF_RECORDED"]).flat());
    expect(f.audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "review.diff.create",
      metadata: expect.objectContaining({ additions: 3, deletions: 2, patchArtifactId: "artifact:patch" }) }));
  });
});
