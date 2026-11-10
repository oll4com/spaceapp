import type { ClipboardItem, ManagedPlanExecution } from "@space/contracts";
import type { NousPlanMarksRepository, PaneReport } from "@space/db";
import type { DashboardAgentsSample } from "../room-routes.js";
import { nextPlanStep } from "./digest.js";

/**
 * Stalled plans (plan clipboard:8s0ZNiO3q5ZT S4; standing orders 2026-10-21): for every open plan, when it last moved (its
 * percentage or a step's status, tracked in nous_plan_marks) and its pane's state. A plan is STALLED when it has not moved for
 * `stalledHours` (3 by default) whatever its pane does, when no open pane works on it, when its pane has waited an hour, or
 * when its pane works with no report for two hours. Space brings every stalled plan to Nous in a STANDING turn
 * (standing-orders.ts), one nudge per plan per stalled window. A room whose panes could not be read is unknown, never stalled.
 */
export const NOUS_STALLED_PLAN_HOURS = 3;
export const NOUS_STALLED_WAITING_HOURS = 1;
export const NOUS_STALLED_SILENT_HOURS = 2;
const HOUR_MS = 3_600_000;

export interface NousPlanActivity {
  planId: string; title: string; status: string; percent: number; nextStep: string | null;
  /** When the plan last moved (percentage or step statuses). */
  changedAt: string; hours: number;
  /** The pane working on it: null when no open pane does; its state is null when the room could not be read. */
  pane: { label: string; state: string | null; since: string | null } | null;
  /** The pane's newest report, "HH:MM UTC status: summary". */
  lastReport: string | null;
  /** Its progress is controlled by a managed plan execution: Nous nudges only its pane. */
  managed: boolean;
  lastNudgedAt: string | null;
  stalled: boolean;
  /** Why it is stalled, null when it is not. */
  reason: string | null;
  /** What it waits on when that is not Nous's to nudge (plan-map.ts `stalledHold`: a date, another plan, the server); never stalled then, unless one of
   *  its steps can run (`openStep`), its pane does not work and no hard server hold is on. */
  hold: string | null;
  /** Its first step that can run: PENDING or IN_PROGRESS, never one marked BLOCKED; null when none. */
  openStep: string | null;
  /** R57: its open pane is idle or done and `openStep` can run (no hard server hold on a held plan, no managed execution sending it): the 90 % push hands it the step before the plan stalls. */
  ready: boolean;
}

/** A plan's first step that is not done and not marked BLOCKED, as "N. title (STATUS)". */
export function openPlanStep(plan: Pick<ClipboardItem, "steps">): string | null {
  const step = [...(plan.steps ?? [])].sort((left, right) => left.order - right.order).find((entry) => entry.status === "PENDING" || entry.status === "IN_PROGRESS");
  return step ? `${step.order}. ${oneLine(step.title, 120)} (${step.status})` : null;
}

/** The plan's status and step statuses as one string: a change counts as movement like a percentage change. */
export function planFingerprint(plan: Pick<ClipboardItem, "executionStatus" | "steps">): string {
  return `${plan.executionStatus ?? ""}|${[...(plan.steps ?? [])].sort((left, right) => left.order - right.order).map((step) => `${step.order}:${step.status}`).join(",")}`;
}

const minute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
export const hoursText = (hours: number) => `${Math.round(hours * 10) / 10} h`;
const oneLine = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

export async function nousPlanActivity(input: {
  owner: string; plans: ClipboardItem[]; samples: Array<{ room?: { id: string }; sample: DashboardAgentsSample | null }>; marks: NousPlanMarksRepository;
  /** The newest report of each pane (pane-reports.ts). */
  reports?: PaneReport[];
  executions?: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>;
  held?: (planId: string) => string | null;
  /** A hard server hold (merge queue paused or down, plan controller off: plan-map.ts HARD_HOLDS) is on: every held plan stays held. */
  hardHold?: boolean;
  stalledHours?: number; now?: Date;
}): Promise<NousPlanActivity[]> {
  const now = input.now ?? new Date();
  const stalledHours = input.stalledHours ?? NOUS_STALLED_PLAN_HOURS;
  const reports = new Map((input.reports ?? []).map((report) => [report.paneId, report]));
  const managedPlans = new Set((input.executions ?? []).map((execution) => execution.planId));
  const marks = await input.marks.observe(input.owner, input.plans.map((plan) =>
    ({ planId: plan.id, percent: plan.progressPercentage, since: plan.lastProgressAt ?? plan.createdAt, fingerprint: planFingerprint(plan) })), now);
  const hoursSince = (iso: string | null) => iso ? Math.max(0, (now.getTime() - Date.parse(iso)) / HOUR_MS) : 0;
  return input.plans.map((plan) => {
    const mark = marks.get(plan.id);
    const changedAt = mark?.changedAt ?? plan.lastProgressAt ?? plan.createdAt;
    const hours = hoursSince(changedAt);
    const holder = plan.paneId ? input.samples.find(({ sample }) => sample?.data.some((pane) => pane.id === plan.paneId && !pane.isClosed)) : undefined;
    const open = holder?.sample?.data.find((pane) => pane.id === plan.paneId);
    // Unknown only when the plan's own room could not be read (operator 3/11 23:11 BKK: one unreadable room hid every plan whose pane had closed).
    const unknown = Boolean(plan.paneId && !holder && input.samples.some(({ room, sample }) => sample === null && (!room || !plan.roomId || room.id === plan.roomId)));
    const pane = open ? { label: open.paneName ?? open.title, state: holder!.sample!.activity[open.id] ?? null, since: holder!.sample!.details[open.id]?.since ?? null } : null;
    const report = open ? reports.get(open.id) ?? null : null;
    const waited = pane?.state === "waiting" ? hoursSince(pane.since) : 0;
    const silent = pane?.state === "working" ? Math.min(hoursSince(pane.since), hoursSince(report?.at ?? pane.since)) : 0;
    const hold = input.held?.(plan.id) ?? null;
    const openStep = openPlanStep(plan);
    // Operator 1/11 23:05 and 3/11 23:11 BKK (10 plans "Not on a pane" for hours, 6 of them behind a dependsOn, the rest behind a closed pane's
    // board line or an unreadable room): no wait on the whole plan (recorded, another plan, its pane's board or report) hides a step that can
    // run while no pane works on it. Only a hard server hold, or a plan with no runnable step (the waiting ones marked BLOCKED), stays held.
    const hidden = hold !== null && (input.hardHold === true || !openStep || pane?.state === "working");
    const reason = unknown || hidden ? null
      : hours >= stalledHours ? `unchanged ${hoursText(hours)}`
      : !pane ? "no open pane"
      : waited >= NOUS_STALLED_WAITING_HOURS ? `pane waiting ${hoursText(waited)}`
      : silent >= NOUS_STALLED_SILENT_HOURS ? `pane working with no report for ${hoursText(silent)}` : null;
    return { planId: plan.id, title: plan.title ?? plan.text.slice(0, 80), status: plan.executionStatus ?? "IN_PROGRESS", percent: plan.progressPercentage,
      nextStep: openStep ?? nextPlanStep(plan), changedAt, hours, pane,
      lastReport: report ? `${report.at.slice(11, 16)} UTC ${report.status.toLowerCase().replace(/_/g, " ")}: "${oneLine(report.summary, Infinity)}"` : null,
      managed: managedPlans.has(plan.id), lastNudgedAt: mark?.lastNudgedAt ?? null, stalled: reason !== null, reason, hold, openStep,
      ready: !hidden && openStep !== null && (pane?.state === "idle" || pane?.state === "done") && !managedPlans.has(plan.id) };
  });
}

const paneText = (item: NousPlanActivity) => item.pane
  ? `pane ${item.pane.label} ${item.pane.state ?? "state unknown"}${item.pane.since ? ` since ${minute(item.pane.since)}` : ""}` : "no open pane";

/** The world's section: one line per open plan. */
export function renderNousPlanActivity(items: NousPlanActivity[]): string {
  if (!items.length) return "";
  return ["## Plan activity (when each open plan last moved, and its pane; STALLED plans come to you in Standing orders turns)",
    ...items.map((item) => `- "${oneLine(item.title, 100)}" ${item.percent}%: unchanged ${hoursText(item.hours)} (since ${minute(item.changedAt)}); ${paneText(item)}`
      + (item.stalled ? ` — STALLED (${item.reason})` : "") + (item.hold ? ` — ${item.hold}` : "") + (item.managed ? " · managed by plan execution" : ""))].join("\n");
}

/** The stalled plans of a STANDING turn, in full (the turn is its own: no world cut or inbox clip touches it). */
export function renderStandingPlansPrompt(items: NousPlanActivity[]): string {
  const stalled = items.filter((item) => item.stalled);
  if (!stalled.length) return "";
  return [`## Stalled plans (operator rule: every open plan moves to 100%; take exactly one concrete action per plan now)`,
    ...stalled.map((item) => `- [${item.planId}] "${oneLine(item.title, 100)}" ${item.status} ${item.percent}% · unchanged ${hoursText(item.hours)} (since ${minute(item.changedAt)})`
      + `${item.nextStep ? ` · next: ${item.nextStep}` : ""} · ${paneText(item)}${item.lastReport ? ` · last report ${item.lastReport}` : ""} · STALLED: ${item.reason}`
      + (item.hold ? ` · its plan ${item.hold}: that wait covers only the steps it names; run the next step that needs no one, or mark the waiting steps BLOCKED` : "")
      + (item.managed ? " · managed by plan execution: do not change its steps, nudge only its pane" : ""))].join("\n");
}
