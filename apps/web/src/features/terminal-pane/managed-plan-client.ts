import { preparePlanStages, type ClipboardItem, type ManagedPlanExecution, type StageModelSelection, type PaneCliModelSettings } from "@space/contracts";
import type { SpaceApiClient } from "../../runtime/SpaceRuntime.js";
export type ManagedPlanApi = Pick<SpaceApiClient, "panePlanExecution" | "planExecution" | "startPlanExecution" | "overridePlanExecutionStage" | "controlPlanExecution">;
export const isFinishedExecution = (execution: ManagedPlanExecution) => execution.status === "COMPLETED" || execution.status === "FAILED";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Managed plan request failed.";
const startRequestIds = new Map<string, string>();
const START_REQUEST_STORAGE = "space.managedPlanStartRequests.v1";
function startRequestId(paneId: string, sessionId: string, planId: string): string {
  const key = JSON.stringify([paneId, sessionId, planId]);
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(START_REQUEST_STORAGE) || "[]");
    if (Array.isArray(stored)) for (const pair of stored.slice(-128)) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" && pair[1].length <= 160) startRequestIds.set(pair[0], pair[1]);
    }
  } catch { /* A blocked storage API does not prevent the current session from starting. */ }
  const requestId = startRequestIds.get(key) ?? crypto.randomUUID();
  startRequestIds.set(key, requestId);
  while (startRequestIds.size > 128) startRequestIds.delete(startRequestIds.keys().next().value!);
  try { sessionStorage.setItem(START_REQUEST_STORAGE, JSON.stringify([...startRequestIds])); } catch {}
  return requestId;
}

/** Presentation client only. The server owns native execution, retries and stage advancement. */
export class ManagedPlanClient {
  current: ManagedPlanExecution | null = null;
  error: string | null = null;
  pending = 0;
  private disposed = false;
  private refreshFlight: Promise<ManagedPlanExecution | null> | null = null;
  private refreshAgain = false;
  private refreshId: string | undefined;
  private starts = new Map<string, Promise<ManagedPlanExecution>>();
  private queue: Promise<unknown> = Promise.resolve();
  private intents = new Map<string, number>();
  constructor(readonly api: ManagedPlanApi, readonly paneId: string, readonly sessionId: string, readonly changed: () => void = () => {}, readonly canRefresh: () => boolean = () => true) {}
  get managed() { return Boolean(this.current && this.current.sessionId === this.sessionId && !isFinishedExecution(this.current)); }
  assertContext() { if (this.disposed) throw new Error("The pane context changed. Reopen Plan Progress in the current session."); }
  private accept(next: ManagedPlanExecution | null) {
    this.assertContext();
    if (next && (next.paneId !== this.paneId || (next.sessionId !== this.sessionId && !isFinishedExecution(next)))) throw new Error("The managed execution session changed. Review the current pane before changing settings.");
    if (next && this.current?.id === next.id && next.revision < this.current.revision) return;
    this.current = next;
    this.changed();
  }
  refresh(id?: string): Promise<ManagedPlanExecution | null> {
    if (this.disposed) return Promise.resolve(this.current);
    if (this.refreshFlight) { this.refreshAgain = true; this.refreshId = id; return this.refreshFlight; }
    if (!this.canRefresh()) { this.refreshAgain = true; this.refreshId = id; return Promise.resolve(this.current); }
    this.refreshFlight = (async () => {
      // One request and one coalesced invalidation at a time; only another event requests a catch-up.
      do {
        this.refreshAgain = false;
        const beforeRead = this.current;
        const next = id ? await this.api.planExecution(id) : await this.api.panePlanExecution(this.paneId);
        if (this.disposed) return this.current;
        // A discovery begun before Start must not erase or replace the newer execution.
        if (this.current === beforeRead || (next && next.id === this.current?.id)) this.accept(next);
        id = this.refreshId;
      } while (this.refreshAgain && this.canRefresh());
      return this.current;
    })().catch(error => {
      if (!this.disposed) { this.error = errorMessage(error); this.changed(); }
      throw error;
    }).finally(() => {
      this.refreshFlight = null;
      // An event may also arrive while the previous flight is settling.
      if (this.refreshAgain && !this.disposed && this.canRefresh()) return this.refresh(this.refreshId).then(() => undefined);
    }).then(() => this.current);
    return this.refreshFlight;
  }
  start(plan: ClipboardItem): Promise<ManagedPlanExecution> {
    this.assertContext();
    const prepared = preparePlanStages(plan);
    if (prepared.issues.length) return Promise.reject(new Error(`Complete the plan before starting: ${prepared.issues.join(" ")}`));
    const inFlight = this.starts.get(plan.id);
    if (inFlight) return inFlight;
    const requestId = startRequestId(this.paneId, this.sessionId, plan.id);
    const request = this.run(async () => {
      const next = await this.api.startPlanExecution(this.paneId, { planId: plan.id, expectedSessionId: this.sessionId, requestId });
      this.assertContext();
      if (next.sessionId !== this.sessionId || next.paneId !== this.paneId) throw new Error("The CLI session changed while starting the plan.");
      this.accept(next); return next;
    });
    this.starts.set(plan.id, request);
    void request.finally(() => this.starts.delete(plan.id)).catch(() => {});
    return request;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    this.pending++; this.error = null; this.changed();
    return operation().catch(error => { if (!this.disposed) { this.error = errorMessage(error); this.changed(); } throw error; })
      .finally(() => { this.pending--; if (!this.disposed) this.changed(); });
  }
  private snapshot(stageId?: string) {
    this.assertContext();
    if (!this.managed || !this.current) throw new Error("This managed execution is finished or its session changed.");
    const current = this.current;
    const id = stageId ?? current.snapshot.stages[current.activeStageIndex]?.id;
    if (!id || !current.snapshot.stages.some(s => s.id === id)) throw new Error("The selected stage was not found.");
    return { executionId: current.id, stageId: id, wasActive: current.snapshot.stages[current.activeStageIndex]?.id === id };
  }
  private validate(target: ReturnType<ManagedPlanClient["snapshot"]>) {
    this.assertContext();
    const current = this.current;
    if (!this.managed || !current || current.id !== target.executionId) throw new Error("The execution or session changed.");
    if (current.completedStageIds.includes(target.stageId)) throw new Error("The selected stage is completed. Its history is immutable.");
    if (target.wasActive && current.snapshot.stages[current.activeStageIndex]?.id !== target.stageId) throw new Error("The active stage changed. Select the current stage explicitly.");
    return current;
  }
  private mutate(target: ReturnType<ManagedPlanClient["snapshot"]>, key: string, send: (revision: number) => Promise<ManagedPlanExecution>) {
    const intent = (this.intents.get(key) ?? 0) + 1; this.intents.set(key, intent);
    const operation = async () => {
      for (let retry = 0; retry < 2; retry++) {
        const current = this.validate(target);
        if (this.intents.get(key) !== intent) throw new Error("A newer stage selection replaced this request.");
        try {
          const next = await send(current.revision);
          this.assertContext();
          if (next.id !== target.executionId || next.sessionId !== this.sessionId || next.paneId !== this.paneId) throw new Error("The execution context changed.");
          this.accept(next);
          this.validate(target);
          return next;
        } catch (error) {
          const conflict = (error as { status?: number })?.status === 409;
          if (!conflict) throw error;
          await this.refresh(target.executionId);
          this.validate(target);
          if (this.intents.get(key) !== intent || retry || !/revision.*stale/i.test(errorMessage(error))) throw error;
        }
      }
      throw new Error("Execution revision changed. Review the latest stage before retrying.");
    };
    // Serialize browser intentions; each send reads the latest server revision.
    const result = this.queue.then(() => this.run(operation));
    this.queue = result.catch(() => {});
    return result;
  }
  override(stageId: string, selection: StageModelSelection | null) {
    let target: ReturnType<ManagedPlanClient["snapshot"]>;
    try { target = this.snapshot(stageId); this.validate(target); } catch (error) { return Promise.reject(error); }
    return this.mutate(target, stageId, revision => this.api.overridePlanExecutionStage(target.executionId, target.stageId, { selection, revision }, this.paneId));
  }
  control(action: "pause" | "resume") {
    let target: ReturnType<ManagedPlanClient["snapshot"]>;
    try { target = this.snapshot(); this.validate(target); } catch (error) { return Promise.reject(error); }
    return this.mutate(target, "control", revision => this.api.controlPlanExecution(target.executionId, { action, revision }, this.paneId));
  }
  assertActiveStage(executionId: string, stageId: string) { this.validate({ executionId, stageId, wasActive: true }); }
  dispose() { this.disposed = true; }
}

export async function switchManagedStageModel(client: ManagedPlanClient, selection: StageModelSelection, read: () => Promise<PaneCliModelSettings>) {
  const execution = client.current;
  const stageId = execution?.snapshot.stages[execution.activeStageIndex]?.id;
  if (!execution || !stageId || !client.managed) throw new Error("No current managed stage is available.");
  await client.override(stageId, selection);
  const settings = await read();
  client.assertActiveStage(execution.id, stageId);
  if (settings.sessionId !== client.sessionId || (settings.threadId && settings.threadId !== execution.threadId)) throw new Error("The CLI session changed while reading model settings.");
  // Native mutable settings are picker settings, never actual per-turn telemetry.
  return { current: settings.current, pending: true,
    message: "Stage override queued. Pending native confirmation; live accepted turn configuration is unavailable. Current picker settings are shown." };
}

export function usesManagedPlanExecution(runtimeId: string | null | undefined): boolean {
  return runtimeId === "cli:codex" || runtimeId === "cli:claude";
}
/** Codex starts every plan as a managed execution; Claude only a plan with executable stages and keeps the plain send for the rest. */
export function startsManagedPlan(runtimeId: string | null | undefined, plan?: ClipboardItem): boolean {
  return runtimeId === "cli:codex" || (runtimeId === "cli:claude" && Boolean(plan) && preparePlanStages(plan!).stages.length > 0);
}
export async function routePanePlanSelection(runtimeId: string | null | undefined, start: () => Promise<unknown>, legacy: () => Promise<unknown> | void, plan?: ClipboardItem) {
  if (startsManagedPlan(runtimeId, plan)) return start();
  return legacy();
}
export interface ManagedStageScope { executionId: string; stageId: string; }
export async function routePaneModelSwitch<T>(client: ManagedPlanClient, selection: StageModelSelection, read: () => Promise<PaneCliModelSettings>, unmanaged: () => Promise<T>, clickedScope?: ManagedStageScope | null) {
  client.assertContext();
  // Explicit null remains unbound for queued UI clicks, even if discovery has since finished.
  if (clickedScope) client.assertActiveStage(clickedScope.executionId, clickedScope.stageId);
  if (client.managed) {
    if (clickedScope === null) throw new Error("A managed plan was discovered. Select the current stage model again to apply an override.");
    return switchManagedStageModel(client, selection, read);
  }
  if (!client.current) {
    await client.refresh();
    client.assertContext();
    if (client.managed) throw new Error("A managed plan was discovered. Select the current stage model again to apply an override.");
  }
  return unmanaged();
}
