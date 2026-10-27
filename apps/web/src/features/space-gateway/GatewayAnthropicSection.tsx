import { useEffect, useState } from "react";
import type { GatewayAnthropicAdminStatus, GatewaySettings } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";

/** Sync error codes from the gateway, in words. */
const syncErrors: Record<string, string> = {
  no_matching_api_key: "No Anthropic API key of this organization matches the gateway's Claude API-key account.",
  anthropic_unreachable: "Anthropic could not be reached.",
  anthropic_http_401: "Anthropic rejected the admin key (HTTP 401). Save a new one.",
  anthropic_http_403: "Anthropic refused the admin key (HTTP 403). It needs an organization admin.",
  anthropic_http_429: "Anthropic asked to slow down (HTTP 429); the next sync retries.",
  admin_key_unreadable: "The stored key could not be read. Save it again.",
  credential_key_missing: "The Space Gateway encryption key is missing. Redeploy Space to create it."
};

/**
 * Anthropic billing (operator request 2026-10-18): the operator's Anthropic Admin API key goes in once, sealed by Space
 * Gateway and never shown again; the gateway reads the organization's real cost every 5 minutes and the daily cost caps
 * of keys on the Claude API-key account count it.
 */
export function AnthropicBillingSection({ settings, client, onSaved }: {
  settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void;
}) {
  const [status, setStatus] = useState<GatewayAnthropicAdminStatus | null>(null);
  const [budget, setBudget] = useState(settings.anthropicMonthlyBudgetUsd === null ? "" : String(settings.anthropicMonthlyBudgetUsd));
  const [credits, setCredits] = useState(settings.anthropicCreditsUsd === null ? "" : String(settings.anthropicCreditsUsd));
  const [adminKey, setAdminKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    client.anthropicAdmin().then((next) => { if (active) setStatus(next); }).catch((reason) => {
      if (active) setMessage({ tone: "error", text: errorText(reason, "Could not read the Anthropic billing state.") });
    });
    return () => { active = false; };
  }, [client]);
  const run = async (action: () => Promise<GatewayAnthropicAdminStatus | null>, success: string) => {
    setBusy(true);
    setConfirmRemove(false);
    try {
      const next = await action();
      setStatus(next ?? { configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] });
      setMessage({ tone: "ok", text: success });
    } catch (reason) {
      setMessage({ tone: "error", text: errorText(reason, "Anthropic billing could not be changed.") });
    } finally {
      setBusy(false);
    }
  };
  // Saved settings remount the settings tab, which reads the amounts back.
  const saveAmounts = async () => {
    const amount = (text: string) => (text.trim() ? Number(text) : null);
    const value = amount(budget);
    const creditsValue = amount(credits);
    if ([value, creditsValue].some((usd) => usd !== null && !(usd > 0 && usd <= 10_000_000))) {
      setMessage({ tone: "error", text: "The budget and the credits must be dollar amounts above 0." });
      return;
    }
    setBusy(true);
    try {
      onSaved(await client.updateSettings({ anthropicMonthlyBudgetUsd: value, anthropicCreditsUsd: creditsValue }));
      setMessage({ tone: "ok", text: "Budget and credits saved." });
    } catch (reason) {
      setMessage({ tone: "error", text: errorText(reason, "Could not save the budget and credits.") });
    } finally {
      setBusy(false);
    }
  };
  const error = status?.lastError ? syncErrors[status.lastError] ?? `The last sync failed (${status.lastError}).` : null;
  return (
    <form className="gw-card" aria-label="Anthropic billing" onSubmit={(event) => {
      event.preventDefault();
      const key = adminKey.trim();
      setAdminKey("");
      void run(() => client.saveAnthropicAdminKey(key), "Admin key saved and checked. Space Gateway now reads Anthropic's bill every 5 minutes.");
    }}>
      <header><h3>Anthropic billing</h3>
        <span className="space-gateway-note">{status?.configured ? `Admin key ${status.keyHint ?? ""}` : "No admin key"}</span></header>
      <p className="space-gateway-note">With an Anthropic Admin API key (Claude Console → Settings → Admin keys, sk-ant-admin01-…), Space Gateway reads the
        organization's real cost and usage. Token usage shows the bill next to the gateway's estimate, and the daily cost limits of keys on the Claude API-key
        account count the real charge. An admin key can manage the whole organization: give it an expiry. It is sealed here and never shown again.</p>
      {status?.configured ? (
        <dl className="space-gateway-stats">
          <div className="space-gateway-stat"><dt>Saved</dt><dd>{formatUserTime(status.savedAt, { withDate: true })}</dd></div>
          <div className="space-gateway-stat"><dt>Last sync</dt><dd>{status.lastSyncAt ? formatUserTime(status.lastSyncAt, { withDate: true }) : "Not yet"}</dd></div>
          <div className="space-gateway-stat"><dt>Matched Anthropic keys</dt>
            <dd>{status.upstream.length ? status.upstream.map((key) => key.keyName || key.apiKeyId).join(", ") : "None"}</dd></div>
        </dl>
      ) : null}
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      <label className="space-gateway-field">{status?.configured ? "Replace admin key" : "Admin API key"}
        <input type="password" autoComplete="off" spellCheck={false} value={adminKey} placeholder="sk-ant-admin01-…"
          onChange={(event) => setAdminKey(event.target.value)} />
      </label>
      <label className="space-gateway-field">Monthly API budget (USD)
        <input type="number" min={0} step="any" inputMode="decimal" value={budget} placeholder="Not set" onChange={(event) => setBudget(event.target.value)} />
        <span>The Claude API-key account shows this month's Anthropic bill as a share of it. Empty: no budget.</span></label>
      <label className="space-gateway-field">Anthropic credits (USD)
        <input type="number" min={0} step="any" inputMode="decimal" value={credits} placeholder="Not set" onChange={(event) => setCredits(event.target.value)} />
        <span>All credit grants in Claude Console → Billing added up. Resources → API shows what is left: these credits minus Anthropic's recorded bill. Empty: not shown.</span></label>
      {message ? <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
      <div className="space-gateway-toolbar">
        <button type="submit" className="space-gateway-button primary" disabled={busy || !adminKey.trim()}>Save and check</button>
        <button type="button" className="space-gateway-button" disabled={busy} onClick={() => void saveAmounts()}>Save budget and credits</button>
        {status?.configured ? (
          <>
            <button type="button" className="space-gateway-button" disabled={busy}
              onClick={() => void run(() => client.syncAnthropicBilling(), "Synced with Anthropic.")}>Sync now</button>
            {confirmRemove
              ? <button type="button" className="space-gateway-button danger" disabled={busy}
                onClick={() => void run(async () => { await client.removeAnthropicAdminKey(); return null; }, "Admin key removed. From now on the daily limits count the estimate.")}>Confirm remove</button>
              : <button type="button" className="space-gateway-button" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove key</button>}
          </>
        ) : null}
      </div>
    </form>
  );
}
