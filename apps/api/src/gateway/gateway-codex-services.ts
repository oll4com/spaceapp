import {
  codexResetCreditAvailabilitySchema, codexResetCreditRedemptionResponseSchema, codexUsageAccountListSchema,
  type CodexResetCreditAvailability, type CodexUsageAccountList, type NotificationRaiseInput
} from "@space/contracts";
import type { GatewayRepository } from "@space/db";
import { codexUsageWindows } from "@space/gateway";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { CodexResetCreditsError, type CodexResetCreditsRedemptionResult, type CodexResetCreditsService } from "../codex-reset-credits.js";
import { outOfRotation } from "./account-rotation.js";
import type { GatewayAdminService } from "./gateway-service.js";

/**
 * Codex account quotas and weekly reset credits from Space Gateway, with the contracts the toolbar and the reset
 * dialog already use (they came from codex-lb on public-host before codex-lb was retired).
 */
const remaining = (used: number | null) => (used === null ? null : Math.max(0, Math.min(100, Math.round((100 - used) * 10) / 10)));

export function createGatewayCodexUsageProvider(options: { repository: GatewayRepository; now?: () => Date }): () => Promise<CodexUsageAccountList> {
  const now = options.now ?? (() => new Date());
  return async () => {
    const checkedAt = now().toISOString();
    try {
      const accounts = (await options.repository.listAccounts())
        .filter((account) => account.provider === "CODEX" && !outOfRotation(account, Date.parse(checkedAt)));
      return codexUsageAccountListSchema.parse({
        data: accounts.slice(0, 100).map((account) => {
          const { fiveHour, weekly } = codexUsageWindows(account);
          return {
            id: account.id, label: account.label, planType: account.planType,
            fiveHourRemainingPercent: remaining(fiveHour?.usedPercent ?? null), weeklyRemainingPercent: remaining(weekly.usedPercent),
            fiveHourResetAt: fiveHour?.resetAt ?? null, weeklyResetAt: weekly.resetAt, sampledAt: account.lastRefreshAt ?? account.lastUsedAt
          };
        }),
        pagination: { page: 1, pageSize: 100, totalItems: Math.min(accounts.length, 100), totalPages: 1 },
        source: "space-gateway", isStale: false, error: null, checkedAt
      });
    } catch {
      return codexUsageAccountListSchema.parse({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }, source: "space-gateway",
        isStale: true, error: "Space Gateway accounts are unavailable.", checkedAt });
    }
  };
}

const outcomes = new Set(["RESET", "ALREADY_REDEEMED", "NOTHING_TO_RESET", "NO_CREDIT"]);

export function createGatewayCodexResetCreditsService(options: { repository: GatewayRepository; admin: Pick<GatewayAdminService, "gatewayAdmin">; now?: () => Date }): CodexResetCreditsService {
  const now = options.now ?? (() => new Date());
  // One redemption per account at a time: a repeated click (same idempotency key) joins the running one, another
  // click is refused until it ends, so a double click can never spend two credits.
  const running = new Map<string, { idempotencyKey: string; result: Promise<CodexResetCreditsRedemptionResult> }>();

  async function redeemOnce(accountId: string, idempotencyKey: string): Promise<CodexResetCreditsRedemptionResult> {
    const result = await options.admin.gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/reset-credit`, { idempotencyKey });
    const outcome = (result.body as { outcome?: unknown } | null)?.outcome;
    if (result.status === 404) throw new CodexResetCreditsError("STALE_CREDIT");
    if (result.status >= 500 || typeof outcome !== "string" || !outcomes.has(outcome)) {
      throw new CodexResetCreditsError(result.status >= 500 ? "UNKNOWN_OUTCOME" : "PROVIDER_UNAVAILABLE");
    }
    const typed = outcome as "RESET" | "ALREADY_REDEEMED" | "NOTHING_TO_RESET" | "NO_CREDIT";
    return {
      response: codexResetCreditRedemptionResponseSchema.parse({ accountId, outcome: typed, completedAt: now().toISOString() }),
      audit: { outcome: typed, usageVerified: typed === "RESET", creditIdHash: null }
    };
  }

  return {
    async availability(): Promise<CodexResetCreditAvailability> {
      const accounts = (await options.repository.listAccounts()).filter((account) => account.provider === "CODEX");
      return codexResetCreditAvailabilitySchema.parse({
        data: accounts.slice(0, 100).map((account) => ({ accountId: account.id, availableCreditCount: account.resetCreditsAvailable })),
        source: "space-gateway", isStale: false, error: null, checkedAt: now().toISOString()
      });
    },
    async redeem(accountId, idempotencyKey) {
      if (!/^gw_account:[a-f0-9]{32}$/.test(accountId)) throw new CodexResetCreditsError("STALE_CREDIT");
      const current = running.get(accountId);
      if (current) {
        if (current.idempotencyKey === idempotencyKey) return current.result;
        throw new SpaceConflictError("A reset credit redemption is already running for this account.");
      }
      const result = redeemOnce(accountId, idempotencyKey);
      running.set(accountId, { idempotencyKey, result });
      const clear = () => { if (running.get(accountId)?.result === result) running.delete(accountId); };
      void result.then(clear, clear);
      return result;
    }
  };
}

type CodexUsageAccount = CodexUsageAccountList["data"][number];

/** Usable like the quota cards say "Available" (`classifyQuota`, 1% threshold): no known window is below 1%. */
function usable(account: CodexUsageAccount): boolean {
  const { fiveHourRemainingPercent: fiveHour, weeklyRemainingPercent: weekly } = account;
  return (fiveHour != null || weekly != null) && (fiveHour ?? 100) >= 1 && (weekly ?? 100) >= 1;
}

const percent = (value: number | null | undefined) => (value == null ? "no data" : `${Math.round(value)}% left`);

/**
 * Tells the admins when a Codex account that was out of quota is usable again (its 5h or weekly reset, or a reset
 * OpenAI grants early). It reads the quotas Space Gateway's usage poller stores, so it makes no provider calls.
 */
export function createCodexQuotaResetWatch(input: {
  usage: () => Promise<CodexUsageAccountList>;
  admins: () => Promise<string[]>;
  raise: (notification: NotificationRaiseInput) => Promise<unknown>;
  log: { warn(meta: Record<string, unknown>, message: string): void };
  intervalMs?: number;
}) {
  // shortcut: the last state lives in memory, so a reset that lands while the API restarts is not announced; persist it if that matters.
  let before: Map<string, boolean> | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    const list = await input.usage();
    if (list.isStale) return;
    const previous = before;
    before = new Map(list.data.map((account) => [account.id, usable(account)]));
    const back = previous ? list.data.filter((account) => previous.get(account.id) === false && usable(account)) : [];
    if (!back.length) return;
    const owners = await input.admins();
    for (const account of back) for (const ownerUserId of owners) {
      await input.raise({
        ownerUserId, roomId: null, paneId: null, source: "SYSTEM", kind: "CODEX_QUOTA_RESET", severity: "ATTENTION",
        title: `Codex account available again: ${account.label ?? account.id}`,
        body: `${account.label ?? "The account"} has quota again (5h ${percent(account.fiveHourRemainingPercent)}, week ${percent(account.weeklyRemainingPercent)}).`,
        link: {}, dedupeKey: null, payload: { accountId: account.id }, telegram: null
      });
    }
  }

  return {
    tick,
    start() {
      timer ??= setInterval(() => { void tick().catch((error: unknown) => input.log.warn({ err: error }, "Codex quota reset watch failed.")); }, input.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

/** Starts the watch on the instance that runs the `codex-quota-reset-notify` job; every ADMIN is told. */
export function registerCodexQuotaResetWatch(app: FastifyInstance, input: {
  enabled: boolean; usage: () => Promise<CodexUsageAccountList>; store: Pick<SpaceStore, "listUsersWithRoomCounts">;
  notifications: { raise(notification: NotificationRaiseInput): Promise<unknown> };
}): void {
  const watch = createCodexQuotaResetWatch({
    usage: input.usage, raise: (notification) => input.notifications.raise(notification), log: app.log,
    admins: async () => ((await input.store.listUsersWithRoomCounts?.()) ?? []).filter((user) => user.role === "ADMIN").map((user) => user.id)
  });
  app.addHook("onReady", async () => { if (input.enabled) watch.start(); });
  app.addHook("onClose", async () => watch.stop());
}
