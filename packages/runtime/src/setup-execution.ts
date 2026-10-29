import { createHash, randomUUID } from "node:crypto";
import {
  SETUP_CATALOG, SETUP_CATALOG_VERSION, resolveSetupSelection, getSetupDependencyClosure,
  setupCompletionSchema, setupDraftSchema, setupPlanSchema, setupReadinessReceiptSchema,
  type SetupActionId, type SetupAvailability,
  type SetupCompletion, type SetupDraft, type SetupExecutionState, type SetupFeatureId,
  type SetupPlan,
  type SetupRun, type SetupTask
} from "@space/contracts";
import type { SpaceStore } from "./store.js";

const maxEvents = 500;
const receiptLifetimeMs = 15 * 60_000;
/** A receipt this close to expiry is checked again before finish rather than finishing on its last seconds. */
export const SETUP_RECEIPT_RENEWAL_WINDOW_MS = 60_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class SetupExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SetupExecutionError";
  }
}

type DraftChoices = Pick<SetupDraft, "persona" | "level" | "requestedFeatureIds" | "connectionChoices">;
type Fingerprints = Partial<Record<SetupFeatureId, string>>;
type ReceiptInput = { checkVersion: string; subjectFingerprint: string; evidenceRef: string };
export interface CompleteSetupExecutionInput {
  reconfigure?: boolean;
  ownerId: string;
  expectedStateRevision: number;
  runId: string;
  draftRevision: number;
  planDigest: string;
  currentFingerprints: Fingerprints;
  completedAt: string;
}

/** Rechecked under the store's owner-state lock immediately before onboarding is committed. */
export function createSetupCompletion(
  state: SetupExecutionState, input: CompleteSetupExecutionInput, starterRoomId: string
): SetupCompletion {
  if (state.ownerId !== input.ownerId || state.revision !== input.expectedStateRevision) {
    throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup state revision changed before completion.");
  }
  const run = state.runs.find((item) => item.id === input.runId);
  const plan = state.plans.find((item) => item.id === run?.planId);
  if (!state.draft || !run || !plan || state.plans.at(-1)?.id !== plan.id ||
    state.draft.id !== plan.draftId || state.draft.revision !== input.draftRevision ||
    plan.draftRevision !== input.draftRevision || plan.planDigest !== input.planDigest) {
    throw new SetupExecutionError("SETUP_PLAN_STALE", "Setup selection or plan changed before completion.");
  }
  if (run.status !== "READY" || state.appliedSettingsRevision == null || state.memoryHandoffRevision == null) {
    throw new SetupExecutionError("SETUP_NOT_READY", "Setup application and memory handoff must be verified.");
  }
  const tasks = state.tasks.filter((task) => task.runId === run.id);
  const requiredActions = new Set(["APPLY_SETTINGS", "ENSURE_STARTER_ROOM", "WRITE_INSTALLATION_MEMORY"]);
  if (tasks.length !== plan.actions.length || ![...requiredActions].every((id) => tasks.some((task) => task.actionId === id))) {
    throw new SetupExecutionError("SETUP_NOT_READY", "Setup plan is missing required final actions.");
  }
  const now = Date.parse(input.completedAt);
  const receipts = tasks.map((task) => state.receipts.find((receipt) => receipt.taskId === task.id));
  if (!Number.isFinite(now) || tasks.some((task, index) =>
    task.status !== "READY" || !receipts[index] ||
    receipts[index]!.outcome !== "PASSED" || Date.parse(receipts[index]!.expiresAt) <= now ||
    input.currentFingerprints[task.featureId] !== receipts[index]!.subjectFingerprint
  )) {
    throw new SetupExecutionError("SETUP_NOT_READY", "Selected setup checks have expired or changed.");
  }
  return setupCompletionSchema.parse({
    runId: run.id, draftRevision: state.draft.revision, planDigest: plan.planDigest,
    settingsRevision: state.appliedSettingsRevision,
    memoryHandoffRevision: state.memoryHandoffRevision,
    receiptSetHash: hash(receipts.map((receipt) => [
      receipt!.id, receipt!.taskId, receipt!.checkVersion, receipt!.subjectFingerprint, receipt!.evidenceRef
    ])),
    starterRoomId, completedAt: input.completedAt
  });
}

// One owner document holds every setup graph; the schema caps it at 50 plans, 50 runs and 500 tasks (a Full run has about
// 53 tasks). Keeping at most 6 runs and 10 plans leaves room for the next plan and run, however often setup is changed.
const maxRetainedRuns = 6;
const maxRetainedPlans = 10;

/**
 * Superseded setup graphs are history (review 2026-10-21 #9; class B under the record retention rule): the completed run,
 * any active run, the newest runs and the latest plan stay with their tasks, receipts, events and request keys; older
 * finished runs and plans no run uses leave, so reconfiguring setup never reaches the schema limits.
 */
export function compactSetupHistory(state: SetupExecutionState): void {
  if (state.runs.length <= maxRetainedRuns && state.plans.length <= maxRetainedPlans) return;
  const keepRuns = new Set<string>();
  if (state.completion?.runId) keepRuns.add(state.completion.runId);
  for (const run of state.runs) if (["RUNNING", "PAUSED", "WAITING_FOR_INPUT"].includes(run.status)) keepRuns.add(run.id);
  for (const run of [...state.runs].reverse()) {
    if (keepRuns.size >= maxRetainedRuns) break;
    keepRuns.add(run.id);
  }
  state.runs = state.runs.filter((run) => keepRuns.has(run.id));
  state.tasks = state.tasks.filter((task) => keepRuns.has(task.runId));
  state.receipts = state.receipts.filter((receipt) => keepRuns.has(receipt.runId));
  state.events = state.events.filter((item) => keepRuns.has(item.runId));
  state.runIdempotency = state.runIdempotency.filter((entry) => keepRuns.has(entry.runId));
  const keepPlans = new Set(state.runs.map((run) => run.planId));
  const latest = state.plans.at(-1);
  if (latest) keepPlans.add(latest.id);
  for (const plan of [...state.plans].reverse()) {
    if (keepPlans.size >= maxRetainedPlans) break;
    keepPlans.add(plan.id);
  }
  state.plans = state.plans.filter((plan) => keepPlans.has(plan.id));
}

function emptyState(ownerId: string): SetupExecutionState {
  return { ownerId, revision: 0, draft: null, plans: [], runs: [], tasks: [], receipts: [], events: [], runIdempotency: [] };
}

function actionFor(featureId: SetupFeatureId): SetupActionId {
  if (featureId === "pane:live") return "VERIFY_LIVE_AUDIO";
  if (featureId === "pane:databases") return "VERIFY_DATABASE";
  if (featureId === "pane:vnc") return "VERIFY_REMOTE_DESKTOP";
  if (featureId === "pane:harness") return "VERIFY_HARNESS";
  if (featureId === "dock:streaming" || featureId === "widget:streaming-metrics") return "VERIFY_STREAMING";
  if (featureId === "utility:snip") return "VERIFY_CAPTURE";
  if (featureId.startsWith("agent:") || featureId === "pane:chat" || featureId === "dock:room-agent") return "VERIFY_AGENT_TASK";
  return "CHECK_SERVICE";
}

function buildActions(effectiveIds: readonly SetupFeatureId[]): SetupPlan["actions"] {
  const selected = new Set(effectiveIds);
  const entries = SETUP_CATALOG.filter((feature) => selected.has(feature.id));
  const finalActionId = (id: SetupFeatureId) => `action:${id}:${actionFor(id)}`;
  const actions: SetupPlan["actions"] = [];
  for (const feature of entries) {
    if (feature.id === "agent:opencode") {
      actions.push({ id: "action:agent:opencode:PREPARE_OPENCODE", featureId: feature.id, actionId: "PREPARE_OPENCODE", dependsOn: [] });
    }
    actions.push({
      id: finalActionId(feature.id), featureId: feature.id, actionId: actionFor(feature.id),
      dependsOn: [
        ...feature.dependencies.filter((id) => selected.has(id)).map(finalActionId),
        ...(feature.id === "agent:opencode" ? ["action:agent:opencode:PREPARE_OPENCODE"] : [])
      ]
    });
  }
  const checks = actions.map((action) => action.id);
  actions.push({
    id: "action:dock:settings:APPLY_SETTINGS", featureId: "dock:settings",
    actionId: "APPLY_SETTINGS", dependsOn: checks
  });
  actions.push({
    id: "action:dock:rooms:ENSURE_STARTER_ROOM", featureId: "dock:rooms",
    actionId: "ENSURE_STARTER_ROOM", dependsOn: ["action:dock:settings:APPLY_SETTINGS"]
  });
  actions.push({
    id: "action:agent:opencode:WRITE_INSTALLATION_MEMORY", featureId: "agent:opencode",
    actionId: "WRITE_INSTALLATION_MEMORY", dependsOn: ["action:dock:rooms:ENSURE_STARTER_ROOM"]
  });
  return actions;
}

const installationActions = new Set<SetupActionId>([
  "PREPARE_OPENCODE", "CONNECT_PROVIDER", "APPLY_SETTINGS", "ENSURE_STARTER_ROOM", "WRITE_INSTALLATION_MEMORY"
]);

const entriesWithHumanInputs: Array<{
  featureId: SetupFeatureId;
  kind: SetupPlan["requiredHumanInputs"][number]["kind"];
  reasonCode: string;
}> = [
  ...SETUP_CATALOG.filter((feature) => feature.kind === "agent" && feature.id !== "agent:opencode")
    .map((feature) => ({ featureId: feature.id, kind: "PROVIDER_LOGIN" as const, reasonCode: "AGENT_CONNECTION_REQUIRED" })),
  { featureId: "pane:live", kind: "API_CREDENTIAL", reasonCode: "LIVE_PROVIDER_REQUIRED" },
  { featureId: "pane:databases", kind: "API_CREDENTIAL", reasonCode: "DATABASE_CONNECTION_REQUIRED" },
  { featureId: "pane:vnc", kind: "PROVIDER_LOGIN", reasonCode: "REMOTE_DESKTOP_REQUIRED" },
  { featureId: "pane:harness", kind: "PROVIDER_LOGIN", reasonCode: "HARNESS_CONNECTION_REQUIRED" },
  { featureId: "dock:streaming", kind: "API_CREDENTIAL", reasonCode: "STREAMING_DESTINATION_REQUIRED" },
  { featureId: "utility:snip", kind: "OS_PERMISSION", reasonCode: "CAPTURE_PERMISSION_REQUIRED" }
];

function findRun(state: SetupExecutionState, runId: string): SetupRun {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new SetupExecutionError("SETUP_RUN_NOT_FOUND", "Setup run was not found.");
  return run;
}

function findTask(state: SetupExecutionState, runId: string, taskId: string): SetupTask {
  const task = state.tasks.find((item) => item.id === taskId && item.runId === runId);
  if (!task) throw new SetupExecutionError("SETUP_TASK_NOT_FOUND", "Setup task was not found.");
  return task;
}

function event(state: SetupExecutionState, run: SetupRun, task: SetupTask, now: string) {
  run.eventSequence++;
  state.events.push({
    runId: run.id, sequence: run.eventSequence, taskId: task.id,
    state: task.status, reasonCode: task.errorCode, createdAt: now
  });
  state.events = state.events.slice(-maxEvents);
}

/** Persisted state transitions are revision-CAS; only server-owned action adapters may settle tasks. */
export class SetupExecutionCoordinator {
  constructor(
    private readonly store: Pick<SpaceStore, "getSetupExecutionState" | "compareAndSwapSetupExecutionState">,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async getState(ownerId: string): Promise<SetupExecutionState> {
    return await this.store.getSetupExecutionState(ownerId) ?? emptyState(ownerId);
  }

  private async mutate<T>(ownerId: string, change: (state: SetupExecutionState) => { value: T; write?: boolean }): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = await this.store.getSetupExecutionState(ownerId);
      const state = existing ? structuredClone(existing) : emptyState(ownerId);
      const result = change(state);
      if (result.write === false) return result.value;
      compactSetupHistory(state);
      state.revision = existing === null ? 0 : existing.revision + 1;
      if (await this.store.compareAndSwapSetupExecutionState(ownerId, existing?.revision ?? null, state)) return result.value;
    }
    throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup changed in another tab. Refresh and try again.");
  }

  async updateDraft(ownerId: string, expectedRevision: number | null, input: DraftChoices): Promise<SetupDraft> {
    const allowed = new Set(SETUP_CATALOG.map((feature) => feature.id));
    if (input.requestedFeatureIds.some((id) => !allowed.has(id))) {
      throw new SetupExecutionError("SETUP_UNKNOWN_FEATURE", "Setup selection contains an unknown feature.");
    }
    const selected = new Set(getSetupDependencyClosure(input.requestedFeatureIds));
    if (input.connectionChoices.some((choice) => !selected.has(choice.featureId))) {
      throw new SetupExecutionError("SETUP_UNSELECTED_CONNECTION", "Connection must belong to a selected feature.");
    }
    return this.mutate(ownerId, (state) => {
      if ((state.draft?.revision ?? null) !== expectedRevision) {
        throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup changed in another tab. Refresh and try again.");
      }
      const now = this.clock().toISOString();
      const draft = setupDraftSchema.parse({
        id: state.draft?.id ?? `draft:${randomUUID()}`, ownerId, protocolVersion: 2,
        revision: (state.draft?.revision ?? -1) + 1,
        persona: input.persona, level: input.level,
        requestedFeatureIds: input.requestedFeatureIds,
        connectionChoices: input.connectionChoices,
        catalogVersion: SETUP_CATALOG_VERSION, updatedAt: now
      });
      for (const run of state.runs) {
        if (run.status !== "CANCELLED" && run.status !== "SUPERSEDED" && run.status !== "READY") {
          run.status = "SUPERSEDED";
          run.revision++;
          run.updatedAt = now;
          run.finishedAt = now;
        }
      }
      state.draft = draft;
      return { value: draft };
    });
  }

  async createPlan(
    ownerId: string, expectedDraftRevision: number,
    availability: Partial<Record<SetupFeatureId, SetupAvailability>>,
    subjectFingerprints: Fingerprints
  ): Promise<SetupPlan> {
    return this.mutate(ownerId, (state) => {
      const draft = state.draft;
      if (!draft || draft.revision !== expectedDraftRevision) {
        throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup draft is stale.");
      }
      const resolution = resolveSetupSelection(draft.requestedFeatureIds, availability);
      if (resolution.issues.length || resolution.effectiveIds.length !== new Set([...resolution.requestedIds, ...resolution.dependencyIds]).size) {
        throw new SetupExecutionError("SETUP_FEATURE_UNAVAILABLE", "One or more selected tools are unavailable.");
      }
      if (Object.entries(subjectFingerprints).some(([id, fingerprint]) =>
        !resolution.effectiveIds.includes(id as SetupFeatureId) || !/^[a-f0-9]{64}$/.test(fingerprint ?? "")
      )) {
        throw new SetupExecutionError("SETUP_INVALID_SUBJECT", "Connection subjects must be selected features with valid fingerprints.");
      }
      const actions = buildActions(resolution.effectiveIds);
      const digest = hash({
        protocolVersion: 2, catalogVersion: draft.catalogVersion, draftId: draft.id,
        draftRevision: draft.revision, persona: draft.persona, level: draft.level,
        requested: resolution.requestedIds, effective: resolution.effectiveIds, actions,
        choices: [...draft.connectionChoices].sort((a, b) => a.featureId.localeCompare(b.featureId)),
        subjects: Object.entries(subjectFingerprints).sort(([a], [b]) => a.localeCompare(b))
      });
      const prior = state.plans.at(-1)?.planDigest === digest ? state.plans.at(-1) : undefined;
      if (prior) return { value: prior, write: false };
      const selected = new Set(resolution.effectiveIds);
      const requiredHumanInputs: SetupPlan["requiredHumanInputs"] = [];
      const needs = (featureId: SetupFeatureId, kind: SetupPlan["requiredHumanInputs"][number]["kind"], reasonCode: string) => {
        if (selected.has(featureId) && !subjectFingerprints[featureId]) requiredHumanInputs.push({ featureId, kind, reasonCode });
      };
      for (const feature of entriesWithHumanInputs) {
        if (!selected.has(feature.featureId)) continue;
        if (feature.featureId === "pane:live") {
          const choice = draft.connectionChoices.find((item) => item.featureId === "pane:live");
          needs("pane:live", "API_CREDENTIAL", choice?.providerId ? "LIVE_CREDENTIAL_REQUIRED" : "LIVE_PROVIDER_REQUIRED");
          needs("pane:live", "MICROPHONE", "LIVE_MICROPHONE_CHECK_REQUIRED");
          continue;
        }
        needs(feature.featureId, feature.kind, feature.reasonCode);
      }
      const plan = setupPlanSchema.parse({
        id: `plan:${randomUUID()}`, draftId: draft.id, ownerId,
        draftRevision: draft.revision, catalogVersion: draft.catalogVersion,
        planDigest: digest, requestedFeatureIds: resolution.requestedIds,
        effectiveFeatureIds: resolution.effectiveIds, actions,
        requiredHumanInputs,
        costDisclosures: SETUP_CATALOG.filter((feature) => selected.has(feature.id))
          .map((feature) => ({ featureId: feature.id, costClass: feature.costClass })),
        resourceConstraints: [], createdAt: this.clock().toISOString()
      });
      state.plans.push(plan);
      return { value: plan };
    });
  }

  async startRun(ownerId: string, planId: string, planDigest: string, idempotencyKey: string): Promise<SetupRun> {
    if (!/^[a-z][a-z0-9._:-]{3,127}$/.test(idempotencyKey)) {
      throw new SetupExecutionError("SETUP_INVALID_IDEMPOTENCY", "Invalid setup request key.");
    }
    return this.mutate(ownerId, (state) => {
      const duplicate = state.runIdempotency.find((entry) => entry.key === idempotencyKey);
      if (duplicate) return { value: findRun(state, duplicate.runId), write: false };
      const plan = state.plans.find((candidate) => candidate.id === planId && candidate.planDigest === planDigest);
      if (!plan || !state.draft || plan.draftId !== state.draft.id ||
        plan.draftRevision !== state.draft.revision ||
        state.plans.at(-1)?.id !== plan.id) {
        throw new SetupExecutionError("SETUP_PLAN_STALE", "Setup plan no longer matches the current choices.");
      }
      if (plan.requiredHumanInputs.length) {
        throw new SetupExecutionError("SETUP_INPUT_REQUIRED", "Complete the selected connections and permissions before starting setup.");
      }
      if (state.runs.some((candidate) => candidate.status === "RUNNING" || candidate.status === "PAUSED" || candidate.status === "WAITING_FOR_INPUT")) {
        throw new SetupExecutionError("SETUP_RUN_ACTIVE", "Another setup run is active.");
      }
      const now = this.clock().toISOString();
      const run: SetupRun = {
        id: `run:${randomUUID()}`, planId, ownerId, status: "RUNNING",
        revision: 1, eventSequence: 0, createdAt: now, updatedAt: now, finishedAt: null
      };
      state.runs.push(run);
      state.tasks.push(...plan.actions.map((action) => ({
        id: `task:${run.id.slice(4)}:${action.id}`, runId: run.id,
        actionId: action.actionId, featureId: action.featureId,
        dependsOn: action.dependsOn.map((dependency) => `task:${run.id.slice(4)}:${dependency}`),
        status: "QUEUED" as const, attempt: 0,
        idempotencyKey: `action:${hash([ownerId, action.id, plan.planDigest]).slice(0, 48)}`,
        leaseOwner: null, leaseExpiresAt: null, errorCode: null, resultRef: null
      })));
      state.runIdempotency.push({ key: idempotencyKey, runId: run.id });
      return { value: run };
    });
  }

  async leaseNextTask(ownerId: string, runId: string, workerId: string, durationMs: number): Promise<SetupTask | null> {
    if (!Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 120_000) {
      throw new SetupExecutionError("SETUP_INVALID_LEASE", "Invalid setup task lease.");
    }
    return this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      if (run.status !== "RUNNING") return { value: null, write: false };
      const now = this.clock();
      const tasks = state.tasks.filter((task) => task.runId === runId);
      let reconciled = false;
      for (const task of tasks) {
        if (task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) <= now.getTime() && (task.status === "INSTALLING" || task.status === "CHECKING")) {
          task.status = "NEEDS_ATTENTION";
          task.errorCode = "LEASE_EXPIRED_RECONCILE";
          task.leaseOwner = null;
          task.leaseExpiresAt = null;
          event(state, run, task, now.toISOString());
          reconciled = true;
        }
      }
      if (reconciled) {
        run.status = "FAILED";
        run.revision++;
        run.updatedAt = now.toISOString();
        return { value: null };
      }
      const readyIds = new Set(tasks.filter((task) => task.status === "READY").map((task) => task.id));
      const installing = tasks.filter((candidate) => candidate.status === "INSTALLING").length;
      const checking = tasks.filter((candidate) => candidate.status === "CHECKING").length;
      const task = tasks.find((candidate) => {
        if (candidate.status !== "QUEUED" || !candidate.dependsOn.every((id) => readyIds.has(id))) return false;
        return installationActions.has(candidate.actionId) ? installing < 1 : checking < 2;
      });
      if (!task) return { value: null, write: false };
      task.status = installationActions.has(task.actionId) ? "INSTALLING" : "CHECKING";
      task.attempt++;
      task.leaseOwner = workerId;
      task.leaseExpiresAt = new Date(now.getTime() + durationMs).toISOString();
      run.revision++;
      run.updatedAt = now.toISOString();
      event(state, run, task, now.toISOString());
      return { value: task };
    });
  }

  async completeTask(ownerId: string, runId: string, taskId: string, workerId: string, input: ReceiptInput): Promise<void> {
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      const task = findTask(state, runId, taskId);
      if (run.status !== "RUNNING" && run.status !== "PAUSED") throw new SetupExecutionError("SETUP_RUN_NOT_ACTIVE", "Setup run is not active.");
      if (task.leaseOwner !== workerId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= this.clock().getTime()) {
        throw new SetupExecutionError("SETUP_LEASE_STALE", "Setup task lease expired or belongs to another worker.");
      }
      const now = this.clock();
      const receipt = setupReadinessReceiptSchema.parse({
        id: `receipt:${randomUUID()}`, runId, taskId, featureId: task.featureId,
        ...input, completedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + receiptLifetimeMs).toISOString(), outcome: "PASSED"
      });
      state.receipts = state.receipts.filter((item) => item.taskId !== taskId);
      state.receipts.push(receipt);
      task.status = "READY";
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.errorCode = null;
      task.resultRef = input.evidenceRef;
      if (task.actionId === "APPLY_SETTINGS") state.appliedSettingsRevision = state.revision + 1;
      if (task.actionId === "WRITE_INSTALLATION_MEMORY") state.memoryHandoffRevision = state.revision + 1;
      run.revision++;
      run.updatedAt = now.toISOString();
      event(state, run, task, now.toISOString());
      if (state.tasks.filter((item) => item.runId === runId).every((item) => item.status === "READY")) {
        run.status = "READY";
        run.finishedAt = now.toISOString();
      }
      return { value: undefined };
    });
  }

  async failTask(ownerId: string, runId: string, taskId: string, workerId: string, reasonCode: string): Promise<void> {
    if (!/^[A-Z0-9_]{1,80}$/.test(reasonCode)) throw new SetupExecutionError("SETUP_INVALID_REASON", "Invalid setup failure code.");
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      const task = findTask(state, runId, taskId);
      if (task.leaseOwner !== workerId || !task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= this.clock().getTime()) {
        throw new SetupExecutionError("SETUP_LEASE_STALE", "Setup task lease expired or belongs to another worker.");
      }
      task.status = "NEEDS_ATTENTION";
      task.errorCode = reasonCode;
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      run.status = "FAILED";
      run.revision++;
      run.updatedAt = this.clock().toISOString();
      event(state, run, task, run.updatedAt);
      return { value: undefined };
    });
  }

  async pauseRun(ownerId: string, runId: string): Promise<void> {
    await this.changeRunStatus(ownerId, runId, ["RUNNING"], "PAUSED");
  }

  async resumeRun(ownerId: string, runId: string): Promise<void> {
    await this.changeRunStatus(ownerId, runId, ["PAUSED"], "RUNNING");
  }

  async cancelRun(ownerId: string, runId: string): Promise<void> {
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      if (run.status === "CANCELLED") return { value: undefined, write: false };
      if (run.status === "READY") throw new SetupExecutionError("SETUP_RUN_COMPLETE", "Completed setup cannot be cancelled.");
      const now = this.clock().toISOString();
      run.status = "CANCELLED";
      run.revision++;
      run.updatedAt = now;
      run.finishedAt = now;
      for (const task of state.tasks.filter((candidate) => candidate.runId === runId && candidate.status !== "READY")) {
        task.status = "CANCELLED";
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        event(state, run, task, now);
      }
      return { value: undefined };
    });
  }

  private async changeRunStatus(ownerId: string, runId: string, from: SetupRun["status"][], to: SetupRun["status"]): Promise<void> {
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      if (run.status === to) return { value: undefined, write: false };
      if (!from.includes(run.status)) throw new SetupExecutionError("SETUP_RUN_NOT_ACTIVE", "Setup run cannot change to that state.");
      run.status = to;
      run.revision++;
      run.updatedAt = this.clock().toISOString();
      return { value: undefined };
    });
  }

  async retryFailedTasks(ownerId: string, runId: string, taskIds: readonly string[], expectedRunRevision: number): Promise<void> {
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      if (run.revision !== expectedRunRevision) throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup run changed in another tab.");
      if (run.status !== "FAILED") throw new SetupExecutionError("SETUP_RUN_NOT_FAILED", "Only failed setup work can be retried.");
      const tasks = state.tasks.filter((task) => task.runId === runId);
      const requested = new Set(taskIds);
      if (!requested.size || [...requested].some((id) => !tasks.some((task) => task.id === id && task.status === "NEEDS_ATTENTION"))) {
        throw new SetupExecutionError("SETUP_RETRY_SCOPE_INVALID", "Retry must target failed setup tasks.");
      }
      if (tasks.some((task) => requested.has(task.id) && task.errorCode === "LEASE_EXPIRED_RECONCILE")) {
        throw new SetupExecutionError("SETUP_RECONCILIATION_REQUIRED", "Inspect the previous setup action before retrying it.");
      }
      const reset = new Set(requested);
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of tasks) {
          if (!reset.has(task.id) && task.dependsOn.some((id) => reset.has(id))) {
            reset.add(task.id);
            changed = true;
          }
        }
      }
      const now = this.clock().toISOString();
      state.receipts = state.receipts.filter((receipt) => !reset.has(receipt.taskId));
      for (const task of tasks.filter((candidate) => reset.has(candidate.id))) {
        task.status = "QUEUED";
        task.errorCode = null;
        task.resultRef = null;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        event(state, run, task, now);
      }
      run.status = "RUNNING";
      run.revision++;
      run.updatedAt = now;
      run.finishedAt = null;
      return { value: undefined };
    });
  }

  /**
   * A READY run whose successful checks expired before finish (a closed browser, a long pause; review 2026-10-21 #8) checks
   * only those tasks again, in the same run: the runner inspects each first and applies it again only when its effect is
   * gone, so completed work is kept. Only READY tasks of the current plan whose receipt has expired or is about to.
   */
  async revalidateStaleTasks(ownerId: string, runId: string, taskIds: readonly string[], expectedRunRevision: number): Promise<void> {
    await this.mutate(ownerId, (state) => {
      const run = findRun(state, runId);
      if (run.revision !== expectedRunRevision) throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Setup run changed in another tab.");
      if (run.status !== "READY") throw new SetupExecutionError("SETUP_RUN_NOT_READY", "Only a completed setup run can check its expired results again.");
      const plan = state.plans.find((candidate) => candidate.id === run.planId);
      if (!plan || !state.draft || plan.draftId !== state.draft.id || plan.draftRevision !== state.draft.revision ||
        state.plans.at(-1)?.id !== plan.id) {
        throw new SetupExecutionError("SETUP_PLAN_STALE", "Setup plan no longer matches the current choices.");
      }
      const now = this.clock();
      const tasks = state.tasks.filter((task) => task.runId === runId);
      const stale = (task: SetupTask) => task.status === "READY" && !state.receipts.some((receipt) =>
        receipt.taskId === task.id && receipt.outcome === "PASSED" && Date.parse(receipt.expiresAt) > now.getTime() + SETUP_RECEIPT_RENEWAL_WINDOW_MS);
      const requested = new Set(taskIds);
      if (!requested.size || [...requested].some((id) => !tasks.some((task) => task.id === id && stale(task)))) {
        throw new SetupExecutionError("SETUP_RETRY_SCOPE_INVALID", "Only expired setup checks can be checked again.");
      }
      state.receipts = state.receipts.filter((receipt) => !requested.has(receipt.taskId));
      for (const task of tasks.filter((candidate) => requested.has(candidate.id))) {
        task.status = "QUEUED";
        task.errorCode = null;
        task.leaseOwner = null;
        task.leaseExpiresAt = null;
        event(state, run, task, now.toISOString());
      }
      run.status = "RUNNING";
      run.revision++;
      run.updatedAt = now.toISOString();
      run.finishedAt = null;
      return { value: undefined };
    });
  }

  async reconcileExpiredTask(
    ownerId: string, runId: string, taskId: string,
    inspect: (task: SetupTask) => Promise<
      { outcome: "VERIFIED"; receipt: ReceiptInput } |
      { outcome: "NOT_APPLIED"; evidenceRef: string } |
      { outcome: "UNKNOWN" }
    >
  ): Promise<void> {
    const state = await this.getState(ownerId);
    if (findRun(state, runId).status !== "FAILED") {
      throw new SetupExecutionError("SETUP_RUN_NOT_ACTIVE", "Run cannot be reconciled in its current state.");
    }
    const previous = findTask(state, runId, taskId);
    if (previous.status !== "NEEDS_ATTENTION" || previous.errorCode !== "LEASE_EXPIRED_RECONCILE") {
      throw new SetupExecutionError("SETUP_RECONCILIATION_NOT_REQUIRED", "Task does not have an expired lease to reconcile.");
    }
    const inspection = await inspect(structuredClone(previous));
    if (inspection.outcome === "UNKNOWN") return;
    await this.mutate(ownerId, (current) => {
      const run = findRun(current, runId);
      const task = findTask(current, runId, taskId);
      if (run.status !== "FAILED") {
        throw new SetupExecutionError("SETUP_RUN_NOT_ACTIVE", "Run changed during reconciliation.");
      }
      if (task.status !== "NEEDS_ATTENTION" || task.errorCode !== "LEASE_EXPIRED_RECONCILE") {
        throw new SetupExecutionError("SETUP_REVISION_CONFLICT", "Task changed during reconciliation.");
      }
      const now = this.clock();
      if (inspection.outcome === "VERIFIED") {
        const receipt = setupReadinessReceiptSchema.parse({
          id: `receipt:${randomUUID()}`, runId, taskId, featureId: task.featureId,
          ...inspection.receipt, completedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + receiptLifetimeMs).toISOString(), outcome: "PASSED"
        });
        current.receipts = current.receipts.filter((item) => item.taskId !== taskId);
        current.receipts.push(receipt);
        task.status = "READY";
        task.resultRef = inspection.receipt.evidenceRef;
        if (task.actionId === "APPLY_SETTINGS") current.appliedSettingsRevision = current.revision + 1;
        if (task.actionId === "WRITE_INSTALLATION_MEMORY") current.memoryHandoffRevision = current.revision + 1;
      } else {
        if (!/^[a-z][a-z0-9._:-]{3,127}$/.test(inspection.evidenceRef)) {
          throw new SetupExecutionError("SETUP_INVALID_INSPECTION", "Inspection requires a bounded evidence reference.");
        }
        task.status = "QUEUED";
        task.resultRef = inspection.evidenceRef;
      }
      task.errorCode = null;
      const runTasks = current.tasks.filter((item) => item.runId === runId);
      run.status = runTasks.some((item) => item.status === "NEEDS_ATTENTION" && item.errorCode === "LEASE_EXPIRED_RECONCILE")
        ? "FAILED"
        : runTasks.every((item) => item.status === "READY") ? "READY" : "RUNNING";
      run.revision++;
      run.updatedAt = now.toISOString();
      run.finishedAt = run.status === "READY" ? run.updatedAt : null;
      event(current, run, task, run.updatedAt);
      return { value: undefined };
    });
  }

  async checkReadiness(ownerId: string, runId: string, currentFingerprints: Fingerprints): Promise<{ ready: boolean; missingTaskIds: string[] }> {
    const state = await this.getState(ownerId);
    const run = findRun(state, runId);
    const plan = state.plans.find((candidate) => candidate.id === run.planId);
    if (!plan || !state.draft || plan.draftRevision !== state.draft.revision || plan.draftId !== state.draft.id ||
      state.plans.at(-1)?.id !== plan.id || run.status !== "READY") {
      return { ready: false, missingTaskIds: state.tasks.filter((task) => task.runId === runId).map((task) => task.id) };
    }
    const now = this.clock().getTime();
    const missingTaskIds = state.tasks.filter((task) => task.runId === runId && (
      task.status !== "READY" || !state.receipts.some((receipt) =>
        receipt.taskId === task.id && receipt.outcome === "PASSED" &&
        Date.parse(receipt.expiresAt) > now &&
        currentFingerprints[task.featureId] === receipt.subjectFingerprint
      )
    )).map((task) => task.id);
    return { ready: missingTaskIds.length === 0 && plan.actions.length > 0, missingTaskIds };
  }

  async listRunEvents(ownerId: string, runId: string, afterSequence = 0, limit = 100): Promise<SetupExecutionState["events"]> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SetupExecutionError("SETUP_EVENT_CURSOR_INVALID", "Invalid setup event cursor or limit.");
    }
    const state = await this.getState(ownerId);
    findRun(state, runId);
    const events = state.events.filter((item) => item.runId === runId);
    if (events[0] && afterSequence < events[0].sequence - 1) {
      throw new SetupExecutionError("SETUP_EVENT_CURSOR_EXPIRED", "Setup event cursor expired; reload the run snapshot.");
    }
    return events.filter((item) => item.sequence > afterSequence).slice(0, limit);
  }
}
