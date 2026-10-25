import type {
  AntigravityUsageAccountList,
  ApiProviderAccountList,
  ClaudeUsageAccountList,
  CodexUsageAccountList,
} from "@space/contracts";
import { api } from "../../api.js";

// One sample of every quota source, shared by every AI Quota & Usage surface.
export interface SharedQuotaCache {
  codex: CodexUsageAccountList | null;
  agy: AntigravityUsageAccountList | null;
  claude: ClaudeUsageAccountList | null;
  api: ApiProviderAccountList | null;
  fetchedAt: number;
}

const sharedQuotaTtlMs = 60_000;
let sharedQuotaCache: SharedQuotaCache | null = null;
let sharedQuotaInFlight: Promise<SharedQuotaCache> | null = null;
const sharedQuotaListeners = new Set<(sample: SharedQuotaCache) => void>();

export function subscribeSharedQuota(listener: (sample: SharedQuotaCache) => void): () => void {
  sharedQuotaListeners.add(listener);
  return () => {
    sharedQuotaListeners.delete(listener);
  };
}

export function peekSharedQuotaMetrics(): SharedQuotaCache | null {
  return sharedQuotaCache;
}

export async function fetchSharedQuotaMetrics(force = false): Promise<SharedQuotaCache> {
  if (!force && sharedQuotaCache && Date.now() - sharedQuotaCache.fetchedAt < sharedQuotaTtlMs) {
    return sharedQuotaCache;
  }
  if (sharedQuotaInFlight) return sharedQuotaInFlight;
  const request = (async () => {
    try {
      let samples: [CodexUsageAccountList | null, AntigravityUsageAccountList | null, ClaudeUsageAccountList | null, ApiProviderAccountList | null] =
        [null, null, null, null];
      try {
        samples = await Promise.all([
          api.toolbarUsageAccounts().catch(() => null),
          api.toolbarAntigravityUsageAccounts().catch(() => null),
          api.toolbarClaudeUsageAccounts().catch(() => null),
          api.toolbarApiProviderAccounts().catch(() => null),
        ]);
      } catch {
        // The runtime is not mounted in isolated tests.
      }
      const [codex, agy, claude, apiProviders] = samples;
      sharedQuotaCache = {
        codex: codex ?? sharedQuotaCache?.codex ?? null,
        agy: agy ?? sharedQuotaCache?.agy ?? null,
        claude: claude ?? sharedQuotaCache?.claude ?? null,
        api: apiProviders ?? sharedQuotaCache?.api ?? null,
        fetchedAt: Date.now(),
      };
      for (const listener of sharedQuotaListeners) listener(sharedQuotaCache);
      return sharedQuotaCache;
    } finally {
      sharedQuotaInFlight = null;
    }
  })();
  sharedQuotaInFlight = request;
  return request;
}

export function resetSharedQuotaCacheForTests(): void {
  sharedQuotaCache = null;
  sharedQuotaInFlight = null;
  sharedQuotaListeners.clear();
}
