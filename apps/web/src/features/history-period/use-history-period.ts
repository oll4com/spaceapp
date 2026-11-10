import { useEffect, useState } from "react";
import { HISTORY_PERIOD_DEFAULT_DAYS, historyPeriodDays } from "@space/contracts";
import { api } from "../../api.js";

/** The owner's History period in days (90 until it is read): range pickers offer nothing longer (plan clipboard:8riKjb1krKyL). */
export function useHistoryPeriodDays(): number {
  const [days, setDays] = useState<number>(HISTORY_PERIOD_DEFAULT_DAYS);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => api.userSettings()).then((saved) => { if (live) setDays(historyPeriodDays(saved)); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return days;
}

/** A range such as "10m", "24h" or "30d" fits the period; one that is not a length ("all") fits (the server keeps it inside). */
export function rangeFits(range: string, days: number): boolean {
  const match = /^(\d+)([mhd])$/.exec(range);
  return !match || Number(match[1]) / { m: 1440, h: 24, d: 1 }[match[2] as "m" | "h" | "d"] <= days;
}
