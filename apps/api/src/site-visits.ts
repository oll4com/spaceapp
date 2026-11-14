import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SPACE_INSTALL_ROOT, type NousSiteFunnel, type NousSiteRow } from "@space/contracts";

/**
 * spaceapp.dev's anonymous page views (plan clipboard:hGoTZ_XwCuXn, section 6): visit.php writes one JSON line per send into a file per UTC day
 * and deletes the days past 90; ~/scripts/spaceapp_install_pings_sync.sh mirrors the folder here (rsync --delete, so the deletion follows).
 * Space reads it and deletes nothing.
 */
export const SITE_VISITS_DIR = `${SPACE_INSTALL_ROOT}/var/inventory/site-visits`;

type Visit = { t: string; p: string; id: string; n: number; w?: string; act?: number; sc?: number; fp?: string; r?: string; src?: string;
  sec?: string; ck?: string; last?: string; ev?: string; out?: string; c?: string; internal?: boolean };

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
};
const pairs = (list: string | undefined) => (list ? list.split(",").map((entry) => { const [key, value] = entry.split(":"); return [key!, Number(value) || 0] as const; }) : []);

/** Every view of the period from the day files' lines: the last send of each visit id, internal ones counted apart. */
export function summarizeSiteVisits(log: string, since: string, updatedAt: string | null = null): NousSiteFunnel {
  const byId = new Map<string, Visit>();
  for (const line of log.split("\n")) {
    let visit: Visit;
    try { visit = JSON.parse(line) as Visit; } catch { continue; }
    if (!visit || typeof visit.id !== "string" || typeof visit.p !== "string" || typeof visit.t !== "string" || visit.t < since) continue;
    const held = byId.get(visit.id);
    if (!held || (visit.n ?? 0) >= (held.n ?? 0)) byId.set(visit.id, visit);
  }
  const all = [...byId.values()];
  const views = all.filter((visit) => !visit.internal);
  // Views counted per key (a view may give several keys, as its actions); every key kept, most views first.
  const grouped = (keys: (visit: Visit) => Array<string | undefined>, seconds?: (visit: Visit) => number | undefined): NousSiteRow[] => {
    const groups = new Map<string, number[]>();
    for (const visit of views) {
      for (const name of keys(visit)) if (name) groups.set(name, [...(groups.get(name) ?? []), seconds?.(visit) ?? Number.NaN]);
    }
    return [...groups].map(([name, list]) => ({ key: name, views: list.length, medianSeconds: seconds ? median(list.filter(Number.isFinite)) : null }))
      .sort((a, b) => b.views - a.views || a.key.localeCompare(b.key));
  };
  const visible = (visit: Visit) => (typeof visit.act === "number" ? Math.round(visit.act / 1000) : undefined);

  // Homepage sections, in the order visitors met them (their mean position in each view's own order).
  const home = views.filter((visit) => visit.p === "/");
  const sections = new Map<string, { positions: number[]; seconds: number[]; exits: number; clicks: number }>();
  const entry = (id: string) => sections.get(id) ?? sections.set(id, { positions: [], seconds: [], exits: 0, clicks: 0 }).get(id)!;
  for (const visit of home) {
    pairs(visit.sec).forEach(([id, seconds], index) => { entry(id).positions.push(index); entry(id).seconds.push(seconds); });
    for (const [id, clicks] of pairs(visit.ck)) entry(id).clicks += clicks;
    if (visit.last && !visit.out?.startsWith("in:")) entry(visit.last).exits += 1;
  }
  const mean = (list: number[]) => (list.length ? list.reduce((total, value) => total + value, 0) / list.length : Number.POSITIVE_INFINITY);

  return {
    updatedAt, since, views: views.length, internal: all.length - views.length,
    installIntent: views.filter((visit) => visit.p.startsWith("/install") || (visit.ev?.split(",") ?? []).includes("install_copy")).length,
    sections: [...sections].sort(([, a], [, b]) => mean(a.positions) - mean(b.positions))
      .map(([id, value]) => ({ id, reached: value.seconds.length, medianSeconds: median(value.seconds), exits: value.exits, clicks: value.clicks })),
    pages: grouped((visit) => [visit.p], visible).map((row) => {
      const list = views.filter((visit) => visit.p === row.key);
      return { ...row, medianDepth: median(list.flatMap((visit) => (typeof visit.sc === "number" ? [visit.sc] : []))), leftSite: list.filter((visit) => !visit.out?.startsWith("in:")).length };
    }),
    referrers: grouped((visit) => [visit.r]),
    sources: grouped((visit) => [visit.src]),
    countries: grouped((visit) => [visit.c]),
    screens: grouped((visit) => [visit.w]),
    next: grouped((visit) => [visit.fp ? `${visit.fp} → ${visit.p}` : undefined]),
    actions: grouped((visit) => visit.ev?.split(",") ?? [])
  };
}

/** The period's day files (named YYYY-MM-DD.log) read together; null when the folder was never synced here. */
export async function readSiteVisits(since: string, dir = SITE_VISITS_DIR): Promise<NousSiteFunnel | null> {
  const names = await readdir(dir).catch(() => null);
  if (names === null) return null;
  const days = names.filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name) && name.slice(0, 10) >= since.slice(0, 10)).sort();
  const [texts, info] = await Promise.all([Promise.all(days.map((name) => readFile(join(dir, name), "utf8").catch(() => ""))),
    days.length ? stat(join(dir, days.at(-1)!)).catch(() => null) : Promise.resolve(null)]);
  return summarizeSiteVisits(texts.join("\n"), since, info?.mtime.toISOString() ?? null);
}
