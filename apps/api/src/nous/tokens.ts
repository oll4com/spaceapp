import { isGatewayFreePlan, NOUS_EFFORTS, nousLowSpendSettingsSchema, nousModelFor, nousTurnKindOf,
  type ClaudeUsageAccountList, type GatewayAccount, type NousLowSpendSettings, type NousModelChoice, type NousSettings, type NousSpendMode, type NousTurnReason } from "@space/contracts";
import { pickClaudeProfile } from "../chess/chess-players.js";
import { anthropicMonthSpendUsd } from "../claude-usage-services.js";
import type { GatewayAdminService } from "../gateway/gateway-service.js";

type Window = GatewayAccount["primaryWindow"];
export interface NousTokens {
  mode: NousSpendMode;
  control: NousLowSpendSettings["mode"];
  since: string;
  sampledAt: string;
  resetAt: string | null;
  nextResetAt: string | null;
  max: { withRoom: number; total: number } | null;
  serving: string;
  servingAccountId: string | null;
  accounts: GatewayAccount[] | null;
  budget: { budgetUsd: number | null; spentUsd: number | null } | null;
  lastHour: { costUsd: number; turns: number; unpricedTurns: number } | null;
}
export type NousTokenInput = { accounts: GatewayAccount[] | null; profiles?: ClaudeUsageAccountList | null; settings: NousLowSpendSettings; now: number; budget?: NousTokens["budget"]; lastHour?: NousTokens["lastHour"] };

/** An expired window has room again without starting a remote usage probe. Null stays unknown. */
export const nousWindowUsed = (window: Window, at: number): number | null => window.resetAt && Date.parse(window.resetAt) <= at ? 0 : window.usedPercent;
const windows = (account: GatewayAccount) => [account.primaryWindow, account.secondaryWindow];
const subscription = (account: GatewayAccount) => account.provider === "CLAUDE" && account.planType !== "api" && !isGatewayFreePlan(account.planType);
const eligible = (account: GatewayAccount) => subscription(account) && ["ACTIVE", "RATE_LIMITED", "QUOTA_EXCEEDED"].includes(account.status);
const isMax = (account: GatewayAccount) => /max/i.test(account.planType ?? "");
const hasRoom = (account: GatewayAccount, at: number, minimum: number) => {
  const value = nousWindowUsed(account.primaryWindow, at);
  return value !== null && 100 - value >= minimum;
};

export function computeNousTokens(input: NousTokenInput): NousTokens {
  const config = input.settings;
  const pool = (input.accounts ?? []).filter((account) => eligible(account) && isMax(account));
  const profiles = input.profiles?.data ?? [];
  const profileId = pickClaudeProfile(profiles) ?? "main";
  const profile = profiles.find((entry) => entry.id === profileId);
  const serving = profile?.status === "CONNECTED" && profile.email
    ? (input.accounts ?? []).find((entry) => subscription(entry) && entry.email?.toLowerCase() === profile.email!.toLowerCase()) : null;
  const budgetLeft = input.budget?.budgetUsd != null && input.budget.spentUsd != null
    ? 100 * (input.budget.budgetUsd - input.budget.spentUsd) / input.budget.budgetUsd : null;
  const modeAt = (at: number): NousSpendMode => {
    if (config.mode === "OFF") return "NORMAL";
    const room = input.accounts === null ? null : pool.filter((account) => hasRoom(account, at, config.roomRemainingPercent)).length;
    if (room === 0 && budgetLeft !== null && budgetLeft < config.criticalBudgetRemainingPercent) return "CRITICAL";
    // The API key is Gateway's last fallback; its budget must not hold healthy subscriptions in LOW.
    return config.mode === "ON" || (room !== null && room < config.minMaxAccountsWithRoom) ? "LOW" : "NORMAL";
  };
  const mode = modeAt(input.now);
  const resets = [...new Set(pool.flatMap((account) => windows(account).map((window) => Date.parse(window.resetAt ?? ""))))]
    .filter((at) => Number.isFinite(at) && at > input.now).sort((a, b) => a - b);
  const recovery = mode === "NORMAL" || config.mode !== "AUTO" ? undefined : resets.find((at) => modeAt(at) === "NORMAL");
  return { mode, control: config.mode, since: new Date(input.now).toISOString(), sampledAt: new Date(input.now).toISOString(),
    resetAt: recovery === undefined ? null : new Date(recovery).toISOString(), nextResetAt: resets[0] === undefined ? null : new Date(resets[0]).toISOString(),
    max: input.accounts === null ? null : { withRoom: pool.filter((account) => hasRoom(account, input.now, config.roomRemainingPercent)).length, total: pool.length },
    serving: serving ? `${serving.alias ?? serving.label} (profile ${profileId})` : profile?.status === "GATEWAY" ? "Space Gateway pool (routing selects the account)"
      : profile ? `${profile.label} (profile ${profileId}; Gateway account match unavailable)` : "unknown (no cached Claude profile selection yet)",
    servingAccountId: serving?.id ?? null, accounts: input.accounts, budget: input.budget ?? null, lastHour: input.lastHour ?? null };
}

/** Only existing database samples and the profile provider's peek. Monthly aggregation is cached by the caller. */
export async function readNousTokens(input: Omit<NousTokenInput, "accounts" | "now"> & { admin?: Pick<GatewayAdminService, "listAccounts"> & Partial<Pick<GatewayAdminService, "getSettings" | "anthropicBilling">>; includeBudget?: boolean; now?: number }): Promise<NousTokens> {
  const now = input.now ?? Date.now();
  const [accounts, settings, bill] = await Promise.all([
    input.admin?.listAccounts().catch(() => null), input.includeBudget ? input.admin?.getSettings?.().catch(() => null) : null,
    input.includeBudget ? input.admin?.anthropicBilling?.(new Date(now).getUTCDate()).catch(() => null) : null
  ]);
  const month = input.profiles?.data.find((profile) => profile.apiKeyMonth)?.apiKeyMonth;
  return computeNousTokens({ ...input, accounts: accounts?.data ?? null, now,
    budget: input.includeBudget ? { budgetUsd: settings?.anthropicMonthlyBudgetUsd ?? month?.budgetUsd ?? null,
      spentUsd: (bill ? anthropicMonthSpendUsd(bill, now) : null) ?? month?.spentUsd ?? null } : input.budget });
}

/** Serialize concurrent reads per owner and notify exactly once when the computed mode changes. */
export function createNousTokenMonitor(deps: { read(owner: string): Promise<NousTokens>; transition(owner: string, previous: NousSpendMode, state: NousTokens): Promise<void> }) {
  const states = new Map<string, NousTokens>();
  const pending = new Map<string, Promise<NousTokens>>();
  return {
    current: (owner: string) => states.get(owner) ?? null,
    read(owner: string): Promise<NousTokens> {
      const active = pending.get(owner);
      if (active) return active;
      const next = (async () => {
        const sample = await deps.read(owner);
        const before = states.get(owner);
        const changed = (before?.mode ?? "NORMAL") !== sample.mode;
        const state = { ...sample, since: changed || !before ? sample.sampledAt : before.since };
        states.set(owner, state);
        if (changed) await deps.transition(owner, before?.mode ?? "NORMAL", state);
        return state;
      })();
      pending.set(owner, next);
      void next.then(() => pending.delete(owner), () => pending.delete(owner));
      return next;
    }
  };
}

export function nousTokenModel(settings: NousSettings, reason: NousTurnReason | "HELPER", mode: NousSpendMode): NousModelChoice {
  const choice = nousModelFor(settings.models, reason);
  if (mode === "NORMAL") return choice;
  const kind = nousTurnKindOf(reason);
  if (kind === "operator" || kind === "decision") return { ...choice, effort: NOUS_EFFORTS.indexOf(choice.effort) > NOUS_EFFORTS.indexOf("high") ? "high" : choice.effort };
  const low = settings.lowSpend ?? nousLowSpendSettingsSchema.parse({});
  if (!low.cheaperModel) return choice;
  // A per-turn choice only: each mode's settings apply without replacing the stored normal models.
  return (mode === "CRITICAL" ? low.criticalModels : low.models)[kind];
}

type TokenModelContext = { settings: NousSettings; reason?: NousTurnReason | "HELPER"; choice?: NousModelChoice };
const modelLabel = (choice: NousModelChoice) => `${({ "claude-fable-5-1": "Fable 5.1", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" })[choice.model]} (${choice.effort})`;
const automaticModelLabel = (settings: NousSettings, mode: NousSpendMode) => ([
  ["INBOX", "inbox"], ["STANDING", "standing/heartbeat/review"], ["HELPER", "helper"]
] as const).map(([reason, label]) => `${label}: ${modelLabel(nousTokenModel(settings, reason, mode))}`).join("; ");

export function renderNousTokenSummary(tokens: NousTokens, zone: string, now = Date.now(), context?: TokenModelContext): string {
  const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + ` ${zone}` : "unknown";
  const budget = tokens.budget;
  const api = budget?.budgetUsd != null && budget.spentUsd != null ? `$${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)} spent, $${Math.max(0, budget.budgetUsd - budget.spentUsd).toFixed(2)} left` : "unknown";
  const codex = (tokens.accounts ?? []).filter((account) => account.provider === "CODEX").map((account) => `${account.alias ?? account.label} ${nousWindowUsed(account.primaryWindow, now) ?? "?"}%/${nousWindowUsed(account.secondaryWindow, now) ?? "?"}% used`).join(", ") || "unknown";
  const hour = tokens.lastHour ? `$${tokens.lastHour.costUsd.toFixed(2)} API value (${tokens.lastHour.turns} turns, ${tokens.lastHour.unpricedTurns} unpriced)` : "unknown";
  const model = context ? context.reason ? `; model: ${modelLabel(context.choice ?? nousTokenModel(context.settings, context.reason, tokens.mode))} for ${context.reason}`
    : `; automatic models — ${automaticModelLabel(context.settings, tokens.mode)}` : "";
  return `Low-spend mode: ${tokens.mode} since ${time(tokens.since)}${tokens.mode !== "NORMAL" ? `; normal again ${tokens.control === "ON" ? "when Auto or Off is selected" : `at about ${time(tokens.resetAt)}`}` : ""} (${tokens.control})${model}.\n`
    + `Tokens: Claude Max ${tokens.max ? `${tokens.max.withRoom}/${tokens.max.total} with room` : "unknown"}; next reset ${time(tokens.nextResetAt)}; API month ${api}; Codex 5-hour/7-day ${codex}; Nous last hour ${hour}; serves Nous: ${tokens.serving}. Detail: space_token_state.`;
}

export function renderNousTokens(tokens: NousTokens, zone: string, now = Date.now(), context?: TokenModelContext): string {
  const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + ` ${zone}` : "unknown";
  const window = (value: Window) => `${nousWindowUsed(value, now) ?? "unknown"}% used; reset ${time(value.resetAt)}${value.resetAt && Date.parse(value.resetAt) <= now ? " (expired sample)" : ""}`;
  return [renderNousTokenSummary(tokens, zone, now, context), `Sample read ${time(tokens.sampledAt)}; percentages are cached Gateway samples.`,
    ...(context ? [`Cheaper model in low-spend mode: ${context.settings.lowSpend.cheaperModel ? "on" : "off"}. Automatic selections: ${automaticModelLabel(context.settings, tokens.mode)}.`] : []),
    ...(tokens.accounts === null ? ["Gateway account windows unavailable."] : tokens.accounts.filter((entry) => ["CLAUDE", "CODEX"].includes(entry.provider)).map((account) =>
      `- ${account.provider} ${account.alias ?? account.label} · ${account.status}${account.id === tokens.servingAccountId ? " · serves Nous" : ""}: `
      + (account.planType === "api" ? "API account (no subscription windows)" : `5-hour: ${window(account.primaryWindow)}; 7-day: ${window(account.secondaryWindow)}`)))].join("\n");
}
