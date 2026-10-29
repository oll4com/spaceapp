import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupActionRunner, SetupExecutionCoordinator } from "@space/runtime";
import type { SetupAvailability, SetupFeatureId } from "@space/contracts";
import { createProductionSetupActionAdapter } from "../src/setup-production-actions.js";
import { projectSetupInstallationMemory, setupInstallationMemoryMatches, writeSetupInstallationMemory } from "../src/setup-installation-memory.js";
import { planSetupSettings } from "../src/setup-settings.js";
import { readAuthenticatedInstallationHandoff, readSetupAssistantProof, writeInstallationUpgradeProof } from "../src/installation-handoff.js";
import type { SetupConnectionsService } from "../src/setup-connections.js";

const choices: SetupFeatureId[] = ["agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"];
const availability = new Proxy({}, { get: () => "AVAILABLE" }) as Record<SetupFeatureId, SetupAvailability>;
const secret = "production-action-installation-secret-for-test";

async function fixture(withProof: boolean) {
  const root = await mkdtemp(join(tmpdir(), "setup-production-"));
  const handoffRoot = join(root, "handoff");
  await mkdir(handoffRoot);
  const store = new InMemorySpaceStore();
  store.initializeOwnerSetup({ tokenHash: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" });
  const claimed = store.claimOwnerSetup({ tokenHash: "a".repeat(64), email: "owner@example.com", passwordHash: "test-hash", now: new Date().toISOString() });
  const ownerId = claimed.user.id;
  const coordinator = new SetupExecutionCoordinator(store);
  const draft = await coordinator.updateDraft(ownerId, null, { persona: "everyday", level: "minimal", requestedFeatureIds: choices, connectionChoices: [] });
  const plan = await coordinator.createPlan(ownerId, draft.revision, availability, {});
  const run = await coordinator.startRun(ownerId, plan.id, plan.planDigest, "request:production-actions");
  let connectionReady = false;
  const connection = () => ({
    id: "cli:opencode", label: "OpenCode", providerName: "OpenCode", category: "AI coding CLI",
    state: "CONNECTED" as const, functionalState: "FUNCTIONAL" as const,
    liveVerificationState: connectionReady ? "VERIFIED" as const : "NOT_CHECKED" as const,
    reasonCode: null, verifiedAt: connectionReady ? new Date().toISOString() : null, staleAt: null, actions: ["VERIFY" as const]
  });
  const connections: SetupConnectionsService = {
    overview: async () => [connection()],
    verify: async () => {
      connectionReady = true;
      store.upsertSetupConnectionVerification({ connectionId: "cli:opencode", state: "CONNECTED", reasonCode: null,
        fingerprintHash: "b".repeat(64), verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return connection();
    },
    verifyAll: async () => [connection()], recordVerifiedEvidence: async () => connection()
  };
  if (withProof) {
    await writeFile(join(root, "installation-model.json"), JSON.stringify({
      id: "opencode/big-pickle", verification: "tool-call",
      verifiedAt: new Date().toISOString(),
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }
    }));
    const memory = "# SpaceApp installation memory\n\nSchema: 1\nPlatform: linux\nHardware profile: small\nVerified free model: opencode/big-pickle\nAssistant status: completed a live account-free tool call before Docker setup.\nNext action: continue the approved SpaceApp installation.\n";
    const payload = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId: "opencode/big-pickle", completed: true };
    await writeFile(join(handoffRoot, "INSTALLATION_MEMORY.md"), memory);
    await writeFile(join(handoffRoot, "installation-handoff.json"), JSON.stringify({ ...payload,
      mac: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") }));
  }
  return { root, handoffRoot, ownerId, store, coordinator, run, plan, connections };
}

describe("production first setup actions", () => {
  it("binds browser tool receipts to the checked runtime identity rather than the catalog alone", async () => {
    const f = await fixture(true);
    try {
      const task = { ...f.plan.actions[0]!, id: "task:osk", runId: f.run.id,
        featureId: "utility:osk" as const, actionId: "CHECK_SERVICE" as const, status: "CHECKING" as const,
        attempt: 1, idempotencyKey: "test:osk-proof", leaseOwner: "test", leaseExpiresAt: null, errorCode: null, resultRef: null };
      let fingerprint = "e".repeat(64);
      const adapter = createProductionSetupActionAdapter({ task, ownerId: f.ownerId, plan: f.plan,
        store: f.store, connections: f.connections, capabilityChecks: { "utility:osk": async () => fingerprint } });
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED", receipt: { subjectFingerprint: "e".repeat(64) } });
      fingerprint = "f".repeat(64);
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED", receipt: { subjectFingerprint: "f".repeat(64) } });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("keeps Live behind current server audio evidence without repeating microphone side effects", async () => {
    const f = await fixture(true);
    try {
      const task = { ...f.plan.actions[0]!, id: "task:local-audio", runId: f.run.id,
        featureId: "pane:live" as const, actionId: "VERIFY_LIVE_AUDIO" as const, status: "CHECKING" as const,
        attempt: 1, idempotencyKey: "test:audio-proof", leaseOwner: "test", leaseExpiresAt: null, errorCode: null, resultRef: null };
      let fingerprint: string | null = "e".repeat(64);
      const adapter = createProductionSetupActionAdapter({ task, ownerId: f.ownerId, plan: f.plan,
        store: f.store, connections: f.connections, voiceFingerprint: async () => fingerprint });
      expect(adapter).not.toBeNull();
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED", receipt: { subjectFingerprint: "e".repeat(64) } });
      fingerprint = null;
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
      await expect(adapter!.apply(task, "test:audio-proof")).rejects.toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("applies selected settings only after real OpenCode, services and signed memory verify", async () => {
    const f = await fixture(true);
    try {
      const runner = new SetupActionRunner(f.coordinator, (task) => createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret
      }));
      await runner.pump(f.ownerId, f.run.id);
      const state = await f.coordinator.getState(f.ownerId);
      expect(state.runs[0]?.status).toBe("READY");
      const memory = await readFile(join(f.root, "INSTALLATION_MEMORY.md"), "utf8");
      expect(memory).toContain("Verified free model: opencode/big-pickle");
      expect(memory).toContain(`Setup plan: ${f.plan.id}`);
      expect(memory).toContain("Selected tools: agent:opencode, pane:chat, dock:rooms, dock:tasks, dock:agent-files, dock:settings");
      // The installer's facts stay, apart from setup's choices (review 2026-10-21 #10).
      expect(memory).toContain("Platform: linux\nHardware profile: small\n");
      expect(memory).toContain("Setup persona: everyday\nSetup level: minimal\n");
      expect(memory.split("\n")).not.toContain("Profile: everyday");
      expect(memory).not.toContain(secret);
      const memoryTask = state.tasks.find((task) => task.actionId === "WRITE_INSTALLATION_MEMORY")!;
      expect(projectSetupInstallationMemory({ ...state, draft: { ...state.draft!, connectionChoices: [
        { featureId: "agent:opencode", providerId: "opencode", modelId: "different" }
      ] } }, f.plan, memoryTask, "opencode/big-pickle")).toBeNull();
      expect(f.store.getUserSettings(f.ownerId).panesHidden).toContain("databases");
      expect(f.store.getUserSettings(f.ownerId).panesHidden).toContain("files");
      const fingerprints = Object.fromEntries(state.tasks.map((task) => [task.featureId,
        task.featureId === "agent:opencode" ? "b".repeat(64)
          : createHash("sha256").update(`${task.featureId}:${f.plan.catalogVersion}`).digest("hex") ]));
      expect(f.store.completeSetupExecution({
        ownerId: f.ownerId, expectedStateRevision: state.revision, runId: f.run.id,
        draftRevision: f.plan.draftRevision, planDigest: f.plan.planDigest,
        currentFingerprints: fingerprints, completedAt: new Date().toISOString()
      }).isComplete).toBe(true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("keeps the run failed when continuation memory cannot be written", async () => {
    const f = await fixture(true);
    try {
      await mkdir(join(f.root, "INSTALLATION_MEMORY.md"));
      await new SetupActionRunner(f.coordinator, (task) => createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret
      })).pump(f.ownerId, f.run.id);
      const state = await f.coordinator.getState(f.ownerId);
      expect(state.runs[0]?.status).toBe("FAILED");
      const task = state.tasks.find((item) => item.actionId === "WRITE_INSTALLATION_MEMORY")!;
      expect(task.status).toBe("NEEDS_ATTENTION");
      expect(state.receipts.some((receipt) => receipt.taskId === task.id)).toBe(false);
      expect((await readdir(f.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("rejects linked memory and replaces the link without modifying its target", async () => {
    const f = await fixture(true);
    try {
      const original = await readFile(join(f.handoffRoot, "INSTALLATION_MEMORY.md"), "utf8");
      await symlink(join(f.handoffRoot, "INSTALLATION_MEMORY.md"), join(f.root, "INSTALLATION_MEMORY.md"));
      expect(await setupInstallationMemoryMatches(f.root, original)).toBe(false);
      await writeSetupInstallationMemory(f.root, "verified continuation\n");
      expect(await setupInstallationMemoryMatches(f.root, "verified continuation\n")).toBe(true);
      expect(await readFile(join(f.handoffRoot, "INSTALLATION_MEMORY.md"), "utf8")).toBe(original);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("does not apply settings or issue Ready without current native free-model proof", async () => {
    const f = await fixture(false);
    try {
      const before = f.store.getUserSettings(f.ownerId);
      await new SetupActionRunner(f.coordinator, (task) => createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret
      })).pump(f.ownerId, f.run.id);
      const state = await f.coordinator.getState(f.ownerId);
      expect(state.runs[0]?.status).toBe("FAILED");
      expect(state.receipts).toHaveLength(0);
      expect(f.store.getUserSettings(f.ownerId)).toEqual(before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("bootstraps the container's first free model check from a signed host handoff", async () => {
    const f = await fixture(true);
    try {
      const modelPath = join(f.root, "installation-model.json");
      const model = await import("node:fs/promises").then((fs) => fs.readFile(modelPath, "utf8"));
      await rm(modelPath);
      const priorVerify = f.connections.verify;
      f.connections.verify = async (id) => {
        await writeFile(modelPath, model);
        return priorVerify(id);
      };
      await new SetupActionRunner(f.coordinator, (task) => createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret
      })).pump(f.ownerId, f.run.id);
      expect((await f.coordinator.getState(f.ownerId)).runs[0]?.status).toBe("READY");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  // Review 2026-10-21 #7: the installer runs its pre-Docker check only on a fresh install, so an installation upgraded from
  // before 1.1.8 has none. Setup observes a live tool call now and records it as its own check, never as a pre-Docker run.
  it("completes setup on an installation without the pre-Docker check after a live tool call, recorded as setup's own check", async () => {
    const f = await fixture(false);
    try {
      // What the upgrade's installer leaves: an unsigned-as-completed handoff ("Assistant status: unavailable").
      const memory = "# SpaceApp installation memory\n\nSchema: 1\nPlatform: linux\nHardware profile: small\nAssistant status: unavailable\nNext action: retry the free assistant check.\n";
      const payload = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId: null, completed: false };
      await writeFile(join(f.handoffRoot, "INSTALLATION_MEMORY.md"), memory);
      await writeFile(join(f.handoffRoot, "installation-handoff.json"), JSON.stringify({ ...payload,
        mac: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") }));
      const handoffBefore = (await readdir(f.handoffRoot)).sort();
      const priorVerify = f.connections.verify;
      let checks = 0;
      // The OpenCode check makes the live tool call and writes the model's proof.
      f.connections.verify = async (id) => {
        checks++;
        await writeFile(join(f.root, "installation-model.json"), JSON.stringify({ id: "opencode/big-pickle", verification: "tool-call",
          verifiedAt: new Date().toISOString(), cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }));
        return priorVerify(id);
      };
      const adapterFor = (task: Parameters<typeof createProductionSetupActionAdapter>[0]["task"]) => createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret });
      await new SetupActionRunner(f.coordinator, adapterFor).pump(f.ownerId, f.run.id);
      expect((await f.coordinator.getState(f.ownerId)).runs[0]?.status).toBe("READY");
      expect(checks).toBeGreaterThan(0);
      expect(await readAuthenticatedInstallationHandoff(f.handoffRoot, secret)).toBeNull();
      expect(await readSetupAssistantProof(f.handoffRoot, f.root, secret)).toMatchObject({ source: "UPGRADE", modelId: "opencode/big-pickle" });
      const written = await readFile(join(f.root, "INSTALLATION_MEMORY.md"), "utf8");
      expect(written).toContain("Installer handoff: none (no pre-Docker check on this installation); authenticated account-free assistant check by setup.");
      expect(written).not.toContain("before Docker setup");
      // The upgrade's signed handoff still names the platform and hardware profile (review 2026-10-21 #10).
      expect(written).toContain("Platform: linux\nHardware profile: small\n");
      expect(written).not.toContain("Completed installer assistant actions");
      expect(written).not.toContain("Installer handoff: authenticated account-free assistant check.");
      expect((await readdir(f.handoffRoot)).sort()).toEqual(handoffBefore);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("refuses a setup check record it did not sign and needs this installation's secret to make one", async () => {
    const f = await fixture(false);
    try {
      const at = new Date().toISOString();
      await writeInstallationUpgradeProof(f.root, "another-installation-secret-with-enough-length", "opencode/big-pickle", at);
      expect(await readSetupAssistantProof(f.handoffRoot, f.root, secret)).toBeNull();
      await writeInstallationUpgradeProof(f.root, secret, "opencode/big-pickle", at);
      const path = join(f.root, "installation-upgrade-proof.json");
      const saved = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...saved, modelId: "opencode/billed-model" }));
      expect(await readSetupAssistantProof(f.handoffRoot, f.root, secret)).toBeNull();
      const task = { ...f.plan.actions.find((action) => action.actionId === "PREPARE_OPENCODE")!,
        id: "task:prepare-no-secret", runId: f.run.id, status: "CHECKING" as const, attempt: 1, idempotencyKey: "test:prepare-no-secret",
        leaseOwner: "test", leaseExpiresAt: null, errorCode: null, resultRef: null };
      const adapter = createProductionSetupActionAdapter({ task, ownerId: f.ownerId, plan: f.plan, store: f.store,
        connections: f.connections, memoryRoot: f.root, handoffRoot: f.handoffRoot });
      expect(await adapter!.inspect(task)).toEqual({ outcome: "UNKNOWN" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("checks the existing agent session history service before enabling its dock", async () => {
    const f = await fixture(true);
    try {
      const task = { ...f.plan.actions.find((action) => action.actionId === "CHECK_SERVICE")!,
        id: "task:agent-sessions-service", runId: f.run.id, featureId: "dock:agent-sessions" as SetupFeatureId,
        status: "CHECKING" as const, attempt: 1, idempotencyKey: "test:agent-sessions",
        leaseOwner: "test", leaseExpiresAt: null, errorCode: null, resultRef: null };
      let checks = 0;
      const adapter = createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        memoryRoot: f.root, handoffRoot: f.handoffRoot, installationSecret: secret,
        checkAgentSessions: async () => { checks++; }
      });
      expect(adapter).not.toBeNull();
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED" });
      expect(checks).toBe(1);
      const unavailable = createProductionSetupActionAdapter({
        task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        checkAgentSessions: async () => { throw new Error("Session history unavailable"); }
      });
      await expect(unavailable!.inspect(task)).rejects.toThrow("Session history unavailable");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("verifies an optional runtime through its registered service check and fails closed", async () => {
    const f = await fixture(true);
    try {
      const task = { ...(await f.coordinator.getState(f.ownerId)).tasks[0]!,
        featureId: "pane:browser" as SetupFeatureId, actionId: "CHECK_SERVICE" as const };
      let healthy = true;
      const context = { task, ownerId: f.ownerId, plan: f.plan, store: f.store, connections: f.connections,
        capabilityChecks: { "pane:browser": async () => { if (!healthy) throw new Error("Browser unavailable"); } } };
      const adapter = createProductionSetupActionAdapter(context);
      expect(adapter).not.toBeNull();
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED" });
      healthy = false;
      await expect(adapter!.inspect(task)).rejects.toThrow("Browser unavailable");
      expect(createProductionSetupActionAdapter({ ...context, capabilityChecks: {} })).toBeNull();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("does not accept matching visible settings with stale Custom hidden tool fields", async () => {
    const f = await fixture(true);
    try {
      const expected = planSetupSettings(f.plan.effectiveFeatureIds, f.store.getUserSettings(f.ownerId));
      f.store.updateUserSettings(f.ownerId, { ...expected, customDocksHidden: [], customPanesHidden: [] });
      const task = { ...f.plan.actions.find((action) => action.actionId === "APPLY_SETTINGS")!,
        id: "task:apply-settings-proof", runId: f.run.id, status: "INSTALLING" as const,
        attempt: 1, idempotencyKey: "test:settings-proof", leaseOwner: "test",
        leaseExpiresAt: null, errorCode: null, resultRef: null };
      const adapter = createProductionSetupActionAdapter({ task, ownerId: f.ownerId, plan: f.plan,
        store: f.store, connections: f.connections });
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  // Review 2026-10-21 #5: finishing setup with a tested Live connection makes it the normal Live default; the other Live
  // preferences the owner had stay as they were.
  it("applies the tested Live provider, model and voice to the Live defaults and keeps the other Live preferences", async () => {
    const f = await fixture(true);
    try {
      f.store.updateUserSettings(f.ownerId, { livePane: { prompt: "Answer briefly.", language: "en" } });
      const state = await f.store.getSetupExecutionState(f.ownerId);
      const draft = await f.coordinator.updateDraft(f.ownerId, state!.draft!.revision, { persona: "creator", level: "balanced",
        requestedFeatureIds: [...choices, "pane:live"],
        connectionChoices: [{ featureId: "pane:live", providerId: "google", modelId: "gemini-3.8-live", voiceId: "Aoede" }] });
      const plan = await f.coordinator.createPlan(f.ownerId, draft.revision, availability, {});
      expect(plan.effectiveFeatureIds).toContain("pane:live");
      const task = { ...plan.actions.find((action) => action.actionId === "APPLY_SETTINGS")!,
        id: "task:apply-settings-live", runId: f.run.id, status: "INSTALLING" as const,
        attempt: 1, idempotencyKey: "test:settings-live", leaseOwner: "test",
        leaseExpiresAt: null, errorCode: null, resultRef: null };
      const adapter = createProductionSetupActionAdapter({ task, ownerId: f.ownerId, plan, store: f.store, connections: f.connections });
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
      await adapter!.apply(task);
      expect(f.store.getUserSettings(f.ownerId).livePane).toMatchObject({ provider: "google", voiceModel: "gemini-3.8-live",
        voice: "Aoede", prompt: "Answer briefly.", language: "en" });
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "VERIFIED" });
      // Another voice chosen afterwards is no longer what setup tested.
      f.store.updateUserSettings(f.ownerId, { livePane: { voice: "Puck" } });
      expect(await adapter!.inspect(task)).toMatchObject({ outcome: "NOT_APPLIED" });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
