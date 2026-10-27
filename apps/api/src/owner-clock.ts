import { ownerWorkingTimeZone, resolveNotificationSettings, type UserSettings } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

type OwnerSettings = Pick<UserSettings, "dateTime" | "notifications"> | null | undefined;

/**
 * The owner's working time zone (Settings → Date & time) and their local time now, as one line for an agent's turn
 * context (plan clipboard:ubQLgcTtQWA_): agents write times to the operator in their zone, never in UTC or Athens time.
 */
export async function ownerClockLine(store: Pick<SpaceStore, "getUserSettings">, owner: string, now = new Date()): Promise<string> {
  const timeZone = ownerWorkingTimeZone(await store.getUserSettings(owner));
  const local = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(now);
  return `The operator's working time zone is ${timeZone}; their local time now is ${local}. Write every time to them in this zone.`;
}

/** The operator's quiet hours now (plan clipboard:9XSwTPyxXP1W): their local time, whether it is their night, and when it ends. */
export interface OwnerQuietState {
  timeZone: string;
  /** "Tue 20 Oct 00:44 ICT" */
  local: string;
  quiet: boolean;
  /** When the current quiet hours end (ISO); null outside them or with quiet hours off. */
  wakeAt: string | null;
  /** "09:00 ICT" */
  wakeLocal: string | null;
  enabled: boolean;
  /** The owner set a working time zone; without one Space cannot know their night and holds nothing. */
  zoneSet: boolean;
  start: string;
  end: string;
}

const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

function localParts(now: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(now).map((part) => [part.type, part.value]));
  return { label: `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`, zone: parts.timeZoneName ?? timeZone,
    minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function ownerQuietState(settings: OwnerSettings, now = new Date()): OwnerQuietState {
  const timeZone = ownerWorkingTimeZone(settings);
  const zoneSet = settings?.dateTime?.timeZone === timeZone;
  const { enabled, start, end } = resolveNotificationSettings(settings?.notifications ?? null).quietHours;
  const local = localParts(now, timeZone);
  const [from, to, at] = [minutesOf(start), minutesOf(end), local.minutes];
  // Across midnight (23:00-09:00) or within a day (13:00-15:00); equal start and end means no quiet hours.
  const quiet = enabled && zoneSet && from !== to && (from > to ? at >= from || at < to : at >= from && at < to);
  // shortcut: the wake time adds the local minutes left to now, so a DST change during the night shifts it by that hour; fine for DST-free zones (Asia/Bangkok).
  const wake = quiet ? new Date(now.getTime() - (now.getTime() % 60_000) + (((to - at + 1440) % 1440) || 1440) * 60_000) : null;
  return { timeZone, local: local.label, quiet, wakeAt: wake?.toISOString() ?? null, wakeLocal: wake ? `${end} ${local.zone}` : null, enabled, zoneSet, start, end };
}

export const isOwnerQuietTime = (settings: OwnerSettings, now = new Date()) => ownerQuietState(settings, now).quiet;

/** When the operator's next quiet hours end: tonight's (or this night's) end; null with quiet hours off. */
export function nextOwnerWakeTime(settings: OwnerSettings, now = new Date()): Date | null {
  const state = ownerQuietState(settings, now);
  if (state.wakeAt) return new Date(state.wakeAt);
  if (!state.enabled || !state.zoneSet || state.start === state.end) return null;
  const local = localParts(now, state.timeZone).minutes;
  const untilStart = ((minutesOf(state.start) - local + 1440) % 1440) || 1440;
  return new Date(ownerQuietState(settings, new Date(now.getTime() - (now.getTime() % 60_000) + untilStart * 60_000)).wakeAt!);
}

/** Nous's world first line: "Operator's time: Tue 20 Oct 00:44 ICT (night, quiet until 09:00 ICT)". */
export function ownerTimeHeader(state: OwnerQuietState): string {
  const mode = state.quiet ? `night, quiet until ${state.wakeLocal}: hand requests wait for the morning batch`
    : !state.zoneSet ? "no working time zone set, so quiet hours cannot apply" : state.enabled ? `day; quiet hours ${state.start}-${state.end}` : "quiet hours off";
  return `Operator's time: ${state.local} (${mode})`;
}

/** What an agent asking for the operator's hands is told (handoff and needs-you answers). */
export function ownerHandsAnswer(state: OwnerQuietState): { localTime: string; quiet: boolean; heldUntil: string | null; note: string } {
  return { localTime: state.local, quiet: state.quiet, heldUntil: state.wakeAt,
    note: state.quiet ? `It is night for the operator (${state.local}): held until ${state.wakeLocal}. Keep the work ready and continue other work.`
      : `The operator's local time is ${state.local}.` };
}

/** A browser handoff's lifetime: 30 minutes by day; at night until an hour after the operator's morning (at most 16 hours). */
export function handoffTtlSeconds(state: Pick<OwnerQuietState, "wakeAt">, now = Date.now()): number {
  return state.wakeAt ? Math.min(57_600, Math.max(1800, Math.ceil((Date.parse(state.wakeAt) - now) / 1000) + 3600)) : 1800;
}

/** The answer for an agent that just asked for the operator's hands, read from the owner's settings now. */
export async function operatorHands(store: Pick<SpaceStore, "getUserSettings">, owner: string, now = new Date()) {
  return ownerHandsAnswer(ownerQuietState(await store.getUserSettings(owner), now));
}
