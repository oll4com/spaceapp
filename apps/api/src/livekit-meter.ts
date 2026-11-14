import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * LiveKit Inference use Space makes (the Live grant bridge and the Video engine; plan clipboard:mmmeF0-e3x4G step 4), one priced JSON
 * line per call: no LiveKit API reports Inference spend (Analytics lists room sessions only). The Startup programs page's LiveKit Used
 * line is this ledger's sum, and Space stops using LiveKit before the grant runs out, because LiveKit bills a card past it.
 */
export const LIVEKIT_LEDGER = process.env.SPACE_LIVEKIT_LEDGER
  || (process.env.SPACE_INSTANCE === "dev" ? `${SPACE_INSTALL_ROOT}-dev/var/livekit-inference.jsonl` : `${SPACE_INSTALL_ROOT}/var/livekit-inference.jsonl`);
// shortcut: LiveKit's Build/Ship list prices of 13/11 (livekit.com/pricing/inference): Nova-3 multilingual $0.0058/min and every voice at the
// highest listed $50 per 1M characters, so the meter counts more than the Scale plan bills, never less; read LiveKit's invoice once it shows Inference.
export const LIVEKIT_STT_USD_PER_MINUTE = 0.0058, LIVEKIT_TTS_USD_PER_CHARACTER = 50 / 1_000_000;
export const LIVEKIT_INFERENCE_GRANT_USD = 7_000, LIVEKIT_GRANT_VALID_UNTIL = "2027-11-07";
/** Billing safety (a technical bound): LiveKit bills a card past the grant, so Space stops at 95% of it; the 5% covers price drift and calls in flight. */
export const LIVEKIT_STOP_SHARE = 0.95;

export type LiveKitUse = { source: "live" | "video"; kind: "stt" | "tts"; model: string; seconds?: number; characters?: number };
export const priceLiveKitUse = (use: LiveKitUse) =>
  use.kind === "stt" ? Math.max(0, use.seconds ?? 0) / 60 * LIVEKIT_STT_USD_PER_MINUTE : Math.max(0, use.characters ?? 0) * LIVEKIT_TTS_USD_PER_CHARACTER;

export type LiveKitMeter = { record(use: LiveKitUse): Promise<void>; spent(): Promise<number>; open(): Promise<boolean> };
export function createLiveKitMeter(path = LIVEKIT_LEDGER, now: () => number = Date.now): LiveKitMeter {
  let spent: number | null = null;
  const sum = async () => spent ??= (await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })).split("\n").reduce((total, line) => {
    try { return total + (Number((JSON.parse(line) as { usd?: unknown }).usd) || 0); } catch { return total; /* a torn or empty line */ }
  }, 0);
  return {
    async record(use) {
      const usd = priceLiveKitUse(use);
      if (usd <= 0) return;
      const before = await sum();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify({ at: new Date(now()).toISOString(), ...use, usd })}\n`);
      spent = before + usd;
    },
    spent: sum,
    // An unreadable ledger closes LiveKit: an unknown spend must never reach the card.
    open: async () => now() < Date.parse(`${LIVEKIT_GRANT_VALID_UNTIL}T00:00:00Z`)
      && await sum().then((usd) => usd < LIVEKIT_INFERENCE_GRANT_USD * LIVEKIT_STOP_SHARE, () => false)
  };
}
export const liveKitMeter = createLiveKitMeter();
export const LIVEKIT_GRANT_CLOSED = "Space stopped using the LiveKit Inference grant: 95% of it is metered as spent or it expired, and LiveKit would bill a card past it.";
