import { z } from "zod";
import { quotaResetCredits, quotaResetCreditsText, type CodexResetCreditRedemptionOutcome, type GatewayAccount } from "@space/contracts";
import { CODEX_RESET_AUTO_LEFT, CODEX_RESET_MANUAL_LEFT, codexResetBlock, codexResetKey, codexResetRefusal, codexResetState, type CodexResetState } from "../codex-reset-guard.js";
import type { CodexResetCreditsService } from "../codex-reset-credits.js";

/**
 * Codex weekly reset credits for Nous (operator 2/11 15:38 BKK, brief 20261102-codex-reset-credits): space_codex_reset_credits lists
 * each account's credits with its windows, space_codex_reset_redeem spends one on an account at its quota through the Resources
 * button's own path (Space Gateway's admin route, one redemption per account at a time), audited like that button.
 */
export const nousResetCreditsArgsSchema = z.object({});
export const nousResetRedeemArgsSchema = z.object({
  account: z.string().trim().min(1).max(320).describe("The Codex account: its e-mail or label (ntheogr@gmail.com, or ntheogr), alias or gw_account id.")
});

type Outcome = { ok: boolean; display: string; result: string; refused?: boolean };
export type CodexResetAudit = { accountId: string; outcome: CodexResetCreditRedemptionOutcome | null; error?: string; idempotencyKey: string; via?: "nous" | "auto" };

export const codexPoolAccounts = (accounts: GatewayAccount[]) => accounts.filter((account) => account.provider === "CODEX" && !["PAUSED", "DEACTIVATED"].includes(account.status));

export function findCodexAccount(accounts: GatewayAccount[], ref: string): GatewayAccount | null {
  const wanted = ref.trim().toLowerCase();
  const codex = accounts.filter((account) => account.provider === "CODEX");
  return codex.find((account) => account.id === ref.trim())
    ?? codex.find((account) => [account.label, account.alias, account.email].some((name) => name?.toLowerCase() === wanted))
    ?? codex.find((account) => [account.label, account.email].some((name) => name?.toLowerCase().split("@")[0] === wanted)) ?? null;
}

const OUTCOMES: Record<CodexResetCreditRedemptionOutcome, string> = {
  RESET: "one credit spent: the account has a fresh week",
  ALREADY_REDEEMED: "this week's credit was already spent (nothing spent again)",
  NOTHING_TO_RESET: "nothing to reset upstream: the account has room (no credit spent)",
  NO_CREDIT: "no credit was available upstream (nothing spent)"
};

export function codexResetLine(state: CodexResetState, now: number, time: (iso: string) => string): string {
  const window = (label: string, entry: CodexResetState["week"]) => entry ? `${label} ${Math.round(entry.left)}% left${entry.resetAt ? `, resets ${time(entry.resetAt)}` : ""}` : `${label} no current sample`;
  const refusal = codexResetRefusal(state, now, CODEX_RESET_MANUAL_LEFT, time);
  return `${state.name} [${state.id}]: ${state.credits} credit${state.credits === 1 ? "" : "s"}; ${window("week", state.week)}; ${window("5-hour", state.fiveHour)}`
    + `${state.quotaExceeded ? "; Gateway: out of quota" : ""}; ${refusal ? `not now (${refusal})` : "redeemable now"}`;
}

export function createNousResetCredits(deps: {
  accounts(): Promise<GatewayAccount[]>;
  service: CodexResetCreditsService;
  audit(owner: string, entry: CodexResetAudit): Promise<void>;
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
      if (!pool.length) return { ok: true, display: "No Codex account in the pool", result: "Space Gateway has no Codex account in rotation, so no reset credits." };
      const total = quotaResetCredits(pool.map((account) => ({ resetCredits: account.resetCreditsAvailable })));
      return { ok: true, display: `Read Codex reset credits (${total?.credits ?? 0})`, result: [
        `Codex reset credits: ${total ? quotaResetCreditsText(total) : "none"} over ${pool.length} account${pool.length === 1 ? "" : "s"}. A credit gives its account a fresh week: `
          + `spend one (space_codex_reset_redeem) only on an account at its quota whose own reset is over 6 hours away; Space spends them by itself when the pool runs dry.`,
        ...pool.map((account) => `- ${codexResetLine(codexResetState(account, now), now, timeIn(zone))}`)
      ].join("\n") };
    },
    async redeem(owner: string, args: z.infer<typeof nousResetRedeemArgsSchema>): Promise<Outcome> {
      const [accounts, zone] = await Promise.all([deps.accounts(), deps.zone(owner)]);
      const now = deps.now?.() ?? Date.now();
      const account = findCodexAccount(accounts, args.account);
      // Daily Nous errors 14/11 (18:18 "a credit now would be wasted"): a credit Space keeps, and a name it does not know, are refusals that say why.
      if (!account) return { ok: false, refused: true, display: `No Codex account ${args.account}`,
        result: `No Codex account is named ${args.account}. Codex accounts: ${accounts.filter((entry) => entry.provider === "CODEX").map((entry) => `${entry.alias ?? entry.label} [${entry.id}]`).join(", ") || "none"}.` };
      const state = codexResetState(account, now);
      const refusal = codexResetRefusal(state, now, CODEX_RESET_MANUAL_LEFT, timeIn(zone));
      if (refusal) return { ok: false, refused: true, display: `Did not spend a credit on ${state.name}`, result: `${refusal} Nothing spent.` };
      const idempotencyKey = codexResetKey(account.id, state.week?.resetAt ?? null);
      let outcome: CodexResetCreditRedemptionOutcome;
      try {
        outcome = (await deps.service.redeem(account.id, idempotencyKey)).response.outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.audit(owner, { accountId: account.id, outcome: null, error: message, idempotencyKey }).catch(() => undefined);
        return { ok: false, display: `Could not spend a credit on ${state.name}`, result: `${message} A retry with this tool uses the same request key, so it never spends two.` };
      }
      await deps.audit(owner, { accountId: account.id, outcome, idempotencyKey }).catch(() => undefined);
      const after = findCodexAccount(await deps.accounts().catch(() => []), account.id);
      return { ok: true, display: `Codex reset credit on ${state.name}: ${outcome}`,
        result: `${state.name}: ${OUTCOMES[outcome]}.${after ? ` Now: ${codexResetLine(codexResetState(after, deps.now?.() ?? Date.now()), now, timeIn(zone))}.` : ""}` };
    }
  };
}
export type NousResetCredits = ReturnType<typeof createNousResetCredits>;

export type CodexResetAutoSpend = { state: CodexResetState; idempotencyKey: string } & ({ outcome: CodexResetCreditRedemptionOutcome } | { error: string });
const AUTO_REFUSED_WINDOW_MS = 15 * 60_000;
const AUTO_RETRY_MS = 10 * 60_000;

/**
 * Space spends a credit by itself (brief step 3), from the minute tick on Space Gateway's stored samples (no new provider call): one at most
 * a tick, on an account whose week (or 5-hour window) is under 1% with its own reset over 6 hours away, and only while Codex work waits for
 * it: no other pool account is usable, or Space Gateway refused a Codex request for quota in the last 15 minutes. Of several, the one whose
 * own reset is furthest, as its credit buys the most. The key is per account and week (upstream spends one credit a key); a key spent is
 * not tried again, a failed one after 10 minutes.
 */
export function createCodexResetAuto(deps: {
  accounts(): Promise<GatewayAccount[]>;
  service: CodexResetCreditsService;
  refusedSince(since: string): Promise<boolean>;
  now?: () => number;
}) {
  // shortcut: in memory; after an API restart the same key goes again, and upstream answers ALREADY_REDEEMED without spending.
  const tried = new Map<string, number>();
  return {
    async tick(): Promise<CodexResetAutoSpend | null> {
      const now = deps.now?.() ?? Date.now();
      const pool = codexPoolAccounts(await deps.accounts()).map((account) => codexResetState(account, now));
      const due = pool.filter((state) => !codexResetRefusal(state, now, CODEX_RESET_AUTO_LEFT, String)
        && !((tried.get(codexResetKey(state.id, state.week?.resetAt ?? null)) ?? 0) > now));
      if (!due.length) return null;
      if (pool.some((state) => !codexResetBlock(state, CODEX_RESET_AUTO_LEFT).blocked) && !(await deps.refusedSince(new Date(now - AUTO_REFUSED_WINDOW_MS).toISOString()))) return null;
      const backAt = (state: CodexResetState) => codexResetBlock(state, CODEX_RESET_AUTO_LEFT).backAt ?? Number.POSITIVE_INFINITY;
      const state = due.sort((a, b) => backAt(b) - backAt(a))[0]!;
      const idempotencyKey = codexResetKey(state.id, state.week?.resetAt ?? null);
      tried.set(idempotencyKey, Number.POSITIVE_INFINITY);
      try {
        return { state, idempotencyKey, outcome: (await deps.service.redeem(state.id, idempotencyKey)).response.outcome };
      } catch (error) {
        tried.set(idempotencyKey, now + AUTO_RETRY_MS);
        return { state, idempotencyKey, error: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

/** The Nous inbox line and notification text of an automatic spend. */
export function codexResetAutoText(spent: CodexResetAutoSpend): { title: string; line: string } {
  const name = spent.state.name;
  if ("error" in spent) return { title: `Codex reset credit not spent: ${name}`, line: `Space tried to spend a Codex weekly reset credit on ${name} (used up, its own reset over 6 hours away, Codex work waiting) and it failed: ${spent.error} It tries again in 10 minutes with the same key, so it never spends two.` };
  return { title: spent.outcome === "RESET" ? `Codex reset credit spent: ${name} has a fresh week` : `Codex reset credit on ${name}: ${spent.outcome}`,
    line: `Space spent a Codex weekly reset credit on ${name} by itself (week ${spent.state.week ? `${Math.round(spent.state.week.left)}% left` : "unknown"}, its own reset over 6 hours away, Codex work waiting): ${OUTCOMES[spent.outcome]}. `
      + `${Math.max(0, spent.state.credits - (spent.outcome === "RESET" ? 1 : 0))} credit(s) left on it. Turn it off in Settings → Assistants & AI → Nous → "Spend Codex reset credits by itself".` };
}
