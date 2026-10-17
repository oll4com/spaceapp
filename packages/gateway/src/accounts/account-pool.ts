import { GATEWAY_FREE_PLAN_PAUSE_REASON, isGatewayFreePlan, type GatewayProvider } from "@space/contracts";
import type { GatewayAccountRecord, GatewayCredentialUpdate, GatewayRepository } from "@space/db";
import {
  handlePermanentFailure, handleQuotaExceeded, handleRateLimit, permanentFailureCodes, type AccountState, type UpstreamError
} from "../router/balancer.js";
import type { CredentialCipher } from "../credential-cipher.js";

/** Upstream answers that reject the access token itself, not only the refresh token. */
const accessTokenRejections = new Set(["token_expired", "token_invalidated", "app_session_terminated", "account_session_expired", "account_auth_invalidated"]);

const freePlanError = () => Object.assign(new Error(GATEWAY_FREE_PLAN_PAUSE_REASON), { code: "free_plan_paused" });

/** What the gateway stores (encrypted) for an OAuth account. */
export interface StoredCredentials {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Provider-side account id sent upstream (ChatGPT account id, Google project, ...). */
  upstreamAccountId: string | null;
  /** Access-token expiry (ms), when the provider reports one. */
  accessExpiresAtMs: number | null;
}

export interface RefreshedCredentials extends StoredCredentials {
  planType?: string | null;
  email?: string | null;
}

/** Provider-specific credential refresh. Throws `{ code }` errors; permanent codes mark the account for re-login. */
export interface CredentialRefresher {
  needsRefresh(account: GatewayAccountRecord, credentials: StoredCredentials, nowMs: number): boolean;
  refresh(credentials: StoredCredentials): Promise<RefreshedCredentials>;
}

interface RuntimeState {
  errorCount: number;
  lastErrorAt: number | null;
  cooldownUntil: number | null;
  lastSelectedAt: number | null;
  healthTier: number;
  /** Status learned from upstream that has not yet reached storage. */
  status: AccountState["status"] | null;
  resetAt: number | null;
  usedPercent: number | null;
  secondaryUsedPercent: number | null;
}

const ACCOUNT_CACHE_MS = 5_000;
/** A token refreshed this recently that the provider still rejects is not refreshed again. */
const FORCED_REFRESH_MIN_AGE_MS = 5 * 60_000;
const toSeconds = (iso: string | null | undefined) => (iso ? Date.parse(iso) / 1000 : null);
const toIso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/**
 * The accounts of one provider, with the per-account runtime state the balancer needs (errors, cooldowns,
 * last selection). Storage holds the durable part; this process holds the fast-changing part.
 */
export class AccountPool {
  private runtime = new Map<string, RuntimeState>();
  private cache: { at: number; accounts: GatewayAccountRecord[] } | null = null;

  constructor(private readonly options: {
    provider: GatewayProvider;
    repository: GatewayRepository;
    cipher: () => CredentialCipher | null;
    refresher: CredentialRefresher;
    now?: () => number;
  }) {}

  private nowMs() { return (this.options.now ?? Date.now)(); }

  private state(accountId: string): RuntimeState {
    let state = this.runtime.get(accountId);
    if (!state) {
      state = { errorCount: 0, lastErrorAt: null, cooldownUntil: null, lastSelectedAt: null, healthTier: 0, status: null, resetAt: null, usedPercent: null, secondaryUsedPercent: null };
      this.runtime.set(accountId, state);
    }
    return state;
  }

  invalidate() { this.cache = null; }

  /** A new sign-in replaced the account's credentials: what this process learned about the old ones no longer holds. */
  signedIn(accountId: string) {
    this.runtime.delete(accountId);
    this.invalidate();
  }

  /** Signed out: the provider rejected the account's credentials and they expired, so routing skips it until a new sign-in. */
  isSignedOut(account: GatewayAccountRecord): boolean {
    const state = this.toBalancerState(account);
    return state.status === "REAUTH_REQUIRED" && state.accessTokenExpiresAt !== null && state.accessTokenExpiresAt !== undefined
      && state.accessTokenExpiresAt <= this.nowMs() / 1000;
  }

  /**
   * A rate limit or used-up quota whose time is over: stored as active again, so the views stop showing a limit the
   * account no longer has even when no request went to it since. With `usageClear` (the provider's usage shows no
   * used-up limit) a block of more than an hour is lifted early too: the provider reset its limits before the time it
   * named. Shorter blocks are burst limits that end by themselves. True when it changed.
   */
  async liftExpiredBlock(account: GatewayAccountRecord, usageClear = false): Promise<boolean> {
    const status = this.state(account.id).status ?? account.status;
    if (status !== "RATE_LIMITED" && status !== "QUOTA_EXCEEDED") return false;
    const until = toSeconds(account.blockedUntil) ?? this.state(account.id).resetAt;
    const now = this.nowMs() / 1000;
    if (until === null || (until > now && !(usageClear && until - now > 3600))) return false;
    const runtime = this.state(account.id);
    runtime.status = "ACTIVE";
    runtime.resetAt = null;
    runtime.cooldownUntil = null;
    await this.options.repository.recordAccountState(account.id, { status: "ACTIVE", statusReason: null, blockedUntil: null });
    this.invalidate();
    return true;
  }

  async accounts(): Promise<GatewayAccountRecord[]> {
    const now = this.nowMs();
    if (!this.cache || now - this.cache.at > ACCOUNT_CACHE_MS) {
      const all = await this.options.repository.listAccounts();
      const own = all.filter((account) => account.provider === this.options.provider);
      this.cache = { at: now, accounts: await Promise.all(own.map((account) => this.pauseIfFree(account))) };
    }
    return this.cache.accounts;
  }

  /** A free-plan account is paused for good (operator rule 2026-10-13), whatever its plan was when it was added. */
  private async pauseIfFree(account: GatewayAccountRecord): Promise<GatewayAccountRecord> {
    if (account.status === "PAUSED" || !isGatewayFreePlan(account.planType)) return account;
    const paused = await this.options.repository.setAccountStatus(account.id, "PAUSED", GATEWAY_FREE_PLAN_PAUSE_REASON).catch(() => null);
    if (paused) process.stdout.write(`space-gateway paused ${account.id}: its plan is free\n`);
    // A failed write still keeps it out of this process; the next load stores the pause.
    return paused ?? { ...account, status: "PAUSED", statusReason: GATEWAY_FREE_PLAN_PAUSE_REASON };
  }

  /**
   * Balancer view: stored status and usage, overlaid with what this process learned since. With a quota key
   * (Antigravity: "gemini" or "claude") the usage comes from that quota group of the account instead.
   */
  toBalancerState(account: GatewayAccountRecord, quotaKey = ""): AccountState {
    const runtime = this.state(account.id);
    const blockedUntil = toSeconds(account.blockedUntil);
    const group = quotaKey ? account.quotaGroups?.find((item) => item.key === quotaKey) : undefined;
    const primary = quotaKey ? group?.primaryWindow ?? { usedPercent: null, resetAt: null, windowMinutes: null } : account.primaryWindow;
    const secondary = quotaKey ? group?.secondaryWindow ?? { usedPercent: null, resetAt: null, windowMinutes: null } : account.secondaryWindow;
    return {
      accountId: account.id,
      // A pause is the operator's (or the free-plan rule's): no limit or recovery learned upstream lifts it.
      status: account.status === "PAUSED" ? "PAUSED" : runtime.status ?? account.status,
      usedPercent: (quotaKey ? null : runtime.usedPercent) ?? primary.usedPercent,
      secondaryUsedPercent: (quotaKey ? null : runtime.secondaryUsedPercent) ?? secondary.usedPercent,
      resetAt: runtime.resetAt ?? blockedUntil,
      primaryResetAt: toSeconds(primary.resetAt),
      secondaryResetAt: toSeconds(secondary.resetAt),
      primaryWindowMinutes: primary.windowMinutes,
      cooldownUntil: runtime.cooldownUntil,
      lastErrorAt: runtime.lastErrorAt,
      lastSelectedAt: runtime.lastSelectedAt ?? toSeconds(account.lastUsedAt),
      errorCount: runtime.errorCount,
      planType: account.planType,
      healthTier: runtime.healthTier,
      accessTokenExpiresAt: toSeconds(account.credentialsExpiresAt)
    };
  }

  async balancerStates(filter?: (account: GatewayAccountRecord) => boolean): Promise<AccountState[]> {
    return (await this.accounts()).filter((account) => !filter || filter(account)).map((account) => this.toBalancerState(account));
  }

  private readonly activeByAccount = new Map<string, number>();
  private readonly activeResponses = new WeakMap<object, string>();

  /**
   * Records that an attempt chose this account. With the client's response, the request counts as in flight on the
   * account until the response closes; a retry on another account moves it there.
   */
  markSelected(accountId: string, response?: { once(event: "close", listener: () => void): unknown }) {
    this.state(accountId).lastSelectedAt = this.nowMs() / 1000;
    if (!response) return;
    const previous = this.activeResponses.get(response);
    if (previous === accountId) return;
    if (previous) this.release(previous);
    else response.once("close", () => { const current = this.activeResponses.get(response); if (current) this.release(current); this.activeResponses.delete(response); });
    this.activeResponses.set(response, accountId);
    this.activeByAccount.set(accountId, (this.activeByAccount.get(accountId) ?? 0) + 1);
  }

  private release(accountId: string) {
    const count = (this.activeByAccount.get(accountId) ?? 1) - 1;
    if (count > 0) this.activeByAccount.set(accountId, count); else this.activeByAccount.delete(accountId);
  }

  /** Requests in flight per account. */
  inFlight(): Record<string, number> { return Object.fromEntries(this.activeByAccount); }

  touch(accountId: string, usedAt: string) { return this.options.repository.touchAccounts([accountId], usedAt); }

  /** Writes back whatever the balancer changed on its state object (recovered limits, cleared cooldowns). */
  absorb(state: AccountState) {
    const runtime = this.state(state.accountId);
    runtime.errorCount = state.errorCount;
    runtime.lastErrorAt = state.lastErrorAt ?? null;
    runtime.cooldownUntil = state.cooldownUntil ?? null;
    if (state.status === "ACTIVE" && runtime.status && runtime.status !== "ACTIVE") {
      runtime.status = "ACTIVE";
      runtime.resetAt = null;
    }
  }

  async markSuccess(accountId: string) {
    const runtime = this.state(accountId);
    // The balancer lifts an expired block in memory only, so storage can still show a limit the account no longer has.
    const stored = (await this.accounts()).find((account) => account.id === accountId)?.status;
    const wasBlocked = (runtime.status !== null && runtime.status !== "ACTIVE") || stored === "RATE_LIMITED" || stored === "QUOTA_EXCEEDED";
    runtime.errorCount = 0;
    runtime.lastErrorAt = null;
    runtime.cooldownUntil = null;
    if (wasBlocked) {
      runtime.status = "ACTIVE";
      runtime.resetAt = null;
      await this.options.repository.recordAccountState(accountId, { status: "ACTIVE", statusReason: null, blockedUntil: null });
      this.invalidate();
    }
  }

  async markRateLimited(account: GatewayAccountRecord, error: UpstreamError) {
    const state = this.toBalancerState(account);
    handleRateLimit(state, error, this.nowMs() / 1000);
    await this.persistBlock(account.id, state, error.message ?? "Rate limited");
  }

  async markQuotaExceeded(account: GatewayAccountRecord, error: UpstreamError) {
    const state = this.toBalancerState(account);
    handleQuotaExceeded(state, error, this.nowMs() / 1000);
    await this.persistBlock(account.id, state, error.message ?? "Usage limit reached");
  }

  markTransientError(accountId: string) {
    const runtime = this.state(accountId);
    runtime.errorCount += 1;
    runtime.lastErrorAt = this.nowMs() / 1000;
  }

  async markPermanentFailure(account: GatewayAccountRecord, code: string, accessTokenRejected = accessTokenRejections.has(code)) {
    const state = this.toBalancerState(account);
    handlePermanentFailure(state, code);
    const runtime = this.state(account.id);
    runtime.status = state.status;
    await this.options.repository.recordAccountState(account.id, { status: state.status, statusReason: state.deactivationReason ?? null, blockedUntil: null });
    // codex-lb keeps a re-login account selectable while its access token is unexpired, which helps when only the
    // refresh token died. When the provider rejected the access token (or API key) itself, it does not work: mark it
    // expired so the account stays out of rotation (also after a restart) until it signs in again.
    if (accessTokenRejected) {
      const expiredAt = new Date(this.nowMs()).toISOString();
      await this.options.repository.withAccountCredentialLock(account.id, async (current) => (
        current.credentialsExpiresAt && Date.parse(current.credentialsExpiresAt) <= this.nowMs() ? null : { credentialsExpiresAt: expiredAt }
      )).catch(() => undefined);
    }
    this.invalidate();
  }

  private async persistBlock(accountId: string, state: AccountState, reason: string) {
    const runtime = this.state(accountId);
    runtime.status = state.status;
    runtime.errorCount = state.errorCount;
    runtime.lastErrorAt = state.lastErrorAt ?? null;
    runtime.cooldownUntil = state.cooldownUntil ?? null;
    runtime.resetAt = state.resetAt ?? null;
    if (state.status === "QUOTA_EXCEEDED") runtime.usedPercent = 100;
    await this.options.repository.recordAccountState(accountId, { status: state.status, statusReason: reason.slice(0, 500), blockedUntil: toIso(state.resetAt) });
    this.invalidate();
  }

  /** Passive usage learned from response headers, applied at once and stored for the dashboards. */
  async recordUsage(accountId: string, usage: { primaryUsedPercent: number | null; secondaryUsedPercent: number | null;
    primaryResetAt: string | null; secondaryResetAt: string | null; primaryWindowMinutes: number | null; secondaryWindowMinutes: number | null }) {
    const runtime = this.state(accountId);
    if (usage.primaryUsedPercent !== null) runtime.usedPercent = usage.primaryUsedPercent;
    if (usage.secondaryUsedPercent !== null) runtime.secondaryUsedPercent = usage.secondaryUsedPercent;
    const windows = [];
    if (usage.primaryUsedPercent !== null) windows.push({ window: "PRIMARY" as const, usedPercent: usage.primaryUsedPercent, resetAt: usage.primaryResetAt, windowMinutes: usage.primaryWindowMinutes });
    if (usage.secondaryUsedPercent !== null) windows.push({ window: "SECONDARY" as const, usedPercent: usage.secondaryUsedPercent, resetAt: usage.secondaryResetAt, windowMinutes: usage.secondaryWindowMinutes });
    if (windows.length > 0) await this.options.repository.saveUsageWindows(accountId, windows);
  }

  /**
   * Decrypted credentials, refreshed first when due. Only one holder refreshes an account at a time (storage
   * lock), and a holder that waited sees the token the other one stored instead of refreshing it again.
   */
  async credentials(account: GatewayAccountRecord): Promise<StoredCredentials> {
    const cipher = this.options.cipher();
    if (!cipher) throw Object.assign(new Error("The gateway encryption key is missing."), { code: "credential_key_missing" });
    if (isGatewayFreePlan(account.planType)) { await this.pauseIfFree(account); this.invalidate(); throw freePlanError(); }
    const current = JSON.parse(cipher.decrypt(account.credentialsEncrypted, account.id)) as StoredCredentials;
    if (!this.options.refresher.needsRefresh(account, current, this.nowMs())) return current;
    let result: StoredCredentials = current;
    let permanentCode: string | null = null;
    const updated = await this.options.repository.withAccountCredentialLock(account.id, async (fresh) => {
      const latest = JSON.parse(cipher.decrypt(fresh.credentialsEncrypted, fresh.id)) as StoredCredentials;
      if (!this.options.refresher.needsRefresh(fresh, latest, this.nowMs())) { result = latest; return null; }
      try {
        const { stored, update } = this.refreshedUpdate(cipher, fresh.id, await this.options.refresher.refresh(latest));
        result = stored;
        return update;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string" && code in permanentFailureCodes) {
          permanentCode = code;
          return null;
        }
        // A transient refresh failure keeps the current token; it is still valid until it expires.
        result = latest;
        return null;
      }
    });
    if (permanentCode && updated) {
      await this.markPermanentFailure(updated, permanentCode);
      if (this.toBalancerState(updated).status === "DEACTIVATED") {
        throw Object.assign(new Error(permanentFailureCodes[permanentCode]!), { code: permanentCode });
      }
    }
    this.invalidate();
    // The refresh showed the plan is now free: the request goes to another account.
    if (updated && isGatewayFreePlan(updated.planType)) { await this.pauseIfFree(updated); throw freePlanError(); }
    return result;
  }

  /**
   * The provider rejected the account's access token (HTTP 401). Like codex-lb, refresh it once before giving up on
   * the account: the refreshed account to retry the request with, or null. A refresh the provider refuses marks the
   * account for re-login; one that could not reach it only cools the account down, so the next request tries again.
   */
  async refreshRejectedToken(account: GatewayAccountRecord, code: string): Promise<GatewayAccountRecord | null> {
    const cipher = this.options.cipher();
    const refreshedAt = account.lastRefreshAt ? Date.parse(account.lastRefreshAt) : 0;
    if (!cipher || !accessTokenRejections.has(code) || this.nowMs() - refreshedAt < FORCED_REFRESH_MIN_AGE_MS) {
      await this.markPermanentFailure(account, code);
      return null;
    }
    let outcome = "refused" as "renewed" | "refused" | "unreachable";
    let refusal = code;
    const updated = await this.options.repository.withAccountCredentialLock(account.id, async (fresh) => {
      // Another holder refreshed it while this one waited: retry with that token.
      if (fresh.lastRefreshAt !== account.lastRefreshAt) { outcome = "renewed"; return null; }
      const latest = JSON.parse(cipher.decrypt(fresh.credentialsEncrypted, fresh.id)) as StoredCredentials;
      if (!latest.refreshToken) return null;
      try {
        const { update } = this.refreshedUpdate(cipher, fresh.id, await this.options.refresher.refresh(latest));
        outcome = "renewed";
        return fresh.status === "REAUTH_REQUIRED" ? { ...update, status: "ACTIVE", statusReason: null } : update;
      } catch (error) {
        const errorCode = (error as { code?: unknown }).code;
        if (typeof errorCode === "string" && errorCode in permanentFailureCodes) refusal = errorCode;
        else outcome = "unreachable";
        return null;
      }
    }).catch(() => { outcome = "unreachable"; return null; });
    if (outcome === "renewed" && updated && isGatewayFreePlan(updated.planType)) {
      await this.pauseIfFree(updated);
      this.invalidate();
      return null;
    }
    if (outcome === "renewed" && updated) {
      const runtime = this.state(account.id);
      if (runtime.status === "REAUTH_REQUIRED") runtime.status = "ACTIVE";
      this.invalidate();
      return updated;
    }
    if (outcome === "unreachable") this.markTransientError(account.id);
    else await this.markPermanentFailure(updated ?? account, refusal, true);
    return null;
  }

  /** What storage keeps after a refresh: the new credentials (encrypted), their expiry and the refresh time. */
  private refreshedUpdate(cipher: CredentialCipher, accountId: string, refreshed: RefreshedCredentials): { stored: StoredCredentials; update: GatewayCredentialUpdate } {
    const { planType, email, ...stored } = refreshed;
    return {
      stored,
      update: {
        credentialsEncrypted: cipher.encrypt(JSON.stringify(stored), accountId),
        credentialsExpiresAt: stored.accessExpiresAtMs ? new Date(stored.accessExpiresAtMs).toISOString() : null,
        lastRefreshAt: new Date(this.nowMs()).toISOString(),
        ...(planType ? { planType } : {}),
        ...(email ? { email } : {})
      }
    };
  }
}
