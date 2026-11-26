import { z } from "zod";
import { gatewayResetGrantsText, gatewayWeekResetCredits, quotaResetCredits, quotaResetCreditsText, type GatewayAccount } from "@space/contracts";
import { CODEX_RESET_MANUAL_LEFT, codexResetRefusal, codexResetState, type CodexResetState } from "../codex-reset-guard.js";

/**
 * Codex and Claude reset credits for Nous, read only (brief 20261102-codex-reset-credits; Claude limit resets operator 14/11 11:06 BKK):
 * space_codex_reset_credits lists each account's credits with its windows, and Nous counts them as room when it plans work.
 * Only the operator spends one, with the Resources button (operator 14/11 «Τα reset τα κανω μονο εγω!!!»): no Nous tool, helper,
 * agent action or automatic tick spends a credit.
 */
export const nousResetCreditsArgsSchema = z.object({});

type Outcome = { ok: boolean; display: string; result: string };

const RESET_PROVIDERS: readonly GatewayAccount["provider"][] = ["CODEX", "CLAUDE"];
export const codexPoolAccounts = (accounts: GatewayAccount[]) => accounts.filter((account) => RESET_PROVIDERS.includes(account.provider)
  && !["PAUSED", "DEACTIVATED"].includes(account.status));

export function codexResetLine(state: CodexResetState, now: number, time: (iso: string) => string): string {
  const window = (label: string, entry: CodexResetState["week"]) => entry ? `${label} ${Math.round(entry.left)}% left${entry.resetAt ? `, resets ${time(entry.resetAt)}` : ""}` : `${label} no current sample`;
  const refusal = codexResetRefusal(state, now, CODEX_RESET_MANUAL_LEFT, time);
  const credits = state.grants ? gatewayResetGrantsText(state.grants) || "no reset grant" : `${state.credits} credit${state.credits === 1 ? "" : "s"}`;
  return `${state.name} [${state.id}${state.provider === "CLAUDE" ? ", Claude" : ""}]: ${credits}; ${window("week", state.week)}; ${window("5-hour", state.fiveHour)}`
    + `${state.quotaExceeded ? "; Gateway: out of quota" : ""}; ${refusal ? `not worth spending now (${refusal})` : "worth spending now (the operator's call)"}`;
}

export function createNousResetCredits(deps: {
  accounts(): Promise<GatewayAccount[]>;
  zone(owner: string): Promise<string>;
  now?: () => number;
}) {
  const timeIn = (zone: string) => (iso: string) => `${new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))} ${zone}`;
  return {
    async list(owner: string): Promise<Outcome> {
      const [accounts, zone] = await Promise.all([deps.accounts(), deps.zone(owner)]);
      const now = deps.now?.() ?? Date.now();
      const pool = codexPoolAccounts(accounts);
      if (!pool.length) return { ok: true, display: "No Codex or Claude account in the pool", result: "Space Gateway has no Codex or Claude account in rotation, so no reset credits." };
      const total = quotaResetCredits(pool.map((account) => ({ resetCredits: gatewayWeekResetCredits(account) })));
      return { ok: true, display: `Read Codex and Claude reset credits (${total?.credits ?? 0})`, result: [
        `Week reset credits: ${total ? quotaResetCreditsText(total) : "none"} over ${pool.length} Codex and Claude account${pool.length === 1 ? "" : "s"}. Each gives its account a fresh week; `
          + `a Claude session reset gives only a fresh 5-hour window and a Claude Fable reset only Fable's own weekly use, never a week, so neither counts here: `
          + `only the operator spends one, with the Resources button; you never spend one or ask anyone to. Count the week resets as room when you plan work.`,
        ...pool.map((account) => `- ${codexResetLine(codexResetState(account, now), now, timeIn(zone))}`)
      ].join("\n") };
    }
  };
}
export type NousResetCredits = ReturnType<typeof createNousResetCredits>;
