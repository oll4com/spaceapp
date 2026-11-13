import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SPACE_AGENT_HOME } from "@space/contracts";
import { readGrantKeys, type GrantKeys } from "../voice-grants.js";

/**
 * Used read from the providers for the choose programs Space spends outside the Gateway's own logs (plan clipboard:mmmeF0-e3x4G step 4), laid
 * on the registry like the usage report (importUsage), so the Startup programs page's Used % is measured, never typed. Claude's line comes from
 * the grants pane's measure.py (the Gateway's Anthropic cost report). LiveKit is not read: Space spends it through LiveKit Inference, which no
 * LiveKit API reports (its Analytics API lists room sessions only, and Space joins no room).
 */
/** The MSfS daily Azure check's readings (plan clipboard:dkmX-VVYx-SX): `daily/<day>.json` with the credit left from Azure's balance summary. */
export const AZURE_DAILY_DIR = `${SPACE_AGENT_HOME}/agent-workspace/nous/msfs-150k/daily`;
// shortcut: Microsoft's $5,000 unlocked on 7/11, and Murf's $1,500 counted from the 50,333,143 characters it reported on 13/11 before Space spent
// any ($0.03 per 1,000); read the credit lots' and Murf's own start amounts once Microsoft unlocks M3 or Murf reports a start.
const AZURE_CREDIT_USD = 5_000, MURF_GRANT_USD = 1_500, MURF_START_CHARACTERS = 50_333_143, MURF_USD_PER_CHARACTER = 0.03 / 1_000;
const METER_EVERY_MS = 6 * 3_600_000;

const usd = (value: number) => {
  const cents = Math.round(value * 100) / 100;
  return { text: `$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, value: cents, currency: "USD" };
};
const credit = (what: string, total: number, used: number, usageAt: string, validUntil: string, source: string, notes: string | null = null) => {
  const spent = Math.min(total, Math.max(0, used));
  return { what, total: usd(total), used: usd(spent), remaining: usd(total - spent), usageAt, validUntil, status: "ACTIVE", source, notes };
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
  return { id: "murf-startup-incubator", benefits: [credit("Murf API credits", MURF_GRANT_USD, used, new Date(now).toISOString(), "2027-02-03",
    `Murf API balance (${answer.remainingCharacterCount.toLocaleString("en-US")} characters left)`)] };
}

/** Every meter that answered, as a usage document; one that failed is left out (the line keeps its last reading) and warned once. */
export async function readProgramMeters(deps: { keys?: () => Promise<GrantKeys>; fetch?: typeof fetch; azureDir?: string; now?: () => number;
  warn?(error: unknown, message: string): void } = {}): Promise<ProgramMeterDocument> {
  const now = (deps.now ?? Date.now)();
  const readings = await Promise.allSettled([azure(deps.azureDir ?? AZURE_DAILY_DIR),
    (deps.keys ?? readGrantKeys)().then((keys) => murf(keys.murf, deps.fetch ?? fetch, now))]);
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
