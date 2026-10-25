import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupActionAdapter } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

const sessionSecret = "setup-route-test-secret-with-enough-length";
const owner = { id: "user:owner", email: "owner@example.com", role: "ADMIN" as const };
const ownerToken = signSession(owner, sessionSecret);
const headers = { cookie: `${cookieName}=${ownerToken}`, [csrfHeaderName]: createCsrfToken(ownerToken, sessionSecret)! };
const essential = ["agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"];

async function fixture(setupConnections?: SetupConnectionsService, actionAdapterFor?: () => SetupActionAdapter | null) {
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  store.claimOwnerSetup({
    tokenHash: "a".repeat(64), email: owner.email, passwordHash: "test-hash", now: "2026-10-07T16:00:00.000Z"
  });
  const app = await createApp({
    store,
    setupConnections,
    setupActionAdapterFor: actionAdapterFor,
    setupActionPumpEnabled: Boolean(actionAdapterFor),
    auth: { sessionSecret, operatorEmail: owner.email, operatorPasswordHash: "unused", devLogin: false, secureCookies: false },
    config: getApiConfig({ SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" })
  });
  return { app, store };
}

describe("first setup v2 owner API", () => {
  it("keeps unaudited public agents visible but refuses their setup plan", async () => {
    vi.stubEnv("SPACE_PUBLIC_DISTRIBUTION", "true");
    const connections: SetupConnectionsService = {
      overview: async () => ["claude", "cursor"].map(id => ({
        id: `cli:${id}`, label: id, providerName: id, category: "AI coding CLI",
        state: "NEEDS_SETUP" as const, functionalState: "NEEDS_SETUP" as const,
        liveVerificationState: "NOT_CHECKED" as const, reasonCode: null, verifiedAt: null, staleAt: null, actions: []
      })),
      verify: async () => { throw new Error("unused"); },
      verifyAll: async () => { throw new Error("unused"); },
      recordVerifiedEvidence: async () => { throw new Error("unused"); }
    };
    const { app } = await fixture(connections);
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/setup/catalog", headers });
      expect(catalog.json().features.find((entry: { id: string }) => entry.id === "agent:claude"))
        .toMatchObject({ availability: "INSTALLABLE", reasonCode: null });
      expect(catalog.json().features.find((entry: { id: string }) => entry.id === "agent:cursor"))
        .toMatchObject({ availability: "UNAVAILABLE", reasonCode: "AGENT_SETUP_CHECK_UNSUPPORTED" });
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "developer", level: "minimal",
        requestedFeatureIds: [...essential, "agent:cursor"], connectionChoices: []
      } });
      expect(draft.statusCode).toBe(200);
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: 0 } });
      expect(plan.statusCode).toBe(422);
      expect(plan.json().error.code).toBe("SETUP_FEATURE_UNAVAILABLE");
    } finally { await app.close(); vi.unstubAllEnvs(); }
  }, 30_000);

  it("runs server-owned action adapters after starting without accepting client receipts", async () => {
    const checked = new Set<string>();
    const adapter: SetupActionAdapter = {
      inspect: async (task) => checked.has(task.id)
        ? { outcome: "VERIFIED", receipt: {
          checkVersion: "test:v1", subjectFingerprint: "a".repeat(64), evidenceRef: "proof:server-owned"
        } } : { outcome: "NOT_APPLIED", evidenceRef: "proof:not-applied" },
      apply: async (task) => { checked.add(task.id); }
    };
    const { app } = await fixture(undefined, () => adapter);
    try {
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "everyday", level: "minimal",
        requestedFeatureIds: essential, connectionChoices: []
      } });
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers,
        payload: { draftRevision: draft.json().revision } });
      const start = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:server-actions"
      } });
      expect(start.statusCode).toBe(201);
      let status = "RUNNING";
      for (let attempt = 0; attempt < 50 && status === "RUNNING"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const snapshot = await app.inject({ method: "GET", url: `/api/setup/runs/${encodeURIComponent(start.json().id)}`, headers });
        status = snapshot.json().run.status;
      }
      expect(status).toBe("READY");
      expect(checked.size).toBe(plan.json().actions.length);
    } finally { await app.close(); }
  }, 30_000);
  it("keeps the installation handoff owner-scoped and refuses an absent proof", async () => {
    const { app } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/setup/installation-handoff" })).statusCode).toBe(401);
      const response = await app.inject({ method: "GET", url: "/api/setup/installation-handoff", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ modelId: null, completed: false });
      expect((await app.inject({ method: "GET", url: "/api/setup/free-model" })).statusCode).toBe(401);
      const freeModel = await app.inject({ method: "GET", url: "/api/setup/free-model", headers });
      expect(freeModel.statusCode).toBe(200);
      expect(freeModel.json()).toEqual({ choice: "AUTO_BEST_FREE", modelId: null, verified: false });
    } finally { await app.close(); }
  }, 30_000);
  it("scopes the catalog and draft to the authenticated owner", async () => {
    const { app } = await fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/api/setup/catalog" })).statusCode).toBe(401);
      const catalog = await app.inject({ method: "GET", url: "/api/setup/catalog", headers });
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().protocolVersion).toBe(2);
      expect(catalog.json().features[0]).toMatchObject({ id: "agent:opencode", availability: "INSTALLABLE" });
      expect(catalog.json().features.find((item: { id: string }) => item.id === "dock:agent-sessions"))
        .toMatchObject({ availability: "AVAILABLE" });
      for (const id of ["dock:media", "dock:shared-chat", "dock:source-control"]) {
        expect(catalog.json().features.find((item: { id: string }) => item.id === id)).toMatchObject({ availability: "AVAILABLE" });
      }
      // File Manager needs its owned write/read/delete check before Ready.
      expect(catalog.json().features.find((item: { id: string }) => item.id === "pane:files"))
        .toMatchObject({ availability: "INSTALLABLE" });
      expect(catalog.json().features.find((item: { id: string }) => item.id === "pane:browser"))
        .toMatchObject({ availability: "UNAVAILABLE" });
      const draft = await app.inject({ method: "GET", url: "/api/setup/draft", headers });
      expect(draft.statusCode).toBe(200);
      expect(draft.json()).toMatchObject({ persona: "everyday", level: "minimal" });
    } finally { await app.close(); }
  }, 30_000);

  it("rejects stale draft writes, unselected connection data and old plans", async () => {
    const { app } = await fixture();
    try {
      const first = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "everyday", level: "minimal",
        requestedFeatureIds: essential, connectionChoices: []
      } });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ revision: 0 });
      const stale = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "developer", level: "full",
        requestedFeatureIds: essential, connectionChoices: []
      } });
      expect(stale.statusCode).toBe(409);
      const unselected = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: 0, persona: "everyday", level: "minimal",
        requestedFeatureIds: essential,
        connectionChoices: [{ featureId: "pane:live", providerId: "openai" }]
      } });
      expect(unselected.statusCode).toBe(422);
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: 0 } });
      expect(plan.statusCode).toBe(200);
      const run = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:api-1"
      } });
      expect(run.statusCode).toBe(201);
      const repeated = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:api-1"
      } });
      expect(repeated.json()).toEqual(run.json());
      const snapshot = await app.inject({ method: "GET", url: `/api/setup/runs/${encodeURIComponent(run.json().id)}`, headers });
      expect(snapshot.json()).toMatchObject({ run: { id: run.json().id }, tasks: expect.arrayContaining([expect.objectContaining({ status: "QUEUED" })]) });
      const current = await app.inject({ method: "GET", url: "/api/setup/current", headers });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({ run: { id: run.json().id }, plan: { id: plan.json().id } });
    } finally { await app.close(); }
  }, 30_000);

  it("refuses to start when a selected runtime disappears after planning", async () => {
    let state: "NEEDS_SETUP" | "UNAVAILABLE" = "NEEDS_SETUP";
    const setupConnections: SetupConnectionsService = {
      overview: async () => [{
        id: "cli:codex", label: "Codex", providerName: "Codex", category: "AI coding CLI",
        state, functionalState: state === "UNAVAILABLE" ? "UNAVAILABLE" : "NEEDS_SETUP",
        liveVerificationState: "NOT_CHECKED", reasonCode: null, verifiedAt: null, staleAt: null, actions: []
      }],
      verify: async () => { throw new Error("unused"); },
      verifyAll: async () => { throw new Error("unused"); },
      recordVerifiedEvidence: async () => { throw new Error("unused"); }
    };
    const { app } = await fixture(setupConnections);
    try {
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "developer", level: "minimal",
        requestedFeatureIds: [...essential, "agent:codex"], connectionChoices: []
      } });
      expect(draft.statusCode).toBe(200);
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: 0 } });
      expect(plan.statusCode).toBe(200);
      state = "UNAVAILABLE";
      const start = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:gone-runtime"
      } });
      expect(start.statusCode).toBe(409);
      expect(start.json().error.code).toBe("SETUP_PLAN_STALE");
    } finally { await app.close(); }
  }, 30_000);

  it("reuses a currently verified selected agent without asking for login again", async () => {
    const verified = {
      id: "cli:codex", label: "Codex", providerName: "Codex", category: "AI coding CLI",
      state: "CONNECTED" as const, functionalState: "FUNCTIONAL" as const,
      liveVerificationState: "VERIFIED" as const, reasonCode: null,
      verifiedAt: new Date().toISOString(), staleAt: null, actions: ["VERIFY" as const]
    };
    const setupConnections: SetupConnectionsService = {
      overview: async () => [verified], verify: async () => verified,
      verifyAll: async () => [verified], recordVerifiedEvidence: async () => verified
    };
    const { app, store } = await fixture(setupConnections);
    try {
      store.upsertSetupConnectionVerification({ connectionId: "cli:codex", state: "CONNECTED", reasonCode: null,
        fingerprintHash: "c".repeat(64), verifiedAt: verified.verifiedAt,
        updatedAt: verified.verifiedAt });
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "developer", level: "minimal",
        requestedFeatureIds: [...essential, "agent:codex"], connectionChoices: []
      } });
      const response = await app.inject({ method: "POST", url: "/api/setup/plan", headers,
        payload: { draftRevision: draft.json().revision } });
      expect(response.statusCode).toBe(200);
      expect(response.json().requiredHumanInputs.some((item: { featureId: string }) => item.featureId === "agent:codex")).toBe(false);
    } finally { await app.close(); }
  }, 30_000);

  it("refuses to start a selected agent while its required login is unresolved", async () => {
    const pending = {
      id: "cli:codex", label: "Codex", providerName: "Codex", category: "AI coding CLI",
      state: "NEEDS_SETUP" as const, functionalState: "NEEDS_SETUP" as const,
      liveVerificationState: "NOT_CHECKED" as const, reasonCode: "CREDENTIAL_REQUIRED",
      verifiedAt: null, staleAt: null, actions: ["OPEN_LOGIN_PANE" as const, "VERIFY" as const]
    };
    const setupConnections: SetupConnectionsService = {
      overview: async () => [pending], verify: async () => pending,
      verifyAll: async () => [pending], recordVerifiedEvidence: async () => pending
    };
    const { app } = await fixture(setupConnections);
    try {
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "developer", level: "minimal",
        requestedFeatureIds: [...essential, "agent:codex"], connectionChoices: []
      } });
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers,
        payload: { draftRevision: draft.json().revision } });
      expect(plan.statusCode).toBe(200);
      expect(plan.json().requiredHumanInputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ featureId: "agent:codex", kind: "PROVIDER_LOGIN" })
      ]));
      const run = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:pending-login"
      } });
      expect(run.statusCode).toBe(422);
      expect(run.json().error.code).toBe("SETUP_INPUT_REQUIRED");
    } finally { await app.close(); }
  }, 30_000);

  it("reconciles an expired service check from server-observed state", async () => {
    const { app, store } = await fixture();
    try {
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "everyday", level: "minimal",
        requestedFeatureIds: essential, connectionChoices: []
      } });
      const plan = await app.inject({ method: "POST", url: "/api/setup/plan", headers,
        payload: { draftRevision: draft.json().revision } });
      const started = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.json().id, planDigest: plan.json().planDigest, idempotencyKey: "request:expired-check"
      } });
      const state = structuredClone(await store.getSetupExecutionState(owner.id));
      const task = state!.tasks.find((item) => item.runId === started.json().id && item.featureId === "dock:rooms" && item.actionId === "CHECK_SERVICE")!;
      task.status = "NEEDS_ATTENTION";
      task.errorCode = "LEASE_EXPIRED_RECONCILE";
      state!.runs.find((item) => item.id === started.json().id)!.status = "FAILED";
      state!.revision++;
      expect(await store.compareAndSwapSetupExecutionState(owner.id, state!.revision - 1, state!)).toBe(true);
      const response = await app.inject({ method: "POST",
        url: `/api/setup/runs/${encodeURIComponent(started.json().id)}/reconcile`, headers,
        payload: { taskId: task.id } });
      expect(response.statusCode).toBe(200);
      expect(response.json().tasks.find((item: { id: string }) => item.id === task.id)).toMatchObject({ status: "READY", errorCode: null });
      expect(response.json().run.status).toBe("RUNNING");
    } finally { await app.close(); }
  }, 30_000);

});
