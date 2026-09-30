import { readFile } from "node:fs/promises";

/**
 * OpenRouter model catalog for the Asteroids AI Benchmark provider toggle.
 *
 * Playability rule (operator decision 2026-09-20):
 *  - the account has credits  -> every chat-capable model of the live catalog is listed,
 *  - the account is out of credits -> only zero-price models that were verified
 *    working by `scripts/verify-openrouter-models.mjs` (cron, twice a day) are listed.
 * The catalog itself is always taken live (https://openrouter.ai/api/v1/models) and
 * falls back to the last-good snapshot written by that same script.
 */

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TOKEN_FILE = "/var/lib/spaceapp-user/.config/opencode/openrouter.token";
const DEFAULT_CATALOG_FILE = "/opt/spaceapp/var/openrouter-models.last-good.json";
const DEFAULT_VERIFIED_FILE = "/opt/spaceapp/var/openrouter-models.verified.json";

const CATALOG_TIMEOUT_MS = 3000;
const CREDITS_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 60 * 1000;
const VERIFICATION_STALE_MS = 36 * 60 * 60 * 1000;

export interface OpenRouterBenchmarkModel {
  id: string;
  displayName: string;
  providerId: string;
  status: string;
}

export interface OpenRouterCatalogEntry {
  id: string;
  displayName: string;
  zeroPrice: boolean;
}

export interface OpenRouterVerificationSnapshot {
  generatedAt?: string;
  mode?: string;
  hasCredits?: boolean;
  verified?: Array<{ id?: string; displayName?: string }>;
}

export interface OpenRouterDeps {
  fetchImpl?: typeof globalThis.fetch;
  readFileImpl?: (path: string) => Promise<string>;
  now?: () => number;
  baseUrl?: string;
  tokenFile?: string;
  catalogFile?: string;
  verifiedFile?: string;
  cache?: boolean;
}

function envValue(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function resolveDeps(deps: OpenRouterDeps = {}) {
  return {
    baseUrl: (deps.baseUrl ?? envValue("SPACE_OPENROUTER_BASE_URL", DEFAULT_BASE_URL)).replace(/\/+$/, ""),
    tokenFile: deps.tokenFile ?? envValue("SPACE_OPENROUTER_TOKEN_FILE", DEFAULT_TOKEN_FILE),
    catalogFile: deps.catalogFile ?? envValue("SPACE_OPENROUTER_CATALOG_FILE", DEFAULT_CATALOG_FILE),
    verifiedFile: deps.verifiedFile ?? envValue("SPACE_OPENROUTER_VERIFIED_FILE", DEFAULT_VERIFIED_FILE),
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    readFileImpl: deps.readFileImpl ?? ((path: string) => readFile(path, "utf8")),
    now: deps.now ?? (() => Date.now()),
    cache: deps.cache !== false,
  };
}

const cache = new Map<string, { expiresAt: number; value: unknown }>();

/** Test seam: drop the short-lived catalog/credits caches. */
export function resetOpenRouterBenchmarkCaches(): void {
  cache.clear();
}

async function readCache<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value as T;
  const value = await producer();
  cache.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

export function isZeroPriceModel(pricing: unknown, id: string): boolean {
  const zero = (value: unknown) => value === undefined || value === null || value === "" || Number(value) === 0;
  const rates = (pricing ?? {}) as { prompt?: unknown; completion?: unknown };
  return (zero(rates.prompt) && zero(rates.completion)) || id.endsWith(":free") || id === "openrouter/free";
}

function isTextChatModel(model: { id?: unknown; architecture?: { input_modalities?: unknown; output_modalities?: unknown } }): boolean {
  const id = String(model?.id ?? "");
  if (!id || id.endsWith(":batch")) return false;
  const architecture = model?.architecture ?? {};
  const inputs = Array.isArray(architecture.input_modalities) ? (architecture.input_modalities as unknown[]) : undefined;
  const outputs = Array.isArray(architecture.output_modalities) ? (architecture.output_modalities as unknown[]) : undefined;
  if (!inputs) return true;
  if (!inputs.includes("text")) return false;
  if (outputs && !outputs.includes("text")) return false;
  return true;
}

export function openRouterCatalogEntries(payload: unknown): OpenRouterCatalogEntry[] {
  const models = (payload as { data?: unknown })?.data;
  if (!Array.isArray(models)) return [];
  return models
    .filter((model) => isTextChatModel(model as { id?: unknown }))
    .map((model) => {
      const raw = model as { id?: unknown; name?: unknown; pricing?: unknown };
      const id = String(raw.id ?? "").trim();
      const displayName = String(raw.name ?? "").trim() || id;
      return { id, displayName, zeroPrice: isZeroPriceModel(raw.pricing, id) };
    })
    .filter((entry) => entry.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function readJsonFile<T>(path: string, readFileImpl: (path: string) => Promise<string>): Promise<T | null> {
  try {
    return JSON.parse(await readFileImpl(path)) as T;
  } catch {
    return null;
  }
}

export async function readOpenRouterVerification(deps: OpenRouterDeps = {}): Promise<OpenRouterVerificationSnapshot | null> {
  const { verifiedFile, readFileImpl } = resolveDeps(deps);
  return readJsonFile<OpenRouterVerificationSnapshot>(verifiedFile, readFileImpl);
}

export async function readOpenRouterToken(deps: OpenRouterDeps = {}): Promise<string | null> {
  const { tokenFile, readFileImpl } = resolveDeps(deps);
  try {
    const token = (await readFileImpl(tokenFile)).trim();
    return token || null;
  } catch {
    return null;
  }
}

async function fetchOpenRouterJson(path: string, timeoutMs: number, deps: ReturnType<typeof resolveDeps>): Promise<unknown> {
  const token = await readOpenRouterToken(deps);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await deps.fetchImpl(`${deps.baseUrl}${path}`, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadCatalogEntries(
  resolved: ReturnType<typeof resolveDeps>
): Promise<{ entries: OpenRouterCatalogEntry[]; source: "live" | "cache" | "none" }> {
  try {
    const payload = await fetchOpenRouterJson("/models", CATALOG_TIMEOUT_MS, resolved);
    const entries = openRouterCatalogEntries(payload);
    if (entries.length > 0) return { entries, source: "live" };
  } catch {
    // fall through to the last-good snapshot
  }
  const snapshot = await readJsonFile<{ models?: OpenRouterCatalogEntry[] }>(resolved.catalogFile, resolved.readFileImpl);
  const cached = Array.isArray(snapshot?.models) ? snapshot.models.filter((entry) => entry?.id) : [];
  return { entries: cached, source: cached.length > 0 ? "cache" : "none" };
}

async function loadCreditsState(
  resolved: ReturnType<typeof resolveDeps>
): Promise<{ known: boolean; hasCredits: boolean; remaining: number | null }> {
  try {
    const payload = await fetchOpenRouterJson("/credits", CREDITS_TIMEOUT_MS, resolved);
    const data = ((payload as { data?: unknown })?.data ?? payload) as { total_credits?: unknown; total_usage?: unknown };
    const totalCredits = Number(data?.total_credits);
    const totalUsage = Number(data?.total_usage);
    if (Number.isFinite(totalCredits) && Number.isFinite(totalUsage)) {
      const remaining = Number((totalCredits - totalUsage).toFixed(6));
      return { known: true, hasCredits: remaining > 0, remaining };
    }
  } catch {
    // unknown -> fall back to the verification snapshot
  }
  return { known: false, hasCredits: false, remaining: null };
}

function isSnapshotStale(snapshot: OpenRouterVerificationSnapshot, nowMs: number): boolean {
  const generatedAt = Date.parse(String(snapshot.generatedAt ?? ""));
  if (!Number.isFinite(generatedAt)) return true;
  return nowMs - generatedAt > VERIFICATION_STALE_MS;
}

export async function loadOpenRouterBenchmarkModels(deps: OpenRouterDeps = {}): Promise<OpenRouterBenchmarkModel[]> {
  const resolved = resolveDeps(deps);
  const catalogKey = `catalog:${resolved.baseUrl}|${resolved.catalogFile}`;
  const creditsKey = `credits:${resolved.baseUrl}`;
  const catalog = resolved.cache
    ? await readCache(catalogKey, CACHE_TTL_MS, () => loadCatalogEntries(resolved))
    : await loadCatalogEntries(resolved);
  if (catalog.entries.length === 0) return [];

  const credits = resolved.cache
    ? await readCache(creditsKey, CACHE_TTL_MS, () => loadCreditsState(resolved))
    : await loadCreditsState(resolved);
  const verification = await readOpenRouterVerification(deps);

  // Credits present: the whole chat-capable catalog is playable.
  const hasCredits = credits.known ? credits.hasCredits : verification?.hasCredits === true;
  if (hasCredits) {
    return catalog.entries.map((entry) => ({
      id: `openrouter/${entry.id}`,
      displayName: entry.displayName,
      providerId: "openrouter",
      status: "VERIFIED",
    }));
  }

  // No credits: only the zero-price models verified by the scheduled checker.
  const verifiedIds = new Set(
    (verification?.verified ?? []).map((entry) => String(entry?.id ?? "").trim()).filter((id) => id.length > 0)
  );
  if (!verification || verifiedIds.size === 0) return [];
  const status = isSnapshotStale(verification, resolved.now()) ? "UNVERIFIED_STALE" : "VERIFIED";
  return catalog.entries
    .filter((entry) => entry.zeroPrice && verifiedIds.has(entry.id))
    .map((entry) => ({
      id: `openrouter/${entry.id}`,
      displayName: entry.displayName,
      providerId: "openrouter",
      status,
    }));
}

/** Live doctrine call for a bare OpenRouter model id (provider-qualified ids included). */
export async function requestOpenRouterDoctrine(options: {
  modelId: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
  deps?: OpenRouterDeps;
}): Promise<string | null> {
  const resolved = resolveDeps(options.deps);
  const token = await readOpenRouterToken(resolved);
  if (!token) return null;
  const controller = new AbortController();
  // Budget mirrors the scheduled verifier (scripts/verify-openrouter-models.mjs).
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const res = await resolved.fetchImpl(`${resolved.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "http-referer": "http://127.0.0.1:4911",
        "x-title": "Space Asteroids AI Benchmark",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.modelId,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.prompt },
        ],
        temperature: 0.2,
        // Reasoning models spend most of the budget on reasoning tokens first.
        max_tokens: 1500,
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
