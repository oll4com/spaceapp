import type { ClipboardItem } from "@space/contracts";
import type { NousPlanMarksRepository } from "@space/db";
import type { DashboardAgentsSample } from "../room-routes.js";

/**
 * Stalled plans (plan clipboard:8s0ZNiO3q5ZT S4): for every open plan, when its percentage last changed and its pane's
 * state and since when, so Nous sees a plan that stopped moving; the heartbeat names plans unchanged 6+ hours whose pane
 * is idle (or that no open pane works on).
 */
export const NOUS_STALLED_PLAN_HOURS = 6;
const HOUR_MS = 3_600_000;

export interface NousPlanActivity {
  planId: string; title: string; percent: number;
  /** When the percentage last changed. */
  changedAt: string; hours: number;
  /** The pane working on it: null when no open pane does; its state is null when the room could not be read. */
  pane: { label: string; state: string | null; since: string | null } | null;
  stalled: boolean;
}

export async function nousPlanActivity(input: {
  owner: string; plans: ClipboardItem[]; samples: Array<{ sample: DashboardAgentsSample | null }>; marks: NousPlanMarksRepository; now?: Date;
}): Promise<NousPlanActivity[]> {
  const now = input.now ?? new Date();
  const changed = await input.marks.observe(input.owner, input.plans.map((plan) =>
    ({ planId: plan.id, percent: plan.progressPercentage, since: plan.lastProgressAt ?? plan.createdAt })), now);
  return input.plans.map((plan) => {
    const changedAt = changed.get(plan.id) ?? plan.lastProgressAt ?? plan.createdAt;
    const hours = Math.max(0, (now.getTime() - Date.parse(changedAt)) / HOUR_MS);
    const holder = plan.paneId ? input.samples.find(({ sample }) => sample?.data.some((pane) => pane.id === plan.paneId)) : undefined;
    const open = holder?.sample?.data.find((pane) => pane.id === plan.paneId);
    // A room whose panes could not be read is unknown, never stalled.
    const unknown = Boolean(plan.paneId && !holder && input.samples.some(({ sample }) => sample === null));
    const pane = open ? { label: open.paneName ?? open.title, state: holder!.sample!.activity[open.id] ?? null, since: holder!.sample!.details[open.id]?.since ?? null } : null;
    const idle = pane ? pane.state === "idle" || pane.state === "done" : !unknown;
    return { planId: plan.id, title: plan.title ?? plan.text.slice(0, 80), percent: plan.progressPercentage, changedAt, hours, pane,
      stalled: idle && hours >= NOUS_STALLED_PLAN_HOURS };
  });
}

const minute = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const hoursText = (hours: number) => `${Math.round(hours * 10) / 10} h`;
const paneText = (item: NousPlanActivity) => item.pane
  ? `pane ${item.pane.label} ${item.pane.state ?? "state unknown"}${item.pane.since ? ` since ${minute(item.pane.since)}` : ""}` : "no open pane";

/** The world's section: one line per open plan. */
export function renderNousPlanActivity(items: NousPlanActivity[]): string {
  if (!items.length) return "";
  return ["## Plan activity (when each open plan's % last changed, and its pane)",
    ...items.map((item) => `- "${item.title.replace(/\s+/g, " ").slice(0, 100)}" ${item.percent}%: unchanged ${hoursText(item.hours)} (since ${minute(item.changedAt)}); ${paneText(item)}`
      + (item.stalled ? " — STALLED" : ""))].join("\n");
}

/** The heartbeat's line naming stalled plans, null when none. */
export function nousStalledPlansLine(items: NousPlanActivity[]): string | null {
  const stalled = items.filter((item) => item.stalled);
  if (!stalled.length) return null;
  return `Stalled ${NOUS_STALLED_PLAN_HOURS}+ h with an idle pane: ${stalled.map((item) => `"${item.title.replace(/\s+/g, " ").slice(0, 80)}" (${hoursText(item.hours)}, ${paneText(item)})`).join("; ")}.`;
}
