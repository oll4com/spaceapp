import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  browserToolActionInputSchema,
  buildDotToolCatalog,
  classifyDotControlAction,
  controlExecuteSchema,
  controlResourceOperations,
  dotApprovalDecisionSchema,
  dotIdSchema,
  dotMcpToolId,
  dotPersonalityInstructions,
  dotToolCallInputSchema,
  dotToolDescribeInputSchema,
  dotToolSearchInputSchema,
  dotMemoryContext,
  dotNativeActionRisk,
  dotWorkspaceRelativePathSchema,
  dotToolSourceSchema,
  isDotProactiveRequest,
  needsDotApproval,
  searchDotTools,
  type ControlAction,
  type ControlExecute,
  type DotActionRisk,
  type DotMemory,
  type DotProfile,
  type DotToolCatalogContext,
  type DotToolEntry,
  type DotToolInvocation,
  type DotToolInvocationStatus,
  type Room,
  type SpaceAgentRunRecord,
  type SpaceAgentSessionRecord
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import type { DotsRepository } from "@space/db";
import type { ControlActor } from "./space-control.js";
import { sanitizeControlExecute } from "./space-control-routes.js";

/**
 * Space Dots tool gateway (Stage 3).
 *
 * The worker forwards a Dot's native tool calls here with the turn identity it
 * runs. Every call is re-authorized from the database: the session must still
 * be active and owned by the Dot, the requesting run must still be running,
 * the Dot and room must belong to the requesting user and that user must still
 * be an authorized Control actor. Catalog entries never grant anything.
 * Sensitive actions wait for the owner's explicit approval in the Chat pane.
 */
export const dotGatewayIdentitySchema = z.object({
  roomId: z.string().trim().min(1).max(200),
  paneId: z.string().trim().min(1).max(200),
  agentSessionId: z.string().trim().min(1).max(200),
  workflowId: z.string().trim().min(1).max(500),
  operatorUserId: z.string().trim().min(1).max(200),
  dotId: dotIdSchema
}).strict();
export type DotGatewayIdentity = z.infer<typeof dotGatewayIdentitySchema>;
const catalogRequestSchema = z.object({
  identity: dotGatewayIdentitySchema,
  search: dotToolSearchInputSchema.optional(),
  describe: dotToolDescribeInputSchema.optional()
}).strict();
const callRequestSchema = dotToolCallInputSchema.extend({
  identity: dotGatewayIdentitySchema,
  callId: z.string().trim().min(1).max(200).nullable().default(null),
  invocationId: z.string().trim().min(1).max(200).nullable().default(null)
}).strict();

type MemoryApprovalTool = "dot_memory.remember" | "dot_memory.update" | "dot_memory.forget";
export type DotGatewayFailureCode = "REVOKED" | "FORBIDDEN" | "INVALID";
export class DotGatewayError extends Error {
  constructor(readonly code: DotGatewayFailureCode, message: string) { super(message); }
}
export interface DotGatewayResult {
  status: DotToolInvocationStatus;
  statusReason: string | null;
  toolId: string;
  result?: unknown;
}
export interface DotGatewayBrowserObservation { [key: string]: unknown }
type BrowserAction = z.infer<typeof browserToolActionInputSchema>;
/** The exact, normalized work an approval executes. Never re-derived from model output. */
export type DotApprovalPayload =
  | { kind: "control"; tool: string; payload: Record<string, unknown> }
  | { kind: "browser"; targetPaneId: string; action: BrowserAction }
  | { kind: "schedule"; scheduleId: string; summary: string }
  | { kind: "computer"; tool: "computer.browser"; arguments: Record<string, unknown> }
  | { kind: "memory"; tool: MemoryApprovalTool; arguments: Record<string, unknown> }
  | { kind: "deliverable"; tool: "deliverable.publish"; path: string; sha256: string }
  /** A design request costs image generation and lands in the owner's Media: it waits for the owner. */
  | { kind: "design"; tool: "design.request"; arguments: Record<string, unknown> }
  /** Starting another Dot's work always waits for the owner. */
  | { kind: "delegate"; tool: "dot.delegate"; arguments: Record<string, unknown> }
  /** Binding email and calendar actions (send, create event) run only after the owner approves them. */
  | { kind: "connector"; tool: string; arguments: Record<string, unknown> }
  /** A native tool the worker runs: approval lets the Dot run this exact call once. */
  | { kind: "native"; tool: string; arguments: Record<string, unknown> };
export interface DotToolGatewayDeps {
  store: SpaceStore;
  repository: DotsRepository;
  resolveActor(userId: string): Promise<ControlActor>;
  callControl(actor: ControlActor, tool: string, args: unknown): Promise<unknown>;
  catalogContext(input: { roomId: string; role: DotToolCatalogContext["role"]; ownerUserId?: string }): Promise<DotToolCatalogContext>;
  executeMcp(input: { roomId: string; paneId: string; toolId: string; arguments: Record<string, unknown> }, request: FastifyRequest):
    Promise<{ status: string; message: string; artifactLocalPath: string | null }>;
  readMcpResult(localPath: string): Promise<unknown>;
  executeBrowser(input: { roomId: string; targetPaneId: string; agentSessionId: string; action: BrowserAction },
    request: FastifyRequest): Promise<DotGatewayBrowserObservation>;
  /** Goal tools (Stage 4), bound to the calling conversation's open Goal. */
  goalTool?(sessionId: string, toolId: string, args: Record<string, unknown>): Promise<{ status: "COMPLETED" | "BLOCKED"; statusReason: string | null; result?: unknown }>;
  /** Proposes a schedule (Stage 4); confirmed or cancelled through the approval. */
  scheduleTool?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>):
    Promise<{ status: "PROPOSED"; schedule: { scheduleId: string }; summary: string } | { status: "BLOCKED"; statusReason: string }>;
  decideSchedule?(owner: string, dotId: string, scheduleId: string, decision: "APPROVE" | "DECLINE"): Promise<{ status: string; nextRunAt: string | null }>;
  /** `dot.delegate` (Stage 4): starts another Dot's Goal after the owner approves. */
  delegate?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** Email and calendar tools (Stage 5) through the owner's connected accounts. */
  connectorTool?(owner: string, toolId: string, args: Record<string, unknown>): Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** `deliverable.publish` (Stage 5): runs only after the owner approves it. */
  publishDeliverable?(owner: string, dotId: string, input: { path: string; roomId: string; expectedSha256: string }):
    Promise<{ deliverable: { version: number; artifactId: string | null; name: string }; unchanged: boolean }>;
  /** `design.request`: asks the owner's Design pane for a graphic, after the owner approves it. */
  designRequest?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** The workspace file's current sha256, pinned in the approval so exactly the approved content is published. */
  deliverableFingerprint?(owner: string, dotId: string, path: string): Promise<string>;
  /** `dot_memory.*` (Stage 5): the Dot's own memory; SHARED memories wait for the owner. */
  memoryTool?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, toolId: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** Scope of a memory this Dot can see, so changes to SHARED memories wait for the owner. */
  memoryScope?(owner: string, dotId: string, memoryId: string): Promise<"DOT" | "PROJECT" | "SHARED" | null>;
  /** `computer.browser` (Stage 4): opens or reuses the Dot's own Browser pane in the room. */
  computerBrowser?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** `channel.slack.send` / `channel.teams.send` (Stage 6): messages the owner or posts into the thread linked to this conversation. */
  channelTool?(session: { sessionId: string; dotId: string; roomId: string }, owner: string, toolId: string, args: Record<string, unknown>):
    Promise<{ status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string }>;
  /** Stage 8, Settings → Dots: sending email and creating events wait for the owner's approval (default on). */
  confirmExternalActions?(owner: string): Promise<boolean>;
  /** True while the conversation runs an evaluation case (Stage 7); its writes then always wait for approval. */
  evaluationSession?(sessionId: string): Promise<boolean>;
  /** Starts the Dot's next turn after its owner decides an approval. */
  continueAfterApproval?(input: { sessionId: string; paneId: string; ownerUserId: string; content: string; requestKey: string }): Promise<boolean>;
  audit(request: FastifyRequest, action: string, roomId: string, metadata: Record<string, unknown>): Promise<void>;
}
interface ResolvedIdentity {
  session: SpaceAgentSessionRecord;
  run: SpaceAgentRunRecord;
  actor: ControlActor;
  room: Room;
}

const maxResultCharacters = 60_000;
export const DOT_PROACTIVE_REASON = "This is proactive work you proposed, so it is read-only. Report what you found and ask the user before changing anything.";

export async function resolveDotGatewayIdentity(deps: Pick<DotToolGatewayDeps, "store" | "repository" | "resolveActor">,
  identity: DotGatewayIdentity): Promise<ResolvedIdentity> {
  const session = await deps.store.getSpaceAgentSession(identity.agentSessionId);
  if (!session || !session.isActive || session.roomId !== identity.roomId || session.paneId !== identity.paneId) {
    throw new DotGatewayError("REVOKED", "This Dot session is no longer active.");
  }
  if (session.dotId !== identity.dotId) throw new DotGatewayError("FORBIDDEN", "This session does not belong to the Dot.");
  const run = await deps.store.getLatestSpaceAgentRun(session.sessionId);
  if (!run || run.workflowId !== identity.workflowId || (run.status !== "QUEUED" && run.status !== "RUNNING")) {
    throw new DotGatewayError("REVOKED", "The task that requested this tool is no longer running.");
  }
  if (!await deps.repository.get(identity.operatorUserId, identity.dotId)) {
    throw new DotGatewayError("FORBIDDEN", "This Dot acts only for its owner.");
  }
  const room = await deps.store.getRoom(session.roomId);
  if (room.ownerUserId !== identity.operatorUserId) throw new DotGatewayError("FORBIDDEN", "This Dot acts only in its owner's rooms.");
  let actor: ControlActor;
  try { actor = await deps.resolveActor(identity.operatorUserId); }
  catch { throw new DotGatewayError("FORBIDDEN", "The Dot owner is no longer an authorized user."); }
  return { session, run, actor: { id: actor.id, role: actor.role, dotId: identity.dotId }, room };
}

export async function dotGatewayCatalog(deps: Pick<DotToolGatewayDeps, "catalogContext">, roomId: string, role: ControlActor["role"],
  ownerUserId?: string): Promise<DotToolEntry[]> {
  return buildDotToolCatalog(await deps.catalogContext({ roomId, role: role === "ADMIN" ? "ADMIN" : "USER", ...(ownerUserId ? { ownerUserId } : {}) }));
}

function bounded(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxResultCharacters) return value;
  return { truncated: true, preview: redactMemoryText(text.slice(0, maxResultCharacters)) };
}
function blocked(toolId: string, statusReason: string): DotGatewayResult { return { status: "BLOCKED", statusReason, toolId }; }

/** Maps a Control result honestly: work still running is PENDING, never COMPLETED. */
export function controlOutcome(value: unknown): { status: DotToolInvocationStatus; statusReason: string | null } {
  const record = (value ?? {}) as { status?: unknown; id?: unknown; results?: Array<{ status?: unknown }> };
  if (typeof record.status === "string" && ["FAILED", "PARTIAL", "UNKNOWN", "CANCELLED"].includes(record.status)) {
    return { status: "FAILED", statusReason: `Space control finished with ${record.status}.` };
  }
  if (record.status === "RUNNING" || record.results?.some((result) => result.status === "PENDING")) {
    return { status: "PENDING", statusReason: `Still in progress${typeof record.id === "string" ? ` (operation ${record.id})` : ""}; check it with space.operations before reporting completion.` };
  }
  return { status: "COMPLETED", statusReason: null };
}

/** Idempotent per (run, call): a retried native call reuses the Control request id. */
function requestIdFor(run: SpaceAgentRunRecord, callId: string | null, args: unknown): string {
  return `dot-${createHash("sha256").update(JSON.stringify([run.runId, callId, args])).digest("hex").slice(0, 40)}`;
}

async function assertOwnedRoom(deps: Pick<DotToolGatewayDeps, "store">, actor: ControlActor, roomId: string): Promise<void> {
  const room = await Promise.resolve().then(() => deps.store.getRoom(roomId)).catch(() => null);
  if (!room || room.ownerUserId !== actor.id) throw new DotGatewayError("FORBIDDEN", "A Dot can only act in its owner's rooms.");
}

const riskOrder: Record<DotActionRisk, number> = { READ: 0, WRITE: 1, SENSITIVE: 2 };
/** Classifies a Control command for a Dot: forbidden reason or the highest action risk. */
export function dotCommandPolicy(command: Pick<ControlExecute, "actions">, actor: ControlActor,
  dotPaneId: string, dotBrowserPaneId: string | null = null): { forbidden: string | null; risk: DotActionRisk } {
  let risk: DotActionRisk = "READ";
  for (const action of command.actions) {
    const classification = classifyDotControlAction(action, { role: actor.role, dotPaneId, dotBrowserPaneId });
    if (classification.forbidden) return { forbidden: classification.forbidden, risk: "SENSITIVE" };
    if (riskOrder[classification.risk] > riskOrder[risk]) risk = classification.risk;
  }
  return { forbidden: null, risk };
}

function targetText(target: { paneIds?: string[]; paneNames?: string[]; runtimeId?: string } | undefined): string {
  if (!target) return "panes";
  return [...(target.paneNames ?? []), ...(target.paneIds ?? [])].slice(0, 6).join(", ") || (target.runtimeId ? `${target.runtimeId} panes` : "all panes");
}
function describeAction(action: ControlAction): string {
  switch (action.kind) {
    case "pane": return `${action.operation} ${targetText(action.target)}${action.text ? `: “${action.text.slice(0, 160)}”` : ""}`;
    case "resource": return `${action.operation}${action.id ? ` ${action.id}` : ""}`;
    case "configure": return `change ${[action.modelId, action.reasoningEffort, action.nativeMode, action.accountProfileId].filter(Boolean).join(" / ") || "settings"} on ${targetText(action.target)}`;
    case "native_command": return `run ${action.command.slice(0, 120)} in ${targetText(action.target)}`;
    case "cli": return `${action.enabled ? "enable" : "disable"} ${action.runtimeId}`;
    case "vpn": return `${action.operation} VPN${action.runtimeId ? ` for ${action.runtimeId}` : ""}`;
    case "clipboard": return `${action.operation} clipboard item${action.id ? ` ${action.id}` : ""}`;
    case "watch": return `${action.operation} watch${action.paneId ? ` on ${action.paneId}` : ""}`;
    case "room": return `${action.operation} room${action.name ? ` ${action.name}` : ""}`;
    default: return action.kind;
  }
}
export function describeDotApproval(payload: DotApprovalPayload): string {
  if (payload.kind === "schedule") return payload.summary;
  if (payload.kind === "delegate") {
    return `Ask ${String(payload.arguments.to ?? "another Dot").slice(0, 80)} to work on: “${String(payload.arguments.task ?? "").slice(0, 300)}”`;
  }
  if (payload.kind === "connector") {
    const args = payload.arguments;
    const to = Array.isArray(args.to) ? args.to.slice(0, 5).join(", ") : "";
    return payload.tool === "mail.send" ? `Send an email to ${to.slice(0, 300)}: “${String(args.subject ?? "").slice(0, 200)}”`
      : payload.tool === "calendar.create" ? `Create the event “${String(args.title ?? "").slice(0, 200)}” on ${String(args.start ?? "").slice(0, 40)}${
        Array.isArray(args.attendees) && args.attendees.length ? ` and invite ${args.attendees.length} people` : ""}`
      : payload.tool.startsWith("channel.") ? `Send on ${payload.tool.includes("slack") ? "Slack" : "Teams"} ${args.where === "thread" ? "in the linked thread" : "to you"}: “${String(args.text ?? "").slice(0, 300)}”`
      : `Run ${payload.tool}`;
  }
  if (payload.kind === "deliverable") return `Publish ${payload.path.slice(0, 300)} from the Dot's workspace to Agent Files`;
  if (payload.kind === "design") {
    const formats = Array.isArray(payload.arguments.formatIds) && payload.arguments.formatIds.length ? payload.arguments.formatIds.slice(0, 8).join(", ") : "the Design pane's default format";
    return `Ask the Design pane for ${String(formats).slice(0, 200)}: “${String(payload.arguments.brief ?? "").slice(0, 300)}”`;
  }
  if (payload.kind === "memory") {
    const text = `“${String(payload.arguments.text ?? "").slice(0, 300)}”`;
    if (payload.tool === "dot_memory.forget") return `Forget the memory ${String(payload.arguments.memoryId ?? "").slice(0, 60)}`;
    if (payload.tool === "dot_memory.update") return `Change the memory ${String(payload.arguments.memoryId ?? "").slice(0, 60)} to ${text}`;
    return payload.arguments.scope === "SHARED" ? `Share a memory with all your Dots: ${text}`
      : payload.arguments.scope === "PROJECT" ? `Remember for this project: ${text}` : `Remember: ${text}`;
  }
  if (payload.kind === "native") {
    const args = payload.arguments;
    const quote = (value: unknown) => typeof value === "string" ? `: “${value.slice(0, 300)}”` : "";
    switch (payload.tool) {
      case "memory.save": return `Save to the shared Space memory that every agent reads${quote(args.title ?? args.body)}`;
      case "chat.send": return `Send a shared chat message${quote(args.text ?? args.content)}`;
      case "chat.react": return "React to a shared chat message";
      case "clipboard.save": case "clipboard.save_plan": return `Save to your clipboard${quote(args.title ?? args.text)}`;
      case "tasks.save": case "tasks.update": return `Change your task list${quote(args.objective ?? args.title)}`;
      default: return `Run ${payload.tool}`;
    }
  }
  if (payload.kind === "computer") {
    const url = typeof payload.arguments.url === "string" ? ` at ${payload.arguments.url.slice(0, 200)}` : "";
    return `Open the Dot's own Browser pane in this room${url}`;
  }
  if (payload.kind === "browser") {
    const url = "url" in payload.action ? ` → ${String(payload.action.url).slice(0, 200)}` : "";
    return `Browser ${payload.action.type} in pane ${payload.targetPaneId}${url}`;
  }
  const value = payload.payload as { actions?: ControlAction[]; command?: ControlExecute; operation?: string; dueAt?: string; paneId?: string };
  if (payload.tool === "space_schedules") return `Schedule at ${value.dueAt ?? "a later time"}: ${(value.command?.actions ?? []).map(describeAction).join("; ")}`;
  if (payload.tool === "space_watches") return `Watch ${value.paneId ?? "a pane"} with follow-up instructions`;
  return (value.actions ?? []).map(describeAction).join("; ").slice(0, 1000) || payload.tool;
}

interface PlannedControl { tool: string; payload: Record<string, unknown>; risk: DotActionRisk }
async function planControl(deps: DotToolGatewayDeps, entry: DotToolEntry, args: Record<string, unknown>,
  resolved: ResolvedIdentity, callId: string | null): Promise<PlannedControl | DotGatewayResult> {
  const { actor, session, run } = resolved;
  const roomId = typeof args.roomId === "string" ? args.roomId : session.roomId;
  await assertOwnedRoom(deps, actor, roomId);
  const ownBrowserPaneId = await deps.repository.dotBrowserPane(session.dotId!, roomId);
  const command = (raw: Record<string, unknown>): ControlExecute => {
    // Only the user may authorize past the safety guard; a Dot can never set it.
    const { userExplicitlyAuthorized: _ignored, ...rest } = raw;
    // Normalize exactly as the Control route does, so the policy sees the final actions.
    const parsed = controlExecuteSchema.safeParse(sanitizeControlExecute({ waitForCompletion: true, ...rest, roomId,
      requestId: typeof rest.requestId === "string" ? rest.requestId : requestIdFor(run, callId, rest) }));
    if (!parsed.success) throw new DotGatewayError("INVALID", `Invalid Space control command: ${parsed.error.issues[0]?.message ?? "invalid input"}.`);
    return parsed.data;
  };
  const execute = (value: ControlExecute): PlannedControl | DotGatewayResult => {
    const policy = dotCommandPolicy(value, actor, session.paneId, ownBrowserPaneId);
    return policy.forbidden ? blocked(entry.id, policy.forbidden) : { tool: "space_execute", payload: value as unknown as Record<string, unknown>, risk: policy.risk };
  };
  if (entry.source === "SPACE_RESOURCE") {
    const operation = entry.id.slice("resource.".length) as (typeof controlResourceOperations)[number];
    const { id, input, confirm, approvalReason, dryRun } = args;
    return execute(command({ actions: [{ kind: "resource", operation, input: input ?? {},
      ...(typeof id === "string" ? { id } : {}), ...(typeof confirm === "boolean" ? { confirm } : {}),
      ...(typeof approvalReason === "string" ? { approvalReason } : {}), ...(typeof dryRun === "boolean" ? { dryRun } : {}) }] }));
  }
  const operation = typeof args.operation === "string" ? args.operation : "list";
  switch (entry.id) {
    case "space.execute": return execute(command(args));
    case "space.inspect": return { tool: "space_inspect", payload: { ...args, roomId }, risk: "READ" };
    case "space.capabilities": return { tool: "space_capabilities", payload: { ...args, roomId }, risk: "READ" };
    case "space.pane_types": return { tool: "space_describe_pane_types", payload: { ...args, roomId }, risk: "READ" };
    // A read-only capture of the Dot's own room, saved in that room's Media (apps/api/src/space-control-capture.ts).
    case "space.screenshot": return { tool: "space_screenshot", payload: { ...args, roomId }, risk: "READ" };
    case "space.operations": return { tool: "space_operations", payload: { ...args, roomId }, risk: operation === "cancel" ? "WRITE" : "READ" };
    case "space.watches": return { tool: "space_watches", payload: { ...args, roomId },
      risk: operation === "register" ? "SENSITIVE" : ["list", "status"].includes(operation) ? "READ" : "WRITE" };
    case "space.schedules": {
      if (operation !== "create") return { tool: "space_schedules", payload: { ...args, roomId }, risk: operation === "cancel" ? "WRITE" : "READ" };
      if (!args.command || typeof args.command !== "object") return blocked(entry.id, "A schedule needs a command.");
      const nested = command(args.command as Record<string, unknown>);
      const policy = dotCommandPolicy(nested, actor, session.paneId, ownBrowserPaneId);
      if (policy.forbidden) return blocked(entry.id, policy.forbidden);
      return { tool: "space_schedules", payload: { ...args, roomId, command: nested }, risk: "SENSITIVE" };
    }
    default: return blocked(entry.id, "This Space control is not available to Dots.");
  }
}

async function runControl(deps: DotToolGatewayDeps, actor: ControlActor, toolId: string, plan: { tool: string; payload: Record<string, unknown> },
  userApproved: boolean): Promise<DotGatewayResult> {
  const payload = userApproved && plan.tool === "space_execute" ? { ...plan.payload, userExplicitlyAuthorized: true } : plan.payload;
  const value = await deps.callControl(actor, plan.tool, payload);
  return { ...controlOutcome(value), toolId, result: bounded(value) };
}

async function parkForApproval(deps: DotToolGatewayDeps, resolved: ResolvedIdentity, toolId: string, invocationId: string | null,
  payload: DotApprovalPayload): Promise<DotGatewayResult> {
  if (!invocationId) return blocked(toolId, "This action needs the user's approval, which is unavailable for this call.");
  const summary = describeDotApproval(payload);
  const parked = await deps.repository.requestToolApproval(invocationId, resolved.session.sessionId, { payload, summary });
  if (!parked) return blocked(toolId, "This action needs the user's approval, but the request could not be recorded.");
  return { status: "APPROVAL_REQUIRED", toolId, statusReason: `Waiting for the user's approval: ${summary}` };
}

export async function executeDotGatewayCall(deps: DotToolGatewayDeps, request: FastifyRequest,
  input: z.infer<typeof callRequestSchema>): Promise<DotGatewayResult> {
  const resolved = await resolveDotGatewayIdentity(deps, input.identity);
  const catalog = await dotGatewayCatalog(deps, resolved.session.roomId, resolved.actor.role, resolved.actor.id);
  const entry = catalog.find((candidate) => candidate.id === input.toolId);
  if (!entry) return blocked(input.toolId, "Unknown tool. Use space_search_tools to find an available tool.");
  if (entry.availability !== "AVAILABLE") return blocked(entry.id, entry.statusReason ?? `Tool is ${entry.availability.toLowerCase()}.`);
  const args = input.arguments;
  // Evaluation conversations (Stage 7) change nothing without a decision: every write waits for approval.
  const mode = await deps.evaluationSession?.(resolved.session.sessionId).catch(() => true) ? "ask_for_approval" : resolved.session.permissionMode;
  // Work the Dot proposed itself (a confirmed proactive schedule) only reads.
  const proactive = isDotProactiveRequest(resolved.run.clientRequestId);
  // MCP tools are not classified by effect, so proactive work does not call them.
  if (proactive && (entry.risk !== "READ" || entry.source === "MCP" || entry.source === "INSTALLED_MCP")) return blocked(entry.id, DOT_PROACTIVE_REASON);
  switch (entry.source) {
    case "SPACE_CONTROL":
    case "SPACE_RESOURCE": {
      const plan = await planControl(deps, entry, args, resolved, input.callId);
      if ("status" in plan) return plan;
      if (proactive && plan.risk !== "READ") return blocked(entry.id, DOT_PROACTIVE_REASON);
      if (needsDotApproval(plan.risk, mode)) return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "control", tool: plan.tool, payload: plan.payload });
      return runControl(deps, resolved.actor, entry.id, plan, false);
    }
    case "MCP": {
      const context = await deps.catalogContext({ roomId: resolved.session.roomId, role: resolved.actor.role === "ADMIN" ? "ADMIN" : "USER" });
      const tool = context.mcpTools.find((candidate) => dotMcpToolId(candidate.toolId) === entry.id);
      if (!tool) return blocked(entry.id, "The MCP tool is no longer registered.");
      const result = await deps.executeMcp({ roomId: resolved.session.roomId, paneId: resolved.session.paneId,
        toolId: tool.toolId, arguments: args }, request);
      if (result.status !== "EXECUTED") {
        return { status: result.status === "FAILED" ? "FAILED" : "BLOCKED", statusReason: result.message.slice(0, 1000), toolId: entry.id };
      }
      return { status: "COMPLETED", statusReason: null, toolId: entry.id,
        result: bounded(result.artifactLocalPath ? await deps.readMcpResult(result.artifactLocalPath) : { message: result.message }) };
    }
    case "BROWSER": {
      const { targetPaneId: requestedPaneId, ...action } = args;
      const ownPaneId = await deps.repository.dotBrowserPane(resolved.session.dotId!, resolved.session.roomId);
      const targetPaneId = typeof requestedPaneId === "string" ? requestedPaneId : ownPaneId;
      if (!targetPaneId) return blocked(entry.id, "Call computer.browser first to open your own browser, or pass a Browser pane id.");
      const parsed = browserToolActionInputSchema.safeParse({ ...action, type: entry.id.slice("browser.".length) });
      if (!parsed.success) return blocked(entry.id, `Invalid browser arguments: ${parsed.error.issues[0]?.message ?? "invalid input"}.`);
      // The Dot's own browser follows the session's mode; changing one of the user's Browser panes always needs approval.
      const risk: DotActionRisk = entry.risk === "READ" ? "READ" : targetPaneId === ownPaneId ? "WRITE" : "SENSITIVE";
      if (needsDotApproval(risk, mode)) {
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "browser", targetPaneId, action: parsed.data });
      }
      const observation = await deps.executeBrowser({ roomId: resolved.session.roomId, targetPaneId,
        agentSessionId: resolved.session.sessionId, action: parsed.data }, request);
      return { status: "COMPLETED", statusReason: null, toolId: entry.id, result: bounded(observation) };
    }
    case "SPACE_GOAL": {
      if (entry.id === "dot.delegate") {
        if (!deps.delegate) return blocked(entry.id, "Delegation is unavailable.");
        // Instructing another agent always waits for the owner.
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "delegate", tool: "dot.delegate", arguments: args });
      }
      if (!deps.goalTool) return blocked(entry.id, "Goals are unavailable.");
      // Goal progress is bookkeeping about the Dot's own work, allowed in every permission mode.
      const outcome = await deps.goalTool(resolved.session.sessionId, entry.id, args);
      return { ...outcome, toolId: entry.id, ...(outcome.result === undefined ? {} : { result: bounded(outcome.result) }) };
    }
    case "SPACE_NATIVE": {
      // The worker runs native tools; it asks here only when the call needs the owner's approval first.
      if (!needsDotApproval(dotNativeActionRisk(entry.id, entry.risk), mode)) return blocked(entry.id, "This tool runs inside the Dot runtime.");
      return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "native", tool: entry.id, arguments: args });
    }
    case "CONNECTOR": {
      if (entry.id.startsWith("channel.")) {
        if (!deps.channelTool) return blocked(entry.id, "Slack and Teams are unavailable.");
        // A direct message reaches only the user; posting into a thread others may read always waits for approval.
        if (needsDotApproval(args.where === "thread" ? "SENSITIVE" : "WRITE", mode)) {
          return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "connector", tool: entry.id, arguments: args });
        }
        const sent = await deps.channelTool({ sessionId: resolved.session.sessionId, dotId: resolved.session.dotId!, roomId: resolved.session.roomId },
          resolved.actor.id, entry.id, args);
        return sent.status === "COMPLETED" ? { status: "COMPLETED", statusReason: null, toolId: entry.id, result: bounded(sent.result) } : blocked(entry.id, sent.statusReason);
      }
      if (!deps.connectorTool) return blocked(entry.id, "Email and calendar connectors are unavailable.");
      // Operator decisions 2026-10-12: sending mail and creating events follow the session's permission mode like drafts,
      // and, while "Ask before sending email or creating events" is on in Settings → Dots (the default), always wait for
      // approval. Proactive work stays read-only above.
      const binding = entry.id === "mail.send" || entry.id === "calendar.create";
      const confirm = binding && (deps.confirmExternalActions ? await deps.confirmExternalActions(resolved.actor.id).catch(() => true) : true);
      if (needsDotApproval(confirm ? "SENSITIVE" : entry.risk === "READ" ? "READ" : "WRITE", mode)) {
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "connector", tool: entry.id, arguments: args });
      }
      const outcome = await deps.connectorTool(resolved.actor.id, entry.id, args);
      return outcome.status === "COMPLETED" ? { status: "COMPLETED", statusReason: null, toolId: entry.id, result: bounded(outcome.result) }
        : blocked(entry.id, outcome.statusReason);
    }
    case "SPACE_MEMORY": {
      if (!deps.memoryTool) return blocked(entry.id, "Dot memory is unavailable.");
      // Sharing with every Dot, or changing a shared memory, always needs the owner; the Dot's own memory follows the session's mode.
      const targetScope = (entry.id === "dot_memory.update" || entry.id === "dot_memory.forget") && typeof args.memoryId === "string" && deps.memoryScope
        ? await deps.memoryScope(resolved.actor.id, resolved.session.dotId!, args.memoryId) : null;
      const shared = (entry.id === "dot_memory.remember" && args.scope === "SHARED") || targetScope === "SHARED";
      if (needsDotApproval(shared ? "SENSITIVE" : entry.risk === "READ" ? "READ" : "WRITE", mode)) {
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "memory", tool: entry.id as MemoryApprovalTool, arguments: args });
      }
      const outcome = await deps.memoryTool({ sessionId: resolved.session.sessionId, dotId: resolved.session.dotId!, roomId: resolved.session.roomId },
        resolved.actor.id, entry.id, args);
      return outcome.status === "COMPLETED" ? { status: "COMPLETED", statusReason: null, toolId: entry.id, result: bounded(outcome.result) }
        : blocked(entry.id, outcome.statusReason);
    }
    case "SPACE_COMPUTER": {
      if (entry.id === "design.request") {
        if (!deps.designRequest) return blocked(entry.id, "The Design pane is unavailable on this server.");
        if (typeof args.brief !== "string" || !args.brief.trim()) return blocked(entry.id, "design.request needs a brief.");
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "design", tool: "design.request", arguments: args });
      }
      if (entry.id === "deliverable.publish") {
        if (!deps.publishDeliverable || !deps.deliverableFingerprint) return blocked(entry.id, "Deliverables are unavailable.");
        const parsed = dotWorkspaceRelativePathSchema.safeParse(args.path);
        if (!parsed.success) return blocked(entry.id, "deliverable.publish needs a path relative to your workspace.");
        const sha256 = await deps.deliverableFingerprint(resolved.actor.id, resolved.session.dotId!, parsed.data).catch(() => null);
        if (!sha256) return blocked(entry.id, "That file is not in your workspace, or it cannot be published (links, folders and files over the size limit are refused).");
        // Agent Files receive only what the user asked for: every publication waits for their approval.
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "deliverable", tool: "deliverable.publish", path: parsed.data, sha256 });
      }
      if (!deps.computerBrowser) return blocked(entry.id, "The Dot's computer is unavailable.");
      // Opening its own pane changes the room's layout, so it follows the session's permission mode.
      if (needsDotApproval("WRITE", mode)) {
        return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "computer", tool: "computer.browser", arguments: args });
      }
      const opened = await deps.computerBrowser({ sessionId: resolved.session.sessionId, dotId: resolved.session.dotId!, roomId: resolved.session.roomId },
        resolved.actor.id, args);
      return opened.status === "COMPLETED" ? { status: "COMPLETED", statusReason: null, toolId: entry.id, result: bounded(opened.result) }
        : blocked(entry.id, opened.statusReason);
    }
    case "SPACE_SCHEDULE": {
      if (!deps.scheduleTool) return blocked(entry.id, "Schedules are unavailable.");
      const proposed = await deps.scheduleTool({ sessionId: resolved.session.sessionId, dotId: resolved.session.dotId!, roomId: resolved.session.roomId },
        resolved.actor.id, args);
      if (proposed.status !== "PROPOSED") return blocked(entry.id, proposed.statusReason);
      return parkForApproval(deps, resolved, entry.id, input.invocationId, { kind: "schedule", scheduleId: proposed.schedule.scheduleId, summary: proposed.summary });
    }
    case "INSTALLED_MCP":
      return blocked(entry.id, "Installed MCP servers are called through space_dispatcher (space_mcp_server_info, then space_call_mcp_tool).");
    default:
      return blocked(entry.id, "This tool runs inside the Dot runtime.");
  }
}

/** Executes or declines one approval for its owner, then lets the Dot continue. */
export async function decideDotApproval(deps: DotToolGatewayDeps, request: FastifyRequest, input: {
  owner: string; dotId: string; invocationId: string; decision: "APPROVE" | "DECLINE";
}): Promise<{ invocation: DotToolInvocation; continued: boolean } | null> {
  let actor: ControlActor;
  try { actor = await deps.resolveActor(input.owner); }
  catch { throw new DotGatewayError("FORBIDDEN", "Only an authorized user can decide this request."); }
  const decided = await deps.repository.decideToolApproval(input.owner, input.dotId, input.invocationId, input.decision, input.owner);
  if (!decided) return null;
  const { invocation } = decided;
  let finished: DotToolInvocation = invocation;
  let outcome: DotGatewayResult = { status: "DECLINED", statusReason: "Declined by the user.", toolId: invocation.toolId };
  const scheduled = decided.payload as DotApprovalPayload;
  if (scheduled.kind === "schedule" && deps.decideSchedule) {
    // A proposed schedule is confirmed (activated) or cancelled, never executed now.
    const result = await deps.decideSchedule(input.owner, input.dotId, scheduled.scheduleId, input.decision).catch((error: unknown) =>
      ({ status: "FAILED", nextRunAt: null, error: error instanceof Error ? error.message : "Schedule update failed." }));
    if (input.decision === "APPROVE") {
      outcome = result.status === "ACTIVE"
        ? { status: "COMPLETED", statusReason: null, toolId: invocation.toolId, result: { scheduleId: scheduled.scheduleId, nextRunAt: result.nextRunAt } }
        : { status: "FAILED", statusReason: (result as { error?: string }).error ?? `The schedule is ${result.status.toLowerCase()}.`, toolId: invocation.toolId };
      finished = await deps.repository.finishToolInvocation(invocation.invocationId, { status: outcome.status === "COMPLETED" ? "COMPLETED" : "FAILED",
        statusReason: outcome.statusReason, resultSummary: JSON.stringify(outcome.result ?? outcome.statusReason ?? "").slice(0, 2000) }) ?? invocation;
    }
  } else if (input.decision === "APPROVE") {
    const session = await deps.store.getSpaceAgentSession(invocation.sessionId);
    const payload = decided.payload as DotApprovalPayload;
    try {
      if (!session?.isActive || session.dotId !== input.dotId) throw new DotGatewayError("REVOKED", "The conversation is no longer active.");
      await assertOwnedRoom(deps, actor, payload.kind === "control" && typeof payload.payload.roomId === "string" ? payload.payload.roomId : invocation.roomId);
      const target = { sessionId: invocation.sessionId, dotId: input.dotId, roomId: invocation.roomId };
      const opened = payload.kind === "computer" && deps.computerBrowser ? await deps.computerBrowser(target, input.owner, payload.arguments)
        : payload.kind === "memory" && deps.memoryTool ? await deps.memoryTool(target, input.owner, payload.tool, payload.arguments)
        : payload.kind === "connector" && payload.tool.startsWith("channel.") && deps.channelTool ? await deps.channelTool(target, input.owner, payload.tool, payload.arguments)
        : payload.kind === "connector" && deps.connectorTool ? await deps.connectorTool(input.owner, payload.tool, payload.arguments)
        : payload.kind === "delegate" && deps.delegate ? await deps.delegate(target, input.owner, payload.arguments)
        : payload.kind === "design" && deps.designRequest ? await deps.designRequest(target, input.owner, payload.arguments) : null;
      outcome = opened ? opened.status === "COMPLETED" ? { status: "COMPLETED", statusReason: null, toolId: invocation.toolId, result: bounded(opened.result) }
          : { status: "FAILED", statusReason: opened.statusReason, toolId: invocation.toolId }
        : payload.kind === "browser"
        ? { status: "COMPLETED", statusReason: null, toolId: invocation.toolId, result: bounded(await deps.executeBrowser({ roomId: invocation.roomId,
          targetPaneId: payload.targetPaneId, agentSessionId: invocation.sessionId, action: payload.action }, request)) }
        : payload.kind === "control" ? await runControl(deps, { ...actor, dotId: input.dotId }, invocation.toolId, payload, true)
        // The worker runs native tools: the approval becomes a one-time grant for this exact call.
        : payload.kind === "native" ? { status: "PENDING", statusReason: "Approved by the user; the Dot runs this exact call once.", toolId: invocation.toolId }
        : payload.kind === "deliverable" && deps.publishDeliverable
        ? await deps.publishDeliverable(input.owner, input.dotId, { path: payload.path, roomId: invocation.roomId, expectedSha256: payload.sha256 }).then((published) => ({
          status: "COMPLETED" as const, statusReason: null, toolId: invocation.toolId,
          result: { name: published.deliverable.name, version: published.deliverable.version, artifactId: published.deliverable.artifactId, unchanged: published.unchanged } }))
        : { status: "FAILED", statusReason: "This approval can no longer be carried out.", toolId: invocation.toolId };
    } catch (error) {
      outcome = { status: "FAILED", statusReason: redactMemoryText(error instanceof Error ? error.message : "Approved action failed.").slice(0, 500), toolId: invocation.toolId };
    }
    const final = outcome.status === "COMPLETED" || outcome.status === "PENDING" ? outcome.status : "FAILED";
    finished = await deps.repository.finishToolInvocation(invocation.invocationId, { status: final, statusReason: outcome.statusReason,
      resultSummary: redactMemoryText(JSON.stringify(outcome.result ?? outcome.statusReason ?? "")).slice(0, 2000) }) ?? invocation;
  }
  await deps.audit(request, "dot.tool.approval", invocation.roomId, { dotId: input.dotId, invocationId: invocation.invocationId,
    toolId: invocation.toolId, decision: input.decision, status: outcome.status });
  const summary = invocation.approvalSummary ?? invocation.toolId;
  const nativeGrant = input.decision === "APPROVE" && (decided.payload as DotApprovalPayload).kind === "native" && outcome.status === "PENDING";
  const content = nativeGrant
    ? `Approved: ${summary}\nRun the same ${(decided.payload as { tool?: string }).tool ?? invocation.toolId} call again now, with the same arguments; it will run once.`
    : input.decision === "APPROVE"
    ? `Approved: ${summary}\nResult: ${outcome.status}${outcome.statusReason ? ` — ${outcome.statusReason}` : ""}\n${finished.resultSummary ? `Details: ${finished.resultSummary.slice(0, 1500)}\n` : ""}Continue the task.`
    : `Declined: ${summary}\nDo not retry this action. Continue without it or ask me what to do instead.`;
  const session = await deps.store.getSpaceAgentSession(invocation.sessionId);
  const continued = deps.continueAfterApproval && session?.isActive ? await deps.continueAfterApproval({ sessionId: invocation.sessionId,
    paneId: session.paneId, ownerUserId: input.owner, content,
    requestKey: `approval-${createHash("sha256").update(invocation.invocationId).digest("hex").slice(0, 32)}` }).catch(() => false) : false;
  return { invocation: finished, continued };
}

export function registerDotToolGatewayRoutes(app: FastifyInstance, deps: DotToolGatewayDeps | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const unavailable = { error: { code: "DOTS_UNAVAILABLE", message: "Dots storage is unavailable." } };
  const failure = (error: unknown) => {
    if (error instanceof DotGatewayError) return { code: error.code === "INVALID" ? 400 : 409, body: { error: { code: `DOT_TOOL_${error.code}`, message: error.message } } };
    if (error instanceof z.ZodError) return { code: 400, body: { error: { code: "DOT_TOOL_INVALID", message: "Dot tool request is invalid." } } };
    return null;
  };
  app.post("/api/internal/dots/tools/catalog", options.routeOptions, async (request, reply) => {
    if (!deps) return reply.code(503).send(unavailable);
    try {
      const input = catalogRequestSchema.parse(request.body ?? {});
      const resolved = await resolveDotGatewayIdentity(deps, input.identity);
      const catalog = await dotGatewayCatalog(deps, resolved.session.roomId, resolved.actor.role, resolved.actor.id);
      if (input.describe) {
        const entry = catalog.find((candidate) => candidate.id === input.describe!.toolId);
        return entry ? { tool: entry } : reply.code(404).send({ error: { code: "DOT_TOOL_NOT_FOUND", message: "Unknown tool. Use space_search_tools." } });
      }
      const tools = searchDotTools(catalog, input.search ?? {});
      return { tools, total: catalog.length, available: catalog.filter((entry) => entry.availability === "AVAILABLE").length };
    } catch (error) {
      const mapped = failure(error);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw error;
    }
  });
  app.post("/api/internal/dots/tools/call", options.routeOptions, async (request, reply) => {
    if (!deps) return reply.code(503).send(unavailable);
    let roomId: string | null = null;
    try {
      const input = callRequestSchema.parse(request.body ?? {});
      roomId = input.identity.roomId;
      const result = await executeDotGatewayCall(deps, request, input);
      await deps.audit(request, "dot.tool.call", input.identity.roomId, { dotId: input.identity.dotId, toolId: input.toolId,
        agentSessionId: input.identity.agentSessionId, status: result.status });
      return result;
    } catch (error) {
      const mapped = failure(error);
      if (mapped) {
        if (roomId) await deps.audit(request, "dot.tool.blocked", roomId, { code: mapped.body.error.code }).catch(() => undefined);
        return reply.code(mapped.code).send(mapped.body);
      }
      throw error;
    }
  });
  const toolsQuery = z.object({
    roomId: z.string().trim().min(1).max(200).optional(),
    q: z.string().trim().max(200).optional(),
    source: dotToolSourceSchema.optional(),
    includeUnavailable: z.enum(["true", "false"]).optional()
  }).strict();
  const params = z.object({ dotId: dotIdSchema }).strict();
  const approvalParams = z.object({ dotId: dotIdSchema, invocationId: z.string().trim().min(1).max(200) }).strict();
  const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
  const userRoute = (action: (request: FastifyRequest, owner: string, deps: DotToolGatewayDeps) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!deps) return reply.code(503).send(unavailable);
      try {
        const data = await action(request, await options.authenticatedOwner(request), deps);
        return data === null ? reply.code(404).send({ error: { code: "DOT_NOT_FOUND", message: "Dot was not found." } }) : data;
      } catch (error) {
        const mapped = failure(error);
        if (mapped) return reply.code(mapped.code === 409 ? 404 : mapped.code).send(mapped.body);
        throw error;
      }
    };
  app.get("/api/dots/:dotId/tools", options.routeOptions, userRoute(async (request, owner, gateway) => {
    const { dotId } = params.parse(request.params);
    const query = toolsQuery.parse(request.query);
    if (!await gateway.repository.get(owner, dotId)) return null;
    const actor = await gateway.resolveActor(owner);
    let roomId = "";
    if (query.roomId) {
      const room = await Promise.resolve().then(() => gateway.store.getRoom(query.roomId!)).catch(() => null);
      if (!room || room.ownerUserId !== owner) return null;
      roomId = room.id;
    }
    const catalog = await dotGatewayCatalog(gateway, roomId, actor.role, owner);
    const includeUnavailable = query.includeUnavailable !== "false";
    const tools = query.q || query.source
      ? searchDotTools(catalog, { query: query.q, source: query.source, includeUnavailable, limit: 50 })
      : catalog.filter((entry) => includeUnavailable || entry.availability === "AVAILABLE")
        .map(({ inputSchema: _schema, ...summary }) => summary);
    return { dotId, tools, total: catalog.length, available: catalog.filter((entry) => entry.availability === "AVAILABLE").length };
  }));
  app.get("/api/dots/:dotId/tool-invocations", options.routeOptions, userRoute(async (request, owner, gateway) => {
    const { dotId } = params.parse(request.params);
    const { limit, offset } = pagination.parse(request.query);
    const items = await gateway.repository.listToolInvocations(owner, dotId, limit, offset);
    return items ? { dotId, items, limit, offset } : null;
  }));
  app.get("/api/dots/:dotId/approvals", options.routeOptions, userRoute(async (request, owner, gateway) => {
    const { dotId } = params.parse(request.params);
    const { sessionId } = z.object({ sessionId: z.string().trim().min(1).max(200).optional() }).strict().parse(request.query);
    const items = await gateway.repository.listPendingApprovals(owner, dotId, sessionId);
    return items ? { dotId, items } : null;
  }));
  app.post("/api/dots/:dotId/approvals/:invocationId", options.routeOptions, userRoute(async (request, owner, gateway) => {
    const { dotId, invocationId } = approvalParams.parse(request.params);
    const { decision } = dotApprovalDecisionSchema.parse(request.body ?? {});
    return decideDotApproval(gateway, request, { owner, dotId, invocationId, decision });
  }));
}

/** The room owner and their Dot, or null when the room's owner has no such Dot. */
export async function findRoomOwnerDot(store: Pick<SpaceStore, "getRoom">, dots: Pick<DotsRepository, "get"> | null, roomId: string, dotId: string) {
  const owner = (await store.getRoom(roomId)).ownerUserId;
  const dot = owner && dots ? await dots.get(owner, dotId) : null;
  return owner && dot ? { owner, dot } : null;
}

/** The identity context of a session's Dot (see dotIdentityContext), or null. */
export async function sessionDotIdentity(store: Pick<SpaceStore, "getRoom">, dots: Pick<DotsRepository, "get"> | null,
  session: { roomId: string; dotId?: string | null }): Promise<string | null> {
  const owned = session.dotId ? await findRoomOwnerDot(store, dots, session.roomId, session.dotId) : null;
  return owned ? dotIdentityContext(owned.dot) : null;
}

/** Who a Dot is and how it speaks; every runtime gets it, CLI runtimes (no Space tools, one bounded prompt) only this. */
export function dotIdentityContext(dot: Pick<DotProfile, "name" | "preferences"> & Partial<Pick<DotProfile, "appearance">>): string {
  const style = dot.preferences.communicationStyle?.trim();
  const language = dot.preferences.language?.trim();
  return [
    `You are ${dot.name}, one of the user's six Space Dots in SpaceApp. Each Dot keeps its own conversations, tasks and memory; all Dots have the same capabilities and act only with the user's authorization.`,
    dot.appearance ? dotPersonalityInstructions(dot.appearance.character) : null,
    style ? `Communication style: ${style.slice(0, 2000)}` : null,
    language ? `Preferred reply language: ${language.slice(0, 80)}.` : "Reply in the language the user writes in."
  ].filter(Boolean).join("\n");
}

/** Developer context for a Dot thread: identity and preferences, never authority. */
export function dotDeveloperContext(dot: Pick<DotProfile, "name" | "preferences"> & Partial<Pick<DotProfile, "appearance">>, project: string | null,
  dotWorkspace: string | null = null, memories: ReadonlyArray<Pick<DotMemory, "memoryId" | "scope" | "text">> = []): string {
  return [
    dotIdentityContext(dot),
    project ? `Project directory: ${project}. Run project work there.` : null,
    dotWorkspace ? `Your private workspace: ${dotWorkspace}. Keep drafts, downloads, scratch code and files you produce for the user there${project ? " unless they belong in the project" : ""}.` : null,
    "For web work, call computer.browser to open your own browser (isolated profile, not signed in to the user's accounts) instead of the user's Browser panes.",
    "Remember durable facts and preferences the user shares with dot_memory.remember (your own by default); never store secrets or credentials.",
    // Operator 2026-10-18: a Dot chat is not a CLI pane, so Nous progress reports (skill space-progress) do not apply.
    "This is a plain chat with the user, not a Space CLI pane: never send or mention progress reports to Nous (space-progress), just answer.",
    dotMemoryContext(memories)
  ].filter(Boolean).join("\n");
}
