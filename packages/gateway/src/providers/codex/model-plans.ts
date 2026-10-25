import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { normalizePlanPriorityType } from "../../router/balancer.js";
import { buildCodexUpstreamHeaders } from "./headers.js";
import { CODEX_UPSTREAM_BASE_URL } from "./usage.js";

/**
 * Which plans offer which models, after codex-lb's model registry (MIT, Soju06/codex-lb): the catalog of one usable
 * account per plan, refreshed every few minutes in the background, so a request only goes to accounts whose plan
 * offers its model. An unknown model is not restricted.
 */
const REFRESH_MS = 5 * 60_000;

export class CodexModelPlans {
  private plansBySlug = new Map<string, Set<string>>();
  private refreshedAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: {
    pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number; upstreamBaseUrl?: string; clientVersion?: () => string;
  }) {}

  private nowMs() { return (this.options.now ?? Date.now)(); }

  /** Plans that offer the model, or null when no plan's catalog mentions it. */
  plansFor(model: string | null): Set<string> | null {
    if (this.nowMs() - this.refreshedAt > REFRESH_MS) void this.refresh();
    if (!model) return null;
    return this.plansBySlug.get(model.toLowerCase()) ?? null;
  }

  /** Models whose catalog lists the plan (empty until a catalog was read). */
  modelsFor(planType: string | null): string[] {
    if (this.nowMs() - this.refreshedAt > REFRESH_MS) void this.refresh();
    const plan = normalizePlanPriorityType(planType);
    return [...this.plansBySlug].filter(([, plans]) => plans.has(plan)).map(([slug]) => slug);
  }

  /** Accounts whose plan offers the model; all accounts when the model is unknown. */
  eligible(accounts: GatewayAccountRecord[], model: string | null): GatewayAccountRecord[] {
    const plans = this.plansFor(model);
    if (!plans) return accounts;
    return accounts.filter((account) => plans.has(normalizePlanPriorityType(account.planType)));
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async load() {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const usable = (await this.options.pool.accounts()).filter((account) => account.status !== "PAUSED" && account.status !== "DEACTIVATED"
      && account.status !== "REAUTH_REQUIRED");
    const byPlan = new Map<string, GatewayAccountRecord>();
    for (const account of usable) {
      const plan = normalizePlanPriorityType(account.planType);
      if (!byPlan.has(plan)) byPlan.set(plan, account);
    }
    const next = new Map<string, Set<string>>();
    let loaded = 0;
    const failed: string[] = [];
    for (const [plan, account] of byPlan) {
      try {
        const credentials = await this.options.pool.credentials(account);
        const version = this.options.clientVersion?.() ?? "0.150.1";
        const response = await fetchImpl(`${(this.options.upstreamBaseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/, "")}/codex/models?client_version=${encodeURIComponent(version)}`, {
          signal: AbortSignal.timeout(15_000),
          headers: buildCodexUpstreamHeaders({ "user-agent": "space-gateway" }, credentials.accessToken, credentials.upstreamAccountId, "application/json")
        });
        if (!response.ok) { failed.push(plan); continue; }
        const body = await response.json() as { models?: unknown };
        for (const model of Array.isArray(body.models) ? body.models : []) {
          const entry = model && typeof model === "object" ? model as Record<string, unknown> : null;
          if (!entry || typeof entry.slug !== "string") continue;
          const plans = next.get(entry.slug.toLowerCase()) ?? new Set<string>();
          const listed = Array.isArray(entry.available_in_plans) ? entry.available_in_plans.filter((item): item is string => typeof item === "string") : [];
          if (listed.length > 0) for (const item of listed) plans.add(normalizePlanPriorityType(item));
          else plans.add(plan);
          next.set(entry.slug.toLowerCase(), plans);
        }
        loaded += 1;
        continue;
      } catch {
        // Retried at the next refresh.
      }
      failed.push(plan);
    }
    // A plan whose catalog could not be read keeps its previous models, so its accounts are not excluded meanwhile.
    for (const plan of failed) {
      for (const [slug, plans] of this.plansBySlug) {
        if (!plans.has(plan)) continue;
        const merged = next.get(slug) ?? new Set<string>();
        merged.add(plan);
        next.set(slug, merged);
      }
    }
    if (loaded > 0) this.plansBySlug = next;
    this.refreshedAt = this.nowMs();
  }
}
