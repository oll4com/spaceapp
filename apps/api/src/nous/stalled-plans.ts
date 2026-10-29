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
  /** What it waits on when that is not Nous's to nudge (plan-map.ts `stalledHold`: a date, another plan, the server); never stalled then. */
  hold: string | null;
}

/** The plan's status and step statuses as one string: a change counts as movement like a percentage change. */
export function planFingerprint(plan: Pick<ClipboardItem, "executionStatus" | "steps">): string {
  return `${plan.executionStatus ?? ""}|${[...(plan.steps ?? [])].sort((left, right) => left.order - right.order).map((step) => `${step.order}:${step.status}`).join(",")}`;
}

const minute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
export const hoursText = (hours: number) => `${Math.round(hours * 10) / 10} h`;
const oneLine = (text: string, max: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

export async function nousPlanActivity(input: {
  owner: string; plans: ClipboardItem[]; samples: Array<{ sample: DashboardAgentsSample | null }>; marks: NousPlanMarksRepository;
  /** The newest report of each pane (pane-reports.ts). */
  reports?: PaneReport[];
  executions?: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>;
  held?: (planId: string) => string | null;
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
    const unknown = Boolean(plan.paneId && !holder && input.samples.some(({ sample }) => sample === null));
    const pane = open ? { label: open.paneName ?? open.title, state: holder!.sample!.activity[open.id] ?? null, since: holder!.sample!.details[open.id]?.since ?? null } : null;
    const report = open ? reports.get(open.id) ?? null : null;
    const waited = pane?.state === "waiting" ? hoursSince(pane.since) : 0;
    const silent = pane?.state === "working" ? Math.min(hoursSince(pane.since), hoursSince(report?.at ?? pane.since)) : 0;
    const hold = input.held?.(plan.id) ?? null;
    const reason = unknown || hold ? null
      : hours >= stalledHours ? `unchanged ${hoursText(hours)}`
      : !pane ? "no open pane"
      : waited >= NOUS_STALLED_WAITING_HOURS ? `pane waiting ${hoursText(waited)}`
      : silent >= NOUS_STALLED_SILENT_HOURS ? `pane working with no report for ${hoursText(silent)}` : null;
    return { planId: plan.id, title: plan.title ?? plan.text.slice(0, 80), status: plan.executionStatus ?? "IN_PROGRESS", percent: plan.progressPercentage,
      nextStep: nextPlanStep(plan), changedAt, hours, pane,
      lastReport: report ? `${report.at.slice(11, 16)} UTC ${report.status.toLowerCase().replace(/_/g, " ")}: "${oneLine(report.summary, 160)}"` : null,
      managed: managedPlans.has(plan.id), lastNudgedAt: mark?.lastNudgedAt ?? null, stalled: reason !== null, reason, hold };
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
      + (item.managed ? " · managed by plan execution: do not change its steps, nudge only its pane" : ""))].join("\n");
}
