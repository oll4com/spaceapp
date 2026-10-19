import { spawn } from "./safe-child-process.js";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { readActiveFreeOpenCodeModel } from "./opencode-free-model.js";
import { childProcessEnv } from "./child-process-env.js";

export interface AdvancedMissionModelSelection {
  providerId: string | null;
  modelId: string;
  reasoningEffort: string | null;
  providerName: string | null;
  modelName: string;
  tier: "CODEX" | "GEMINI" | "OPENCODE";
}

export interface ResolveAdvancedMissionModelOptions {
  codexLbBaseUrl?: string | null;
  codexLbKeyFile?: string | null;
  fetchImpl?: typeof fetch;
  geminiTokenRoot?: string;
  openCodeStateFile?: string;
}

/** The service root of a Codex-compatible base URL, which is usually configured with its `/v1` suffix. */
export function codexServiceRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function checkCodexSolAvailability(
  baseUrl?: string | null,
  fetchImpl: typeof fetch = fetch,
  apiKey?: string | null
): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    // The pooled weekly quota needs the service's API key (codex-lb and Space Gateway alike).
    const url = `${codexServiceRoot(baseUrl)}/api/codex/weekly-remaining`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000), ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}) });
    if (!response.ok) return false;
    const data = (await response.json()) as Record<string, unknown>;
    const remaining = typeof data.remaining_percent === "number" ? data.remaining_percent : 0;
    const activeAccounts = typeof data.active_accounts_count === "number" ? data.active_accounts_count : 0;
    return activeAccounts > 0 && remaining > 0;
  } catch {
    return false;
  }
}

export async function checkGeminiAvailability(
  geminiRoot = "/var/lib/spaceapp-user/.codex/space-gemini"
): Promise<boolean> {
  const mainToken = path.join(geminiRoot, "home/.gemini/antigravity-cli/antigravity-oauth-token");
  try {
    const stats = await fs.stat(mainToken);
    if (stats.size > 0) return true;
  } catch {}
  try {
    const profilesDir = path.join(geminiRoot, "profiles");
    const entries = await fs.readdir(profilesDir);
    for (const entry of entries) {
      const pToken = path.join(profilesDir, entry, "home/.gemini/antigravity-cli/antigravity-oauth-token");
      try {
        const stats = await fs.stat(pToken);
        if (stats.size > 0) return true;
      } catch {}
    }
  } catch {}
  return false;
}

export async function resolveAdvancedMissionModel(
  options: ResolveAdvancedMissionModelOptions = {}
): Promise<AdvancedMissionModelSelection> {
  // Tier 1: Check Codex OpenAI Sol access & remaining quota
  const apiKey = options.codexLbKeyFile ? await fs.readFile(options.codexLbKeyFile, "utf8").then((text) => text.trim() || null, () => null) : null;
  const hasCodex = await checkCodexSolAvailability(options.codexLbBaseUrl, options.fetchImpl, apiKey);
  if (hasCodex) {
    return {
      providerId: null,
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      providerName: null,
      modelName: "GPT-5.6 Sol",
      tier: "CODEX"
    };
  }

  // Tier 2: Check Gemini Flash access & credentials
  const hasGemini = await checkGeminiAvailability(options.geminiTokenRoot);
  if (hasGemini) {
    return {
      providerId: "cli:gemini",
      modelId: "gemini-3.8-flash",
      reasoningEffort: "high",
      providerName: "Gemini",
      modelName: "Gemini 3.8 Flash",
      tier: "GEMINI"
    };
  }

  // Tier 3: Fall back to daily selected free OpenCode model
  const freeModel = readActiveFreeOpenCodeModel(options.openCodeStateFile);
  return {
    providerId: "cli:opencode",
    modelId: freeModel,
    reasoningEffort: null,
    providerName: "OpenCode",
    modelName: freeModel,
    tier: "OPENCODE"
  };
}

/**
 * The Room Agent's tier, checked at most once a minute: the check calls the quota service, and dock polls and chat
 * turns would otherwise repeat it every few seconds.
 */
export function createCachedModelSelection(options: ResolveAdvancedMissionModelOptions, ttlMs = 60_000): () => Promise<AdvancedMissionModelSelection> {
  let cache: { expires: number; value: Promise<AdvancedMissionModelSelection> } | null = null;
  return () => {
    if (cache && cache.expires > Date.now()) return cache.value;
    const value = resolveAdvancedMissionModel(options);
    const entry = { expires: Date.now() + ttlMs, value };
    cache = entry;
    value.catch(() => { if (cache === entry) cache = null; });
    return value;
  };
}

/** OpenCode 2 (`@opencode/cli`) starts a per-user background service for `run` unless it gets --standalone. */
export function openCodeRunModeArgs(searchPath = process.env.PATH ?? ""): string[] {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    try {
      return realpathSync(path.join(dir, "opencode")).includes("/node_modules/@opencode/cli/") ? ["--standalone"] : [];
    } catch {}
  }
  return [];
}

/** One answer from `opencode run` (text only, no tools). Null when it fails or does not answer in time. */
export function runOpenCodeText(modelId: string, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let stdout = "";
    let settled = false;
    const child = spawn("opencode", ["run", ...openCodeRunModeArgs(), "--format", "json", "--model", modelId, prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...childProcessEnv(), LANG: "C.UTF-8" }
    });
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(null); };
    const timer = setTimeout(onAbort, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) return finish(null);
      let extracted = "";
      for (const line of stdout.split("\n")) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.type === "text" && typeof parsed.part?.text === "string") extracted += parsed.part.text;
        } catch {}
      }
      // Only text events are an answer: an error event ({"type":"error",...}) must never reach the operator raw.
      finish(extracted.trim() || null);
    });
  });
}
