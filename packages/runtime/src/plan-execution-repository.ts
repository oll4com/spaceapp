import { randomUUID } from "node:crypto";
import {
  managedPlanExecutionSchema,
  managedPlanCommandSchema,
  type ManagedPlanExecution,
} from "@space/contracts";

export type CreateManagedPlanExecution = Pick<
  ManagedPlanExecution,
  | "ownerUserId"
  | "planId"
  | "paneId"
  | "sessionId"
  | "threadId"
  | "cwd"
  | "requestId"
  | "snapshot"
>;
export type ManagedPlanExecutionPatch = Partial<
  Pick<
    ManagedPlanExecution,
    | "status"
    | "activeStageIndex"
    | "overrides"
    | "attempts"
    | "completedStageIds"
    | "checkpoint"
    | "correctionCount"
    | "pendingCommand"
    | "interruptReason"
    | "interruptCommand"
    | "nextRetryAt"
    | "retryCount"
    | "statusReason"
    | "errorCode"
  >
>;
export type PlanExecutionLease = NonNullable<ManagedPlanExecution["lease"]>;
export type PlanExecutionEvent = {
  id: string; executionId: string; ownerUserId: string; planId: string; paneId: string;
  revision: number; status: ManagedPlanExecution["status"]; activeStageIndex: number; createdAt: string;
};
export function planExecutionEvents(record: ManagedPlanExecution): PlanExecutionEvent[] {
  return record.events.filter(event => event.revision > record.eventCursor).map(event => ({...event,
    id: `${record.id}:${event.revision}`, executionId:record.id, ownerUserId:record.ownerUserId, planId:record.planId, paneId:record.paneId}));
}
export interface PlanExecutionRepository {
  listPendingEvents(): Promise<PlanExecutionEvent[]>;
  acknowledgeEvent(executionId: string, revision: number): Promise<void>;
  create(input: CreateManagedPlanExecution, projectToPlan?: boolean): Promise<ManagedPlanExecution>;
  get(ownerUserId: string, id: string): Promise<ManagedPlanExecution | null>;
  findForPane(
    ownerUserId: string,
    paneId: string,
  ): Promise<ManagedPlanExecution | null>;
  listActive(): Promise<ManagedPlanExecution[]>;
  update(
    ownerUserId: string,
    id: string,
    revision: number,
    patch: ManagedPlanExecutionPatch,
    lease?: PlanExecutionLease,
    projectToPlan?: boolean,
  ): Promise<ManagedPlanExecution>;
  claim(
    id: string,
    owner: string,
    now: number,
    durationMs: number,
  ): Promise<ManagedPlanExecution | null>;
  release(id: string, lease: PlanExecutionLease): Promise<void>;
}
export function isPlanExecutionActive(record: ManagedPlanExecution): boolean {
  return !["COMPLETED", "FAILED"].includes(record.status);
}
export class PlanExecutionConflictError extends Error {}
export function newPlanExecution(
  input: CreateManagedPlanExecution,
): ManagedPlanExecution {
  const now = new Date().toISOString();
  return managedPlanExecutionSchema.parse({
    ...input,
    id: `plan_execution:${randomUUID()}`,
    status: "RUNNING",
    events: [{revision:0,status:"RUNNING",activeStageIndex:0,createdAt:now}],
    eventCursor: -1,
    activeStageIndex: 0,
    revision: 0,
    overrides: {},
    attempts: [],
    completedStageIds: [],
    checkpoint: null,
    correctionCount: 0,
    pendingCommand: null,
    interruptReason: null,
    nextRetryAt: null,
    retryCount: 0,
    statusReason: null,
    lease: null,
    createdAt: now,
    updatedAt: now,
  });
}
export function applyPlanExecutionPatch(
  record: ManagedPlanExecution,
  patch: ManagedPlanExecutionPatch,
): ManagedPlanExecution {
  if (
    !isPlanExecutionActive(record) &&
    patch.status &&
    patch.status !== record.status
  )
    throw new PlanExecutionConflictError(
      "Finished executions cannot be resumed.",
    );
  const allowed = managedPlanExecutionSchema
    .pick({
      status: true,
      activeStageIndex: true,
      overrides: true,
      attempts: true,
      completedStageIds: true,
      checkpoint: true,
      correctionCount: true,
      pendingCommand: true,
      interruptReason: true,
      interruptCommand: true,
      nextRetryAt: true,
      retryCount: true,
      statusReason: true,
      errorCode: true,
    })
    .partial()
    .extend({interruptCommand: managedPlanCommandSchema.nullable().optional()})
    .strict()
    .parse(patch);
  return managedPlanExecutionSchema.parse({
    ...record,
    ...allowed,
    events: [...record.events, {revision:record.revision+1,status:allowed.status??record.status,
      activeStageIndex:allowed.activeStageIndex??record.activeStageIndex,createdAt:new Date().toISOString()}],
    commands: [allowed.pendingCommand, allowed.interruptCommand].reduce((commands, next) =>
      next ? [...commands.filter(command => command.id !== next.id), next] : commands, record.commands),
    revision: record.revision + 1,
    updatedAt: new Date().toISOString(),
  });
}
export class InMemoryPlanExecutionRepository implements PlanExecutionRepository {
  private readonly records = new Map<string, ManagedPlanExecution>();
  constructor(snapshot: ManagedPlanExecution[] = [], private readonly project?: (execution: ManagedPlanExecution) => void) {
    for (const record of snapshot) {
      const parsed = managedPlanExecutionSchema.parse(record);
      this.records.set(parsed.id, structuredClone(parsed));
    }
  }
  snapshot(): ManagedPlanExecution[] {
    return structuredClone([...this.records.values()]);
  }
  hasManagedPlan(owner: string, planId: string): boolean {
    return [...this.records.values()].some(
      (r) => r.ownerUserId === owner && r.planId === planId,
    );
  }
  async create(
    input: CreateManagedPlanExecution,
    projectToPlan = false,
  ): Promise<ManagedPlanExecution> {
    const duplicate = [...this.records.values()].find(
      (r) =>
        r.ownerUserId === input.ownerUserId && r.requestId === input.requestId,
    );
    if (duplicate) {
      if (
        duplicate.planId !== input.planId ||
        duplicate.paneId !== input.paneId ||
        duplicate.sessionId !== input.sessionId
      )
        throw new PlanExecutionConflictError(
          "Request id was used for a different execution.",
        );
      return structuredClone(duplicate);
    }
    if (
      [...this.records.values()].some(
        (r) =>
          isPlanExecutionActive(r) &&
          (r.paneId === input.paneId || r.planId === input.planId),
      )
    )
      throw new PlanExecutionConflictError(
        "An active execution already owns this pane or plan.",
      );
    const record = newPlanExecution(input);
    if (projectToPlan) {
      if (!this.project) throw new PlanExecutionConflictError("PLAN projection is unavailable.");
      this.project(record);
    }
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  projectCurrent(owner: string, id: string, revision: number): ManagedPlanExecution {
    const record = this.records.get(id);
    if (!record || record.ownerUserId !== owner || record.revision !== revision)
      throw new PlanExecutionConflictError("Execution revision is stale.");
    if (!this.project) throw new PlanExecutionConflictError("PLAN projection is unavailable.");
    this.project(record);
    return structuredClone(record);
  }
  async get(owner: string, id: string): Promise<ManagedPlanExecution | null> {
    const record = this.records.get(id);
    return record?.ownerUserId === owner ? structuredClone(record) : null;
  }
  async findForPane(
    owner: string,
    paneId: string,
  ): Promise<ManagedPlanExecution | null> {
    const records = [...this.records.values()]
      .filter((r) => r.ownerUserId === owner && r.paneId === paneId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(
      records.find(isPlanExecutionActive) ?? records[0] ?? null,
    );
  }
  async listPendingEvents(): Promise<PlanExecutionEvent[]> {
    return structuredClone([...this.records.values()].flatMap(planExecutionEvents));
  }
  async acknowledgeEvent(id: string, revision: number): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.eventCursor >= revision) return;
    if (planExecutionEvents(record)[0]?.revision !== revision) throw new PlanExecutionConflictError("Outbox acknowledgment is out of order.");
    record.eventCursor = revision;
  }
  async listActive(): Promise<ManagedPlanExecution[]> {
    return structuredClone(
      [...this.records.values()].filter(isPlanExecutionActive),
    );
  }
  async update(
    owner: string,
    id: string,
    revision: number,
    patch: ManagedPlanExecutionPatch,
    lease?: PlanExecutionLease,
    projectToPlan?: boolean,
  ): Promise<ManagedPlanExecution> {
    const record = this.records.get(id);
    if (!record || record.ownerUserId !== owner)
      throw new PlanExecutionConflictError("Execution was not found.");
    if (record.revision !== revision)
      throw new PlanExecutionConflictError("Execution revision is stale.");
    if (
      lease &&
      (!record.lease ||
        record.lease.owner !== lease.owner ||
        record.lease.epoch !== lease.epoch ||
        Date.parse(record.lease.expiresAt) <= Date.now())
    )
      throw new PlanExecutionConflictError("Controller lease is stale.");
    const next = applyPlanExecutionPatch(record, patch);
    if (projectToPlan) {
      if (!this.project) throw new PlanExecutionConflictError("PLAN projection is unavailable.");
      this.project(next);
    }
    this.records.set(id, next);
    return structuredClone(next);
  }
  async claim(
    id: string,
    owner: string,
    now: number,
    durationMs: number,
  ): Promise<ManagedPlanExecution | null> {
    const record = this.records.get(id);
    if (!record || !isPlanExecutionActive(record)) return null;
    if (
      record.lease &&
      record.lease.owner !== owner &&
      Date.parse(record.lease.expiresAt) > now
    )
      return null;
    const epoch =
      record.lease &&
      record.lease.owner === owner &&
      Date.parse(record.lease.expiresAt) > now
        ? record.lease.epoch
        : (record.lease?.epoch ?? 0) + 1;
    record.lease = {
      owner,
      epoch,
      expiresAt: new Date(now + durationMs).toISOString(),
    };
    return structuredClone(record);
  }
  async release(id: string, lease: PlanExecutionLease): Promise<void> {
    const record = this.records.get(id);
    if (
      record?.lease?.owner === lease.owner &&
      record.lease.epoch === lease.epoch
    )
      record.lease.expiresAt = new Date(0).toISOString();
  }
}
