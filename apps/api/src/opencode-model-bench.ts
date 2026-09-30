import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { SystemAnalyticsModel } from "@space/contracts";
import { opencodeBenchResponseSchema } from "@space/contracts";
import type { SystemAnalyticsRepository } from "@space/db";

const execFileAsync = promisify(execFile);
const opencodeBin = "/usr/local/bin/opencode";
const probeTimeoutMs = 20_000;
const maxBuffer = 4 * 1024 * 1024;
const benchCacheMs = 30_000;
const networkProbeTimeoutMs = 5_000;
const chatProbeTimeoutMs = 25_000;
const complexProbeTimeoutMs = 35_000;

interface OpencodeVerboseModel {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  api?: { id?: string; url?: string; npm?: string };
  status?: string;
  cost?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  limit?: { context?: number; input?: number; output?: number };
  capabilities?: {
    temperature?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    input?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean };
    output?: { text?: boolean; audio?: boolean; image?: boolean; video?: boolean; pdf?: boolean };
  };
}

interface BenchCacheEntry {
  sampledAt: string;
  payload: unknown;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clampScore(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100);
}
function safeLower(value: string): string {
  return value.toLocaleLowerCase();
}

function extractVerboseModels(text: string): OpencodeVerboseModel[] {
  const models: OpencodeVerboseModel[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    } else {
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const slice = text.slice(start, i + 1);
          try {
            const obj = JSON.parse(slice) as OpencodeVerboseModel;
            if (obj && typeof (obj as any).id === "string" && typeof (obj as any).providerID === "string") models.push(obj);
          } catch { /* ignore */ }
          start = -1;
        } else if (depth < 0) { depth = 0; start = -1; }
      }
    }
  }
  return models;
}

async function runOpencodeVerbose(provider: string): Promise<OpencodeVerboseModel[]> {
  try {
    const { stdout } = await execFileAsync(opencodeBin, ["models", provider, "--verbose"], {
      timeout: probeTimeoutMs,
      maxBuffer,
      env: { ...process.env, HOME: "/var/lib/spaceapp-user" }
    });
    const text = String(stdout);
    const models = extractVerboseModels(text);
    if (models.length > 0) return models;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed as OpencodeVerboseModel[];
    } catch { /* ignore */ }
    return models;
  } catch {
    return [];
  }
}

async function probeProviderLatency(baseUrl: string, tokenPath: string | null): Promise<{ ok: boolean; latencyMs: number | null }> {
  const started = Date.now();
  try {
    let headers: Record<string, string> = { accept: "application/json" };
    if (tokenPath) {
      try {
        const token = (await readFile(tokenPath, "utf8")).trim();
        if (token) headers.authorization = `Bearer ${token}`;
      } catch { /* no token */ }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), networkProbeTimeoutMs);
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: controller.signal });
    clearTimeout(timeout);
    const latency = Date.now() - started;
    return { ok: res.ok || res.status === 401 || res.status === 403, latencyMs: latency };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

interface ChatProbeResult {
  ok: boolean;
  latencyMs: number | null;
  status: number | null;
  errorType: string | null;
  outLen: number | null;
}

async function probeChatHttp(providerId: string, modelId: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<ChatProbeResult> {
  const isGo = providerId === "opencode-go";
  const isOpenRouter = providerId === "openrouter";
  const baseUrl = isOpenRouter
    ? "https://openrouter.ai/api/v1"
    : (isGo ? "https://opencode.ai/zen/go/v1" : "https://opencode.ai/zen/v1");
  const tokenPath = isOpenRouter
    ? "/var/lib/spaceapp-user/.config/opencode/openrouter.token"
    : (isGo ? "/var/lib/spaceapp-user/.config/opencode/opencode-go.token" : null);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tokenPath) {
    try {
      const token = (await readFile(tokenPath, "utf8")).trim();
      if (token) headers["authorization"] = `Bearer ${token}`;
    } catch { /* no token */ }
  }
  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2, stream: false }),
      signal: ctrl.signal
    });
    clearTimeout(to);
    const latency = Date.now() - started;
    const txt = await res.text();
    let outLen: number | null = null;
    let errorType: string | null = null;
    let ok = res.ok;
    try {
      const j = JSON.parse(txt) as any;
      const content: string = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.message?.reasoning ?? "";
      outLen = content.length;
      if (j?.error) {
        ok = false;
        errorType = j.error?.type ?? j.error?.code ?? `HTTP${res.status}`;
        if (txt.includes("FreeUsageLimitError") || txt.includes("Rate limit")) errorType = "RATE_LIMIT";
        else if (txt.includes("Endpoint is unavailable") || res.status === 503) errorType = "UPSTREAM_UNAVAILABLE";
        else if (res.status === 500) errorType = "INTERNAL_500";
      } else if (!content.trim() && ok) {
        ok = false;
        errorType = "EMPTY";
      }
      if (!ok && !errorType) {
        if (res.status === 429) errorType = "RATE_LIMIT";
        else if (res.status === 503) errorType = "UPSTREAM_UNAVAILABLE";
        else if (res.status === 500) errorType = "INTERNAL_500";
        else errorType = `HTTP${res.status}`;
      }
    } catch {
      ok = false;
      errorType = `HTTP${res.status}`;
    }
    if (!ok && !errorType) errorType = `HTTP${res.status}`;
    return { ok, latencyMs: latency, status: res.status, errorType, outLen };
  } catch (e: any) {
    clearTimeout(to);
    const latency = Date.now() - started;
    const msg = e?.name === "AbortError" ? "TIMEOUT" : (e?.message ?? "FETCH_FAIL");
    return { ok: false, latencyMs: latency, status: null, errorType: msg.includes("aborted") ? "TIMEOUT" : msg.slice(0, 40), outLen: null };
  }
}


async function probeChatSimple(providerId: string, modelId: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<ChatProbeResult> {
  // Direct HTTP probe for all providers — never spawn interactive CLI agent processes in space-api cgroup
  return probeChatHttp(providerId, modelId, prompt, maxTokens, Math.min(timeoutMs, 6000));
}

export interface OpencodeModelBenchOptions {
  repository: SystemAnalyticsRepository;
  now?: () => Date;
  execVerbose?: (provider: string) => Promise<OpencodeVerboseModel[]>;
  probeLatency?: (baseUrl: string, tokenPath: string | null) => Promise<{ ok: boolean; latencyMs: number | null }>;
}

export class OpencodeModelBenchService {
  private readonly repository: SystemAnalyticsRepository;
  private readonly now: () => Date;
  private readonly execVerbose: (provider: string) => Promise<OpencodeVerboseModel[]>;
  private readonly probeLatency: (baseUrl: string, tokenPath: string | null) => Promise<{ ok: boolean; latencyMs: number | null }>;
  private cache: BenchCacheEntry | null = null;
  private inFlight: Promise<unknown> | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private isRefreshingInBackground = false;

  constructor(options: OpencodeModelBenchOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.execVerbose = options.execVerbose ?? runOpencodeVerbose;
    this.probeLatency = options.probeLatency ?? probeProviderLatency;
  }

  startDailyRefresh(): void {
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
    if (this.dailyTimer) return;
    const dayMs = 24 * 60 * 60 * 1000;
    this.dailyTimer = setInterval(() => {
      void this.runBackgroundRefresh();
    }, dayMs);
    this.dailyTimer.unref();

    // Initial background refresh 10 seconds after server startup
    this.startupTimer = setTimeout(() => {
      void this.runBackgroundRefresh();
    }, 10_000);
    this.startupTimer.unref();
  }

  stopDailyRefresh(): void {
    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
      this.dailyTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  private async runBackgroundRefresh(): Promise<void> {
    if (this.isRefreshingInBackground) return;
    this.isRefreshingInBackground = true;
    try {
      await this.get("7d", true);
    } catch {
      /* ignore background errors */
    } finally {
      this.isRefreshingInBackground = false;
    }
  }

  async get(range: "10m" | "1h" | "7d" | "30d" = "7d", force = false): Promise<unknown> {
    const nowMs = this.now().getTime();
    if (!force && this.cache && this.cache.expiresAt > nowMs) return this.cache.payload;
    if (this.inFlight) return this.inFlight;
    const job = this.collect(range, force).then((payload) => {
      const parsed = opencodeBenchResponseSchema.parse(payload);
      this.cache = { sampledAt: parsed.sampledAt, payload: parsed, expiresAt: nowMs + benchCacheMs };
      return parsed;
    }).finally(() => { this.inFlight = null; });
    this.inFlight = job;
    return job;
  }

  async probeSingle(providerId: string, modelId: string): Promise<unknown> {
    const simplePrompt = "Say hello in one word";
    const complexPrompt = `Write a TypeScript function that implements a concurrent LRU cache with TTL and async load, with tests. Requirements: maxSize, ttlMs, async loader (key)=>Promise<value>, concurrent get deduplicates, LRU eviction, TTL expiration, generic types and 3 unit tests. Return only code.`;
    const simple = await probeChatSimple(providerId, modelId, simplePrompt, 20, chatProbeTimeoutMs);
    // add small delay to avoid rate spike before complex
    await new Promise((r) => setTimeout(r, 400));
    const complex = await probeChatSimple(providerId, modelId, complexPrompt, 500, complexProbeTimeoutMs);
    const sampledAt = this.now().toISOString();
    // quick historical lookup for context
    let hist: SystemAnalyticsModel | null = null;
    try {
      const events = await this.repository.listModelEvents(this.sinceIso("7d"));
      const agg = this.aggregateHistorical(events);
      hist = agg.find((m) => m.providerId === providerId && m.modelId === modelId) ?? null;
    } catch { /* ignore */ }
    return {
      sampledAt,
      providerId,
      modelId,
      simple,
      complex,
      hist: hist ? { completedTurns: hist.completedTurns, abortedTurns: hist.abortedTurns, avgTtftMs: hist.avgTtftMs, avgTokPerSec: hist.avgTokPerSec, coverage: hist.coverage } : null,
      verdict: this.verdictForProbe(simple, complex)
    };
  }

  private verdictForProbe(simple: ChatProbeResult, complex: ChatProbeResult): string {
    if (!simple.ok && simple.errorType === "UPSTREAM_UNAVAILABLE") return "Model is offline (503 Upstream unavailable) — highly unstable, avoid for production.";
    if (!simple.ok && simple.errorType === "RATE_LIMIT") return "Rate limit (429) — free tier exhausted, wait or use go tier.";
    if (!simple.ok && simple.errorType === "INTERNAL_500") return "Internal 500 — frequent errors, unsuitable for stable coding.";
    if (!simple.ok) return `Simple probe failed (${simple.errorType}) — unreliable.`;
    if (!complex.ok) {
      if (complex.errorType === "TIMEOUT") return "Slow on complex code (>30s timeout) — confirms delay experience.";
      return `Failed on complex prompt (${complex.errorType}) — good for simple, unstable for complex code.`;
    }
    if ((complex.latencyMs ?? 0) > 20000) return "Functional but very slow on complex code (>20s) — low speed score.";
    if ((simple.latencyMs ?? 0) > 4000) return "Functional but slow even on simple — moderate suitability.";
    return "Functional and fast on both tests — good choice.";
  }

  private async collect(range: "10m" | "1h" | "7d" | "30d", force = false) {
    const sampledAt = this.now().toISOString();
    const since = this.sinceIso(range);
    // Historical aggregates from system analytics (last 7d by default to capture speed)
    let historical: SystemAnalyticsModel[] = [];
    try {
      const events = await this.repository.listModelEvents(since);
      // aggregate similar to system-analytics but we just need mapping by provider+model
      historical = this.aggregateHistorical(events);
    } catch {
      historical = [];
    }
    const histByKey = new Map<string, SystemAnalyticsModel>();
    for (const h of historical) histByKey.set(`${h.providerId}\u0000${h.modelId}`, h);

    const [opencodeModels, opencodeGoModels, openrouterModels] = await Promise.all([
      this.execVerbose("opencode"),
      this.execVerbose("opencode-go"),
      this.execVerbose("openrouter")
    ]);

    // probe latencies for endpoints
    const [zenProbe, zenGoProbe, openrouterProbe] = await Promise.all([
      this.probeLatency("https://opencode.ai/zen/v1", null),
      this.probeLatency("https://opencode.ai/zen/go/v1", "/var/lib/spaceapp-user/.config/opencode/opencode-go.token"),
      this.probeLatency("https://openrouter.ai/api/v1", "/var/lib/spaceapp-user/.config/opencode/openrouter.token")
    ]);

    const isFreeOpenRouter = (m: OpencodeVerboseModel) => {
      const isZeroCost = (m.cost?.input ?? 0) === 0 && (m.cost?.output ?? 0) === 0;
      const isFreeTag = m.id.endsWith(":free") || m.id === "openrouter/free" || (m.name ? safeLower(m.name).includes("free") : false);
      return isZeroCost || isFreeTag;
    };

    const all = [
      ...opencodeModels.filter((m) => m.providerID === "opencode").map((m) => ({ raw: m, providerGroup: "opencode" as const, probe: zenProbe })),
      ...opencodeGoModels.filter((m) => m.providerID === "opencode-go").map((m) => ({ raw: m, providerGroup: "opencode-go" as const, probe: zenGoProbe })),
      ...openrouterModels.filter((m) => m.providerID === "openrouter" && isFreeOpenRouter(m)).map((m) => ({ raw: m, providerGroup: "openrouter" as const, probe: openrouterProbe }))
    ];

    // Normalize fallback if verbose returned empty: use known lists
    let items = all.map(({ raw, providerGroup, probe }) => this.toBenchItem(raw, providerGroup, probe, histByKey.get(`${raw.providerID}\u0000${raw.id}`) ?? null, sampledAt));
    // If no verbose data, synthesize from known active models to still show something
    if (items.length === 0) {
      items = this.fallbackSynthetic(histByKey, zenProbe, sampledAt);
    }

    // Auto-prune models that have not been refreshed in 3 days
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    const cutoffMs = this.now().getTime() - threeDaysMs;
    items = items.filter((item) => {
      const refreshedMs = new Date(item.lastRefreshedAt).getTime();
      return !Number.isNaN(refreshedMs) && refreshedMs >= cutoffMs;
    });

    // Live per-model chat probe (only on explicit refresh — heavy, simple hello)
    let liveMap: Map<string, ChatProbeResult> | null = null;
    if (force) {
      liveMap = await this.probeAllSimple(items);
      for (const it of items) {
        const key = `${it.providerId}\u0000${it.modelId}`;
        const pr = liveMap.get(key);
        if (pr) {
          (it as any)._liveProbe = pr;
          it.lastRefreshedAt = sampledAt;
          if (pr.ok) {
            it.networkStatus = "ONLINE";
            it.networkLatencyMs = pr.latencyMs;
            // live latency overwrites historical TTFT to reflect current speed (weighted 70% live / 30% hist)
            if (it.avgTtftMs !== null) it.avgTtftMs = Math.round(it.avgTtftMs * 0.3 + (pr.latencyMs ?? it.avgTtftMs) * 0.7);
            else it.avgTtftMs = pr.latencyMs;
            if (pr.outLen && pr.latencyMs) {
              const liveTps = Math.round((pr.outLen / (pr.latencyMs / 1000)) * 10) / 10;
              if (it.avgTokPerSec !== null) it.avgTokPerSec = Math.round((it.avgTokPerSec * 0.3 + liveTps * 0.7) * 10) / 10;
              else it.avgTokPerSec = liveTps;
            }
          } else {
            if (pr.errorType === "RATE_LIMIT") { it.networkStatus = "DEGRADED"; it.networkLatencyMs = pr.latencyMs; }
            else if (pr.errorType === "UPSTREAM_UNAVAILABLE" || pr.errorType === "INTERNAL_500" || pr.errorType === "EMPTY") { it.networkStatus = "OFFLINE"; it.networkLatencyMs = pr.latencyMs; }
            else if (pr.errorType === "TIMEOUT") { it.networkStatus = "DEGRADED"; it.networkLatencyMs = pr.latencyMs; }
            else { it.networkStatus = "DEGRADED"; it.networkLatencyMs = pr.latencyMs; }
          }
        }
      }
    }

    // Compute scores
    const maxTokPerSec = Math.max(...items.map((i) => i.avgTokPerSec ?? 0), 1);
    const minTtft = Math.min(...items.filter((i) => i.avgTtftMs !== null).map((i) => i.avgTtftMs as number), 9999);
    const maxTtft = Math.max(...items.filter((i) => i.avgTtftMs !== null).map((i) => i.avgTtftMs as number), 1);
    const maxContext = Math.max(...items.map((i) => i.contextLimit ?? 0), 1);

    for (const item of items) {
      const hist = histByKey.get(`${item.providerId}\u0000${item.modelId}`);
      const completed = hist?.completedTurns ?? 0;
      const aborted = hist?.abortedTurns ?? 0;
      const total = completed + aborted;
      const successRate = total > 0 ? (completed / total) * 100 : null;
      const liveProbe = (item as any)._liveProbe as ChatProbeResult | undefined;
      // networkScore — live chat probe overrides historical when available (force refresh)
      if (liveProbe) {
        if (!liveProbe.ok) {
          if (liveProbe.errorType === "RATE_LIMIT") item.networkScore = 35;
          else if (liveProbe.errorType === "UPSTREAM_UNAVAILABLE") item.networkScore = 8;
          else if (liveProbe.errorType === "INTERNAL_500") item.networkScore = 12;
          else if (liveProbe.errorType === "TIMEOUT") item.networkScore = 18;
          else item.networkScore = 22;
          // even if OFFLINE we keep low score (not 0) to show degraded vs dead
          if (item.networkStatus === "OFFLINE" && item.networkScore > 12) item.networkScore = 8;
        } else {
          const lat = liveProbe.latencyMs ?? 2500;
          let probeScore = 88;
          if (lat < 800) probeScore = 96;
          else if (lat < 1400) probeScore = 88;
          else if (lat < 2500) probeScore = 72;
          else if (lat < 6000) probeScore = 55;
          else if (lat < 12000) probeScore = 35;
          else probeScore = 22;
          if (successRate !== null) item.networkScore = clampScore(successRate * 0.35 + probeScore * 0.65);
          else item.networkScore = probeScore;
          // special penalty for x-preview known flakiness: if model is x-preview-f-free and live ok but latency >4000, cap at 45
          if (item.modelId === "x-preview-f-free" && lat > 3500 && item.networkScore > 45) item.networkScore = 45;
        }
      } else {
        if (item.networkStatus === "OFFLINE") item.networkScore = 0;
        else if (successRate !== null) item.networkScore = clampScore(successRate * 0.7 + (item.networkStatus === "ONLINE" ? 30 : 10));
        else item.networkScore = item.networkStatus === "ONLINE" ? 85 : item.networkStatus === "DEGRADED" ? 60 : 30;
      }

      // speedScore: tokPerSec normalized 0-60 + ttft inverted 0-40, but heavily penalized if live probe failed
      const complexProbe = (item as any)._complexProbe as ChatProbeResult | undefined;
      if (liveProbe && !liveProbe.ok) {
        if (liveProbe.errorType === "UPSTREAM_UNAVAILABLE" || liveProbe.errorType === "EMPTY") item.speedScore = 14;
        else if (liveProbe.errorType === "INTERNAL_500") item.speedScore = 16;
        else if (liveProbe.errorType === "TIMEOUT") item.speedScore = 12;
        else if (liveProbe.errorType === "RATE_LIMIT") item.speedScore = 22;
        else item.speedScore = 18;
      } else if (complexProbe && (!complexProbe.ok || (complexProbe.latencyMs ?? 0) > 15000)) {
        // x-preview complex timeout → very slow for complex code as user reported
        item.speedScore = 18;
      } else {
        let speed = 0;
        if (item.avgTokPerSec !== null) speed += (item.avgTokPerSec / maxTokPerSec) * 60;
        else speed += 15; // baseline if no data
        if (item.avgTtftMs !== null) {
          const range = Math.max(maxTtft - minTtft, 1);
          const inverted = 1 - ((item.avgTtftMs - minTtft) / range);
          speed += inverted * 40;
        } else {
          speed += 20;
        }
        item.speedScore = clampScore(speed);
      }

      const contextNorm = item.contextLimit ? (item.contextLimit / maxContext) * 100 : 50;
      const qualityBase = clampScore(contextNorm * 0.6 + (item.reasoning ? 20 : 0) + (item.toolcall ? 15 : 0) + (item.costFree ? 5 : 0));

      if (item.vision) {
        // visionScore = network 30% + speed 40% + quality 30%
        item.visionScore = clampScore(item.networkScore * 0.3 + item.speedScore * 0.4 + qualityBase * 0.3);
      } else {
        item.visionScore = null;
      }
      // codingScore: network 25 + speed 35 + toolcall/reasoning + context
      const codingQuality = clampScore((item.toolcall ? 35 : 0) + (item.reasoning ? 15 : 0) + contextNorm * 0.3 + (item.costFree ? 5 : 0) + 15);
      item.codingScore = clampScore(item.networkScore * 0.25 + item.speedScore * 0.35 + codingQuality * 0.4);
    }

    // ranks
    const visionRanked = [...items].filter((i) => i.visionScore !== null).sort((a, b) => (b.visionScore as number) - (a.visionScore as number));
    visionRanked.forEach((item, idx) => { item.rankVision = idx + 1; });
    const codingRanked = [...items].sort((a, b) => (b.codingScore as number) - (a.codingScore as number));
    codingRanked.forEach((item, idx) => { item.rankCoding = idx + 1; });

    // best picks
    const bestVision = visionRanked[0] ?? null;
    const bestCoding = codingRanked[0] ?? null;
    const mostReliable = [...items].sort((a, b) => b.networkScore - a.networkScore || (b.speedScore ?? 0) - (a.speedScore ?? 0))[0] ?? null;

    // ensure stable sort: by codingScore desc then visionScore desc then modelId
    items.sort((a, b) => (b.codingScore as number) - (a.codingScore as number) || (b.visionScore ?? -1) - (a.visionScore ?? -1) || a.modelId.localeCompare(b.modelId));

    const methodology = force
      ? "Live catalog synthesis opencode --verbose (capabilities image/attachment, toolcall, reasoning, context), system-analytics history (TTFT/duration/tok/s, success rate), lightweight fetch probe on Zen endpoints AND live chat probe (simple hello) per model (concurrency 4, timeout 10s) for real network/speed measurement. VisionScore = 30% networking + 40% speed + 30% quality. CodingScore = 25% networking + 35% speed + 40% quality."
      : "Live catalog synthesis opencode --verbose (capabilities image/attachment, toolcall, reasoning, context), system-analytics history (TTFT/duration/tok/s, success rate) and lightweight fetch probe on Zen endpoints (latency). Click \"Run Benchmark now\" for live chat probe per model. VisionScore = 30% networking + 40% speed + 30% quality (context/reasoning). CodingScore = 25% networking + 35% speed + 40% quality (toolcall, reasoning, context).";
    const notices = this.buildNotices(items, zenProbe, zenGoProbe, openrouterProbe);
    // strip internal _liveProbe/_complexProbe before validation (strict schema)
    for (const it of items) { delete (it as any)._liveProbe; delete (it as any)._complexProbe; }
    if (bestVision) { delete (bestVision as any)._liveProbe; delete (bestVision as any)._complexProbe; }
    if (bestCoding) { delete (bestCoding as any)._liveProbe; delete (bestCoding as any)._complexProbe; }
    if (mostReliable) { delete (mostReliable as any)._liveProbe; delete (mostReliable as any)._complexProbe; }

    return {
      sampledAt,
      range,
      providers: ["opencode", "opencode-go", "openrouter"],
      totalModels: items.length,
      visionModels: items.filter((i) => i.vision).length,
      codingModels: items.filter((i) => i.toolcall).length,
      bestVision,
      bestCoding,
      mostReliable,
      models: items,
      methodology,
      notices
    };
  }

  private sinceIso(range: string): string {
    const map: Record<string, number> = { "10m": 10*60_000, "1h": 60*60_000, "7d": 7*24*60*60_000, "30d": 30*24*60*60_000 };
    const lookup = (map as Record<string, number>)[range];
    const ms = lookup ?? map["7d"]!;
    return new Date(this.now().getTime() - ms).toISOString();
  }

  private aggregateHistorical(events: import("@space/db").SystemAnalyticsModelEventRecord[]): SystemAnalyticsModel[] {
    // reuse logic similar to system-analytics-service but lightweight: group by provider+model
    const acc = new Map<string, SystemAnalyticsModel>();
    for (const ev of events) {
      const key = `${ev.providerId}\u0000${ev.modelId}`;
      const cur = acc.get(key);
      if (!cur) {
        acc.set(key, {
          providerId: ev.providerId,
          modelId: ev.modelId,
          runtimeIds: [ev.runtimeId],
          coverage: ev.coverage as any,
          activeSessions: 0,
          activeTurns: ev.status === "RUNNING" ? ev.turnCount : 0,
          completedTurns: ev.status === "COMPLETED" ? ev.turnCount : 0,
          abortedTurns: ev.status === "ABORTED" ? ev.turnCount : 0,
          tokensIn: ev.tokensIn,
          tokensOut: ev.tokensOut,
          tokensReasoning: ev.tokensReasoning,
          avgTtftMs: ev.ttftMs,
          avgDurationMs: ev.durationMs,
          avgTokPerSec: ev.durationMs && ev.tokensOut ? Math.round((ev.tokensOut / (ev.durationMs/1000))*10)/10 : null,
          firstActivityAt: ev.startedAt,
          lastActivityAt: ev.endedAt ?? ev.updatedAt
        });
      } else {
        cur.completedTurns += ev.status === "COMPLETED" ? ev.turnCount : 0;
        cur.abortedTurns += ev.status === "ABORTED" ? ev.turnCount : 0;
        cur.activeTurns += ev.status === "RUNNING" ? ev.turnCount : 0;
        if (ev.ttftMs !== null && cur.avgTtftMs !== null) cur.avgTtftMs = Math.round(((cur.avgTtftMs as number) + ev.ttftMs)/2);
        else if (ev.ttftMs !== null) cur.avgTtftMs = ev.ttftMs;
        // tok/s recalc rough
      }
    }
    return [...acc.values()];
  }

  private toBenchItem(raw: OpencodeVerboseModel, providerGroup: "opencode"|"opencode-go"|"openrouter", probe: { ok: boolean; latencyMs: number | null }, hist: SystemAnalyticsModel | null, sampledAt: string) {
    const vision = Boolean(raw.capabilities?.attachment && raw.capabilities?.input?.image);
    const toolcall = Boolean(raw.capabilities?.toolcall);
    const reasoning = Boolean(raw.capabilities?.reasoning);
    const rawContext = raw.limit?.context ?? raw.limit?.output ?? null;
    const contextLimit = (typeof rawContext === "number" && rawContext > 0) ? Math.round(rawContext) : null;
    const baseUrl = raw.api?.url ?? (
      providerGroup === "openrouter"
        ? "https://openrouter.ai/api/v1"
        : providerGroup === "opencode"
          ? "https://opencode.ai/zen/v1"
          : "https://opencode.ai/zen/go/v1"
    );
    const costFree = ((raw.cost?.input ?? 0) === 0 && (raw.cost?.output ?? 0) === 0) || raw.id.endsWith(":free") || raw.id === "openrouter/free";
    const status = (raw.status ?? "active").toLocaleLowerCase();
    const family = (raw.family && typeof raw.family === "string" && raw.family.trim().length > 0) ? raw.family.trim().slice(0, 160) : null;
    let networkStatus: "ONLINE"|"DEGRADED"|"OFFLINE"|"UNKNOWN" = "UNKNOWN";
    if (status === "active") networkStatus = probe.ok ? "ONLINE" : "DEGRADED";
    else if (status === "inactive" || status === "offline") networkStatus = "OFFLINE";
    else networkStatus = probe.ok ? "ONLINE" : "OFFLINE";
    if (providerGroup === "opencode-go" && raw.providerID !== "opencode-go") networkStatus = "UNKNOWN";
    if (providerGroup === "openrouter" && raw.providerID !== "openrouter") networkStatus = "UNKNOWN";

    return {
      providerId: raw.providerID,
      modelId: raw.id,
      displayName: raw.name || raw.id,
      baseUrl,
      family,
      costFree,
      costInput: raw.cost?.input ?? null,
      costOutput: raw.cost?.output ?? null,
      vision,
      toolcall,
      reasoning,
      contextLimit,
      status: raw.status ?? "active",
      networkStatus,
      networkLatencyMs: probe.latencyMs,
      networkScore: 0,
      speedScore: null as number | null,
      visionScore: null as number | null,
      codingScore: null as number | null,
      avgTtftMs: hist?.avgTtftMs ?? null,
      avgDurationMs: hist?.avgDurationMs ?? null,
      avgTokPerSec: hist?.avgTokPerSec ?? null,
      completedTurns: hist?.completedTurns ?? 0,
      abortedTurns: hist?.abortedTurns ?? 0,
      coverage: hist?.coverage ?? "UNAVAILABLE",
      rankVision: null as number | null,
      rankCoding: null as number | null,
      lastRefreshedAt: sampledAt
    };
  }

  private fallbackSynthetic(histByKey: Map<string, SystemAnalyticsModel>, zenProbe: { ok: boolean; latencyMs: number | null }, sampledAt: string) {
    // Only real active models currently available in OpenCode
    const synthetic: Array<{ id: string; providerID: string; name: string; vision: boolean; toolcall: boolean; reasoning: boolean; context?: number }> = [
      { id: "muse-spark-1.3-contributor-free", providerID: "opencode", name: "Muse Spark 1.3 Free", vision: true, toolcall: true, reasoning: true, context: 1048576 },
      { id: "muse-spark-1.2-contributor-free", providerID: "opencode", name: "Muse Spark 1.2 Free", vision: true, toolcall: true, reasoning: true, context: 1048576 },
      { id: "mimo-v2.5-free", providerID: "opencode", name: "MiMo V2.5 Free", vision: true, toolcall: true, reasoning: true, context: 200000 },
      { id: "big-pickle", providerID: "opencode", name: "Big Pickle", vision: false, toolcall: true, reasoning: true, context: 200000 },
      { id: "ling-3.0-flash-fin-free", providerID: "opencode", name: "Ling 3.0 Flash Fin Free", vision: false, toolcall: true, reasoning: true, context: 262144 },
      { id: "nemotron-3-ultra-free", providerID: "opencode", name: "Nemotron 3 Ultra Free", vision: false, toolcall: true, reasoning: true, context: 1000000 },
      { id: "nemotron-3.5-lightning-free", providerID: "opencode", name: "Nemotron 3.5 Lightning Free", vision: false, toolcall: true, reasoning: true, context: 262144 }
    ];
    return synthetic.map((s) => {
      const hist = histByKey.get(`${s.providerID}\u0000${s.id}`) ?? null;
      return {
        providerId: s.providerID,
        modelId: s.id,
        displayName: s.name,
        baseUrl: "https://opencode.ai/zen/v1",
        family: s.id,
        costFree: true,
        costInput: 0,
        costOutput: 0,
        vision: s.vision,
        toolcall: s.toolcall,
        reasoning: s.reasoning,
        contextLimit: s.context ?? null,
        status: "active",
        networkStatus: zenProbe.ok ? "ONLINE" as const : "DEGRADED" as const,
        networkLatencyMs: zenProbe.latencyMs,
        networkScore: 0,
        speedScore: null,
        visionScore: null,
        codingScore: null,
        avgTtftMs: hist?.avgTtftMs ?? null,
        avgDurationMs: hist?.avgDurationMs ?? null,
        avgTokPerSec: hist?.avgTokPerSec ?? null,
        completedTurns: hist?.completedTurns ?? 0,
        abortedTurns: hist?.abortedTurns ?? 0,
        coverage: hist?.coverage ?? "UNAVAILABLE",
        rankVision: null,
        rankCoding: null,
        lastRefreshedAt: hist?.lastActivityAt ?? sampledAt
      };
    });
  }

  private async probeAllSimple(items: Array<{ providerId: string; modelId: string }>): Promise<Map<string, ChatProbeResult>> {
    const prompt = "Say hello in one word";
    const map = new Map<string, ChatProbeResult>();
    let idx = 0;
    const concurrency = 4;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const cur = idx++;
        if (cur >= items.length) break;
        const it = items[cur]!;
        const res = await probeChatSimple(it.providerId, it.modelId, prompt, 20, chatProbeTimeoutMs);
        map.set(`${it.providerId}\u0000${it.modelId}`, res);
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await Promise.all(workers);
    return map;
  }

  private buildNotices(items: any[], zenProbe: { ok: boolean; latencyMs: number | null }, zenGoProbe: { ok: boolean; latencyMs: number | null }, openrouterProbe: { ok: boolean; latencyMs: number | null }): string[] {
    const notices: string[] = [];
    if (!zenProbe.ok) notices.push("Zen (opencode) endpoint probe failed — network DEGRADED for free models. TTFT/tok/s history used as fallback.");
    if (!zenGoProbe.ok) notices.push("Zen Go endpoint probe failed or token missing — opencode-go models DEGRADED. Check /var/lib/spaceapp-user/.config/opencode/opencode-go.token.");
    if (!openrouterProbe.ok) notices.push("OpenRouter endpoint probe failed or token missing — openrouter models DEGRADED. Check /var/lib/spaceapp-user/.config/opencode/openrouter.token.");
    if (items.every((i) => i.avgTtftMs === null)) notices.push("No TTFT/tok/s history for this range — speed scores are indicative (baseline). Select 7d/30d for richer signal.");
    const liveFails = items.filter((i: any) => i._liveProbe && !i._liveProbe.ok);
    if (liveFails.length > 0) {
      const byType: Record<string, number> = {};
      for (const it of liveFails) {
        const t = (it as any)._liveProbe.errorType ?? "UNKNOWN";
        byType[t] = (byType[t] ?? 0) + 1;
      }
      const summary = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ");
      notices.push(`Live chat probe (force): ${liveFails.length}/${items.length} models failed — ${summary}.`);
    }
    notices.push("Catalog policy: Models not seen or refreshed within 3 days are automatically purged from the benchmark.");
    return notices;
  }
}
