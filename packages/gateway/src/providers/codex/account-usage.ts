import type { FastifyInstance } from "fastify";
import type { AccountPool } from "../../accounts/account-pool.js";
import { createAdminGuard } from "../../admin/codex-sign-in.js";

/**
 * Codex account quotas for tools on this host (`GET /__space-gateway/codex/account-usage`), in the schema
 * `space-codex-account-usage` printed when it read codex-lb on public-host: one row per paid account the gateway uses, with the
 * remaining share of its 5-hour and weekly windows. The LAN listener serves proxy routes only, so this stays local.
 */
const remaining = (used: number | null) => (used === null ? null : Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10)));

export function registerCodexAccountUsageRoute(app: FastifyInstance, options: { pool: AccountPool; internalToken: string | null }) {
  // Account labels can be e-mail addresses: only the root helper (with the admin token) reads them, never a CLI pane on
  // loopback (security addendum step 8).
  const guard = createAdminGuard(options.internalToken);
  app.get("/__space-gateway/codex/account-usage", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    try {
      const accounts = (await options.pool.accounts())
        .filter((account) => account.status !== "PAUSED" && account.status !== "DEACTIVATED" && !options.pool.isSignedOut(account)
          && (account.planType ?? "").trim().toLowerCase() !== "free");
      return {
        schemaVersion: 1,
        source: "space-gateway",
        accounts: accounts.slice(0, 100).map((account) => ({
          id: account.id, label: account.label,
          fiveHourRemainingPercent: remaining(account.primaryWindow.usedPercent), weeklyRemainingPercent: remaining(account.secondaryWindow.usedPercent),
          fiveHourResetAt: account.primaryWindow.resetAt, weeklyResetAt: account.secondaryWindow.resetAt,
          sampledAt: account.lastRefreshAt ?? account.lastUsedAt, planType: account.planType
        }))
      };
    } catch {
      return reply.code(503).send({ error: { code: "accounts_unavailable", message: "Space Gateway accounts are unavailable." } });
    }
  });
}
