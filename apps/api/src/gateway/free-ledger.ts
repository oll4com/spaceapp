import { GATEWAY_FREE_GRANTS, GATEWAY_FREE_TIERS, gatewayPoolModelFree, type GatewayFreeLedger, type GatewayFreeLedgerRow, type GatewayPoolModels,
  type GatewayProvider } from "@space/contracts";
import type { GatewayProviderDailyUsage, GatewayRepository } from "@space/db";

/**
 * The free-token ledger (operator 7/11, nous_msg:d9b67550: "what we were given, what is spent, what is left"): one row per free or granted
 * Space Gateway pool. Spend comes from the gateway's daily sums (they outlive the request logs): since the grant began, or the last 30 days for
 * a free tier. A dollar grant whose provider reports no cost shows its tokens and no "left" (never a guess).
 */
export const GATEWAY_FREE_POOL_NAMES: Partial<Record<GatewayProvider, string>> = {
  INCEPTION: "Inception Labs", JINA: "Jina AI", FREEAI: "Free.ai", ADAPTION: "Adaption Labs", AGENTROUTER: "AgentRouter", MIXEDBREAD: "Mixedbread",
  AZURE_OPENAI: "Azure OpenAI", AMD_TOKEN_LAB: "AMD Token Lab", GROQ: "Groq", NVIDIA: "NVIDIA NIM", CLOUDFLARE_AI: "Cloudflare Workers AI",
  GOOGLE_AI: "Gemini API (free tier)", OPENROUTER: "OpenRouter free models", ZAI: "Z.AI", SILICONFLOW: "SiliconFlow", OVH: "OVHcloud AI Endpoints", MISTRAL: "Mistral"
};
const TIER_DAYS = 30;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function buildFreeLedger(input: { accounts: Array<{ provider: GatewayProvider; status: string }>; usage: GatewayProviderDailyUsage[];
  poolModels: GatewayPoolModels | null; now: number }): GatewayFreeLedger {
  const tierSince = day(input.now - (TIER_DAYS - 1) * 86_400_000);
  const providers = Object.keys(GATEWAY_FREE_POOL_NAMES) as GatewayProvider[];
  const rows = providers.flatMap((provider): GatewayFreeLedgerRow[] => {
    const grant = GATEWAY_FREE_GRANTS[provider];
    const tier = GATEWAY_FREE_TIERS[provider];
    const own = input.accounts.filter((account) => account.provider === provider && account.status !== "DEACTIVATED");
    // A pool with neither an account nor a grant is not ours yet.
    if (!own.length && !grant) return [];
    const since = grant?.since ?? tierSince;
    const days = input.usage.filter((row) => row.provider === provider && row.day >= since);
    const sum = (pick: (row: GatewayProviderDailyUsage) => number) => days.reduce((total, row) => total + pick(row), 0);
    const inputTokens = sum((row) => row.inputTokens);
    const outputTokens = sum((row) => row.outputTokens);
    const reported = Math.round(sum((row) => row.costUsd) * 1e6) / 1e6;
    const price = reported === 0 && grant?.pricePerMillion ? grant.pricePerMillion : null;
    const spent = { requests: sum((row) => row.requests), inputTokens, outputTokens, tokens: inputTokens + outputTokens,
      costUsd: price ? Math.round(((inputTokens * price.input + outputTokens * price.output) / 1e6) * 1e6) / 1e6 : reported, ...(price ? { estimated: true } : {}) };
    let left: number | null = null;
    if (grant?.amount != null) {
      if (grant.unit === "tokens") left = Math.max(0, grant.amount - spent.tokens);
      else if (spent.costUsd > 0 || spent.tokens === 0) left = Math.max(0, Math.round((grant.amount - spent.costUsd) * 100) / 100);
    }
    const listed = input.poolModels?.data.find((row) => row.provider === provider)?.models ?? [];
    const models = listed.filter((id) => gatewayPoolModelFree(provider, id) !== false && (provider !== "OPENROUTER" || id.endsWith(":free"))).slice(0, 200);
    const lastDay = days.filter((row) => row.requests > 0).map((row) => row.day).sort().at(-1) ?? null;
    return [{ provider, label: GATEWAY_FREE_POOL_NAMES[provider]!, kind: grant ? "GRANT" : "FREE_TIER",
      granted: grant ? { amount: grant.amount, unit: grant.unit } : null, since: grant ? grant.since : null, validUntil: grant?.validUntil ?? null,
      spent, left, leftPercent: left !== null && grant?.amount ? Math.max(0, Math.min(100, Math.round((left / grant.amount) * 1000) / 10)) : null,
      lastUsedAt: lastDay, accounts: own.filter((account) => account.status === "ACTIVE" || account.status === "RATE_LIMITED").length, models,
      note: (grant?.note ?? tier ?? "").slice(0, 300) }];
  });
  return { rows, at: new Date(input.now).toISOString() };
}

export async function loadFreeLedger(repository: Pick<GatewayRepository, "listAccounts" | "providerDailyUsage">, poolModels: () => Promise<GatewayPoolModels>,
  now = Date.now()): Promise<GatewayFreeLedger> {
  const earliest = [day(now - (TIER_DAYS - 1) * 86_400_000), ...Object.values(GATEWAY_FREE_GRANTS).map((grant) => grant!.since)].sort()[0]!;
  const [accounts, usage, models] = await Promise.all([repository.listAccounts(), repository.providerDailyUsage(earliest), poolModels().catch(() => null)]);
  return buildFreeLedger({ accounts, usage, poolModels: models, now });
}
