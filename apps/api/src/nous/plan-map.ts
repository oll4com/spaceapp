import type { ClipboardItem, ManagedPlanExecution, NousGlobalHold, NousPlanHold, PlanWaitsOnKind } from "@space/contracts";
import type { NousPaneSummaryRow, PaneReport } from "@space/db";

/**
 * Plan map (operator request 2026-10-25): one picture of every open plan for the operator (the Nous dock's Plans view) and for
 * Nous (the world's "## Plan map" section): what each plan waits on, the plans it depends on, the date it must keep, the
 * server-wide holds that stop every plan, and what to unblock first. Pure: the wiring collects the inputs.
 */
export interface PlanMapNode {
  id: string; title: string; status: string; progress: number; paneId: string | null;
  /** Dependency depth: 0 depends on no open plan; a loop never recurses. */
  level: number;
  /** The open plans it depends on, and the open plans that depend on it. */
  dependsOn: string[]; dependents: string[];
  dueAt: string | null; overdue: boolean; hold: NousPlanHold | null;
}
/** A blocker to clear: SERVER holds every plan (no plan ids); FINISH is a plan others depend on; the rest are holds someone can act on. */
export interface PlanMapUnblock { kind: PlanWaitsOnKind | "FINISH"; what: string; planIds: string[]; unsticks: number }
export interface PlanMapDate { planId: string; title: string; at: string; kind: "DUE" | "RESUMES"; overdue: boolean }
export interface PlanMap {
  holds: NousGlobalHold[];
  nodes: Map<string, PlanMapNode>;
  /** Every open plan in dependency order: level, overdue first, nearest date, title. */
  ordered: PlanMapNode[];
  unblockFirst: PlanMapUnblock[];
  dates: PlanMapDate[];
}

const EXECUTION_HOLD: Partial<Record<ManagedPlanExecution["status"], PlanWaitsOnKind>> = { PAUSED: "OPERATOR", WAITING_FOR_INPUT: "OPERATOR", BLOCKED: "NOUS", WAITING_FOR_MODEL: "SERVER" };
// The pane board's fallback table (pane-board.ts): a report of these statuses means the pane, and so its plan, waits.
const REPORT_HOLD: Partial<Record<PaneReport["status"], PlanWaitsOnKind>> = { NEEDS_YOU: "OPERATOR", BLOCKED: "NOUS", NEEDS_DECISION: "NOUS", WAITING: "NOUS" };
/** The holds that stop work from landing (nothing deploys, executions never advance): each open plan waits on them and Nous is told once; Nous off, its paused model, low-spend mode and server load are listed but reach Nous on their own paths. */
export const HARD_HOLDS = new Set<NousGlobalHold["kind"]>(["QUEUE_PAUSED", "QUEUE_DOWN", "PLAN_CONTROLLER_OFF"]);
/** Holds someone can act on; a date passes by itself and a dependency is cleared by finishing the plan it names. */
const ACTIONABLE = new Set<PlanWaitsOnKind>(["OPERATOR", "THIRD_PARTY", "PROMOTE", "NOUS"]);
const KIND_ORDER: Array<PlanMapUnblock["kind"]> = ["SERVER", "OPERATOR", "THIRD_PARTY", "PROMOTE", "NOUS", "FINISH"];
export const PLAN_HOLD_LABELS: Record<PlanWaitsOnKind, string> = { OPERATOR: "you", DATE: "a date", PROMOTE: "a promote", THIRD_PARTY: "a third party", PLAN: "another plan", NOUS: "Nous", SERVER: "the server" };

const oneLine = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };
const planTitle = (plan: ClipboardItem) => plan.title ?? oneLine(plan.text, 80);

export function buildPlanMap(input: {
  /** The owner's open plans (a completed or deleted dependency counts as done). */
  plans: ClipboardItem[];
  executions: Array<Pick<ManagedPlanExecution, "planId" | "status" | "statusReason" | "nextRetryAt">>;
  /** The pane board's newest line per pane. */
  summaries: Array<Pick<NousPaneSummaryRow, "paneId" | "waitsOn" | "until" | "detail" | "line">>;
  /** The newest report naming each plan. */
  reports: PaneReport[];
  holds: NousGlobalHold[];
  now: Date;
}): PlanMap {
  const now = input.now.getTime();
  const open = input.plans.filter((plan) => !plan.isCompleted);
  const byId = new Map(open.map((plan) => [plan.id, plan]));
  const executions = new Map(input.executions.map((execution) => [execution.planId, execution]));
  const summaries = new Map(input.summaries.map((summary) => [summary.paneId, summary]));
  const reports = new Map(input.reports.filter((report) => report.planId).map((report) => [report.planId!, report]));
  const future = (iso: string | null) => iso === null || Date.parse(iso) > now;

  const holdOf = (plan: ClipboardItem): NousPlanHold | null => {
    // A recorded wait on a date that passed is over; every other recorded wait stands until it is cleared.
    if (plan.waitsOn && (plan.waitsOn.kind !== "DATE" || future(plan.waitsOn.until))) return { ...plan.waitsOn, source: "PLAN" };
    const dependency = (plan.dependsOn ?? []).map((id) => byId.get(id)).find((entry): entry is ClipboardItem => Boolean(entry));
    if (dependency) return { kind: "PLAN", what: planTitle(dependency), until: dependency.dueAt, source: "DEPENDENCY" };
    const execution = executions.get(plan.id);
    const executionKind = execution ? EXECUTION_HOLD[execution.status] : undefined;
    if (execution && executionKind) return { kind: executionKind, what: execution.statusReason ?? execution.status.toLowerCase().replace(/_/g, " "), until: execution.nextRetryAt, source: "EXECUTION" };
    const summary = plan.paneId ? summaries.get(plan.paneId) : undefined;
    if (summary && summary.waitsOn !== "NONE") return { kind: summary.waitsOn, what: summary.detail ?? summary.line, until: summary.until, source: "PANE" };
    const report = reports.get(plan.id);
    const reportKind = report ? REPORT_HOLD[report.status] : undefined;
    if (report && reportKind) return { kind: reportKind, what: report.needs ?? report.summary, until: null, source: "REPORT" };
    const hold = input.holds.find((entry) => HARD_HOLDS.has(entry.kind));
    return hold ? { kind: "SERVER", what: hold.text, until: null, source: "SERVER" } : null;
  };

  const levels = new Map<string, number>();
  const levelOf = (id: string, trail: Set<string>): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (trail.has(id)) return 0;
    trail.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((dep) => byId.has(dep));
    const level = deps.length ? 1 + Math.max(...deps.map((dep) => levelOf(dep, trail))) : 0;
    levels.set(id, level);
    return level;
  };
  const dependents = new Map<string, string[]>(open.map((plan) => [plan.id, []]));
  for (const plan of open) for (const dep of plan.dependsOn ?? []) dependents.get(dep)?.push(plan.id);
  const transitive = (id: string, seen = new Set<string>()): Set<string> => {
    for (const next of dependents.get(id) ?? []) if (!seen.has(next)) { seen.add(next); transitive(next, seen); }
    return seen;
  };

  const nodes = new Map<string, PlanMapNode>(open.map((plan) => [plan.id, {
    id: plan.id, title: planTitle(plan), status: plan.executionStatus, progress: plan.progressPercentage, paneId: plan.paneId,
    level: levelOf(plan.id, new Set()), dependsOn: (plan.dependsOn ?? []).filter((dep) => byId.has(dep)), dependents: dependents.get(plan.id) ?? [],
    dueAt: plan.dueAt ?? null, overdue: Boolean(plan.dueAt) && Date.parse(plan.dueAt!) < now, hold: holdOf(plan)
  }]));
  const byDate = (left: { dueAt: string | null }, right: { dueAt: string | null }) => (left.dueAt ?? "9").localeCompare(right.dueAt ?? "9");
  const ordered = [...nodes.values()].sort((left, right) => left.level - right.level || Number(right.overdue) - Number(left.overdue) || byDate(left, right) || left.title.localeCompare(right.title));

  // Unblock first (operator review 2026-10-25: a list of every plan read as a wall): the server-wide holds, then each hold someone
  // can act on, merged when plans wait on the same thing, then the plans others depend on that wait on nothing actionable.
  const blockers = new Map<string, PlanMapUnblock>();
  for (const node of ordered) {
    const hold = node.hold && ACTIONABLE.has(node.hold.kind) ? node.hold : null;
    if (!hold && !node.dependents.length) continue;
    const kind = hold ? hold.kind : "FINISH";
    const what = hold ? oneLine(hold.what, 200) : node.title;
    const key = `${kind}\u0000${hold ? what.toLowerCase() : node.id}`;
    const entry = blockers.get(key) ?? { kind, what, planIds: [], unsticks: 0 };
    entry.planIds.push(node.id);
    blockers.set(key, entry);
  }
  for (const entry of blockers.values()) entry.unsticks = new Set(entry.planIds.flatMap((id) => [id, ...transitive(id)])).size;
  const soonest = (entry: PlanMapUnblock) => entry.planIds.map((id) => nodes.get(id)!.dueAt ?? "9").sort()[0] ?? "9";
  const unblockFirst: PlanMapUnblock[] = [
    ...input.holds.map((hold) => ({ kind: "SERVER" as const, what: hold.text, planIds: [], unsticks: open.length })),
    ...[...blockers.values()].sort((left, right) => right.unsticks - left.unsticks || KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
      || soonest(left).localeCompare(soonest(right)) || left.what.localeCompare(right.what))
  ];
  const dates: PlanMapDate[] = ordered.flatMap((node) => [
    ...(node.dueAt ? [{ planId: node.id, title: node.title, at: node.dueAt, kind: "DUE" as const, overdue: node.overdue }] : []),
    ...(node.hold?.kind === "DATE" && node.hold.until ? [{ planId: node.id, title: node.title, at: node.hold.until, kind: "RESUMES" as const, overdue: Date.parse(node.hold.until) < now }] : [])
  ]).sort((left, right) => left.at.localeCompare(right.at));
  return { holds: input.holds, nodes, ordered, unblockFirst, dates };
}

/** "2026-10-30 09:00" in the owner's working time zone. */
export function planMapTime(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)).replace(",", "");
  } catch { return iso.slice(0, 16).replace("T", " "); }
}

const holdText = (hold: NousPlanHold, zone: string) => `waits on ${PLAN_HOLD_LABELS[hold.kind]}: ${oneLine(hold.what, 160)}${hold.until ? ` (until ${planMapTime(hold.until, zone)})` : ""}`;

/** The world's "## Plan map" section: holds, what to unblock first, the dates, then every plan that waits, has a date or depends on another. */
export function renderPlanMap(map: PlanMap, zone = "UTC"): string {
  const lines = ["## Plan map (the one picture of every open plan: before you propose or start work, name the holds, the unblock-first items and the dates to keep)",
    map.holds.length ? ["Server-wide holds (name them to the operator):", ...map.holds.map((hold) => `- ${hold.kind}: ${hold.text}${hold.since ? ` (since ${planMapTime(hold.since, zone)})` : ""}`)].join("\n") : "Server-wide holds: none.",
    "Unblock first (what someone can act on; waits for a date or for another plan are not listed):", ...(map.unblockFirst.length ? map.unblockFirst.map((item) => {
      const plans = item.planIds.map((id) => `[${id}] "${oneLine(map.nodes.get(id)?.title ?? id, 60)}"`).join(", ");
      const count = ` · unsticks ${item.unsticks} plan${item.unsticks === 1 ? "" : "s"}`;
      if (item.kind === "SERVER") return `- SERVER: ${item.what} · holds every plan`;
      if (item.kind === "FINISH") return `- finish ${plans} (${map.nodes.get(item.planIds[0]!)?.progress ?? 0}%)${count}`;
      return `- waits on ${PLAN_HOLD_LABELS[item.kind]}: ${oneLine(item.what, 200)} → ${plans}${count}`;
    }) : ["- nothing: no plan waits on you, a third party, a promote, Nous or the server"]),
    "Dates (due dates and the times plans waiting for a date resume, soonest first):", ...(map.dates.length ? map.dates.map((date) =>
      `- ${planMapTime(date.at, zone)} ${date.kind === "DUE" ? "due" : "resumes"} [${date.planId}] "${oneLine(date.title, 100)}"${date.overdue ? (date.kind === "DUE" ? " — OVERDUE" : " — passed: check it") : ""}`) : ["- none recorded (space_plan_update dueAt)"])];
  // A server-wide hold is listed once above, never per plan.
  const own = (node: PlanMapNode) => node.hold && node.hold.source !== "SERVER" ? node.hold : null;
  const linked = map.ordered.filter((node) => own(node) || node.dueAt || node.dependsOn.length);
  if (linked.length) lines.push("Plans that wait, have a date or depend on another (dependency order):", ...linked.map((node) =>
    `- [${node.id}] "${oneLine(node.title, 100)}" ${node.progress}%${own(node) ? ` · ${holdText(own(node)!, zone)}` : ""}${node.dueAt ? ` · due ${planMapTime(node.dueAt, zone)}${node.overdue ? " OVERDUE" : ""}` : ""}`
    + `${node.dependsOn.length ? ` · needs: ${node.dependsOn.map((dep) => `[${dep}] "${oneLine(map.nodes.get(dep)!.title, 60)}"`).join(", ")}` : ""}`));
  const free = map.ordered.length - linked.length;
  if (free) lines.push(`${free} other plan${free === 1 ? "" : "s"} wait${free === 1 ? "s" : ""} on nothing recorded.`);
  return lines.join("\n");
}

/** Why a plan is not stalled: a wait on a date, another plan or the server is not Nous's to nudge (its root is). */
export function stalledHold(map: PlanMap, planId: string): string | null {
  const hold = map.nodes.get(planId)?.hold;
  if (!hold) return null;
  if (hold.kind === "DATE" || hold.kind === "PLAN" || hold.kind === "SERVER") return holdText(hold, "UTC");
  return null;
}

/** One inbox line per change (operator decision 2026-10-25): a server-wide hold that appears or clears, a plan that turns overdue. In memory, like the token monitor: a restart announces the current holds once. */
export function createPlanHoldsMonitor() {
  const states = new Map<string, { holds: Map<NousGlobalHold["kind"], NousGlobalHold>; overdue: Set<string> }>();
  return {
    observe(owner: string, map: PlanMap, zone = "UTC"): Array<{ key: string; line: string }> {
      const before = states.get(owner);
      const holds = new Map(map.holds.filter((hold) => HARD_HOLDS.has(hold.kind)).map((hold) => [hold.kind, hold]));
      const lines: Array<{ key: string; line: string }> = [];
      for (const [kind, hold] of holds) if (!before?.holds.has(kind)) lines.push({ key: `plan-hold:${kind}`, line: `Server-wide hold: ${hold.text} Every plan waits until it clears: tell the operator what it holds and what clears it.` });
      for (const [kind, hold] of before?.holds ?? []) if (!holds.has(kind)) lines.push({ key: `plan-hold:${kind}`, line: `Server-wide hold cleared: ${hold.text} Plans can move again: start with the unblock-first items of the Plan map.` });
      const due = map.dates.filter((date) => date.kind === "DUE" && date.overdue);
      const overdue = new Set(due.map((date) => `${date.planId}:${date.at}`));
      for (const date of due) if (!before?.overdue.has(`${date.planId}:${date.at}`)) {
        lines.push({ key: `plan-overdue:${date.planId}`, line: `Plan [${date.planId}] "${oneLine(date.title, 100)}" is overdue (due ${planMapTime(date.at, zone)}): tell the operator, and record what holds it (space_plan_update waitsOn) or a new date.` });
      }
      states.set(owner, { holds, overdue });
      return lines;
    }
  };
}
