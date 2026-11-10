import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { gatewayProviderSchema, TOKEN_USAGE_PERIODS, tokenUsageRange, tokenUsageTotal, type NousTurnFacts, type TokenUsageBreakdown, type TokenUsageFigures,
  type TokenUsagePeriod, type TokenUsageProcess } from "@space/contracts";
import type { GatewayProjectDayUsage } from "@space/db";

/**
 * Token usage by process and provider (operator 5/11 17:26 BKK, plan clipboard:qH5emwVaV6yO): one read of Space Gateway's request logs per
 * period (and the period before), labelled. Nous's background project ("nous") is shared among its turns by the minute their requests ran
 * (Nous's own turn facts give each turn's kind and span); its operator turns and helpers carry their own project tags. No second count.
 */
export interface TokenUsageSources {
  projectUsage(since: string, until: string, timeZone: string, minutesOf?: string): Promise<GatewayProjectDayUsage[]>;
  turns(owner: string, since: string): Promise<Array<Pick<NousTurnFacts, "reason" | "startedAt" | "endedAt">>>;
  /** A pane's room, title and mode; null when the pane is gone. */
  pane(paneId: string): Promise<{ room: string | null; title: string; mode: string } | null>;
  /** Gateway API keys by id, naming untagged requests ("key:<id>") by the key they came with. */
  apiKeys?(): Promise<Array<{ id: string; name: string }>>;
}

const NOUS_KINDS: Record<string, string> = {
  OPERATOR: "operator turns", INBOX: "inbox turns", DECISION: "decision turns", HEARTBEAT: "away rounds", STANDING: "standing orders",
  REVIEW: "daily review", GOAL: "goal turns", HELPER: "helpers", OTHER: "between recorded turns"
};
const MODES: Record<string, string> = {
  JOB_APPLY: "Job Copilot", APP_STUDIO: "App Studio", FREELANCE_COPILOT: "Freelance Copilot", MAIL_COPILOT: "Mail Copilot",
  MARKETING_COPILOT: "Marketing Copilot", SECURITY_COPILOT: "Security Copilot", MONITORING_COPILOT: "Monitoring Copilot",
  DESIGN: "Design", VIDEO: "Video", TERMINAL: "CLI panes", BROWSER: "Browser"
};
const modeName = (mode: string) => MODES[mode] ?? mode.toLowerCase().split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");

const zero = (): TokenUsageFigures => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, costUsd: 0 });
function add(into: TokenUsageFigures, row: TokenUsageFigures) {
  into.requests += row.requests; into.inputTokens += row.inputTokens; into.cachedInputTokens += row.cachedInputTokens;
  into.cacheCreationTokens += row.cacheCreationTokens; into.outputTokens += row.outputTokens; into.costUsd += row.costUsd;
}
const byTotal = <T extends TokenUsageFigures>(rows: T[]) => rows.sort((a, b) => tokenUsageTotal(b) - tokenUsageTotal(a));

/**
 * The kind of the Nous turn running in each UTC minute ("YYYY-MM-DDTHH:MM"): every minute a turn touched, the latest-started turn winning
 * (background turns rarely overlap; the operator's and helpers' requests carry their own tags). A minute no turn touched is "OTHER".
 */
export function nousKindsByMinute(turns: Array<Pick<NousTurnFacts, "reason" | "startedAt" | "endedAt">>): Map<string, string> {
  const out = new Map<string, string>();
  for (const turn of [...turns].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const end = Date.parse(turn.endedAt);
    for (let at = Math.floor(Date.parse(turn.startedAt) / 60_000) * 60_000; at <= end; at += 60_000) out.set(new Date(at).toISOString().slice(0, 16), turn.reason);
  }
  return out;
}

/**
 * The category an untagged request's API key or client, or a CLI's own tag, belongs to (operator 5/11 20:25 BKK, nous_msg:563976acdd89421197f47443),
 * with the part it shows as inside it; null keeps the key on its own row. Claude Code (panes) is the pane CLIs' key: their requests before the
 * pane tag (2026-10-27) carry only it.
 */
export function keyCategory(name: string): { key: string; label: string; kind: TokenUsageProcess["kind"]; part: string } | null {
  if (name === "Claude Code (panes)") return { key: "mode:TERMINAL", label: modeName("TERMINAL"), kind: "pane", part: "without pane tag" };
  if (/^(spaceapp-pilot-rehearsal-|lab-)/.test(name)) return { key: "group:lab", label: "Lab / pilot rehearsals", kind: "other", part: name };
  if (CLI_TOOLS.has(name)) return { key: "group:cli", label: "CLI outside panes", kind: "other", part: name };
  if (/^(Space internal|Mission Control|MC |space-|nbpro-test-)|-free-proof$/.test(name)) return { key: "group:internal", label: "Space internal", kind: "other", part: name };
  return null;
}
const CLI_TOOLS = new Set(["Codex CLI", "Claude API credits (CLIs)", "OpenCode", "Oh My Pi", "Hermes", "DeepSeek Harness", "Reasonix (DeepSeek CLI)", "T3 Code"]);
/** Project tags CLIs send outside panes (agent-chat runs, the shared OpenCode server). */
const CLI_TAGS: Record<string, string> = { "claude-code": "Claude Code (outside panes)", "opencode": "OpenCode", "agent-chat": "Agent chat" };

/** A process key for a gateway row: Nous kinds by their own tags, everything else by its project tag. */
function processKey(project: string): string {
  if (project === "nous-operator") return "nous:OPERATOR";
  if (project === "nous-helper") return "nous:HELPER";
  return project;
}

/** `provider` narrows every figure to one Space Gateway provider (the phone's provider screen, operator 9/11 nous_msg:d818e183); never an account. */
export async function tokenUsageBreakdown(sources: TokenUsageSources, owner: string, period: TokenUsagePeriod, timeZone: string, now = Date.now(),
  provider?: string): Promise<TokenUsageBreakdown> {
  const range = tokenUsageRange(period, timeZone, now);
  const read = async (since: string, until: string, minutesOf?: string) => (await sources.projectUsage(since, until, timeZone, minutesOf))
    .filter((row) => provider === undefined || row.provider === provider);
  const [rows, before, minutes, minutesBefore, turns] = await Promise.all([
    read(range.since, range.until), read(range.previousSince, range.previousUntil),
    read(range.since, range.until, "nous"), read(range.previousSince, range.previousUntil, "nous"),
    // A turn that started up to a day before the span can still run into it.
    sources.turns(owner, new Date(Date.parse(range.previousSince) - 86_400_000).toISOString())]);
  const kinds = nousKindsByMinute(turns);

  const processFigures = (dayRows: GatewayProjectDayUsage[], minuteRows: GatewayProjectDayUsage[]) => {
    const out = new Map<string, TokenUsageFigures>();
    const put = (key: string, row: TokenUsageFigures) => { const entry = out.get(key) ?? zero(); add(entry, row); out.set(key, entry); };
    for (const row of dayRows) if (row.project !== "nous") put(processKey(row.project), row);
    for (const row of minuteRows) put(`nous:${kinds.get(row.day) ?? "OTHER"}`, row);
    return out;
  };
  const current = processFigures(rows, minutes);
  const previous = processFigures(before, minutesBefore);

  // Operator 5/11: categories only (App Studio, Freelance Copilot, Nous · goal turns...), never a room or pane name or id.
  type Category = Pick<TokenUsageProcess, "key" | "label" | "kind"> & { part?: string };
  const keyNames = new Map((await sources.apiKeys?.().catch(() => []) ?? []).map((key) => [key.id, key.name]));
  const categoryOf = async (key: string): Promise<Category> => {
    if (key.startsWith("nous:")) return { key, label: `Nous · ${NOUS_KINDS[key.slice(5)] ?? key.slice(5).toLowerCase()}`, kind: "nous" };
    if (key.startsWith("pane:")) {
      const pane = await sources.pane(key).catch(() => null);
      if (!pane) return { key: "mode:CLOSED", label: "Closed or removed panes", kind: "pane" };
      return { key: `mode:${pane.mode}`, label: modeName(pane.mode), kind: pane.mode === "TERMINAL" || pane.mode === "BROWSER" ? "pane" : "copilot" };
    }
    // Untagged requests (CLIs on a gateway key, logs from before project tags): by the key's category, else the key, else the client (a CLI
    // without a key); only the rest is unattributed.
    if (key.startsWith("key:")) {
      const name = keyNames.get(key.slice(4));
      // Keys sharing a name (deleted keys) are one row.
      return (name && keyCategory(name)) || { key: `key:${name ?? "deleted key"}`, label: `API key · ${name ?? "deleted key"}`, kind: "other" };
    }
    if (key.startsWith("client:") && key !== "client:Other") return { key: "group:cli", label: "CLI outside panes", kind: "other", part: `${key.slice(7)} (no key)` };
    if (CLI_TAGS[key]) return { key: "group:cli", label: "CLI outside panes", kind: "other", part: CLI_TAGS[key] };
    if (!key || key === "client:Other") return { key: "", label: "Other (unattributed)", kind: "other" };
    return { key, label: key, kind: "other" };
  };
  const categories = new Map<string, Category>();
  for (const key of new Set([...current.keys(), ...previous.keys()])) categories.set(key, await categoryOf(key));
  const group = (figures: Map<string, TokenUsageFigures>) => {
    const out = new Map<string, Omit<Category, "part"> & { figures: TokenUsageFigures; panes: number; parts: Map<string, TokenUsageFigures> }>();
    for (const [key, row] of figures) {
      const { part, ...category } = categories.get(key)!;
      const entry = out.get(category.key) ?? { ...category, figures: zero(), panes: 0, parts: new Map() };
      add(entry.figures, row);
      if (key.startsWith("pane:")) entry.panes += 1;
      if (part) { const sum = entry.parts.get(part) ?? zero(); add(sum, row); entry.parts.set(part, sum); }
      out.set(category.key, entry);
    }
    return out;
  };
  const grouped = group(current);
  const groupedBefore = group(previous);

  const processes = byTotal([...grouped.values()].map(({ figures, panes, parts, ...category }): TokenUsageProcess => ({ ...category,
    detail: panes ? `${panes} ${category.key === "mode:CLOSED" ? "closed " : ""}pane${panes === 1 ? "" : "s"}` : null, ...figures,
    ...(parts.size ? { parts: byTotal([...parts.entries()].map(([label, sum]) => ({ label, ...sum }))) } : {}) })));
  const risers = [...new Set([...grouped.keys(), ...groupedBefore.keys()])].map((key) => {
    const { label, kind } = (grouped.get(key) ?? groupedBefore.get(key))!;
    return { key, label, kind, tokens: grouped.has(key) ? tokenUsageTotal(grouped.get(key)!.figures) : 0,
      before: groupedBefore.has(key) ? tokenUsageTotal(groupedBefore.get(key)!.figures) : 0 };
  }).filter((entry) => entry.tokens > entry.before).sort((a, b) => (b.tokens - b.before) - (a.tokens - a.before)).slice(0, 10);

  const providers = new Map<string, TokenUsageFigures>();
  const models = new Map<string, TokenUsageFigures>();
  const days = new Map<string, Record<string, number>>();
  const totals = zero();
  for (const row of rows) {
    add(totals, row);
    for (const [map, key] of [[providers, row.provider], [models, row.model]] as const) { const sum = map.get(key) ?? zero(); add(sum, row); map.set(key, sum); }
    const day = days.get(row.day) ?? {};
    day[row.provider] = (day[row.provider] ?? 0) + tokenUsageTotal(row);
    days.set(row.day, day);
  }
  const previousTotals = zero();
  for (const row of before) add(previousTotals, row);
  const list = (map: Map<string, TokenUsageFigures>) => byTotal([...map.entries()].map(([key, figures]) => ({ key, ...figures })));
  return { period, ...(provider === undefined ? {} : { provider }), timeZone, ...range, totals, previousTotals, processes,
    providers: list(providers), models: list(models),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, byProvider]) => ({ day, providers: byProvider })), risers };
}

/** Nous's world lines: the top consumers today and over 7 days, by process and by provider. */
export function tokenUsageWorldLines(today: TokenUsageBreakdown, week: TokenUsageBreakdown): string {
  const fmt = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
  const top = (rows: Array<TokenUsageFigures & { label?: string; key: string }>, total: number) => rows.slice(0, 5)
    .map((row) => `${row.label ?? row.key} ${fmt(tokenUsageTotal(row))} (${total ? Math.round(tokenUsageTotal(row) / total * 100) : 0}%, ${row.requests} req, ${fmt(row.requests ? row.inputTokens / row.requests : 0)}/req, $${row.costUsd.toFixed(0)})`).join("; ");
  const line = (name: string, data: TokenUsageBreakdown) => {
    const total = tokenUsageTotal(data.totals);
    const change = tokenUsageTotal(data.previousTotals) ? ` (${Math.round((total / tokenUsageTotal(data.previousTotals) - 1) * 100)}% against the same span before)` : "";
    return [`- ${name}: ${fmt(total)} tokens, ${data.totals.requests} requests, $${data.totals.costUsd.toFixed(0)}${change}`,
      `  - by process: ${top(data.processes, total) || "none"}`, `  - by provider: ${top(data.providers, total) || "none"}`].join("\n");
  };
  return ["## Token usage (Space Gateway; space_token_usage {period: day|week|month} reads the whole breakdown and risers)",
    line("Today so far", today), line("Last 7 days", week)].join("\n");
}

/** One answer per owner and period for a minute: the dock refreshes, Nous reads it each turn, and a month reads two months of request logs. */
export function cachedTokenUsage(read: (owner: string, period: TokenUsagePeriod, provider?: string) => Promise<TokenUsageBreakdown>, ttlMs = 60_000, now = () => Date.now()) {
  const cache = new Map<string, { at: number; value: Promise<TokenUsageBreakdown> }>();
  return (owner: string, period: TokenUsagePeriod, provider?: string) => {
    const key = `${owner}\0${period}\0${provider ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = read(owner, period, provider);
    cache.set(key, { at: now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
}

/**
 * GET /api/nous/token-usage?period=day|week|month[&provider=CLAUDE] (ADMIN: it shows every process and provider of the install; operator 6/11,
 * nous_msg:781819c5: never per account). `provider` narrows it to one Space Gateway provider.
 */
export function registerTokenUsageRoute(app: FastifyInstance, deps: { routeOptions: Record<string, unknown>; owner(request: FastifyRequest): Promise<string>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  read?(owner: string, period: TokenUsagePeriod, provider?: string): Promise<TokenUsageBreakdown> }): void {
  const query = z.object({ period: z.enum(TOKEN_USAGE_PERIODS).default("day"), provider: gatewayProviderSchema.optional() }).strict();
  app.get("/api/nous/token-usage", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (request.user?.role !== "ADMIN") throw Object.assign(new Error("Token usage is available to administrators."), { statusCode: 403 });
    // Registered without Space Gateway's logs too (public installs, tests), so the phone's allowlist names a route that always exists.
    if (!deps.read) throw Object.assign(new Error("Token usage needs Space Gateway's request logs."), { statusCode: 404 });
    const { period, provider } = deps.parseQuery(query, request.query);
    return deps.read(owner, period, provider);
  });
}

/** space_token_usage's answer: every process, provider and day of the period, and the risers. */
export function renderTokenUsage(data: TokenUsageBreakdown): string {
  const fmt = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(Math.round(value));
  const total = tokenUsageTotal(data.totals);
  const figures = (row: TokenUsageFigures) => `${fmt(tokenUsageTotal(row))} (${total ? (tokenUsageTotal(row) / total * 100).toFixed(1) : "0"}%): ${row.requests} req, input ${fmt(row.inputTokens)}`
    + ` (cache re-read ${fmt(row.cachedInputTokens)}, cache write ${fmt(row.cacheCreationTokens)}), output ${fmt(row.outputTokens)}, ${fmt(row.requests ? row.inputTokens / row.requests : 0)}/req, $${row.costUsd.toFixed(2)}`;
  const before = tokenUsageTotal(data.previousTotals);
  return [`Token usage, ${data.period} (${data.since.slice(0, 16)} to ${data.until.slice(0, 16)} UTC, days in ${data.timeZone}): ${figures(data.totals)}`
    + `; the same span before: ${fmt(before)}${before ? ` (${Math.round((total / before - 1) * 100)}%)` : ""}.`,
  "By process:", ...data.processes.flatMap((row) => [`- ${row.label}${row.detail ? ` [${row.detail}]` : ""} (${row.key}): ${figures(row)}`,
    ...(row.parts ?? []).map((part) => `  - ${part.label}: ${figures(part)}`)]),
  "By provider:", ...data.providers.map((row) => `- ${row.key}: ${figures(row)}`),
  "By model:", ...(data.models ?? []).map((row) => `- ${row.key}: ${figures(row)}`),
  "By day:", ...data.days.map((day) => `- ${day.day}: ${Object.entries(day.providers).sort((a, b) => b[1] - a[1]).map(([provider, tokens]) => `${provider} ${fmt(tokens)}`).join(", ")}`),
  "Grew most against the span before:", ...(data.risers.length ? data.risers.map((row) => `- ${row.label}: ${fmt(row.before)} → ${fmt(row.tokens)}`) : ["- nothing grew"])].join("\n");
}
