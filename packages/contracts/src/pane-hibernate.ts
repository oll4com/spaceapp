import { z } from "zod";

/**
 * Sleeping panes (operator 13/11 14:47 BKK, plan clipboard:YqhRIXfLAnfK decision Α): an idle CLI pane's process stops after this many
 * minutes and its next message resumes the same conversation natively. 0 turns it off; unset reads as 30.
 */
export const PANE_HIBERNATE_MINUTES = [0, 15, 30, 60, 120, 240] as const;
export type PaneHibernateMinutes = typeof PANE_HIBERNATE_MINUTES[number];
export const PANE_HIBERNATE_DEFAULT_MINUTES: PaneHibernateMinutes = 30;
export const paneHibernateSettingsSchema = z.object({ minutes: z.literal(PANE_HIBERNATE_MINUTES).default(PANE_HIBERNATE_DEFAULT_MINUTES) }).strict();

/** The owner's idle minutes before a pane sleeps (30 when unset or unreadable, 0 = never). */
export function paneHibernateMinutes(settings: { paneHibernate?: unknown } | null | undefined): PaneHibernateMinutes {
  return paneHibernateSettingsSchema.safeParse(settings?.paneHibernate ?? {}).data?.minutes ?? PANE_HIBERNATE_DEFAULT_MINUTES;
}

/** The status reason a slept pane's last session keeps; the next message resumes a session whose reason starts with it. */
export const PANE_HIBERNATED_REASON = "Sleeping: idle, stopped to save memory; the next message resumes this conversation.";
export const isHibernatedSession = (session: { status: string; statusReason?: string | null } | null | undefined) =>
  session?.status === "EXITED" && Boolean(session.statusReason?.startsWith("Sleeping:"));
