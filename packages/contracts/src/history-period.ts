import { z } from "zod";

/**
 * How far back every history reaches (operator 1/11 03:37 BKK: «Χρονικό διάστημα ιστορικών θα ορίζεται μέσα στις ρυθμίσεις του app και θα
 * είναι μέγιστο 3 μήνες--- θα ισχύει για κάθε ιστορικό»): one user setting, `history.periodDays`, 90 days at most. Every history reads it
 * through `historySince` (and its retention drops what is older): Task runs first (plan clipboard:GA__W4qBxSPR).
 */
export const HISTORY_PERIOD_DAYS = [7, 14, 30, 60, 90] as const;
export type HistoryPeriodDays = typeof HISTORY_PERIOD_DAYS[number];
export const HISTORY_PERIOD_DEFAULT_DAYS: HistoryPeriodDays = 90;
export const historySettingsSchema = z.object({ periodDays: z.literal(HISTORY_PERIOD_DAYS).default(HISTORY_PERIOD_DEFAULT_DAYS) }).strict();
export type HistorySettings = z.infer<typeof historySettingsSchema>;

/** The owner's history period in days (90 when unset or unreadable). */
export function historyPeriodDays(settings: { history?: unknown } | null | undefined): HistoryPeriodDays {
  return historySettingsSchema.safeParse(settings?.history ?? {}).data?.periodDays ?? HISTORY_PERIOD_DEFAULT_DAYS;
}

/** The oldest moment a history shows or keeps for this owner: now minus their history period. */
export function historySince(settings: { history?: unknown } | null | undefined, nowMs = Date.now()): string {
  return new Date(nowMs - historyPeriodDays(settings) * 86_400_000).toISOString();
}
