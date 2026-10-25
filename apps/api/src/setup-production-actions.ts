import { createHash } from "node:crypto";
import type { SetupFeatureId, SetupPlan, SetupTask, UserSettings } from "@space/contracts";
import type { SetupActionAdapter, SetupActionInspection, SpaceStore } from "@space/runtime";
import type { SetupConnectionsService } from "./setup-connections.js";
import { readAuthenticatedInstallationHandoff, readSetupAssistantProof, writeInstallationUpgradeProof } from "./installation-handoff.js";
import { planSetupSettings, setupLiveDefaults } from "./setup-settings.js";
import { readVerifiedFreeModel, readVerifiedFreeModelProof } from "./verified-free-model.js";
import { projectSetupInstallationMemory, setupInstallationMemoryMatches, writeSetupInstallationMemory } from "./setup-installation-memory.js";

export const supportedSetupServices = new Set([
  "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings",
  "dock:clipboard", "dock:links", "dock:cli", "dock:agent-sessions"
]);

export type SetupCapabilityChecks = Partial<Record<SetupFeatureId, (ownerId: string) => Promise<void | string>>>;
export type SetupFunctionalChecks = Partial<Record<SetupFeatureId, {
  fingerprint: (ownerId: string) => Promise<string>;
  exercise: (ownerId: string) => Promise<void>;
}>>;

type Context = {
  task: SetupTask;
  ownerId: string;
  plan: SetupPlan;
  store: SpaceStore;
  connections: SetupConnectionsService;
  memoryRoot?: string;
  handoffRoot?: string;
  installationSecret?: string;
  checkAgentSessions?: () => Promise<void>;
  capabilityChecks?: SetupCapabilityChecks;
  functionalChecks?: SetupFunctionalChecks;
  selectedServiceFingerprint?: (ownerId: string) => Promise<string | null>;
  voiceFingerprint?: (ownerId: string) => Promise<string | null>;
  captureFingerprint?: (ownerId: string) => Promise<string | null>;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function setupSettingsMatch(current: UserSettings, expected: ReturnType<typeof planSetupSettings>): boolean {
  const sameIds = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id) => b.includes(id));
  if (current.environmentPreset !== expected.environmentPreset ||
      !sameIds(current.docksHidden, expected.docksHidden ?? []) ||
      !sameIds(current.panesHidden, expected.panesHidden ?? []) ||
      !sameIds(current.customDocksHidden, expected.customDocksHidden ?? []) ||
      !sameIds(current.customPanesHidden, expected.customPanesHidden ?? []) ||
      !sameIds(current.customCliDisabled, expected.customCliDisabled ?? [])) return false;
  const live = expected.livePane;
  if (live && (current.livePane.provider !== live.provider || current.livePane.voiceModel !== live.voiceModel ||
    current.livePane.voice !== live.voice)) return false;
  for (const [id, widget] of Object.entries(expected.desktopWidgets ?? {})) {
    if ((current.desktopWidgets as Record<string, unknown>)[id] &&
      JSON.stringify((current.desktopWidgets as Record<string, unknown>)[id]) !== JSON.stringify(widget)) return false;
    if (!(current.desktopWidgets as Record<string, unknown>)[id]) return false;
  }
  return true;
}

/** Each receipt is issued only after observing the server-side capability it names. */
export function createProductionSetupActionAdapter(context: Context): SetupActionAdapter | null {
  const { task, ownerId, plan, store, connections } = context;
  const agentId = task.featureId.startsWith("agent:") ? task.featureId.slice(6)
    : task.featureId === "pane:chat" ? "opencode" : null;
  const connectionId = agentId ? `cli:${agentId}` : null;
  const receipt = (subjectFingerprint: string): SetupActionInspection => ({
    outcome: "VERIFIED",
    receipt: {
      checkVersion: "first-setup:v2", subjectFingerprint,
      evidenceRef: `check:${task.actionId.toLowerCase()}:${task.featureId.replace(":", "-")}`
    }
  });
  const staticReceipt = () => receipt(hash(`${task.featureId}:${plan.catalogVersion}`));

  if (task.actionId === "VERIFY_CAPTURE" && task.featureId === "utility:snip" && context.captureFingerprint) {
    return {
      inspect: async () => {
        const fingerprint = await context.captureFingerprint!(ownerId);
        return fingerprint ? receipt(fingerprint) : { outcome: "NOT_APPLIED", evidenceRef: "check:capture-pending" };
      },
      apply: async () => { throw new Error("Complete the explicit Screen capture test first."); }
    };
  }

  if (task.actionId === "VERIFY_LIVE_AUDIO" && task.featureId === "pane:live" && context.voiceFingerprint) {
    return {
      inspect: async () => {
        const fingerprint = await context.voiceFingerprint!(ownerId);
        return fingerprint ? receipt(fingerprint) : { outcome: "NOT_APPLIED", evidenceRef: "check:live-audio-pending" };
      },
      apply: async () => { throw new Error("Complete the selected connection's microphone and playback check first."); }
    };
  }

  if (["VERIFY_DATABASE", "VERIFY_REMOTE_DESKTOP", "VERIFY_HARNESS", "VERIFY_STREAMING"].includes(task.actionId) && context.selectedServiceFingerprint) {
    if (task.featureId === "widget:streaming-metrics" && !context.capabilityChecks?.[task.featureId]) return null;
    return {
      inspect: async () => {
        const fingerprint = await context.selectedServiceFingerprint!(ownerId);
        if (fingerprint && task.featureId === "widget:streaming-metrics") await context.capabilityChecks![task.featureId]!(ownerId);
        return fingerprint ? receipt(fingerprint) : { outcome: "NOT_APPLIED", evidenceRef: "check:selected-service-pending" };
      },
      apply: async () => { throw new Error("Verify the selected authorized service connection first."); }
    };
  }

  if (task.actionId === "WRITE_INSTALLATION_MEMORY") {
    const projection = async () => {
      const [proof, modelId, state] = await Promise.all([
        readSetupAssistantProof(context.handoffRoot, context.memoryRoot, context.installationSecret, true),
        readVerifiedFreeModel(context.memoryRoot), store.getSetupExecutionState(ownerId)
      ]);
      return proof && modelId && state
        ? projectSetupInstallationMemory(state, plan, task, modelId, proof) : null;
    };
    return {
      inspect: async () => {
        const content = await projection();
        if (!context.memoryRoot || !content) return { outcome: "UNKNOWN" };
        if (!await setupInstallationMemoryMatches(context.memoryRoot, content)) {
          return { outcome: "NOT_APPLIED", evidenceRef: "check:installation-memory-pending" };
        }
        const saved = await store.getSetupConnectionVerification("cli:opencode");
        return saved?.state === "CONNECTED" && saved.fingerprintHash && saved.verifiedAt
          ? receipt(saved.fingerprintHash) : { outcome: "UNKNOWN" };
      },
      apply: async () => {
        const content = await projection();
        if (!context.memoryRoot || !content) throw new Error("Verified setup state is required before writing installation memory.");
        await writeSetupInstallationMemory(context.memoryRoot, content);
      }
    };
  }

  if (task.actionId === "PREPARE_OPENCODE") {
    // Without the installer's pre-Docker check (an installation upgraded from before 1.1.8; review 2026-10-21 #7) setup
    // observes a live account-free tool call now and signs it as an after-upgrade check, never as a pre-Docker run.
    const upgradeBootstrap = Boolean(context.memoryRoot && context.installationSecret && context.installationSecret.length >= 32);
    return {
      inspect: async () => {
        const [proof, currentModel, saved] = await Promise.all([
          readSetupAssistantProof(context.handoffRoot, context.memoryRoot, context.installationSecret),
          readVerifiedFreeModel(context.memoryRoot),
          store.getSetupConnectionVerification("cli:opencode")
        ]);
        if (!proof) return upgradeBootstrap
          ? { outcome: "NOT_APPLIED", evidenceRef: "check:opencode-upgrade-bootstrap-pending" } : { outcome: "UNKNOWN" };
        if (!currentModel) return { outcome: "NOT_APPLIED", evidenceRef: "check:opencode-bootstrap-pending" };
        return saved?.state === "CONNECTED" && saved.fingerprintHash && saved.verifiedAt
          ? receipt(saved.fingerprintHash)
          : { outcome: "NOT_APPLIED", evidenceRef: "check:opencode-pending" };
      },
      apply: async () => {
        // The OpenCode check renews the free model's tool-call proof where the installation manages that model.
        const result = await connections.verify("cli:opencode");
        if (result.functionalState !== "FUNCTIONAL" || result.liveVerificationState !== "VERIFIED") {
          throw new Error("The signed free OpenCode installation did not pass its runtime check.");
        }
        const installer = await readAuthenticatedInstallationHandoff(context.handoffRoot, context.installationSecret);
        if (installer?.completed || !upgradeBootstrap) return;
        const model = await readVerifiedFreeModelProof(context.memoryRoot);
        if (!model) throw new Error("No free OpenCode model completed a tool call. Choose a free model in setup and retry.");
        await writeInstallationUpgradeProof(context.memoryRoot!, context.installationSecret!, model.id, model.verifiedAt);
      }
    };
  }

  if (task.actionId === "VERIFY_AGENT_TASK" && connectionId) {
    return {
      inspect: async () => {
        if (agentId === "opencode" && !await readVerifiedFreeModel(context.memoryRoot)) return { outcome: "UNKNOWN" };
        const [observed, saved] = await Promise.all([
          connections.overview(), store.getSetupConnectionVerification(connectionId)
        ]);
        const current = observed.find((item) => item.id === connectionId);
        if (current?.functionalState !== "FUNCTIONAL" || current.liveVerificationState !== "VERIFIED" ||
            !current.verifiedAt || saved?.state !== "CONNECTED" || !saved.fingerprintHash || !saved.verifiedAt) {
          return { outcome: "NOT_APPLIED", evidenceRef: "check:agent-not-verified" };
        }
        return task.featureId.startsWith("agent:") ? receipt(saved.fingerprintHash) : staticReceipt();
      },
      apply: async () => {
        const result = await connections.verify(connectionId);
        if (result.functionalState !== "FUNCTIONAL" || result.liveVerificationState !== "VERIFIED") {
          throw new Error("The selected agent did not complete a native provider check.");
        }
      }
    };
  }

  const functionalCheck = context.functionalChecks?.[task.featureId];
  if (functionalCheck && (task.actionId === "CHECK_SERVICE" || task.actionId === "VERIFY_AGENT_TASK" && task.featureId === "dock:room-agent")) {
    const connectionId = `setup:runtime:${hash(ownerId).slice(0, 24)}:${task.featureId.replace(":", "-")}`;
    const fingerprint = async () => hash(`${task.featureId}:${plan.catalogVersion}:${await functionalCheck.fingerprint(ownerId)}`);
    return {
      inspect: async () => {
        const current = await fingerprint();
        const saved = await store.getSetupConnectionVerification(connectionId);
        const age = saved?.verifiedAt ? Date.now() - Date.parse(saved.verifiedAt) : Infinity;
        return saved?.state === "CONNECTED" && saved.fingerprintHash === current && age >= 0 && age < 10 * 60_000
          ? receipt(current) : { outcome: "NOT_APPLIED", evidenceRef: "check:runtime-function-pending" };
      },
      apply: async () => {
        const before = await fingerprint();
        await functionalCheck.exercise(ownerId);
        if (before !== await fingerprint()) throw new Error("The selected runtime changed during its function check.");
        const now = new Date().toISOString();
        await store.upsertSetupConnectionVerification({ connectionId, state: "CONNECTED", reasonCode: null,
          fingerprintHash: before, verifiedAt: now, updatedAt: now });
      }
    };
  }

  const capabilityCheck = context.capabilityChecks?.[task.featureId];
  if (task.actionId === "CHECK_SERVICE" && capabilityCheck) {
    return {
      inspect: async () => {
        const fingerprint = await capabilityCheck(ownerId);
        return typeof fingerprint === "string" ? receipt(fingerprint) : staticReceipt();
      },
      apply: async () => { throw new Error("This capability must be repaired through its existing service."); }
    };
  }

  if (task.actionId === "CHECK_SERVICE" && supportedSetupServices.has(task.featureId)) {
    if (task.featureId === "dock:agent-sessions" && !context.checkAgentSessions) return null;
    return {
      inspect: async () => {
        if (task.featureId === "dock:rooms") await store.listRooms(ownerId);
        else if (task.featureId === "dock:tasks") await store.listTaskItems(ownerId);
        else if (task.featureId === "dock:agent-files") await store.listArtifacts({ page: 1, pageSize: 1, sortOrder: "desc" });
        else if (task.featureId === "dock:settings") await store.getUserSettings(ownerId);
        else if (task.featureId === "dock:clipboard") await store.listClipboardItems(ownerId);
        else if (task.featureId === "dock:links") await store.listUserLinks(ownerId);
        else if (task.featureId === "dock:cli") await connections.overview();
        else if (task.featureId === "dock:agent-sessions") await context.checkAgentSessions!();
        return staticReceipt();
      },
      apply: async () => { throw new Error("A service check cannot be installed by setup."); }
    };
  }

  if (task.actionId === "APPLY_SETTINGS") {
    const liveDefaults = async () => setupLiveDefaults((await store.getSetupExecutionState(ownerId))?.draft, plan);
    return {
      inspect: async () => {
        const [current, live] = await Promise.all([store.getUserSettings(ownerId), liveDefaults()]);
        const expected = planSetupSettings(plan.effectiveFeatureIds, current, live);
        return setupSettingsMatch(current, expected)
          ? staticReceipt() : { outcome: "NOT_APPLIED", evidenceRef: "check:settings-pending" };
      },
      apply: async () => {
        const [current, live] = await Promise.all([store.getUserSettings(ownerId), liveDefaults()]);
        await store.updateUserSettings(ownerId, planSetupSettings(plan.effectiveFeatureIds, current, live));
      }
    };
  }

  if (task.actionId === "ENSURE_STARTER_ROOM") {
    return {
      inspect: async () => {
        const onboarding = await store.getOwnerOnboarding();
        if (!onboarding.starterRoomId) return { outcome: "NOT_APPLIED", evidenceRef: "check:room-pending" };
        try { await store.getRoom(onboarding.starterRoomId); return staticReceipt(); }
        catch { return { outcome: "NOT_APPLIED", evidenceRef: "check:room-pending" }; }
      },
      apply: async () => { await store.ensureOwnerStarterRoom(); }
    };
  }
  return null;
}
