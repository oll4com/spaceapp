import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { InMemorySpaceStore, SetupActionRunner, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupActionAdapter } from "@space/runtime";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { SetupConnection, SetupConnectionsService } from "../src/setup-connections.js";
import { planSetupSettings, setupLiveDefaults } from "../src/setup-settings.js";

// Review 2026-10-21 #4: finishing asks the providers again. An unchanged local credential is no proof that the provider still
// accepts it: an agent checked more than five minutes ago is checked live at finish, and a selected Live connection must be
// accepted by its provider at finish.
const sessionSecret = "setup-route-test-secret-with-enough-length";
const owner = { id: "user:owner", email: "owner@example.com", role: "ADMIN" as const };
const ownerToken = signSession(owner, sessionSecret);
const headers = { cookie: `${cookieName}=${ownerToken}`, [csrfHeaderName]: createCsrfToken(ownerToken, sessionSecret)! };
const essential = ["agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"];
const agentFingerprint = "a".repeat(64);
const fingerprintOf = (featureId: string) => featureId === "agent:opencode" ? agentFingerprint : createHash("sha256").update(featureId).digest("hex");

function connection(verifiedAt: string | null, state: SetupConnection["liveVerificationState"]): SetupConnection {
  return { id: "cli:opencode", label: "OpenCode", providerName: "OpenCode", category: "AI coding CLI", state: "CONNECTED",
    functionalState: "FUNCTIONAL", liveVerificationState: state, reasonCode: state === "VERIFIED" ? null : "PROVIDER_CHECK_FAILED",
    verifiedAt, staleAt: null, actions: ["VERIFY"] };
}

async function finishedRun(options: { checkedMinutesAgo: number; providerAccepts: () => boolean; live?: boolean;
  liveReauthorize?: (ownerId: string) => Promise<boolean>; completedMinutesAgo?: number }) {
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: owner.email, passwordHash: "test-hash", now: "2026-10-07T16:00:00.000Z" });
  const checkedAt = new Date(Date.now() - options.checkedMinutesAgo * 60_000).toISOString();
  store.upsertSetupConnectionVerification({ connectionId: "cli:opencode", state: "CONNECTED", reasonCode: null,
    fingerprintHash: agentFingerprint, verifiedAt: checkedAt, updatedAt: checkedAt });
  const verifyCalls: string[] = [];
  const setupConnections: SetupConnectionsService = {
    overview: async () => {
      const saved = await store.getSetupConnectionVerification("cli:opencode");
      return [connection(saved?.verifiedAt ?? null, saved?.verifiedAt ? "VERIFIED" : "PROVIDER_FAILED")];
    },
    // The live provider challenge: it records what the provider answered, as the real service does.
    verify: async (connectionId) => {
      verifyCalls.push(connectionId);
      const now = new Date().toISOString();
      const accepted = options.providerAccepts();
      store.upsertSetupConnectionVerification({ connectionId, state: "CONNECTED", reasonCode: accepted ? null : "PROVIDER_CHECK_FAILED",
        fingerprintHash: agentFingerprint, verifiedAt: accepted ? now : null, updatedAt: now });
      return connection(accepted ? now : null, accepted ? "VERIFIED" : "PROVIDER_FAILED");
    },
    verifyAll: async () => { throw new Error("unused"); },
    recordVerifiedEvidence: async () => { throw new Error("unused"); }
  };
  const adapter = (task: { featureId: string }): SetupActionAdapter => ({
    inspect: async () => ({ outcome: "VERIFIED", receipt: { checkVersion: "check:v1", subjectFingerprint: fingerprintOf(task.featureId),
      evidenceRef: `proof:${task.featureId}` } } as never),
    apply: async () => undefined
  });
  const app = await createApp({ store, setupConnections, setupActionAdapterFor: adapter as never, setupActionPumpEnabled: false,
    setupLiveVoice: options.liveReauthorize ? { fingerprint: async () => "f".repeat(64), reauthorize: options.liveReauthorize } : undefined,
    auth: { sessionSecret, operatorEmail: owner.email, operatorPasswordHash: "unused", devLogin: false, secureCookies: false },
    config: getApiConfig({ SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" }) });
  const requested = options.live ? [...essential, "pane:live"] : essential;
  const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: { expectedRevision: null,
    persona: "creator", level: "minimal", requestedFeatureIds: requested,
    connectionChoices: options.live ? [{ featureId: "pane:live", providerId: "openai", modelId: "gpt-realtime-2.1", voiceId: "alloy" }] : [] } });
  expect(draft.statusCode).toBe(200);
  const planResponse = await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: draft.json().revision } });
  const plan = planResponse.json();
  const completedAt = Date.now() - (options.completedMinutesAgo ?? 0) * 60_000;
  const coordinator = new SetupExecutionCoordinator(store, () => new Date(completedAt));
  // Started through the coordinator: starting through the route needs the Live connection's own audio proof first, and this
  // test is about what finishing checks afterwards.
  const run = await coordinator.startRun(owner.id, plan.id, plan.planDigest, "request:finish-provider");
  for (let index = 0; index < plan.actions.length; index++) {
    const task = await coordinator.leaseNextTask(owner.id, run.id, "worker:api-proof", 30_000);
    await coordinator.completeTask(owner.id, run.id, task!.id, "worker:api-proof", {
      checkVersion: "check:v1", subjectFingerprint: fingerprintOf(task!.featureId), evidenceRef: `proof:${index}` });
  }
  store.updateUserSettings(owner.id, planSetupSettings(plan.effectiveFeatureIds, store.getUserSettings(owner.id),
    setupLiveDefaults((await store.getSetupExecutionState(owner.id))?.draft, plan)));
  const finish = () => app.inject({ method: "POST", url: "/api/setup/finish", headers,
    payload: { runId: run.id, draftRevision: draft.json().revision, planDigest: plan.planDigest } });
  return { app, store, finish, verifyCalls, run, plan, adapter };
}

describe("finishing re-asks the providers (review 2026-10-21 #4)", () => {
  it("checks an agent live when its last provider check is older than five minutes, and refuses what the provider refuses", async () => {
    let accepts = false;
    const f = await finishedRun({ checkedMinutesAgo: 20, providerAccepts: () => accepts });
    try {
      const refused = await f.finish();
      expect(refused.statusCode).toBe(422);
      expect(f.verifyCalls).toEqual(["cli:opencode"]);
      expect(f.store.getOwnerOnboarding().isComplete).toBe(false);
      accepts = true;
      const finished = await f.finish();
      expect(finished.statusCode).toBe(200);
      expect(f.verifyCalls).toEqual(["cli:opencode", "cli:opencode"]);
    } finally { await f.app.close(); }
  });

  it("does not repeat a provider check made in the last five minutes", async () => {
    const f = await finishedRun({ checkedMinutesAgo: 1, providerAccepts: () => true });
    try {
      expect((await f.finish()).statusCode).toBe(200);
      expect(f.verifyCalls).toEqual([]);
    } finally { await f.app.close(); }
  });

  it("refuses a selected Live connection its provider no longer accepts", async () => {
    let live = false;
    const f = await finishedRun({ checkedMinutesAgo: 1, providerAccepts: () => true, live: true, liveReauthorize: async () => live });
    try {
      const refused = await f.finish();
      expect(refused.statusCode).toBe(422);
      expect(f.store.getOwnerOnboarding().isComplete).toBe(false);
      live = true;
      expect((await f.finish()).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });

  // Review 2026-10-21 #8: results that expired before finish are checked again in the same run, not with a new setup.
  it("asks for the expired checks to run again in the same run before asking any provider, then finishes", async () => {
    const f = await finishedRun({ checkedMinutesAgo: 1, providerAccepts: () => true, completedMinutesAgo: 20 });
    try {
      const expired = await f.finish();
      expect(expired.statusCode).toBe(422);
      expect(expired.json().error.code).toBe("SETUP_CHECKS_EXPIRED");
      const taskIds: string[] = expired.json().error.details.missingTaskIds;
      expect(taskIds).toHaveLength(f.plan.actions.length);
      expect(f.verifyCalls).toEqual([]);
      const state = await f.store.getSetupExecutionState(owner.id);
      const again = await f.app.inject({ method: "POST", url: `/api/setup/runs/${f.run.id}/retry`, headers,
        payload: { taskIds, expectedRunRevision: state!.runs.find((item) => item.id === f.run.id)!.revision } });
      expect(again.statusCode).toBe(200);
      expect(again.json().run).toMatchObject({ id: f.run.id, status: "RUNNING" });
      await new SetupActionRunner(new SetupExecutionCoordinator(f.store), (task) => f.adapter(task)).pump(owner.id, f.run.id);
      expect((await f.finish()).statusCode).toBe(200);
      expect(f.store.getOwnerOnboarding().isComplete).toBe(true);
    } finally { await f.app.close(); }
  });
});
