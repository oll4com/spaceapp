import { useCallback, useEffect, useMemo, useState } from "react";
import type { GatewayAccount, GatewayAccountDetail, GatewayAnthropicBillingReport, GatewaySettings } from "@space/contracts";
import { matchesAvailabilityFilter, type AccountAvailabilityFilter } from "../toolbar-metrics/account-availability.js";
import { AvailabilityFilterBar, countAvailability } from "../toolbar-metrics/AccountQuotaCards.js";
import { anthropicBillLines } from "../toolbar-metrics/account-entries.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { AddAccount, CopyButton, SignInAgain } from "./gateway-add-account.js";
import { RemainingBar, TrendChart } from "./gateway-charts.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import {
  accountName, accountStatusLabel, accountStatusTone, formatAgo, formatCostPrecise, formatCountdown, formatDateTime, formatPercent, formatTokens,
  gatewayAccountAvailability, planLabel, providerLabel
} from "./space-gateway-model.js";

const quotaGroupLabels: Record<string, string> = { gemini: "Gemini", claude: "Claude and GPT" };
const quotaGroupLabel = (key: string) => quotaGroupLabels[key] ?? key;
const remaining = (used: number | null) => (used === null ? null : Math.max(0, 100 - used));

const statusFilters: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" }, { value: "ACTIVE", label: "Active" }, { value: "PAUSED", label: "Paused" },
  { value: "RATE_LIMITED", label: "Rate limited" }, { value: "QUOTA_EXCEEDED", label: "Quota used up" },
  { value: "REAUTH_REQUIRED", label: "Sign in again" }, { value: "DEACTIVATED", label: "Deactivated" }
];

const resetOutcomes: Record<string, string> = {
  RESET: "Weekly limit reset.", NOTHING_TO_RESET: "Nothing to reset: the limits are not used up.", NO_CREDIT: "No reset credit is available.",
  ALREADY_REDEEMED: "This reset was already applied."
};

function UsageWindows({ account, windows, now, compact = false }: {
  account: GatewayAccount; windows: GatewaySettings["displayAccountWindows"]; now: number; compact?: boolean;
}) {
  if (account.quotaGroups && account.quotaGroups.length > 0) {
    return (
      <div className="gw-quota-groups">
        {account.quotaGroups.map((group) => (
          <div key={group.key} className="gw-quota-group">
            <span className="space-gateway-quota-group-name">{quotaGroupLabel(group.key)}</span>
            {windows !== "SECONDARY" ? <RemainingBar compact={compact} label="5h" remaining={remaining(group.primaryWindow.usedPercent)} resetAt={group.primaryWindow.resetAt} now={now} /> : null}
            {windows !== "PRIMARY" ? <RemainingBar compact={compact} label="Weekly" remaining={remaining(group.secondaryWindow.usedPercent)} resetAt={group.secondaryWindow.resetAt} now={now} /> : null}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="gw-quota-group">
      {windows !== "SECONDARY" ? <RemainingBar compact={compact} label="5h" remaining={remaining(account.primaryWindow.usedPercent)} resetAt={account.primaryWindow.resetAt} now={now} /> : null}
      {windows !== "PRIMARY" ? <RemainingBar compact={compact} label="Weekly" remaining={remaining(account.secondaryWindow.usedPercent)} resetAt={account.secondaryWindow.resetAt} now={now} /> : null}
    </div>
  );
}

/** Accounts Space Gateway stopped using until they sign in again. */
const needsSignIn = (account: Pick<GatewayAccount, "status">) => account.status === "REAUTH_REQUIRED" || account.status === "DEACTIVATED";

function tokenExpiry(expiresAt: string | null, now: number, status: GatewayAccount["status"]) {
  if (!expiresAt) return "Unknown";
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return "Unknown";
  if (ms <= 0) return status === "REAUTH_REQUIRED" ? "Rejected or expired: sign in again" : "Expired (refreshed on next use)";
  return `Valid, ${formatCountdown(expiresAt, now).replace(/^Resets in/, "expires in")}`;
}

const yesNo = (value: boolean | null, yes: string, no: string) => (value === null ? "Unknown" : value ? yes : no);

function AccountDetail({ account, client, settings, hideEmails, now, openSignIn, onChanged }: {
  account: GatewayAccount; client: SpaceGatewayClient; settings: GatewaySettings | null; hideEmails: boolean; now: number;
  /** Changes when the list's "Sign in again" label was clicked: opens the sign-in. */
  openSignIn: number;
  onChanged: (message?: string) => void;
}) {
  const [detail, setDetail] = useState<GatewayAccountDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [alias, setAlias] = useState(account.alias ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "reset" | "export" | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [bill, setBill] = useState<GatewayAnthropicBillingReport | null>(null);
  const timeFormat = settings?.displayTimeFormat ?? "24H";
  const apiKeyAccount = account.provider === "CLAUDE" && account.planType === "api";
  useEffect(() => {
    let active = true;
    setBill(null);
    if (apiKeyAccount && client.anthropicBilling) void client.anthropicBilling(31).then((next) => { if (active) setBill(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [apiKeyAccount, client, account.id]);
  const signInNeeded = needsSignIn(account);
  useEffect(() => { if (openSignIn && signInNeeded) setSigningIn(true); }, [openSignIn, signInNeeded]);

  const loadDetail = useCallback(async () => {
    try { setDetail(await client.accountDetail(account.id)); setDetailError(null); }
    catch (reason) { setDetailError(errorText(reason, "Could not load account details.")); }
  }, [client, account.id]);
  useEffect(() => { setAlias(account.alias ?? ""); setExported(null); setConfirm(null); setNotice(null); }, [account.id, account.alias]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  async function run(action: () => Promise<string | void>, failure: string) {
    setPending(true);
    setNotice(null);
    try {
      const message = await action();
      setConfirm(null);
      if (message) setNotice({ tone: "ok", text: message });
      onChanged();
      void loadDetail();
    } catch (reason) {
      setNotice({ tone: "error", text: errorText(reason, failure) });
    } finally {
      setPending(false);
    }
  }

  const name = accountName(account);
  const downloadExport = () => {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "auth.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="gw-detail" aria-label={`${name} details`}>
      <header className="gw-detail-head">
        <div>
          <h3>{name}</h3>
          <span className="space-gateway-note">{account.alias ? `${account.label} · ` : ""}{account.email ? (hideEmails ? "Email hidden" : account.email) : "No email"}</span>
        </div>
        <div className="gw-chips">
          <span className="space-gateway-chip">{providerLabel(account.provider)}</span>
          <span className="space-gateway-chip">{planLabel(account.planType)}</span>
          {needsSignIn(account)
            ? <button type="button" className={`space-gateway-chip tone-${accountStatusTone(account.status)} is-action`} aria-expanded={signingIn}
              title="Sign this account in again" onClick={() => setSigningIn(true)}>{accountStatusLabel(account.status)}</button>
            : <span className={`space-gateway-chip tone-${accountStatusTone(account.status)}`}>{accountStatusLabel(account.status)}</span>}
        </div>
      </header>
      {account.statusReason ? <p className="space-gateway-account-reason">{account.statusReason}</p> : null}
      {needsSignIn(account) ? (
        <div className="gw-signin-needed" role="status">
          <span>Space Gateway no longer sends requests to this account. Sign it in again to bring it back.</span>
          <button type="button" className="space-gateway-button primary" aria-expanded={signingIn} onClick={() => setSigningIn(!signingIn)}>
            {signingIn ? "Close sign-in" : "Sign in again"}</button>
        </div>
      ) : null}
      {signingIn && needsSignIn(account) ? (
        <SignInAgain client={client} account={account} onConnected={(label, accountId) => {
          setSigningIn(false);
          onChanged(accountId && accountId !== account.id
            ? `${label} was added as a different account. Sign in with ${name} to bring this one back.`
            : `${name} is signed in again.`);
        }} />
      ) : null}
      {apiKeyAccount ? (
        <p className="space-gateway-note" data-testid="claude-api-key-role">
          {settings?.claudeApiKeyFallback
            ? "Fallback: serves Claude requests from clients other than Claude Code only while every pooled Claude account is out of quota; the accounts take over again at their next reset. Claude Code never uses it."
            : "Not used: Claude API key fallback is off (Settings › Routing). Turn it on to serve requests while every pooled Claude account is out of quota."}
          {" "}
          <strong>{detail
            ? detail.lifetime.requests === 0 && !account.lastUsedAt ? "Never used." : `Served ${formatTokens(detail.lifetime.requests)} requests · last used ${formatAgo(account.lastUsedAt, now, timeFormat)}.`
            : account.lastUsedAt ? `Last used ${formatAgo(account.lastUsedAt, now, timeFormat)}.` : "Never used."}</strong>
        </p>
      ) : null}
      {apiKeyAccount ? anthropicBillLines(bill, now).map((line) => <p key={line} className="space-gateway-note" data-testid="claude-api-key-bill">{line}</p>) : null}

      <form className="gw-inline-form" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => { await client.updateAccount(account.id, { alias: alias.trim() || null }); return alias.trim() ? `Alias saved: ${alias.trim()}.` : "Alias removed."; }, "Could not save the alias.");
      }}>
        <label className="space-gateway-field">Alias
          <input value={alias} maxLength={80} placeholder={account.label} onChange={(event) => setAlias(event.target.value)} />
        </label>
        <button type="submit" className="space-gateway-button" disabled={pending || alias.trim() === (account.alias ?? "")}>Save alias</button>
      </form>

      <div className="gw-detail-block">
        <h4>Usage</h4>
        <UsageWindows account={account} windows="BOTH" now={now} />
        <span className="space-gateway-note">Usage read {formatAgo(account.lastRefreshAt, now, timeFormat)} · last used {formatAgo(account.lastUsedAt, now, timeFormat)}</span>
      </div>

      {detailError ? <p className="space-gateway-alert" role="alert">{detailError}</p> : null}
      {detail ? (
        <>
          <dl className="space-gateway-stats gw-compact-stats" aria-label="Request totals">
            <div className="space-gateway-stat"><dt>Requests (all time)</dt><dd>{formatTokens(detail.lifetime.requests)}</dd>
              <span>{formatTokens(detail.last7d.requests)} in 7 days · {detail.last7d.errors} errors</span></div>
            <div className="space-gateway-stat"><dt>Tokens (all time)</dt><dd>{formatTokens(detail.lifetime.inputTokens + detail.lifetime.outputTokens)}</dd>
              <span>{formatTokens(detail.lifetime.cachedInputTokens)} cached input</span></div>
            <div className="space-gateway-stat"><dt>Cost (all time)</dt><dd>{formatCostPrecise(detail.lifetime.costUsd)}</dd>
              <span>{formatCostPrecise(detail.last7d.costUsd)} in 7 days</span></div>
          </dl>
          <div className="gw-detail-block">
            <h4>Remaining over 7 days</h4>
            <TrendChart label={`${name} remaining quota over 7 days`} percent timeFormat={timeFormat} formatValue={(value) => formatPercent(value)}
              series={[{ id: "primary", label: "5h", points: detail.trend.primary }, { id: "secondary", label: "Weekly", points: detail.trend.secondary },
                { id: "plan", label: "Weekly plan", points: detail.trend.secondaryScheduled, muted: true }]} />
            <span className="space-gateway-note">Weekly plan: what would be left if the week were used evenly until its reset.</span>
          </div>
          <dl className="gw-facts" aria-label="Sign-in status">
            <dt>Access token</dt><dd>{tokenExpiry(detail.tokenStatus.accessExpiresAt, now, account.status)}</dd>
            <dt>Refresh token</dt><dd>{yesNo(detail.tokenStatus.refreshStored, "Stored", "Missing")}</dd>
            <dt>ID token</dt><dd>{yesNo(detail.tokenStatus.idTokenParsed, "Parsed", "Not readable")}</dd>
            <dt>Last sign-in refresh</dt><dd>{formatDateTime(detail.tokenStatus.lastRefreshAt, timeFormat)}</dd>
            <dt>Added by</dt><dd>{detail.tokenStatus.source}</dd>
            <dt>Last warm-up</dt><dd>{detail.lastWarmup ? `${detail.lastWarmup.status.toLowerCase()} · ${detail.lastWarmup.window === "PRIMARY" ? "5h" : "weekly"} · ${formatAgo(detail.lastWarmup.attemptedAt, now, timeFormat)}${detail.lastWarmup.errorCode ? ` · ${detail.lastWarmup.errorCode}` : ""}` : "None yet"}</dd>
          </dl>
        </>
      ) : detailError ? null : <p className="space-gateway-empty">Loading details…</p>}

      <SpaceToggle checked={account.warmupEnabled} label="Limit warm-up"
        detail={settings?.warmupEnabled ? "Send one tiny request right after this account's window resets." : "Limit warm-up is off in Settings; this account joins when it is turned on."}
        onChange={(checked) => void run(async () => { await client.updateAccount(account.id, { warmupEnabled: checked }); return checked ? "Warm-up enabled." : "Warm-up disabled."; }, "Could not change warm-up.")} />

      {notice ? <p className={notice.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={notice.tone === "ok" ? "status" : "alert"}>{notice.text}</p> : null}

      <div className="space-gateway-toolbar">
        <button type="button" className="space-gateway-button" disabled={pending || account.status === "DEACTIVATED"}
          title={account.status === "DEACTIVATED" ? "Sign the account in again to reactivate it" : undefined}
          onClick={() => void run(async () => { await client.setAccountPaused(account.id, account.status !== "PAUSED"); return account.status === "PAUSED" ? `${name} resumed.` : `${name} paused.`; }, "Could not update the account.")}>
          {account.status === "PAUSED" ? "Resume" : "Pause"}
        </button>
        <button type="button" className="space-gateway-button" disabled={pending} title="Send one tiny request with this account"
          onClick={() => void run(async () => {
            const result = await client.testAccount(account.id);
            if (!result.ok) throw new Error(`${name} test failed: ${result.error ?? `HTTP ${result.status}`}`);
            return result.model ? `${name} answered with ${result.model} in ${result.latencyMs} ms.` : `${name} is signed in and reachable (${result.latencyMs} ms).`;
          }, "The test failed.")}>Test</button>
        <button type="button" className="space-gateway-button" disabled={pending} title="Read the current 5h and weekly usage from the provider"
          onClick={() => void run(async () => { await client.refreshUsage(account.id); return `Usage refreshed for ${name}.`; }, "Could not refresh usage.")}>Refresh usage</button>
        {account.resetCreditsAvailable ? (confirm === "reset"
          ? <button type="button" className="space-gateway-button danger" disabled={pending}
            onClick={() => void run(async () => { const result = await client.useResetCredit(account.id, crypto.randomUUID()); return `${name}: ${resetOutcomes[result.outcome] ?? result.outcome}`; }, "Could not use the reset credit.")}>Confirm reset</button>
          : <button type="button" className="space-gateway-button" disabled={pending} title="Spend one weekly limit reset credit on this account"
            onClick={() => setConfirm("reset")}>Use reset credit ({account.resetCreditsAvailable})</button>) : null}
        {account.provider === "CODEX" ? (confirm === "export"
          ? <button type="button" className="space-gateway-button danger" disabled={pending}
            onClick={() => void run(async () => { setExported((await client.exportAccount(account.id)).authJson); }, "Could not export the sign-in.")}>Confirm export</button>
          : <button type="button" className="space-gateway-button" disabled={pending} title="Show this account's sign-in as a Codex auth.json"
            onClick={() => setConfirm("export")}>Export auth.json</button>) : null}
        {confirm === "remove"
          ? <button type="button" className="space-gateway-button danger" disabled={pending}
            onClick={() => void run(async () => { await client.deleteAccount(account.id); onChanged(`${name} removed from Space Gateway.`); }, "Could not remove the account.")}>Confirm remove</button>
          : <button type="button" className="space-gateway-button" disabled={pending} onClick={() => setConfirm("remove")}>Remove</button>}
      </div>
      {confirm === "export" && !exported ? (
        <p className="space-gateway-note" role="status">The export contains this account's current access token but no refresh token, so it works only until that token expires. Whoever holds it can use this account until then. Every export is recorded in the audit log.</p>
      ) : null}
      {exported ? (
        <div className="space-gateway-created" role="status">
          <strong>This auth.json is a live sign-in. Keep it private.</strong>
          <textarea readOnly rows={6} value={exported} aria-label="Exported auth.json" className="gw-export" />
          <div className="space-gateway-toolbar">
            <CopyButton text={exported} label="Copy auth.json" />
            <button type="button" className="space-gateway-button" onClick={downloadExport}>Download</button>
            <button type="button" className="space-gateway-button" onClick={() => setExported(null)}>Hide</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function GatewayAccountsTab({ client, settings, initialAccountId, initialAdd = null, onChanged }: {
  client: SpaceGatewayClient; settings: GatewaySettings | null; initialAccountId?: string | null;
  /** Open with the add-account form on Claude › API key (the Routing tab's shortcut). */
  initialAdd?: "claude-api-key" | null; onChanged: () => void;
}) {
  const [accounts, setAccounts] = useState<GatewayAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [providerFilter, setProviderFilter] = useState("ALL");
  const [planFilter, setPlanFilter] = useState("ALL");
  const [availability, setAvailability] = useState<AccountAvailabilityFilter>("all");
  const [hideEmails, setHideEmails] = useState(true);
  const [adding, setAdding] = useState(initialAdd !== null);
  const [selectedId, setSelectedId] = useState<string | null>(initialAccountId ?? null);
  const [signInRequest, setSignInRequest] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const windows = settings?.displayAccountWindows ?? "BOTH";

  const load = useCallback(async () => {
    try { setAccounts((await client.accounts()).data); setError(null); setNow(Date.now()); }
    catch (reason) { setError(errorText(reason, "Could not load accounts.")); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Provider, plan and status narrow the list; the availability tiles count what is left (as Resources does per provider).
  const providers = useMemo(() => [...new Set((accounts ?? []).map((account) => account.provider))].sort(), [accounts]);
  const plans = useMemo(() => [...new Set((accounts ?? []).map((account) => account.planType ?? "unknown"))].sort(), [accounts]);
  const narrowed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (accounts ?? []).filter((account) => (statusFilter === "ALL" || account.status === statusFilter)
      && (providerFilter === "ALL" || account.provider === providerFilter)
      && (planFilter === "ALL" || (account.planType ?? "unknown") === planFilter)
      && (!needle || [account.label, account.alias, account.email, account.id, account.planType, providerLabel(account.provider)]
        .some((value) => value?.toLowerCase().includes(needle))))
      .map((account) => ({ account, availability: gatewayAccountAvailability(account, now) }));
  }, [accounts, query, statusFilter, providerFilter, planFilter, now]);
  const counts = useMemo(() => countAvailability(narrowed), [narrowed]);
  const visible = useMemo(() => narrowed.filter((entry) => matchesAvailabilityFilter(entry.availability.state, availability)).map((entry) => entry.account),
    [narrowed, availability]);
  const selected = visible.find((account) => account.id === selectedId) ?? visible[0] ?? null;

  if (error && !accounts) return <p className="space-gateway-alert" role="alert">{error}</p>;
  if (!accounts) return <p className="space-gateway-empty">Loading accounts…</p>;
  const showAdd = adding || accounts.length === 0;
  return (
    <div className="space-gateway-panel">
      {accounts.length > 0 ? <AvailabilityFilterBar counts={counts} value={availability} onChange={setAvailability} /> : null}
      <div className="space-gateway-toolbar">
        <input className="gw-search" type="search" value={query} aria-label="Search accounts" placeholder="Search name, email, plan or id"
          onChange={(event) => setQuery(event.target.value)} />
        <select className="gw-select" aria-label="Provider" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
          <option value="ALL">All providers</option>
          {providers.map((provider) => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}
        </select>
        <select className="gw-select" aria-label="Plan" value={planFilter} onChange={(event) => setPlanFilter(event.target.value)}>
          <option value="ALL">All plans</option>
          {plans.map((plan) => <option key={plan} value={plan}>{plan === "unknown" ? "Unknown plan" : planLabel(plan)}</option>)}
        </select>
        <select className="gw-select" aria-label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          {statusFilters.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <SpaceToggle checked={hideEmails} label="Hide emails" onChange={setHideEmails} />
        {accounts.length > 0 ? <button type="button" className="space-gateway-button" aria-expanded={showAdd} onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add account"}</button> : null}
      </div>
      {showAdd ? <AddAccount client={client} onConnected={() => { void load(); onChanged(); }}
        initialProvider={initialAdd === "claude-api-key" ? "CLAUDE" : undefined} initialClaudeMethod={initialAdd === "claude-api-key" ? "api-key" : undefined} /> : null}
      {settings ? <p className="space-gateway-note">Imports {settings.importWithoutOverwrite ? "never replace" : "may replace"} an account with the same email but a different upstream account (Settings).</p> : null}
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {notice ? <p className="space-gateway-success" role="status">{notice}</p> : null}
      {accounts.length === 0 ? <p className="space-gateway-empty">No accounts connected yet. Accounts appear here once a provider is signed in through Space Gateway.</p> : (
        <div className="gw-split">
          <ul className="gw-list" aria-label="Accounts">
            {visible.length === 0 ? <li className="space-gateway-empty">No account matches.</li> : visible.map((account) => (
              <li key={account.id}>
                <button type="button" className={`gw-list-item${selected?.id === account.id ? " is-selected" : ""} status-${account.status.toLowerCase()}`}
                  aria-pressed={selected?.id === account.id} onClick={(event) => {
                    setSelectedId(account.id);
                    // The "Sign in again" label opens the account's sign-in.
                    if ((event.target as HTMLElement).closest("[data-sign-in]")) setSignInRequest({ id: account.id, at: Date.now() });
                  }}>
                  <span className="gw-list-title"><strong>{accountName(account)}</strong>
                    <span className={`space-gateway-chip tone-${accountStatusTone(account.status)}${needsSignIn(account) ? " is-action" : ""}`}
                      data-sign-in={needsSignIn(account) ? "" : undefined} title={needsSignIn(account) ? "Sign this account in again" : undefined}>
                      {accountStatusLabel(account.status)}</span></span>
                  <span className="space-gateway-note">{providerLabel(account.provider)} · {planLabel(account.planType)}{account.email ? ` · ${hideEmails ? "Email hidden" : account.email}` : ""}</span>
                  <UsageWindows account={account} windows={windows} now={now} compact />
                </button>
              </li>
            ))}
          </ul>
          {selected ? <AccountDetail key={selected.id} account={selected} client={client} settings={settings} hideEmails={hideEmails} now={now}
            openSignIn={signInRequest?.id === selected.id ? signInRequest.at : 0} onChanged={(message) => { if (message) setNotice(message); void load(); onChanged(); }} /> : null}
        </div>
      )}
    </div>
  );
}
