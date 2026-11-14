import { GATEWAY_PACE_BAND, gatewayPaceDay, gatewayWeekPace, isGatewayFreePlan, neededReservePercent, NOUS_EFFORTS, NOUS_SPACE_ROUTES, quotaLeftAtReset, quotaResetCredits, quotaResetCreditsText, type QuotaResetCredits, NOUS_PROVIDER_GATEWAY, nousKeyPoolProvider, nousModelLabel, nousSettingsWithProvider, nousLowSpendSettingsSchema, nousModelFor, nousTurnKindOf,
  type ApiProviderAccount, type ApiProviderAccountList, type GatewayWeekPace, type NousProvider, type ClaudeUsageAccountList, type GatewayAccount, type NousLowSpendSettings, type NousModelChoice, type NousSettings, type NousSpendMode, type NousTurnReason } from "@space/contracts";
import { pickClaudeProfile } from "../chess/chess-players.js";
import { anthropicMonthSpendUsd } from "../claude-usage-services.js";
import type { GatewayAdminService } from "../gateway/gateway-service.js";
import { lostAtResetText, type NousLostRow } from "./lost-tokens.js";

type Window = GatewayAccount["primaryWindow"];
export interface NousTokens {
  provider?: NousProvider;
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
  /** The API keys' last balance sample (no remote call of its own); null when Space has none. */
  api?: ApiProviderAccount[] | null;
  /** The mode the samples ask for while it has not held NOUS_MODE_HOLD_MS yet, and since when (the monitor's hysteresis). */
  pending?: { mode: NousSpendMode; since: string } | null;
  /** What each subscription week left unused at its reset in the last 7 days (operator 5/11); null when not read. */
  lost?: NousLostRow[] | null;
  /** Space provider: the subscription pools with no room for Nous now (CRITICAL by its own reserve); an auto model tries their routes last. */
  noRoom?: NousProvider[];
}
export type NousTokenInput = { provider?: NousProvider;
  /** The Space provider's enabled routes as providers, in the Gateway's order; default Claude, Codex, Gemini. */
  spaceProviders?: string[]; accounts: GatewayAccount[] | null; profiles?: ClaudeUsageAccountList | null; settings: NousLowSpendSettings; now: number; budget?: NousTokens["budget"]; lastHour?: NousTokens["lastHour"]; api?: ApiProviderAccountList | null };

/** An expired window has room again without starting a remote usage probe. Null stays unknown. */
export const nousWindowUsed = (window: Window, at: number): number | null => window.resetAt && Date.parse(window.resetAt) <= at ? 0 : window.usedPercent;
const windows = (account: Pick<GatewayAccount, "primaryWindow" | "secondaryWindow">) => [account.primaryWindow, account.secondaryWindow];
/**
 * When the first usable account of a Gateway provider's pool has room again: its spent windows' latest reset. Null when an account has
 * room now, a spent window has no reset, or the pool has no usable account (2026-11-06 REVIEW: web search, Codex weeks used up to 11/11).
 */
export function poolBackAt(accounts: GatewayAccount[], gatewayProvider: string, now: number): number | null {
  const backs = accounts.filter((account) => account.provider === gatewayProvider && !["PAUSED", "DEACTIVATED"].includes(account.status))
    .map((account) => Math.max(now, ...windows(account).filter((window) => (nousWindowUsed(window, now) ?? 0) >= 100).map((window) => Date.parse(window.resetAt ?? "") || now)));
  const first = backs.length ? Math.min(...backs) : now;
  return first > now ? first : null;
}
const subscription = (account: GatewayAccount) => account.provider === "CLAUDE" && account.planType !== "api" && !isGatewayFreePlan(account.planType);
const eligible = (account: GatewayAccount) => subscription(account) && ["ACTIVE", "RATE_LIMITED", "QUOTA_EXCEEDED"].includes(account.status);
const isMax = (account: GatewayAccount) => /max/i.test(account.planType ?? "");
// Room in the 5-hour window, and a week not used up (unknown weekly samples do not take room away); `minimum` is what the pool keeps of a window.
const hasRoom = (account: GatewayAccount, at: number, minimum: (window: Window) => number) => {
  const value = nousWindowUsed(account.primaryWindow, at);
  const week = nousWindowUsed(account.secondaryWindow, at);
  return value !== null && value < 100 && 100 - value >= minimum(account.primaryWindow) && (week === null || (week < 100 && 100 - week >= minimum(account.secondaryWindow)));
};

const windowLabel = (minutes: number) => minutes === 300 ? "5-hour" : minutes === 10_080 ? "7-day" : minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${minutes}-minute`;
/** A window with a figure or a reset: Gateway keeps a slot's length when it blanks it (a weekly-only Codex plan's old 5-hour slot). */
const sampled = (window: Window) => window.windowMinutes !== null && (window.usedPercent !== null || window.resetAt !== null);
/** The account's sampled window of that length: Codex prolite and free plans report no 5-hour window. */
const windowOf = (account: GatewayAccount, minutes: number): Window | null => windows(account).find((window) => window.windowMinutes === minutes && sampled(window)) ?? null;
/** Pace points with their sign: +26, -17, 0. */
const points = (value: number | null) => value === null ? "?" : value > 0 ? `+${value}` : String(value);
/** Max accounts Nous can use, and every Codex account in the pool. */
const paced = (account: GatewayAccount) => (eligible(account) && isMax(account)) || (account.provider === "CODEX" && !["PAUSED", "DEACTIVATED"].includes(account.status));
/** Today's share of the week the Gateway holds background work to (plan clipboard:DotwYXVD2N3n): " today 9%/12%", HELD once it is used. */
const paceToday = (account: GatewayAccount, now: number) => {
  const resetAt = Date.parse(account.secondaryWindow.resetAt ?? "");
  const day = account.paceDayStart ? gatewayPaceDay({ usedPercent: account.secondaryWindow.usedPercent, resetAt: Number.isFinite(resetAt) ? resetAt : null }, account.paceDayStart, now) : null;
  return day ? ` today ${Math.round(day.usedTodayPercent)}%/${Math.round(day.allowancePercent)}%${day.daysLeft === 1 ? " last day" : day.capped ? " HELD" : ""}` : "";
};


/**
 * The Space provider is as conserving as the first route in the Gateway order that has room, since that route serves its turns first
 * (goal d844e0cc, 4/11: Gemini NORMAL had hidden a Claude route that ran out before its reset): CRITICAL only when no enabled Claude,
 * Codex or Gemini pool has room. Pay-per-token routes never lift CRITICAL: their budget is not quota Nous can count on.
 */
function spaceTokens(input: NousTokenInput): NousTokens {
  const order = [...new Set(input.spaceProviders ?? ["claude", "codex", "gemini"])];
  const routes = order.filter((provider): provider is "claude" | "codex" | "gemini" => provider === "claude" || provider === "codex" || provider === "gemini");
  const states = routes.map((provider) => computeNousTokens({ ...input, provider }));
  if (!states.length) return { ...computeNousTokens({ ...input, provider: "codex" }), provider: "space", serving: "Space Gateway: no subscription route is on (Settings → Routing)" };
  const first = states.find((state) => state.mode !== "CRITICAL") ?? states[0]!;
  const resets = states.map((state) => state.nextResetAt).filter((value): value is string => Boolean(value)).sort();
  const max = states.every((state) => state.max === null) ? null : states.reduce((sum, state) => ({ withRoom: sum.withRoom + (state.max?.withRoom ?? 0), total: sum.total + (state.max?.total ?? 0) }), { withRoom: 0, total: 0 });
  return { ...first, provider: "space", max, nextResetAt: resets[0] ?? null, noRoom: states.filter((state) => state.mode === "CRITICAL").map((state) => state.provider!),
    // Every enabled route in the Gateway order (stable 5/11: the world named only claude, codex, gemini and hid Claude via OpenCode).
    serving: `Space Gateway routes in the provider order (${order.map((provider) => { const state = states.find((entry) => entry.provider === provider);
      return state ? `${provider} ${state.mode}` : `${Object.values(NOUS_SPACE_ROUTES).find((route) => route.provider === provider)?.name ?? provider} (API key, paid per token)`; }).join(", ")}); each pool's routing picks the account` };
}

export function computeNousTokens(input: NousTokenInput): NousTokens {
  if (input.provider === "space") return spaceTokens(input);
  const config = input.settings;
  const provider = input.provider ?? "claude";
  const gatewayProvider = NOUS_PROVIDER_GATEWAY[provider];
  const pool = (input.accounts ?? []).filter((account) => provider === "claude" ? eligible(account) && isMax(account)
    : account.provider === gatewayProvider && ["ACTIVE", "RATE_LIMITED", "QUOTA_EXCEEDED"].includes(account.status));
  // Operator 5/11 (nous_msg:3723fc28): roomRemainingPercent of a window is kept only while the pool runs short before its next reset (an
  // account whose other window is spent brings nothing back at this one's reset).
  const lengthWindows = (minutes: number | null, at: number) => pool
    .filter((other) => windows(other).every((own) => own.windowMinutes === minutes || (nousWindowUsed(own, at) ?? 0) < 100))
    .flatMap(windows).filter((other) => other.windowMinutes === minutes)
    .map((other) => ({ used: other.usedPercent, resetAt: other.resetAt ? Date.parse(other.resetAt) : null, length: (other.windowMinutes ?? 0) * 60_000 }));
  const kept = (window: Window, at: number) => neededReservePercent(lengthWindows(window.windowMinutes, at), config.roomRemainingPercent, at);
  const runsShort = (at: number) => [...new Set(pool.flatMap(windows).map((window) => window.windowMinutes))]
    .some((minutes) => neededReservePercent(lengthWindows(minutes, at), 100, at) > 0);
  const roomAt = (account: GatewayAccount, at: number) => provider === "claude" ? hasRoom(account, at, (window) => kept(window, at))
    : account.status !== "QUOTA_EXCEEDED" && windows(account).every((window) => {
      const used = nousWindowUsed(window, at);
      return used === null || (used < 100 && 100 - used >= kept(window, at));
    });
  const profiles = input.profiles?.data ?? [];
  const profileId = pickClaudeProfile(profiles) ?? "main";
  const profile = profiles.find((entry) => entry.id === profileId);
  const serving = profile?.status === "CONNECTED" && profile.email
    ? (input.accounts ?? []).find((entry) => subscription(entry) && entry.email?.toLowerCase() === profile.email!.toLowerCase()) : null;
  const modeAt = (at: number): NousSpendMode => {
    if (config.mode === "OFF") return "NORMAL";
    if (nousKeyPoolProvider(provider)) return config.mode === "ON" ? "LOW" : "NORMAL";
    const room = input.accounts === null ? null : pool.filter((account) => roomAt(account, at)).length;
    // Operator rule 2026-10-27: the API key never serves Claude Code, so its budget no longer counts for Nous's mode.
    if (room === 0) return "CRITICAL";
    if (config.mode === "ON") return "LOW";
    // Operator 13/11 23:03 BKK: full 5-hour windows are a wait (or another pool), never a hold; 21:30-22:59 BKK LOW came from lab, ntheo and dev's
    // 5-hour windows while dev had 52% and lab 60% of their weeks. The pool is held only when no account has week room (service.ts prompt rule).
    if (pool.some((account) => weekRoom(account, at))) return "NORMAL";
    // Operator 5/11 («μην χάνετε ούτε ένα token»): while an account with room now still has room left at its own reset at its pace, that room
    // would reset unused: the pool is not LOW (5/11 05:19-10:05 BKK: LOW with ntheo's whole week free, 27 panes idle all night).
    if (pool.some((account) => roomAt(account, at) && losesRoomAtReset(account, at))) return "NORMAL";
    // Goal d844e0cc (4/11): a Claude pool whose week runs out before its reset at this pace is LOW, by the Provider advice's own figure.
    const outOfWeek = provider === "claude" && (nousProviderRooms(input.accounts, null, at).find((entry) => entry.key === "claude")?.atReset?.percent ?? 1) < 1;
    // The same rule for the count (6/11 01:30-04:30 BKK: LOW on 1 of 5 with room while ntheo had 52% of its week and lab's fresh week came
    // at 04:00): fewer accounts with room than minMaxAccountsWithRoom is LOW only while a window's room runs short before its next reset.
    return (room !== null && room < config.minMaxAccountsWithRoom && runsShort(at)) || outOfWeek ? "LOW" : "NORMAL";
  };
  const mode = modeAt(input.now);
  const resets = [...new Set(pool.flatMap((account) => windows(account).map((window) => Date.parse(window.resetAt ?? ""))))]
    .filter((at) => Number.isFinite(at) && at > input.now).sort((a, b) => a - b);
  const recovery = mode === "NORMAL" || config.mode !== "AUTO" ? undefined : resets.find((at) => modeAt(at) === "NORMAL");
  return { provider, mode, control: config.mode, since: new Date(input.now).toISOString(), sampledAt: new Date(input.now).toISOString(),
    resetAt: recovery === undefined ? null : new Date(recovery).toISOString(), nextResetAt: resets[0] === undefined ? null : new Date(resets[0]).toISOString(),
    max: input.accounts === null ? null : { withRoom: pool.filter((account) => roomAt(account, input.now)).length, total: pool.length },
    serving: provider !== "claude" ? `Space Gateway ${gatewayProvider} pool (routing selects the account)` : serving ? `${serving.alias ?? serving.label} (profile ${profileId})` : profile?.status === "GATEWAY" ? "Space Gateway pool (routing selects the account)"
      : profile ? `${profile.label} (profile ${profileId}; Gateway account match unavailable)` : "unknown (no cached Claude profile selection yet)",
    servingAccountId: serving?.id ?? null, accounts: input.accounts, budget: input.budget ?? null, lastHour: input.lastHour ?? null, api: input.api?.data ?? null };
}

/**
 * What each provider has left (plan clipboard:mjpENip0ilmC, operator 31/10 13:12 BKK: Nous sees the pickers' percentages and acts on
 * them, so every token is used and the right provider chosen). Subscription pools: usable accounts, the best account's tightest window
 * left now, the pool's weekly quota still free at its last reset at this pace (`quotaLeftAtReset`, the account menus' figure) and the
 * average weekly pace; API keys: the balance or budget left in the last sample. Unknown stays null, never a guessed number.
 */
export interface NousProviderRoom {
  key: string;
  name: string;
  /** The Nous provider this pool serves, when Nous can run on it. */
  provider: NousProvider | null;
  accounts: number;
  nowLeft: number | null;
  atReset: { percent: number; resetAt: string } | null;
  pace: GatewayWeekPace["pace"];
  points: number | null;
  /** API keys only. */
  api?: { balance: string | null; percent: number | null; exhausted: boolean; pool?: string } | null;
  /** Codex weekly reset credits: each one more fresh week (operator 2/11 15:38 BKK), so a pool holding them is never out of room. */
  resetCredits?: QuotaResetCredits | null;
}

const WEEK_MS = 10_080 * 60_000;
/** Week room (operator 13/11 23:03 BKK): 20% of the week left, a week that resets within 24 h, or a Codex weekly reset credit. Unknown weeks give none. */
function weekRoom(account: GatewayAccount, at: number): boolean {
  if ((account.resetCreditsAvailable ?? 0) > 0) return true;
  const week = windowOf(account, 10_080);
  const used = week ? nousWindowUsed(week, at) : null;
  if (used === null) return false;
  const resetAt = Date.parse(week!.resetAt ?? "");
  return 100 - used >= 20 || (Number.isFinite(resetAt) && resetAt - at <= 24 * 3_600_000);
}
/** The account's week still has at least 1% free at its own reset at its pace since the week began (quotaLeftAtReset over one account). */
function losesRoomAtReset(account: GatewayAccount, at: number): boolean {
  const week = windowOf(account, 10_080);
  const used = week ? nousWindowUsed(week, at) : null;
  return used !== null && (quotaLeftAtReset([{ remaining: 100 - used, resetAt: week!.resetAt, periodMs: WEEK_MS }], at)?.percent ?? 0) >= 1;
}
const POOLS: Array<{ key: string; name: string; provider: NousProvider | null; gateway: string; group?: string; serves: (account: GatewayAccount) => boolean }> = [
  { key: "claude", name: "Claude Max", provider: "claude", gateway: "CLAUDE", serves: (account) => eligible(account) && isMax(account) },
  { key: "codex", name: "Codex", provider: "codex", gateway: "CODEX", serves: () => true },
  { key: "gemini", name: "Gemini (Antigravity)", provider: "gemini", gateway: "ANTIGRAVITY", group: "gemini", serves: () => true },
  { key: "antigravity-claude", name: "Claude · GPT on Antigravity", provider: null, gateway: "ANTIGRAVITY", group: "claude", serves: () => true }
];
const API_POOLS: Array<{ key: string; name: string; provider: NousProvider | null }> = [
  { key: "openai", name: "OpenAI API", provider: null }, { key: "openrouter", name: "OpenRouter", provider: null },
  { key: "deepseek", name: "DeepSeek", provider: null }, { key: "anthropic", name: "Claude API key", provider: null }
];

export function nousProviderRooms(accounts: GatewayAccount[] | null, api: ApiProviderAccount[] | null, now: number): NousProviderRoom[] {
  const pools = POOLS.map((pool) => {
    const members = (accounts ?? []).filter((account) => account.provider === pool.gateway && (pool.provider === "claude" || !["PAUSED", "DEACTIVATED"].includes(account.status)) && pool.serves(account))
      .map((account) => {
        const group = pool.group ? account.quotaGroups?.find((entry) => entry.key === pool.group) : account;
        return group ? { status: account.status, primaryWindow: group.primaryWindow, secondaryWindow: group.secondaryWindow, resetCredits: account.resetCreditsAvailable } : null;
      }).filter((member) => member !== null);
    const left = members.flatMap((member) => {
      const used = windows(member).filter(sampled).map((window) => nousWindowUsed(window, now)).filter((value) => value !== null);
      return member.status === "QUOTA_EXCEEDED" ? [0] : used.length ? [100 - Math.max(...used)] : [];
    });
    const weeks = members.map((member) => windows(member).find((window) => window.windowMinutes === 10_080 && sampled(window)));
    const atReset = quotaLeftAtReset(weeks.map((week) => ({ remaining: week?.usedPercent == null ? null : 100 - week.usedPercent, resetAt: week?.resetAt, periodMs: WEEK_MS })), now);
    const paces = members.map((member) => gatewayWeekPace(member, now)?.points).filter((value) => value != null);
    const points = paces.length ? Math.round(paces.reduce((sum, value) => sum + value, 0) / paces.length) : null;
    return { key: pool.key, name: pool.name, provider: pool.provider, accounts: members.length, nowLeft: left.length ? Math.round(Math.max(...left)) : null,
      atReset: atReset && { percent: Math.round(atReset.percent), resetAt: atReset.resetAt }, points, resetCredits: quotaResetCredits(members),
      pace: points === null ? null : points > GATEWAY_PACE_BAND ? "AHEAD" as const : points < -GATEWAY_PACE_BAND ? "UNDER" as const : "ON" as const };
  });
  return [...pools, ...API_POOLS.map((pool) => {
    const account = api?.find((entry) => entry.providerId === pool.key);
    const known = account && account.status !== "ERROR" && account.status !== "UNCONFIGURED";
    return { key: pool.key, name: pool.name, provider: pool.provider, accounts: known ? 1 : 0, nowLeft: null, atReset: null, pace: null, points: null,
      api: known ? { balance: account.balance && /^\$/.test(account.balance) ? account.balance : null, percent: account.remainingPercent ?? null, exhausted: account.status === "EXHAUSTED" } : null };
  }),
  // Space Gateway's key pools, one per provider (Adaption Labs, AMD Token Lab, NVIDIA NIM...; gatewayPoolProviderAccounts, nous_msg:71a41c2e).
  ...(api ?? []).filter((row) => row.id.startsWith("gateway-")).map((row) => ({ key: row.id, name: row.label, provider: null, accounts: row.status === "CONNECTED" ? 1 : 0,
    nowLeft: null, atReset: null, pace: null, points: null, api: { balance: null, percent: null, exhausted: row.status === "EXHAUSTED", pool: row.detail ?? "Space Gateway key pool" } }))];
}

/**
 * Space's provider advice: use now the pools with room whose weekly quota would otherwise reset unused (the most first, then the earliest
 * reset); avoid the ones with no room now, that run out before their reset or run AHEAD of pace with no known room at the reset, and API keys with no balance. A pool
 * holding Codex reset credits is never avoided: each credit is a fresh week its account gets at once (operator 2/11 15:38 BKK).
 */
export function nousProviderAdvice(rooms: NousProviderRoom[], minimum = 10): { use: NousProviderRoom[]; avoid: Array<{ room: NousProviderRoom; why: string }> } {
  const avoid = rooms.flatMap((room) => {
    const why = room.api ? (room.api.exhausted || room.api.percent === 0 ? "no balance left" : null)
      : !room.accounts || room.resetCredits ? null : room.nowLeft !== null && room.nowLeft < minimum ? "no room now"
        // Operator 5/11 12:32 BKK: never "avoid" a pool whose week would reset with room left (AHEAD of pace with room at the reset is still room to use).
        : room.atReset && room.atReset.percent < 1 ? "runs out before its reset" : room.pace === "AHEAD" && !room.atReset ? "ahead of pace" : null;
    return why ? [{ room, why }] : [];
  });
  const use = rooms.filter((room) => !room.api && room.atReset && room.atReset.percent >= 20 && !avoid.some((entry) => entry.room === room))
    .sort((a, b) => b.atReset!.percent - a.atReset!.percent || Date.parse(a.atReset!.resetAt) - Date.parse(b.atReset!.resetAt));
  return { use, avoid };
}

/** One provider's room in a few words; `time` formats a reset, or leaves it out. */
export function nousProviderRoomText(room: NousProviderRoom | undefined, time?: (value: string) => string): string {
  if (!room) return "no data";
  if (room.api !== undefined) {
    if (!room.api) return "balance unknown";
    if (room.api.pool) return room.api.pool;
    if (room.api.exhausted && !room.api.balance) return "no balance left";
    const percent = room.api.percent === null ? null : `${room.api.percent}%`;
    return room.api.balance ? `${room.api.balance} left${percent ? ` (${percent})` : ""}` : percent ? `${percent} left` : "balance not reported";
  }
  if (!room.accounts) return "no account";
  const parts = [room.nowLeft === null ? "now unknown" : `${room.nowLeft}% left now`,
    room.atReset ? `${room.atReset.percent}% at the weekly reset${time ? ` ${time(room.atReset.resetAt)}` : ""}` : "reset unknown"];
  return `${parts.join(", ")}${room.pace ? `, pace ${room.pace}` : ""}${room.resetCredits ? `, ${quotaResetCreditsText(room.resetCredits)}` : ""}`;
}

/** The world's provider lines: each pool's room, Space's advice and the operator's code-model rule. */
export function renderNousProviderAdvice(rooms: NousProviderRoom[] | null, time: (value: string) => string, zone: string): string {
  const rule = "Code changes in any app: Claude Opus or GPT-6 Astra only, never a Sol model.";
  if (!rooms) return `Providers: unknown (no Space Gateway account sample). ${rule}`;
  const { use, avoid } = nousProviderAdvice(rooms);
  const unused = (room: NousProviderRoom) => `${room.name} (${room.atReset!.percent}% would reset unused ${time(room.atReset!.resetAt)})`;
  // Plan clipboard:ctqx7SPqkWR2 step 5 (1/11: the Antigravity Claude · GPT pool 100% unused while four Max accounts hit their 5 hours).
  const antigravity = use.find((room) => room.key === "antigravity-claude" || room.key === "gemini");
  return `Providers (left now, at this pace at the weekly reset in ${zone}, pace): ${rooms.map((room) => `${room.name} ${nousProviderRoomText(room, time)}`).join("; ")}.\n`
    + `Provider advice: use now ${use.map(unused).join(", ") || "nothing in particular"}; avoid ${avoid.map(({ room, why }) => `${room.name} (${why})`).join(", ") || "none"}. `
    + (antigravity ? `Non-code work (research, reading, mail drafts, checks, summaries) goes by default to a Gemini (Antigravity) pane (pane type gemini${antigravity.key === "antigravity-claude"
      ? ", a Claude or GPT model there for the Claude · GPT pool" : ""}), not to Claude Max. ` : "")
    // The free and granted pools (nous_msg:d9b67550): their lines above say granted, used and left; they serve the Space provider after the subscriptions.
    + (rooms.some((room) => room.key.startsWith("gateway-") && room.accounts) ? "Free and granted Space Gateway pools take non-code and background work after the subscriptions (Space provider auto); never code. " : "")
    + rule;
}

/**
 * The Load tab (plan clipboard:f4SH36t3fJ6c): how much of each subscription pool is in use now, from the cached Gateway samples only. Per
 * account the tighter of its 5-hour window used and its week used against the share of the week passed (100 = spending at pace; ahead of
 * pace counts as full), an account at its quota 100; the pool is the mean of its accounts, null without a sample.
 */
export function nousPoolUtilization(accounts: GatewayAccount[] | null, now: number): { claude: number | null; codex: number | null; gemini: number | null } {
  // Gemini (4/11, plan clipboard:ro5ukMcJnIk4 step 5): the Space provider's third route; its windows are the Antigravity account's "gemini" quota group.
  const gemini = (accounts ?? []).filter((account) => account.provider === "ANTIGRAVITY" && !["PAUSED", "DEACTIVATED"].includes(account.status)).flatMap((account) => {
    const group = account.quotaGroups?.find((entry) => entry.key === "gemini");
    return group ? [{ ...account, primaryWindow: group.primaryWindow, secondaryWindow: group.secondaryWindow }] : [];
  });
  const of = (provider: string) => {
    const values = (provider === "ANTIGRAVITY" ? gemini : (accounts ?? []).filter((account) => account.provider === provider && paced(account))).flatMap((account) => {
      if (account.status === "QUOTA_EXCEEDED") return [100];
      const fiveHour = windowOf(account, 300);
      const used = fiveHour ? nousWindowUsed(fiveHour, now) : null;
      const week = gatewayWeekPace(account, now);
      const pace = week?.usedPercent == null ? null : Math.min(100, (100 * week.usedPercent) / Math.max(week.passedPercent, 1));
      const known = [used, pace].filter((value) => value !== null);
      return known.length ? [Math.min(100, Math.max(...known))] : [];
    });
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return { claude: of("CLAUDE"), codex: of("CODEX"), gemini: of("ANTIGRAVITY") };
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

/** LOW starts only once the samples asked for it this long (operator 5/11: 79 changes since 27/10, 27 on 1/11); NORMAL comes back at once (13/11). */
export const NOUS_MODE_HOLD_MS = 30 * 60_000;
/** The mode in force, since when, and the one the samples ask for meanwhile; kept across API restarts by `held`. */
export interface NousHeldMode { mode: NousSpendMode; since: string; pending?: { mode: NousSpendMode; since: string } | null }

/**
 * Serialize concurrent reads per owner and notify exactly once when the mode in force changes. NORMAL → LOW waits until the samples have
 * asked for LOW for NOUS_MODE_HOLD_MS; LOW → NORMAL applies on the first sample that asks it; CRITICAL (no account has room now) comes and goes at once. `held` keeps the mode in force
 * across restarts (a deploy restarts the API; a fresh monitor took each restart's first sample as a change).
 */
export function createNousTokenMonitor(deps: { read(owner: string): Promise<NousTokens>; transition(owner: string, previous: NousSpendMode, state: NousTokens): Promise<void>;
  held?: { load(owner: string): Promise<NousHeldMode | null>; save(owner: string, value: NousHeldMode): Promise<void> } }) {
  const states = new Map<string, NousTokens>();
  const holds = new Map<string, NousHeldMode>();
  const pending = new Map<string, Promise<NousTokens>>();
  return {
    current: (owner: string) => states.get(owner) ?? null,
    read(owner: string): Promise<NousTokens> {
      const active = pending.get(owner);
      if (active) return active;
      const next = (async () => {
        const sample = await deps.read(owner);
        const known = holds.get(owner) ?? await deps.held?.load(owner).catch(() => null) ?? null;
        const hold = known ?? { mode: "NORMAL" as const, since: sample.sampledAt };
        const asked = sample.mode === hold.mode ? null : hold.pending?.mode === sample.mode ? hold.pending : { mode: sample.mode, since: sample.sampledAt };
        // Only the automatic samples wait: a first start (nothing held), the operator's ON/OFF and CRITICAL apply at once. NORMAL too (operator 13/11
        // 23:07 BKK «οταν μπενεις σε περιοερισμενο καταναλωση πρεπει να βγαινεις κιολας»: LOW from 21:30 waited "normal again at about 23:40" with
        // crew, lab and ops' 5-hour windows open): the same modeAt asks NORMAL on the sample after room comes back, and it applies then; only LOW waits.
        const now = !asked || !known || sample.control !== "AUTO" || sample.mode === "CRITICAL" || sample.mode === "NORMAL" || hold.mode === "CRITICAL"
          || Date.parse(sample.sampledAt) - Date.parse(asked.since) >= NOUS_MODE_HOLD_MS;
        const held: NousHeldMode = !asked ? { mode: hold.mode, since: hold.since } : now ? { mode: sample.mode, since: sample.sampledAt } : { mode: hold.mode, since: hold.since, pending: asked };
        holds.set(owner, held);
        if (!known || held.mode !== hold.mode || held.since !== hold.since || held.pending?.since !== hold.pending?.since || held.pending?.mode !== hold.pending?.mode) {
          await deps.held?.save(owner, held).catch(() => undefined);
        }
        // While LOW waits out a NORMAL ask, normal comes back when that ask has held long enough.
        const state: NousTokens = { ...sample, mode: held.mode, since: held.since, pending: held.pending ?? null,
          resetAt: held.pending?.mode === "NORMAL" ? new Date(Date.parse(held.pending.since) + NOUS_MODE_HOLD_MS).toISOString() : held.mode === sample.mode ? sample.resetAt : null };
        states.set(owner, state);
        if (held.mode !== hold.mode) await deps.transition(owner, hold.mode, state);
        return state;
      })();
      pending.set(owner, next);
      void next.then(() => pending.delete(owner), () => pending.delete(owner));
      return next;
    }
  };
}

export function nousTokenModel(settings: NousSettings, reason: NousTurnReason | "HELPER", mode: NousSpendMode): NousModelChoice {
  const kind = nousTurnKindOf(reason);
  const picked = nousModelFor(settings.models, reason);
  // Operator 8/11 (ops 100%→24%: Nous took 43% of it on Opus xhigh): a goal turn's "auto" runs the balanced class; an explicit model stays.
  const choice = kind === "goal" && picked.model === "auto" ? { ...picked, model: "auto-balanced" } : picked;
  if (mode === "NORMAL") return choice;
  // Goal turns are not downgraded further in low-spend mode (operator 2026-10-27); CRITICAL runs none at all (service.ts).
  if (kind === "goal") return choice;
  if (kind === "operator" || kind === "decision") return { ...choice, effort: NOUS_EFFORTS.indexOf(choice.effort) > NOUS_EFFORTS.indexOf("high") ? "high" : choice.effort };
  const low = nousSettingsWithProvider({ ...settings, lowSpend: settings.lowSpend ?? nousLowSpendSettingsSchema.parse({}) }).lowSpend;
  if (!low.cheaperModel) return choice;
  // A per-turn choice only: each mode's settings apply without replacing the stored normal models.
  return (mode === "CRITICAL" ? low.criticalModels : low.models)[kind];
}

type TokenModelContext = { settings: NousSettings; reason?: NousTurnReason | "HELPER"; choice?: NousModelChoice };
const modelLabel = (choice: NousModelChoice) => `${nousModelLabel(choice.model).replace(/^Claude /, "")}${choice.effort === "none" ? "" : ` (${choice.effort})`}`;
const automaticModelLabel = (settings: NousSettings, mode: NousSpendMode) => ([
  ["INBOX", "inbox"], ["STANDING", "standing/heartbeat/review"], ["HELPER", "helper"]
] as const).map(([reason, label]) => `${label}: ${modelLabel(nousTokenModel(settings, reason, mode))}`).join("; ");

export function renderNousTokenSummary(tokens: NousTokens, zone: string, now = Date.now(), context?: TokenModelContext): string {
  const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + ` ${zone}` : "unknown";
  const budget = tokens.budget;
  const api = budget?.budgetUsd != null && budget.spentUsd != null ? `$${budget.spentUsd.toFixed(2)} / $${budget.budgetUsd.toFixed(2)} spent, $${Math.max(0, budget.budgetUsd - budget.spentUsd).toFixed(2)} left` : "unknown";
  const codex = (tokens.accounts ?? []).filter((account) => account.provider === "CODEX" && paced(account)).map((account) => {
    const fiveHour = windowOf(account, 300);
    return `${account.alias ?? account.label} ${fiveHour ? `${nousWindowUsed(fiveHour, now) ?? "?"}%` : "none"}${account.resetCreditsAvailable ? ` (+${account.resetCreditsAvailable} reset${account.resetCreditsAvailable === 1 ? "" : "s"})` : ""}`;
  }).join(", ") || "unknown";
  const short = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  const pace = (provider: string) => (tokens.accounts ?? []).filter((account) => account.provider === provider && paced(account)).map((account) => {
    const week = gatewayWeekPace(account, now);
    return `${account.alias ?? account.label} ${week ? `${week.usedPercent ?? "?"}%/${week.passedPercent}% ${points(week.points)} ${week.pace ?? "unknown"} ${short(week.resetAt)}` : "unknown"}${paceToday(account, now)}`;
  }).join(", ") || "none";
  const hour = tokens.lastHour ? `$${tokens.lastHour.costUsd.toFixed(2)} API value (${tokens.lastHour.turns} turns, ${tokens.lastHour.unpricedTurns} unpriced)` : "unknown";
  const model = context ? context.reason ? `; model: ${modelLabel(context.choice ?? nousTokenModel(context.settings, context.reason, tokens.mode))} for ${context.reason}`
    : `; automatic models — ${automaticModelLabel(context.settings, tokens.mode)}` : "";
  const providers = renderNousProviderAdvice(tokens.accounts === null ? null : nousProviderRooms(tokens.accounts, tokens.api ?? null, now), short, zone);
  const asked = tokens.pending ? `; the samples ask ${tokens.pending.mode} since ${time(tokens.pending.since)}, in force once asked ${NOUS_MODE_HOLD_MS / 60_000} minutes` : "";
  const lost = tokens.lost ? `; lost at weekly resets, last 7 days (${zone}): ${lostAtResetText(tokens.lost, short)}` : "";
  return `Low-spend mode: ${tokens.mode} since ${time(tokens.since)}${tokens.mode !== "NORMAL" ? `; normal again ${tokens.control === "ON" ? "when Auto or Off is selected" : `at about ${time(tokens.resetAt)}`}` : ""}${asked} (${tokens.control})${model}.\n`
    + `Tokens: ${{ space: "Space routes", claude: "Claude Max", codex: "Codex", gemini: "Gemini", openai: "OpenAI API", openrouter: "OpenRouter", deepseek: "DeepSeek" }[tokens.provider ?? "claude"]} ${tokens.max ? `${tokens.max.withRoom}/${tokens.max.total} with room` : "unknown"}; next reset ${time(tokens.nextResetAt)}; API month ${api}; Codex 5-hour ${codex}; weekly pace (7-day used/week passed, points, reset in ${zone}; today used/allowance, background work HELD at it): Claude ${pace("CLAUDE")}; Codex ${pace("CODEX")}${lost}; Nous last hour ${hour}; serves Nous: ${tokens.serving}. Detail: space_token_state.\n${providers}`;
}

export function renderNousTokens(tokens: NousTokens, zone: string, now = Date.now(), context?: TokenModelContext): string {
  const time = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-GB", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) + ` ${zone}` : "unknown";
  const window = (value: Window) => `${nousWindowUsed(value, now) ?? "unknown"}% used; reset ${time(value.resetAt)}${value.resetAt && Date.parse(value.resetAt) <= now ? " (expired sample)" : ""}`;
  const accountWindows = (account: Pick<GatewayAccount, "primaryWindow" | "secondaryWindow">, withPace: boolean) => {
    const shown = windows(account).filter(sampled).sort((a, b) => a.windowMinutes! - b.windowMinutes!);
    const week = withPace ? gatewayWeekPace(account, now) : null;
    return (shown.map((entry) => `${windowLabel(entry.windowMinutes!)}: ${window(entry)}`).join("; ") || "no quota windows sampled")
      + (week ? `; week passed ${week.passedPercent}%, pace ${points(week.points)} ${week.pace ?? "unknown"}` : "");
  };
  return [renderNousTokenSummary(tokens, zone, now, context), `Sample read ${time(tokens.sampledAt)}; percentages are cached Gateway samples.`,
    `Weekly pace: points = 7-day used % minus the share of the week passed; AHEAD (above +${GATEWAY_PACE_BAND}) runs out before the reset, UNDER (below -${GATEWAY_PACE_BAND}) leaves tokens unused, ON is within ${GATEWAY_PACE_BAND}.`,
    `Today's allowance: (100 - the 7-day used % when the day began) / days left to the reset; a guide only: the pace cap is off (operator 7/11), so Space Gateway holds nothing by it; only a spent week (100%) stops an account.`,
    ...(context ? [`Cheaper model in low-spend mode: ${context.settings.lowSpend.cheaperModel ? "on" : "off"}. Automatic selections: ${automaticModelLabel(context.settings, tokens.mode)}.`] : []),
    ...(tokens.accounts === null ? ["Gateway account windows unavailable."] : tokens.accounts.filter((entry) => ["CLAUDE", "CODEX"].includes(entry.provider)
      || (entry.provider === "ANTIGRAVITY" && !["PAUSED", "DEACTIVATED"].includes(entry.status))).map((account) =>
      `- ${account.provider} ${account.alias ?? account.label} · ${account.status}${account.id === tokens.servingAccountId ? " · serves Nous" : ""}`
      + `${account.resetCreditsAvailable ? ` · ${account.resetCreditsAvailable} weekly reset credit${account.resetCreditsAvailable === 1 ? "" : "s"} (space_codex_reset_redeem)` : ""}: `
      + (account.planType === "api" ? "API account (no subscription windows)" : account.quotaGroups?.length
        ? account.quotaGroups.map((group) => `${group.key === "claude" ? "Claude · GPT" : group.key} models: ${accountWindows(group, true)}`).join(" | ") : accountWindows(account, paced(account)) + (paced(account) ? paceToday(account, now).replace(/^ today/, "; today used/allowance") : "")))),
    ...(tokens.api ?? []).map((account) => `- API ${account.label} · ${account.status}: ${[account.balance && `balance ${account.balance}`, account.remainingPercent != null && `${account.remainingPercent}% left`, account.detail].filter(Boolean).join("; ") || "no balance reported"}`)].join("\n");
}
