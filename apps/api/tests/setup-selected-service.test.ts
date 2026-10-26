import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { registerSetupExecutionRoutes } from "../src/setup-execution-routes.js";

describe("selected service connections", () => {
  it("connects an approved streaming dependency without broadening selection to unrelated services", async () => {
    const store = new InMemorySpaceStore(); const app = Fastify(); app.decorateRequest("user", null);
    app.addHook("preHandler", async request => { request.user = { id: "user:owner", email: "owner@example.com", role: "ADMIN" }; });
    registerSetupExecutionRoutes(app, { store, actionPumpEnabled: false,
      connections: { overview: async () => [], verify: async () => { throw Error(); }, verifyAll: async () => [], recordVerifiedEvidence: async () => { throw Error(); } },
      capabilityChecks: { "widget:streaming-metrics": async () => {} },
      selectedServices: { "dock:streaming": { list: async () => [{ id: "owned-channel", label: "Owned channel" }], inspect: async () => "a".repeat(64) } }
    } as Parameters<typeof registerSetupExecutionRoutes>[1]);
    try {
      const saved = await app.inject({ method: "PUT", url: "/api/setup/draft", payload: { expectedRevision: null, persona: "creator", level: "full",
        requestedFeatureIds: ["widget:streaming-metrics"], connectionChoices: [{ featureId: "dock:streaming", modelId: "owned-channel" }] } });
      expect(saved.statusCode).toBe(200);
      const path = "/api/setup/services/dock%3Astreaming";
      expect((await app.inject({ method: "GET", url: `${path}/choices` })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/setup/services/pane%3Adatabases/choices" })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: `${path}/check`, payload: { draftRevision: saved.json().revision, choiceId: "owned-channel" } })).statusCode).toBe(200);
      const plan = (await app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: saved.json().revision } })).json();
      expect(plan.effectiveFeatureIds).toEqual(["dock:streaming", "widget:streaming-metrics"]);
      expect(plan.requiredHumanInputs).toEqual([]);
    } finally { await app.close(); }
  });
  it("checks only an owner-selected approved target, binds proof to the draft and rechecks current health", async () => {
    let healthy = true; let requests = 0;
    const service = createServer((_request, response) => { requests++; response.writeHead(healthy ? 200 : 503); response.end("1"); });
    service.listen(0, "127.0.0.1"); await once(service, "listening");
    const origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    const store = new InMemorySpaceStore(); const app = Fastify(); app.decorateRequest("user", null);
    let ownerId = "user:owner"; let role = "ADMIN";
    app.addHook("preHandler", async request => { request.user = { id: ownerId, email: "owner@example.com", role: role as "ADMIN" }; });
    const fingerprint = createHash("sha256").update("approved-fixture-revision").digest("hex");
    registerSetupExecutionRoutes(app, { store, actionPumpEnabled: false,
      connections: { overview: async () => [], verify: async () => { throw Error(); }, verifyAll: async () => [], recordVerifiedEvidence: async () => { throw Error(); } },
      selectedServices: { "pane:databases": {
        list: async () => [{ id: "approved-db", label: "Owned database" }],
        inspect: async (_owner: string, id: string) => {
          if (id !== "approved-db") throw Error("Target is not authorized");
          const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
          if (!response.ok || await response.text() !== "1") throw Error("Connection is unavailable");
          return fingerprint;
        }
      } }
    } as Parameters<typeof registerSetupExecutionRoutes>[1]);
    const path = "/api/setup/services/pane%3Adatabases";
    try {
      expect((await app.inject({ method: "GET", url: `${path}/choices` })).statusCode).toBe(422);
      expect(requests).toBe(0);
      const draft = (await app.inject({ method: "PUT", url: "/api/setup/draft", payload: { expectedRevision: null, persona: "developer", level: "full",
        requestedFeatureIds: ["pane:databases"], connectionChoices: [{ featureId: "pane:databases", modelId: "approved-db" }] } })).json();
      const choices = await app.inject({ method: "GET", url: `${path}/choices` });
      expect(choices.statusCode).toBe(200); expect(choices.json().choices).toEqual([{ id: "approved-db", label: "Owned database" }]);
      const before = (await app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: draft.revision } })).json();
      expect(before.requiredHumanInputs).toHaveLength(1);
      const invalid = await app.inject({ method: "POST", url: `${path}/check`, payload: { draftRevision: draft.revision, choiceId: "arbitrary-target" } });
      expect(invalid.statusCode).toBe(422); expect(requests).toBe(0);
      const checked = await app.inject({ method: "POST", url: `${path}/check`, payload: { draftRevision: draft.revision, choiceId: "approved-db" } });
      expect(checked.statusCode).toBe(200); expect(checked.json()).toEqual({ verified: true });
      const after = (await app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: draft.revision } })).json();
      expect(after.requiredHumanInputs).toEqual([]); expect(after.planDigest).not.toBe(before.planDigest);
      healthy = false;
      const revoked = (await app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: draft.revision } })).json();
      expect(revoked.requiredHumanInputs).toHaveLength(1);
      healthy = true;
      const revised = (await app.inject({ method: "PUT", url: "/api/setup/draft", payload: { expectedRevision: draft.revision,
        persona: "developer", level: "full", requestedFeatureIds: ["pane:databases"],
        connectionChoices: [{ featureId: "pane:databases", modelId: "approved-db" }] } })).json();
      const changed = (await app.inject({ method: "POST", url: "/api/setup/plan", payload: { draftRevision: revised.revision } })).json();
      expect(changed.requiredHumanInputs).toHaveLength(1);
      const requestCount = requests;
      expect((await app.inject({ method: "POST", url: `${path}/check`, payload: { draftRevision: draft.revision, choiceId: "approved-db" } })).statusCode).toBe(422);
      expect(requests).toBe(requestCount);
      ownerId = "user:foreign";
      expect((await app.inject({ method: "POST", url: `${path}/check`, payload: { draftRevision: draft.revision, choiceId: "approved-db" } })).statusCode).toBe(422);
      role = "MEMBER";
      expect((await app.inject({ method: "GET", url: `${path}/choices` })).statusCode).toBe(403);
    } finally { await app.close(); await new Promise<void>(resolve => service.close(() => resolve())); }
  });
});

it("production database adapter checks a real read-only target and retains its existing data", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { SqliteAdapter } = await import("../src/databases/sqlite-adapter.js");
  const { createSetupSelectedServiceAdapters } = await import("../src/setup-selected-services.js");
  const root = await mkdtemp(join(tmpdir(), "setup-db-check-")); const filename = join(root, "owned.sqlite");
  const writable = new SqliteAdapter({ filename });
  const readOnly = new SqliteAdapter({ filename, isReadOnly: true });
  const record = { id: "owned-db", name: "Owned read-only target", ownerUserId: "user:owner", engine: "SQLITE", filename,
    isReadOnly: true, isInternal: false, updatedAt: "2026-10-08T12:00:00Z", host: null, port: null, database: null, username: null, ssl: false, options: {} };
  try {
    await writable.executeSql({ sql: "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('preserved');" });
    const adapters = createSetupSelectedServiceAdapters({ databases: {
      listConnections: async () => [record],
      getConnection: async (id: string) => { if (id !== record.id) throw Error(); return record; },
      getAdapter: async () => readOnly
    } });
    expect(adapters["pane:databases"]).toBeDefined();
    expect(await adapters["pane:databases"]!.list("user:owner")).toEqual([{ id: "owned-db", label: "Owned read-only target" }]);
    expect(await adapters["pane:databases"]!.inspect("user:owner", "owned-db")).toMatch(/^[a-f0-9]{64}$/);
    await expect(adapters["pane:databases"]!.inspect("user:owner", "foreign-target")).rejects.toThrow();
    const rows = await readOnly.executeSql({ sql: "SELECT value FROM marker", limit: 1 });
    expect(rows.rows).toEqual([{ value: "preserved" }]);
    expect(adapters["dock:streaming"]).toBeUndefined();
  } finally { await writable.close(); await readOnly.close(); await rm(root, { recursive: true, force: true }); }
});

it("the database run task consumes the verified service fingerprint instead of an unavailable adapter", async () => {
  const { createProductionSetupActionAdapter } = await import("../src/setup-production-actions.js");
  const adapter = createProductionSetupActionAdapter({ task: { actionId: "VERIFY_DATABASE", featureId: "pane:databases" },
    ownerId: "user:owner", plan: { catalogVersion: "first-setup-v2.0" }, store: new InMemorySpaceStore(), connections: {},
    selectedServiceFingerprint: async () => "b".repeat(64) } as Parameters<typeof createProductionSetupActionAdapter>[0]);
  expect(adapter).not.toBeNull();
  expect(await adapter!.inspect()).toMatchObject({ outcome: "VERIFIED", receipt: { subjectFingerprint: "b".repeat(64) } });
});
