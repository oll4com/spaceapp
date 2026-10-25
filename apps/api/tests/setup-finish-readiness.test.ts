import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupActionAdapter } from "@space/runtime";
import { createHash, createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import { cookieName, createCsrfToken, csrfHeaderName, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";
import { planSetupSettings } from "../src/setup-settings.js";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSetupInstallationMemory } from "../src/setup-installation-memory.js";
import { writeInstallationUpgradeProof } from "../src/installation-handoff.js";

const sessionSecret = "setup-route-test-secret-with-enough-length";
const owner = { id: "user:owner", email: "owner@example.com", role: "ADMIN" as const };
const ownerToken = signSession(owner, sessionSecret);
const headers = { cookie: `${cookieName}=${ownerToken}`, [csrfHeaderName]: createCsrfToken(ownerToken, sessionSecret)! };
const essential = ["agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"];

async function fixture(setupConnections?: SetupConnectionsService, actionAdapterFor?: () => SetupActionAdapter | null, memoryRoot?: string) {
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  store.claimOwnerSetup({
    tokenHash: "a".repeat(64), email: owner.email, passwordHash: "test-hash", now: "2026-10-07T16:00:00.000Z"
  });
  const app = await createApp({
    store,
    setupConnections,
    setupMemoryRoot: memoryRoot,
    setupHandoffRoot: memoryRoot ? join(memoryRoot, "handoff") : undefined,
    setupActionAdapterFor: actionAdapterFor,
    setupActionPumpEnabled: Boolean(actionAdapterFor),
    auth: { sessionSecret, operatorEmail: owner.email, operatorPasswordHash: "unused", devLogin: false, secureCookies: false },
    config: getApiConfig({ SPACE_BROWSER_EVIDENCE_ENABLED: "false", SPACE_BROWSER_SESSIONS_ENABLED: "false" })
  });
  return { app, store };
}

describe("first setup completion readiness", () => {
  // Review 2026-10-21 #7: a public installation without the installer's pre-Docker check finishes on setup's own signed
  // check, and its installation memory must say that no pre-Docker check ran.
  it("finishes a public installation without the pre-Docker check on setup's own check, never as a pre-Docker run", async () => {
    const now = new Date().toISOString();
    const setupConnections: SetupConnectionsService = {
      overview: async () => [{ id: "cli:opencode", label: "OpenCode", providerName: "OpenCode", category: "AI coding CLI",
        state: "CONNECTED", functionalState: "FUNCTIONAL", liveVerificationState: "VERIFIED", reasonCode: null,
        verifiedAt: new Date().toISOString(), staleAt: null, actions: ["VERIFY"] }],
      verify: async () => { throw new Error("unused"); },
      verifyAll: async () => { throw new Error("unused"); },
      recordVerifiedEvidence: async () => { throw new Error("unused"); }
    };
    const root = await mkdtemp(join(tmpdir(), "setup-finish-upgrade-"));
    const { app, store } = await fixture(setupConnections, undefined, root);
    try {
      await mkdir(join(root, "handoff"));
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "everyday", level: "minimal", requestedFeatureIds: essential, connectionChoices: [] } });
      const plan = (await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: draft.json().revision } })).json();
      const run = (await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.id, planDigest: plan.planDigest, idempotencyKey: "request:finish-upgrade" } })).json();
      store.upsertSetupConnectionVerification({ connectionId: "cli:opencode", state: "CONNECTED", reasonCode: null,
        fingerprintHash: "a".repeat(64), verifiedAt: now, updatedAt: now });
      const coordinator = new SetupExecutionCoordinator(store);
      for (let index = 0; index < plan.actions.length; index++) {
        const task = await coordinator.leaseNextTask(owner.id, run.id, "worker:api-proof", 30_000);
        await coordinator.completeTask(owner.id, run.id, task!.id, "worker:api-proof", { checkVersion: "check:v1",
          subjectFingerprint: task!.featureId === "agent:opencode" ? "a".repeat(64)
            : createHash("sha256").update(`${task!.featureId}:${plan.catalogVersion}`).digest("hex"), evidenceRef: `proof:upgrade-${index}` });
      }
      store.updateUserSettings(owner.id, planSetupSettings(plan.effectiveFeatureIds, store.getUserSettings(owner.id)));
      await store.ensureOwnerStarterRoom();
      await writeFile(join(root, "installation-model.json"), JSON.stringify({ id: "opencode/big-pickle", verification: "tool-call",
        verifiedAt: now, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }));
      const state = await coordinator.getState(owner.id);
      const memoryTask = state.tasks.find((task) => task.actionId === "WRITE_INSTALLATION_MEMORY")!;
      vi.stubEnv("SPACE_PUBLIC_DISTRIBUTION", "true");
      const body = { runId: run.id, draftRevision: draft.json().revision, planDigest: plan.planDigest };
      // No installer check and no setup check: nothing to finish on.
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), projectSetupInstallationMemory(state, plan, memoryTask, "opencode/big-pickle", { source: "UPGRADE" })!);
      expect((await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body })).statusCode).toBe(422);
      await writeInstallationUpgradeProof(root, sessionSecret, "opencode/big-pickle", now);
      // A memory that claims the installer's check is refused.
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), projectSetupInstallationMemory(state, plan, memoryTask, "opencode/big-pickle")!);
      expect((await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body })).statusCode).toBe(422);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), projectSetupInstallationMemory(state, plan, memoryTask, "opencode/big-pickle", { source: "UPGRADE" })!);
      const finished = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(finished.statusCode).toBe(200);
      expect(finished.json()).toMatchObject({ isComplete: true });
    } finally {
      vi.unstubAllEnvs();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks the selected agent at finish and rejects a changed credential", async () => {
    let verification: "VERIFIED" | "CREDENTIAL_CHANGED" = "CREDENTIAL_CHANGED";
    const setupConnections: SetupConnectionsService = {
      overview: async () => [{
        id: "cli:opencode", label: "OpenCode", providerName: "OpenCode", category: "AI coding CLI",
        state: "CONNECTED", functionalState: "FUNCTIONAL", liveVerificationState: verification,
        reasonCode: verification === "VERIFIED" ? null : "CREDENTIAL_CHANGED",
        verifiedAt: verification === "VERIFIED" ? new Date().toISOString() : null,
        staleAt: null, actions: ["VERIFY"]
      }],
      verify: async () => { throw new Error("unused"); },
      verifyAll: async () => { throw new Error("unused"); },
      recordVerifiedEvidence: async () => { throw new Error("unused"); }
    };
    const root = await mkdtemp(join(tmpdir(), "setup-finish-memory-"));
    const { app, store } = await fixture(setupConnections, undefined, root);
    try {
      const draft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: null, persona: "everyday", level: "minimal",
        requestedFeatureIds: essential, connectionChoices: []
      } });
      const planResponse = await app.inject({ method: "POST", url: "/api/setup/plan", headers, payload: { draftRevision: draft.json().revision } });
      const plan = planResponse.json();
      const runResponse = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: plan.id, planDigest: plan.planDigest, idempotencyKey: "request:finish-proof"
      } });
      const run = runResponse.json();
      const now = new Date().toISOString();
      store.upsertSetupConnectionVerification({
        connectionId: "cli:opencode", state: "CONNECTED", reasonCode: null,
        fingerprintHash: "a".repeat(64), verifiedAt: now, updatedAt: now
      });
      const coordinator = new SetupExecutionCoordinator(store);
      for (let index = 0; index < plan.actions.length; index++) {
        const task = await coordinator.leaseNextTask(owner.id, run.id, "worker:api-proof", 30_000);
        expect(task).not.toBeNull();
        const fingerprint = task!.featureId === "agent:opencode" ? "a".repeat(64)
          : createHash("sha256").update(`${task!.featureId}:${plan.catalogVersion}`).digest("hex");
        await coordinator.completeTask(owner.id, run.id, task!.id, "worker:api-proof", {
          checkVersion: "check:v1", subjectFingerprint: fingerprint,
          evidenceRef: `proof:api-${index}`
        });
      }
      const body = { runId: run.id, draftRevision: draft.json().revision, planDigest: plan.planDigest };
      const revoked = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(revoked.statusCode).toBe(422);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      verification = "VERIFIED";
      const changedSettings = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(changedSettings.statusCode).toBe(422);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      store.updateUserSettings(owner.id, planSetupSettings(plan.effectiveFeatureIds, store.getUserSettings(owner.id)));
      await mkdir(join(root, "handoff"));
      const memory = "# SpaceApp installation memory\n\nSchema: 1\nPlatform: linux\nHardware profile: small\nVerified free model: opencode/big-pickle\nAssistant status: completed a live account-free tool call before Docker setup.\nNext action: continue the approved SpaceApp installation.\n";
      const signed = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId: "opencode/big-pickle", completed: true };
      await writeFile(join(root, "handoff", "INSTALLATION_MEMORY.md"), memory);
      await writeFile(join(root, "handoff", "installation-handoff.json"), JSON.stringify({ ...signed,
        mac: createHmac("sha256", sessionSecret).update(JSON.stringify(signed)).digest("hex") }));
      await writeFile(join(root, "installation-model.json"), JSON.stringify({
        id: "opencode/big-pickle", verification: "tool-call",
        verifiedAt: now, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }
      }));
      vi.stubEnv("SPACE_PUBLIC_DISTRIBUTION", "true");
      const missingMemory = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(missingMemory.statusCode).toBe(422);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      const state = await coordinator.getState(owner.id);
      const memoryTask = state.tasks.find((task) => task.actionId === "WRITE_INSTALLATION_MEMORY")!;
      // The installer's platform and hardware profile stay in setup's memory (review 2026-10-21 #10).
      const installer = { source: "INSTALLER" as const, notes: { platform: "linux", hardwareProfile: "small", completedActions: [] } };
      const projected = projectSetupInstallationMemory(state, plan, memoryTask, "opencode/big-pickle", installer);
      expect(projected).not.toBeNull();
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), projected!);
      await store.ensureOwnerStarterRoom();
      const listTasks = store.listTaskItems.bind(store);
      store.listTaskItems = () => { throw new Error("Task storage unavailable"); };
      const unavailableService = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(unavailableService.statusCode).toBe(422);
      expect(store.getOwnerOnboarding().isComplete).toBe(false);
      store.listTaskItems = listTasks;
      const finished = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(finished.statusCode).toBe(200);
      expect(finished.json()).toMatchObject({ onboardingVersion: 2, isComplete: true });
      const repeat = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(repeat.json().completedAt).toBe(finished.json().completedAt);
      const revisedDraft = await app.inject({ method: "PUT", url: "/api/setup/draft", headers, payload: {
        expectedRevision: draft.json().revision, persona: "everyday", level: "balanced",
        requestedFeatureIds: [...essential, "widget:clock"], connectionChoices: []
      } });
      expect(revisedDraft.statusCode).toBe(200);
      const revisedPlanResponse = await app.inject({ method: "POST", url: "/api/setup/plan", headers,
        payload: { draftRevision: revisedDraft.json().revision } });
      const revisedPlan = revisedPlanResponse.json();
      const revisedRunResponse = await app.inject({ method: "POST", url: "/api/setup/runs", headers, payload: {
        planId: revisedPlan.id, planDigest: revisedPlan.planDigest, idempotencyKey: "request:reconfiguration"
      } });
      expect(revisedRunResponse.statusCode).toBe(201);
      const revisedRun = revisedRunResponse.json();
      const revisedBody = { runId: revisedRun.id, draftRevision: revisedDraft.json().revision, planDigest: revisedPlan.planDigest };
      const unreadyReconfiguration = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: revisedBody });
      expect(unreadyReconfiguration.statusCode).toBe(422);
      expect(store.getOwnerOnboarding().completedAt).toBe(finished.json().completedAt);
      const staleReconfiguration = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: body });
      expect(staleReconfiguration.statusCode).toBe(409);
      for (let index = 0; index < revisedPlan.actions.length; index++) {
        const task = await coordinator.leaseNextTask(owner.id, revisedRun.id, "worker:api-proof", 30_000);
        const fingerprint = task!.featureId === "agent:opencode" ? "a".repeat(64)
          : createHash("sha256").update(`${task!.featureId}:${revisedPlan.catalogVersion}`).digest("hex");
        await coordinator.completeTask(owner.id, revisedRun.id, task!.id, "worker:api-proof", {
          checkVersion: "check:v1", subjectFingerprint: fingerprint, evidenceRef: `proof:reconfiguration-${index}`
        });
      }
      store.updateUserSettings(owner.id, planSetupSettings(revisedPlan.effectiveFeatureIds, store.getUserSettings(owner.id)));
      const revisedState = await coordinator.getState(owner.id);
      const revisedMemoryTask = revisedState.tasks.find(task => task.runId === revisedRun.id && task.actionId === "WRITE_INSTALLATION_MEMORY")!;
      await writeFile(join(root, "INSTALLATION_MEMORY.md"), projectSetupInstallationMemory(revisedState, revisedPlan, revisedMemoryTask, "opencode/big-pickle", installer)!);
      const reconfigured = await app.inject({ method: "POST", url: "/api/setup/finish", headers, payload: revisedBody });
      expect(reconfigured.statusCode).toBe(200);
      expect(reconfigured.json().completedAt).toBe(finished.json().completedAt);
      expect((await coordinator.getState(owner.id)).completion?.runId).toBe(revisedRun.id);
      const legacyRepeat = await app.inject({ method: "POST", url: "/api/setup/finish", headers });
      expect(legacyRepeat.statusCode).toBe(200);
    } finally { vi.unstubAllEnvs(); await app.close(); await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});
