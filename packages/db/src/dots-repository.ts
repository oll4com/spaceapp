import { createHash, randomUUID } from "node:crypto";
import { dotProfileSchema, dotToolInvocationSchema, updateDotProfileSchema, DOT_TOOL_GATEWAY_VERSION, type AgentPaneGoal, type DotProfile,
  type DotResource, type DotToolInvocation, type DotToolInvocationStatus, type DotToolRisk, type DotToolSource, type UpdateDotProfile } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";

export interface DotsRepository {
  list(owner: string): Promise<DotProfile[]>;
  get(owner: string, dotId: string): Promise<DotProfile | null>;
  update(owner: string, dotId: string, input: UpdateDotProfile): Promise<DotProfile | null>;
  related(owner: string, dotId: string, resource: DotResource, limit: number, offset: number, nativeGoals?: AgentPaneGoal[]): Promise<Record<string, unknown>[] | null>;
  /** Gateway-enabled native threads; a legacy thread keeps fenced bridges. */
  sessionToolGateway(sessionId: string): Promise<typeof DOT_TOOL_GATEWAY_VERSION | null>;
  markSessionToolGateway(sessionId: string, threadId: string): Promise<void>;
  /** `created=false` means the same Codex call was already recorded; never execute it twice. */
  startToolInvocation(input: DotToolInvocationStart): Promise<{ created: boolean; running: boolean; invocation: DotToolInvocation }>;
  finishToolInvocation(invocationId: string, result: { status: Exclude<DotToolInvocationStatus, "RUNNING">; statusReason?: string | null; resultSummary?: string | null }): Promise<DotToolInvocation | null>;
  listToolInvocations(owner: string, dotId: string, limit: number, offset: number): Promise<DotToolInvocation[] | null>;
  /** Parks a running call for its owner's decision; only the API stores the exact normalized payload. */
  requestToolApproval(invocationId: string, sessionId: string, input: { payload: Record<string, unknown>; summary: string }): Promise<DotToolInvocation | null>;
  listPendingApprovals(owner: string, dotId: string, sessionId?: string): Promise<DotToolInvocation[] | null>;
  hasPendingApproval(sessionId: string): Promise<boolean>;
  /** Atomically claims a pending approval; APPROVE returns the payload to execute once. */
  decideToolApproval(owner: string, dotId: string, invocationId: string, decision: "APPROVE" | "DECLINE", decidedBy: string):
    Promise<{ invocation: DotToolInvocation; payload: Record<string, unknown> } | null>;
  /** One Chat run's state, looked up by id (not only the latest run). */
  getRunSummary(runId: string): Promise<{ runId: string; sessionId: string; status: string; clientRequestId: string | null } | null>;
  /** Recent queued or running runs of this Dot in open panes (other conversations). */
  countActiveDotRuns(dotId: string, excludeSessionId: string): Promise<number>;
  /** Fails a run only while it is still QUEUED; returns whether it changed. */
  failStrandedRun(runId: string, message: string): Promise<boolean>;
  /** Chat runs still QUEUED long after submission; the caller verifies Temporal before failing them. */
  listStaleQueuedRuns(olderThanSeconds: number, limit: number): Promise<Array<{ runId: string; workflowId: string; sessionId: string; responseMessageId: string }>>;
  /** Fails a run only while it is still RUNNING, with an unknown outcome; returns whether it changed. */
  failLostRunningRun(runId: string, message: string): Promise<boolean>;
  /** Chat runs RUNNING without an update for a while; the caller verifies that Temporal no longer runs them. */
  listStaleRunningRuns(olderThanSeconds: number, limit: number): Promise<Array<{ runId: string; workflowId: string; sessionId: string; responseMessageId: string }>>;
  /**
   * The latest identical earlier call (same conversation, tool and arguments) when its outcome is not
   * settled: still running, unknown after a transport failure, or waiting for approval. A reconcile
   * notice recorded after it settles the question, so the next identical call runs.
   */
  unresolvedToolCall(sessionId: string, toolId: string, args: unknown): Promise<{ state: "RUNNING" | "UNKNOWN" | "AWAITING_APPROVAL"; startedAt: string } | null>;
  /**
   * Uses one owner-approved native call (memory, clipboard, tasks, chat) with exactly these arguments:
   * the approval leaves it PENDING until the Dot runs it once. Returns the approved invocation id, or null.
   */
  consumeApprovedNativeCall(sessionId: string, toolId: string, args: unknown): Promise<string | null>;
  /** This Dot's queued or running work in open panes of the owner's rooms, newest first. */
  listActiveRuns(owner: string, dotId: string, limit: number): Promise<DotActiveRun[]>;
  /** The Dot's own open Browser pane in a room, if it has one. */
  dotBrowserPane(dotId: string, roomId: string): Promise<string | null>;
  /** Records the pane unless the Dot already has an open one in the room; returns the pane that won. */
  recordDotBrowserPane(owner: string, dotId: string, roomId: string, paneId: string): Promise<string>;
  listDotBrowserPanes(owner: string, dotId: string): Promise<Array<{ roomId: string; roomName: string | null; paneId: string }>>;
  dispose(): Promise<void>;
}
export interface DotActiveRun {
  runId: string; sessionId: string; roomId: string; roomName: string | null; paneId: string; title: string | null;
  status: "QUEUED" | "RUNNING"; clientRequestId: string | null; startedAt: string;
}
export interface DotToolInvocationStart {
  dotId: string; ownerUserId: string; roomId: string; sessionId: string; runId: string | null; callId: string | null;
  toolId: string; source: DotToolSource; risk: DotToolRisk; arguments: unknown;
}
export function dotToolArgumentsHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;
}
const invocationSelect = `SELECT invocation_id AS "invocationId", dot_id AS "dotId", owner_user_id AS "ownerUserId", room_id AS "roomId",
  session_id AS "sessionId", run_id AS "runId", call_id AS "callId", tool_id AS "toolId", source, risk, status,
  status_reason AS "statusReason", arguments_hash AS "argumentsHash", result_summary AS "resultSummary",
  approval_summary AS "approvalSummary", decided_at AS "decidedAt",
  started_at AS "startedAt", completed_at AS "completedAt" FROM dot_tool_invocations`;
/** Approvals expire after a day; an old request is never executed by a late click. */
const pendingApproval = `status='APPROVAL_REQUIRED' AND approval_payload IS NOT NULL AND started_at > now() - interval '24 hours'`;
function invocation(row: Record<string, unknown>): DotToolInvocation {
  const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
  return dotToolInvocationSchema.parse({ ...row, status: row.status === "RUNNING" ? "FAILED" : row.status,
    statusReason: row.status === "RUNNING" ? row.statusReason ?? "Invocation did not report completion." : row.statusReason,
    approvalSummary: row.approvalSummary ?? null, decidedAt: iso(row.decidedAt),
    startedAt: iso(row.startedAt), completedAt: iso(row.completedAt) });
}
const profileSelect = `SELECT dot_id AS "dotId", owner_user_id AS "ownerUserId", slot, name, appearance, preferences,
  permissions, work_limits AS "workLimits", created_at AS "createdAt", updated_at AS "updatedAt" FROM space_dots`;
function profile(row: Record<string, unknown>): DotProfile {
  return dotProfileSchema.parse({ ...row, createdAt: new Date(row.createdAt as string).toISOString(), updatedAt: new Date(row.updatedAt as string).toISOString() });
}
// Fixed SQL only. Each resource independently checks both profile and current room ownership.
const owned = `JOIN space_dots d ON d.dot_id=t.dot_id JOIN rooms r ON r.id=t.room_id
  WHERE d.owner_user_id=$1 AND d.dot_id=$2 AND r.owner_user_id=$1`;
const queries: Record<DotResource, string> = {
  sessions: `SELECT jsonb_build_object('dotId',t.dot_id,'sessionId',t.session_id,'paneId',t.pane_id,'roomId',t.room_id,
    'threadId',t.thread_id,'title',t.title,'status',t.status,'isActive',t.is_active,'updatedAt',t.updated_at) AS item
    FROM space_agent_sessions t ${owned} ORDER BY t.updated_at DESC,t.session_id LIMIT $3 OFFSET $4`,
  tasks: `SELECT jsonb_build_object('dotId',t.dot_id,'runId',t.run_id,'sessionId',t.session_id,'roomId',t.room_id,
    'workflowId',t.workflow_id,'status',t.status,'createdAt',t.created_at,'updatedAt',t.updated_at,'completedAt',t.completed_at) AS item
    FROM space_agent_runs t ${owned} ORDER BY t.updated_at DESC,t.run_id LIMIT $3 OFFSET $4`,
  goals: `SELECT item FROM (
    SELECT t.updated_at,t.mission_id AS id,jsonb_build_object('dotId',t.dot_id,'kind','MISSION','missionId',t.mission_id,
      'sessionId',t.session_id,'roomId',t.room_id,'workflowId',t.workflow_id,'status',t.status,'statusReason',t.status_reason,
      'updatedAt',t.updated_at) AS item FROM room_agent_missions t ${owned}
    UNION ALL SELECT (g.value->>'updatedAt')::timestamptz,t.session_id,
      g.value || jsonb_build_object('dotId',t.dot_id,'kind','NATIVE_GOAL','sessionId',t.session_id,'roomId',t.room_id) AS item
      FROM space_agent_sessions t JOIN jsonb_array_elements($5::jsonb) g(value) ON g.value->>'threadId'=t.thread_id
      ${owned}
    ) goals ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
  memory: `SELECT item FROM (
    SELECT t.created_at AS updated_at,t.id,jsonb_build_object('dotId',t.dot_id,'id',t.id,'kind','ROOM',
      'roomId',t.room_id,'scope',t.scope,'title',t.title,'body',t.body,'provenance',t.provenance,'createdAt',t.created_at) AS item
      FROM memory_records t ${owned}
    UNION ALL SELECT t.updated_at,t.owner_user_id,jsonb_build_object('dotId',t.dot_id,'id',t.owner_user_id,'kind','PERSONAL',
      'revision',t.revision,'value',t.value,'updatedAt',t.updated_at) FROM live_personal_memory t
      JOIN space_dots d ON d.dot_id=t.dot_id WHERE d.owner_user_id=$1 AND d.dot_id=$2 AND t.owner_user_id=$1
    ) memory ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
  schedules: `SELECT jsonb_build_object('dotId',t.dot_id,'id',t.record_key,'roomId',t.room_id,'version',t.version,
    'schedule',t.value,'updatedAt',t.updated_at) AS item FROM space_control_records t ${owned}
    AND t.actor_id=$1 AND t.kind='schedule' ORDER BY t.updated_at DESC,t.record_key LIMIT $3 OFFSET $4`,
  receipts: `SELECT item FROM (
    SELECT t.updated_at,t.run_id AS id,jsonb_build_object('dotId',t.dot_id,'kind','SUBMISSION','runId',t.run_id,'sessionId',t.session_id,
      'clientRequestId',t.client_request_id,'status',t.status,'updatedAt',t.updated_at) AS item
      FROM space_agent_runs t ${owned} AND t.client_request_id IS NOT NULL
    UNION ALL SELECT t.updated_at,t.record_key,jsonb_build_object('dotId',t.dot_id,'kind','CONTROL','id',t.record_key,
      'roomId',t.room_id,'status',t.value->>'status','results',t.value->'results','updatedAt',t.updated_at)
      FROM space_control_records t ${owned} AND t.actor_id=$1 AND t.kind='operation'
    ) receipts ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`,
  activity: `SELECT item FROM (
    SELECT t.updated_at,t.run_id AS id,jsonb_build_object('dotId',t.dot_id,'kind','TASK','id',t.run_id,'sessionId',t.session_id,
      'status',t.status,'updatedAt',t.updated_at) AS item FROM space_agent_runs t ${owned}
    UNION ALL SELECT t.updated_at,t.record_key,jsonb_build_object('dotId',t.dot_id,'kind',upper(t.kind),'id',t.record_key,
      'roomId',t.room_id,'status',t.value->>'status','updatedAt',t.updated_at)
      FROM space_control_records t ${owned} AND t.actor_id=$1 AND t.kind IN ('operation','schedule','audit')
    ) activity ORDER BY updated_at DESC,id LIMIT $3 OFFSET $4`
};
export class PostgresDotsRepository implements DotsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresDotsRepository(createSpacePgPool(url, { max: 3 })); }
  async list(owner: string) {
    return (await this.pool.query<Record<string, unknown>>(`${profileSelect} WHERE owner_user_id=$1 ORDER BY slot`, [owner])).rows.map(profile);
  }
  async get(owner: string, dotId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`${profileSelect} WHERE owner_user_id=$1 AND dot_id=$2`, [owner, dotId])).rows[0];
    return row ? profile(row) : null;
  }
  async update(owner: string, dotId: string, input: UpdateDotProfile) {
    const patch = updateDotProfileSchema.parse(input);
    // Atomic field patches preserve simultaneous edits to unrelated preferences.
    const result = await this.pool.query<Record<string, unknown>>(`UPDATE space_dots SET name=COALESCE($3,name),
      appearance=appearance || COALESCE($4::jsonb,'{}'), preferences=preferences || COALESCE($5::jsonb,'{}'),
      work_limits=COALESCE($6::jsonb,work_limits),updated_at=now() WHERE owner_user_id=$1 AND dot_id=$2
      RETURNING dot_id AS "dotId",owner_user_id AS "ownerUserId",slot,name,appearance,preferences,permissions,
        work_limits AS "workLimits",created_at AS "createdAt",updated_at AS "updatedAt"`,
      [owner, dotId, patch.name ?? null, patch.appearance ? JSON.stringify(patch.appearance) : null,
        patch.preferences ? JSON.stringify(patch.preferences) : null, patch.workLimits ? JSON.stringify(patch.workLimits) : null]);
    return result.rows[0] ? profile(result.rows[0]) : null;
  }
  async related(owner: string, dotId: string, resource: DotResource, limit: number, offset: number, nativeGoals: AgentPaneGoal[] = []) {
    if (!await this.get(owner, dotId)) return null;
    const result = await this.pool.query<{ item: Record<string, unknown> }>(queries[resource], [owner, dotId, Math.min(100, Math.max(1, limit)), Math.max(0, offset), ...(resource === "goals" ? [JSON.stringify(nativeGoals)] : [])]);
    return result.rows.map(row => row.item);
  }
  async sessionToolGateway(sessionId: string) {
    const row = (await this.pool.query<{ gateway: string | null }>(`SELECT tool_gateway AS gateway FROM space_agent_sessions WHERE session_id=$1`, [sessionId])).rows[0];
    return row?.gateway === DOT_TOOL_GATEWAY_VERSION ? DOT_TOOL_GATEWAY_VERSION : null;
  }
  async markSessionToolGateway(sessionId: string, threadId: string) {
    // Only the thread that actually started with gateway tools is marked. A new
    // session's thread id is checkpointed right after the thread starts.
    await this.pool.query(`UPDATE space_agent_sessions SET tool_gateway=$3
      WHERE session_id=$1 AND (thread_id=$2 OR thread_id IS NULL) AND tool_gateway IS NULL`,
      [sessionId, threadId, DOT_TOOL_GATEWAY_VERSION]);
  }
  async startToolInvocation(input: DotToolInvocationStart) {
    const id = `dot_tool:${randomUUID()}`;
    const inserted = await this.pool.query<Record<string, unknown>>(`INSERT INTO dot_tool_invocations(invocation_id,dot_id,owner_user_id,room_id,session_id,
      run_id,call_id,tool_id,source,risk,status,arguments_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RUNNING',$11)
      ON CONFLICT (session_id,call_id,tool_id,arguments_hash) WHERE call_id IS NOT NULL DO NOTHING RETURNING invocation_id`,
      [id, input.dotId, input.ownerUserId, input.roomId, input.sessionId, input.runId, input.callId, input.toolId, input.source, input.risk,
        dotToolArgumentsHash(input.arguments)]);
    const created = inserted.rows.length === 1;
    const row = (await this.pool.query<Record<string, unknown>>(created ? `${invocationSelect} WHERE invocation_id=$1`
      : `${invocationSelect} WHERE session_id=$1 AND call_id=$2 AND tool_id=$3 AND arguments_hash=$4`,
      created ? [id] : [input.sessionId, input.callId, input.toolId, dotToolArgumentsHash(input.arguments)])).rows[0]!;
    return { created, running: row.status === "RUNNING", invocation: invocation(row) };
  }
  async finishToolInvocation(invocationId: string, result: { status: Exclude<DotToolInvocationStatus, "RUNNING">; statusReason?: string | null; resultSummary?: string | null }) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE dot_tool_invocations SET status=$2,status_reason=$3,result_summary=$4,completed_at=now()
      WHERE invocation_id=$1 AND status='RUNNING' RETURNING invocation_id`, [invocationId, result.status,
      result.statusReason?.slice(0, 1000) ?? null, result.resultSummary?.slice(0, 2000) ?? null])).rows[0];
    if (!row) return null;
    return invocation((await this.pool.query<Record<string, unknown>>(`${invocationSelect} WHERE invocation_id=$1`, [invocationId])).rows[0]!);
  }
  async listToolInvocations(owner: string, dotId: string, limit: number, offset: number) {
    if (!await this.get(owner, dotId)) return null;
    const rows = await this.pool.query<Record<string, unknown>>(`${invocationSelect} t WHERE t.owner_user_id=$1 AND t.dot_id=$2
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=t.room_id AND r.owner_user_id=$1)
      ORDER BY t.started_at DESC, t.invocation_id LIMIT $3 OFFSET $4`, [owner, dotId, Math.min(100, Math.max(1, limit)), Math.max(0, offset)]);
    return rows.rows.map(invocation);
  }
  async requestToolApproval(invocationId: string, sessionId: string, input: { payload: Record<string, unknown>; summary: string }) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE dot_tool_invocations SET status='APPROVAL_REQUIRED',
      approval_payload=$3::jsonb, approval_summary=$4, status_reason='Waiting for the user''s approval.'
      WHERE invocation_id=$1 AND session_id=$2 AND status='RUNNING' AND approval_payload IS NULL RETURNING invocation_id`,
      [invocationId, sessionId, JSON.stringify(input.payload), input.summary.slice(0, 1000)])).rows[0];
    return row ? invocation((await this.pool.query<Record<string, unknown>>(`${invocationSelect} WHERE invocation_id=$1`, [invocationId])).rows[0]!) : null;
  }
  async listPendingApprovals(owner: string, dotId: string, sessionId?: string) {
    if (!await this.get(owner, dotId)) return null;
    const rows = await this.pool.query<Record<string, unknown>>(`${invocationSelect} t WHERE t.owner_user_id=$1 AND t.dot_id=$2 AND ${pendingApproval}
      AND ($3::text IS NULL OR t.session_id=$3) AND EXISTS (SELECT 1 FROM space_agent_sessions s WHERE s.session_id=t.session_id AND s.is_active)
      ORDER BY t.started_at, t.invocation_id LIMIT 20`, [owner, dotId, sessionId ?? null]);
    return rows.rows.map(invocation);
  }
  async hasPendingApproval(sessionId: string) {
    return (await this.pool.query(`SELECT 1 FROM dot_tool_invocations WHERE session_id=$1 AND ${pendingApproval} LIMIT 1`, [sessionId])).rows.length > 0;
  }
  async decideToolApproval(owner: string, dotId: string, invocationId: string, decision: "APPROVE" | "DECLINE", decidedBy: string) {
    const row = (await this.pool.query<{ payload: Record<string, unknown> }>(`UPDATE dot_tool_invocations SET
      status=CASE WHEN $4='APPROVE' THEN 'RUNNING' ELSE 'DECLINED' END,
      status_reason=CASE WHEN $4='APPROVE' THEN 'Approved by the user.' ELSE 'Declined by the user.' END,
      completed_at=CASE WHEN $4='APPROVE' THEN NULL ELSE now() END, decided_at=now(), decided_by=$5
      WHERE invocation_id=$1 AND owner_user_id=$2 AND dot_id=$3 AND ${pendingApproval}
        AND EXISTS (SELECT 1 FROM rooms r WHERE r.id=dot_tool_invocations.room_id AND r.owner_user_id=$2)
      RETURNING approval_payload AS payload`, [invocationId, owner, dotId, decision, decidedBy])).rows[0];
    if (!row) return null;
    const current = invocation((await this.pool.query<Record<string, unknown>>(`${invocationSelect} WHERE invocation_id=$1`, [invocationId])).rows[0]!);
    return { invocation: current, payload: row.payload };
  }
  async getRunSummary(runId: string) {
    return (await this.pool.query<{ runId: string; sessionId: string; status: string; clientRequestId: string | null }>(`SELECT run_id AS "runId",
      session_id AS "sessionId", status, client_request_id AS "clientRequestId" FROM space_agent_runs WHERE run_id=$1`, [runId])).rows[0] ?? null;
  }
  async countActiveDotRuns(dotId: string, excludeSessionId: string) {
    // Closed panes and long-silent rows never hold a Dot "busy".
    const row = (await this.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM space_agent_runs r
      JOIN panes p ON p.id=r.pane_id AND p.is_closed=false
      WHERE r.dot_id=$1 AND r.session_id<>$2 AND r.status IN ('QUEUED','RUNNING') AND r.updated_at > now() - interval '6 hours'`,
      [dotId, excludeSessionId])).rows[0];
    return Number(row?.count ?? 0);
  }
  async failStrandedRun(runId: string, message: string) {
    return (await this.pool.query(`UPDATE space_agent_runs SET status='FAILED', error_code='SPACE_AGENT_RUNTIME_NOT_STARTED', error_message=$2,
      completed_at=now(), updated_at=now() WHERE run_id=$1 AND status='QUEUED' RETURNING run_id`, [runId, message.slice(0, 1000)])).rows.length === 1;
  }
  async listStaleQueuedRuns(olderThanSeconds: number, limit: number) {
    // A Room Agent turn stays QUEUED in its supervisor queue, without its child
    // workflow, until the supervisor reaches it (behind an active turn or a
    // paused mission). It is not stranded; the supervisor and API recovery own it.
    return (await this.pool.query<{ runId: string; workflowId: string; sessionId: string; responseMessageId: string }>(`SELECT run_id AS "runId",
      workflow_id AS "workflowId", session_id AS "sessionId", response_message_id AS "responseMessageId" FROM space_agent_runs r
      WHERE status='QUEUED' AND created_at < now() - make_interval(secs => $1)
        AND NOT EXISTS (SELECT 1 FROM room_agent_requests q WHERE q.response_message_id = r.response_message_id)
      ORDER BY created_at LIMIT $2`,
      [Math.max(60, olderThanSeconds), Math.min(100, Math.max(1, limit))])).rows;
  }
  async failLostRunningRun(runId: string, message: string) {
    return (await this.pool.query(`UPDATE space_agent_runs SET status='FAILED', error_code='SPACE_AGENT_RUN_OUTCOME_UNKNOWN', error_message=$2,
      completed_at=now(), updated_at=now() WHERE run_id=$1 AND status='RUNNING' RETURNING run_id`, [runId, message.slice(0, 1000)])).rows.length === 1;
  }
  async listStaleRunningRuns(olderThanSeconds: number, limit: number) {
    // Room Agent turns are excluded: their supervisor records the outcome of a failed child turn.
    return (await this.pool.query<{ runId: string; workflowId: string; sessionId: string; responseMessageId: string }>(`SELECT run_id AS "runId",
      workflow_id AS "workflowId", session_id AS "sessionId", response_message_id AS "responseMessageId" FROM space_agent_runs r
      WHERE status='RUNNING' AND updated_at < now() - make_interval(secs => $1)
        AND NOT EXISTS (SELECT 1 FROM room_agent_requests q WHERE q.response_message_id = r.response_message_id)
      ORDER BY updated_at LIMIT $2`,
      [Math.max(60, olderThanSeconds), Math.min(100, Math.max(1, limit))])).rows;
  }
  async consumeApprovedNativeCall(sessionId: string, toolId: string, args: unknown) {
    return (await this.pool.query<{ invocationId: string }>(`UPDATE dot_tool_invocations SET status='COMPLETED',
      status_reason='Approved by the user and run once.', completed_at=now() WHERE invocation_id=(
        SELECT invocation_id FROM dot_tool_invocations WHERE session_id=$1 AND tool_id=$2 AND arguments_hash=$3 AND source='SPACE_NATIVE'
          AND status='PENDING' AND decided_at IS NOT NULL AND decided_at > now() - interval '24 hours'
        ORDER BY decided_at, invocation_id LIMIT 1 FOR UPDATE SKIP LOCKED)
      AND status='PENDING' RETURNING invocation_id AS "invocationId"`, [sessionId, toolId, dotToolArgumentsHash(args)])).rows[0]?.invocationId ?? null;
  }
  async unresolvedToolCall(sessionId: string, toolId: string, args: unknown) {
    // An owner-approved native call waiting to be run (PENDING with a decision) is not an unknown outcome.
    const rows = (await this.pool.query<{ status: string; statusReason: string | null; startedAt: unknown; pending: boolean }>(`SELECT status,
      status_reason AS "statusReason", started_at AS "startedAt", (${pendingApproval}) AS pending FROM dot_tool_invocations
      WHERE session_id=$1 AND tool_id=$2 AND arguments_hash=$3 AND started_at > now() - interval '24 hours'
        AND NOT (status='PENDING' AND decided_at IS NOT NULL)
      ORDER BY started_at DESC, invocation_id DESC LIMIT 50`, [sessionId, toolId, dotToolArgumentsHash(args)])).rows;
    const iso = (value: unknown) => new Date(value as string).toISOString();
    // A pending approval always blocks an identical request, even after a reconcile notice.
    const waiting = rows.find(row => row.status === "APPROVAL_REQUIRED" && row.pending);
    if (waiting) return { state: "AWAITING_APPROVAL" as const, startedAt: iso(waiting.startedAt) };
    const latest = rows[0];
    if (!latest) return null;
    if (latest.status === "RUNNING" || latest.status === "PENDING") return { state: "RUNNING" as const, startedAt: iso(latest.startedAt) };
    if (latest.status === "FAILED" && latest.statusReason?.startsWith("Outcome unknown:")) return { state: "UNKNOWN" as const, startedAt: iso(latest.startedAt) };
    // Settled, or a reconcile notice was already given: the next identical call runs.
    return null;
  }
  async listActiveRuns(owner: string, dotId: string, limit: number) {
    const rows = (await this.pool.query<Omit<DotActiveRun, "startedAt"> & { startedAt: unknown }>(`SELECT r.run_id AS "runId", r.session_id AS "sessionId",
      r.room_id AS "roomId", rm.name AS "roomName", r.pane_id AS "paneId", s.title, r.status, r.client_request_id AS "clientRequestId",
      r.created_at AS "startedAt" FROM space_agent_runs r
      JOIN panes p ON p.id=r.pane_id AND p.is_closed=false
      JOIN rooms rm ON rm.id=r.room_id AND rm.owner_user_id=$1
      LEFT JOIN space_agent_sessions s ON s.session_id=r.session_id
      WHERE r.dot_id=$2 AND r.status IN ('QUEUED','RUNNING') AND r.updated_at > now() - interval '6 hours'
      ORDER BY r.created_at DESC LIMIT $3`, [owner, dotId, Math.min(20, Math.max(1, limit))])).rows;
    return rows.map(row => ({ ...row, startedAt: new Date(row.startedAt as string).toISOString() }));
  }
  // A pane counts as the Dot's browser only while it is open and still in the recorded room.
  async dotBrowserPane(dotId: string, roomId: string) {
    return (await this.pool.query<{ paneId: string }>(`SELECT b.pane_id AS "paneId" FROM dot_browser_panes b
      JOIN panes p ON p.id=b.pane_id AND p.is_closed=false AND p.room_id=b.room_id WHERE b.dot_id=$1 AND b.room_id=$2`, [dotId, roomId])).rows[0]?.paneId ?? null;
  }
  async recordDotBrowserPane(owner: string, dotId: string, roomId: string, paneId: string) {
    // Only a closed or moved pane is replaced, so concurrent callers agree on one pane.
    // The identity trigger re-checks Dot, room, pane and owner.
    const recorded = (await this.pool.query<{ paneId: string }>(`INSERT INTO dot_browser_panes(dot_id,room_id,pane_id,owner_user_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (dot_id, room_id) DO UPDATE SET pane_id=EXCLUDED.pane_id, created_at=now()
      WHERE NOT EXISTS (SELECT 1 FROM panes p WHERE p.id=dot_browser_panes.pane_id AND p.is_closed=false AND p.room_id=dot_browser_panes.room_id)
      RETURNING pane_id AS "paneId"`, [dotId, roomId, paneId, owner])).rows[0];
    if (recorded) return recorded.paneId;
    return (await this.pool.query<{ paneId: string }>(`SELECT pane_id AS "paneId" FROM dot_browser_panes WHERE dot_id=$1 AND room_id=$2`,
      [dotId, roomId])).rows[0]!.paneId;
  }
  async listDotBrowserPanes(owner: string, dotId: string) {
    return (await this.pool.query<{ roomId: string; roomName: string | null; paneId: string }>(`SELECT b.room_id AS "roomId", r.name AS "roomName",
      b.pane_id AS "paneId" FROM dot_browser_panes b JOIN panes p ON p.id=b.pane_id AND p.is_closed=false AND p.room_id=b.room_id
      JOIN rooms r ON r.id=b.room_id AND r.owner_user_id=$1 WHERE b.dot_id=$2 AND b.owner_user_id=$1 ORDER BY b.created_at DESC LIMIT 20`,
      [owner, dotId])).rows;
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
