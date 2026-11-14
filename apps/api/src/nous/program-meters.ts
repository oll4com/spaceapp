import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SPACE_AGENT_HOME } from "@space/contracts";
import { readGrantKeys, type GrantKeys } from "../voice-grants.js";
import { LIVEKIT_GRANT_VALID_UNTIL, LIVEKIT_INFERENCE_GRANT_USD, LIVEKIT_STOP_SHARE, liveKitMeter } from "../livekit-meter.js";

/**
 * Used read from the providers for the choose programs Space spends outside the Gateway's own logs (plan clipboard:mmmeF0-e3x4G step 4), laid
 * on the registry like the usage report (importUsage), so the Startup programs page's Used % is measured, never typed. Claude's line comes from
 * the grants pane's measure.py (the Gateway's Anthropic cost report). LiveKit's comes from Space's own LiveKit Inference ledger (livekit-meter.ts):
 * no LiveKit API reports Inference spend (its Analytics API lists room sessions only, and Space joins no room). Cartesia's comes from its usage
 * API with the admin key (`space-cartesia-admin.key`).
 */
/** The MSfS daily Azure check's readings (plan clipboard:dkmX-VVYx-SX): `daily/<day>.json` with the credit left from Azure's balance summary. */
export const AZURE_DAILY_DIR = `${SPACE_AGENT_HOME}/agent-workspace/nous/msfs-150k/daily`;
// shortcut: Microsoft's $5,000 unlocked on 7/11, and Murf's $1,500 counted from the 50,333,143 characters it reported on 13/11 before Space spent
// any ($0.03 per 1,000); read the credit lots' and Murf's own start amounts once Microsoft unlocks M3 or Murf reports a start.
const AZURE_CREDIT_USD = 5_000, MURF_GRANT_USD = 1_500, MURF_START_CHARACTERS = 50_333_143, MURF_USD_PER_CHARACTER = 0.03 / 1_000;
// Cartesia Scale on a 100% coupon from 13/11/2026 to 13/11/2027: 8M credits a month at its $299 list price, renewing on the 13th (unused credits lapse).
const CARTESIA_START = "2026-11-13T00:00:00Z", CARTESIA_END = "2027-11-13", CARTESIA_MONTH_CREDITS = 8_000_000, CARTESIA_MONTH_USD = 299;
const METER_EVERY_MS = 6 * 3_600_000;

const usd = (value: number) => {
  const cents = Math.round(value * 100) / 100;
  return { text: `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, value: cents, currency: "USD" };
};
const credit = (what: string, total: number, used: number, usageAt: string, validUntil: string, source: string, notes: string | null = null, account?: string) => {
  const spent = Math.min(total, Math.max(0, used));
  return { what, ...(account ? { account } : {}), total: usd(total), used: usd(spent), remaining: usd(total - spent), usageAt, validUntil, status: "ACTIVE", source, notes };
};
export type ProgramMeterDocument = { generatedAt: string; entries: Array<{ id: string; benefits: Array<ReturnType<typeof credit>> }> };

async function azure(dir: string) {
  const day = (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().at(-1);
  if (!day) return null;
  const reading = JSON.parse(await readFile(join(dir, day), "utf8")) as { readAt?: string;
    credit?: { leftUsd?: number; expires?: string; burnEurPerDay?: number; runsOutOn?: string | null; outlastsExpiry?: boolean } };
  const left = reading.credit;
  if (typeof left?.leftUsd !== "number" || !reading.readAt || !left.expires) throw new Error(`Azure daily check ${day} has no credit left in USD.`);
  const pace = left.runsOutOn && left.outlastsExpiry === false ? `At €${left.burnEurPerDay} a day it runs out on ${left.runsOutOn}, before it expires.` : null;
  return { id: "microsoft-for-startups", benefits: [credit("Azure credits", AZURE_CREDIT_USD, AZURE_CREDIT_USD - left.leftUsd, reading.readAt, left.expires,
    "Azure balance summary (MSfS daily Azure check, plan clipboard:dkmX-VVYx-SX)", pace)] };
}

async function murf(key: string | undefined, fetcher: typeof fetch, now: number) {
  if (!key) return null;
  // The shortest speech: its answer carries the balance (0 characters consumed when Jack read it, 13/11). Base64, so Murf keeps no audio file.
  const response = await fetcher("https://api.murf.ai/v1/speech/generate", { method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify({ text: "Hi", voiceId: "en-US-natalie", modelVersion: "GEN2", format: "WAV", encodeAsBase64: true }) });
  const answer = await response.json().catch(() => ({})) as { remainingCharacterCount?: unknown };
  if (!response.ok || typeof answer.remainingCharacterCount !== "number") throw new Error(`Murf balance not read: HTTP ${response.status}.`);
  const used = (MURF_START_CHARACTERS - answer.remainingCharacterCount) * MURF_USD_PER_CHARACTER;
  // The registry's own line (what + account), so the reading lands on it instead of adding a second one.
  return { id: "murf-startup-incubator", benefits: [credit("Murf API credits (Startup Incubator grant)", MURF_GRANT_USD, used, new Date(now).toISOString(), "2027-02-03",
    `Murf API balance (${answer.remainingCharacterCount.toLocaleString("en-US")} characters left)`, null, "crew@spaceapp.dev")] };
}

async function cartesia(key: string | undefined, fetcher: typeof fetch, now: number) {
  if (!key) return null;
  const end = new Date(Math.min(now, Date.parse(`${CARTESIA_END}T00:00:00Z`)));
  const query = new URLSearchParams({ start_ts: CARTESIA_START, end_ts: end.toISOString(), interval: "day" });
  const response = await fetcher(`https://api.cartesia.ai/usage/credits?${query}`, { signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${key}`, "Cartesia-Version": "2026-08-14" } });
  const answer = await response.json().catch(() => ({})) as { data?: Array<{ start_ts?: unknown; credits?: unknown }> };
  const days = answer.data;
  if (!response.ok || !Array.isArray(days) || days.some((day) => typeof day.credits !== "number" || typeof day.start_ts !== "string"))
    throw new Error(`Cartesia credits not read: HTTP ${response.status}.`);
  // The billing month runs from the latest 13th (UTC).
  const monthStart = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (end.getUTCDate() < 13 ? 1 : 0), 13);
  const credits = (from: number) => days.filter((day) => Date.parse(day.start_ts as string) >= from).reduce((sum, day) => sum + (day.credits as number), 0);
  const month = credits(monthStart);
  return { id: "cartesia-startup-grant", benefits: [credit("Cartesia Scale plan credits (Sonic/Ink)", 12 * CARTESIA_MONTH_USD,
    credits(0) * CARTESIA_MONTH_USD / CARTESIA_MONTH_CREDITS, end.toISOString(), CARTESIA_END, "Cartesia usage API (credits per day since 13/11/2026)",
    `This billing month (from ${new Date(monthStart).toISOString().slice(0, 10)}): ${month.toLocaleString("en-US")} of ${CARTESIA_MONTH_CREDITS.toLocaleString("en-US")} credits `
    + `(${Math.round((month / CARTESIA_MONTH_CREDITS) * 1000) / 10}%); unused credits lapse at each renewal on the 13th, and overages are off.`)] };
}

async function liveKit(spent: () => Promise<number>, now: number) {
  return { id: "livekit-startup-program", benefits: [credit("LiveKit Inference credits", LIVEKIT_INFERENCE_GRANT_USD, await spent(), new Date(now).toISOString(),
    LIVEKIT_GRANT_VALID_UNTIL, "Space's LiveKit Inference ledger (Live and Video calls, priced at LiveKit's list prices)",
    `Space stops using LiveKit at ${LIVEKIT_STOP_SHARE * 100}% of it, before LiveKit would bill a card.`)] };
}

/** Every meter that answered, as a usage document; one that failed is left out (the line keeps its last reading) and warned once. */
export async function readProgramMeters(deps: { keys?: () => Promise<GrantKeys>; fetch?: typeof fetch; azureDir?: string; now?: () => number; liveKitSpent?: () => Promise<number>;
  warn?(error: unknown, message: string): void } = {}): Promise<ProgramMeterDocument> {
  const now = (deps.now ?? Date.now)();
  const readings = await Promise.allSettled([azure(deps.azureDir ?? AZURE_DAILY_DIR),
    (deps.keys ?? readGrantKeys)().then((keys) => murf(keys.murf, deps.fetch ?? fetch, now)), liveKit(deps.liveKitSpent ?? liveKitMeter.spent, now),
    (deps.keys ?? readGrantKeys)().then((keys) => cartesia(keys.cartesiaAdmin, deps.fetch ?? fetch, now))]);
  for (const reading of readings) if (reading.status === "rejected") deps.warn?.(reading.reason, "A startup program meter failed.");
  return { generatedAt: new Date(now).toISOString(), entries: readings.flatMap((reading) => reading.status === "fulfilled" && reading.value ? [reading.value] : []) };
}

/** After each programs import: the meters read every 6 hours, their lines laid on again whenever a programs file rewrote the benefit lines. */
export function createProgramMeters(deps: { importUsage(document: ProgramMeterDocument): Promise<{ problems: string[] }>; read?: () => Promise<ProgramMeterDocument>;
  now?: () => number; warn?(error: unknown, message: string): void }) {
  let last: { at: number; document: ProgramMeterDocument } | null = null;
  return async (results: Array<{ page: string }>) => {
    const at = (deps.now ?? Date.now)();
    const fresh = !last || at - last.at >= METER_EVERY_MS;
    if (fresh) last = { at, document: await (deps.read ?? (() => readProgramMeters({ warn: deps.warn })))() };
    if (!fresh && !results.some((result) => result.page !== "usage")) return;
    const { problems } = await deps.importUsage(last!.document);
    if (problems.length) deps.warn?.(new Error(problems.join("\n")), "Startup program meters not laid on.");
  };
}
