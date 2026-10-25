import { useEffect, useMemo, useState } from "react";
import type { ListCliAccountProfilesResponse } from "@space/contracts";
import { api } from "../../api.js";
import { cliAccountProfileForPane } from "../cli-accounts/cli-account-default.js";
import { hasCliAccountProfiles, readLastCliAccountProfileId } from "../cli-accounts/cli-account-memory.js";
import { peekSharedQuotaMetrics, subscribeSharedQuota } from "../desktop-widgets/shared-quota-cache.js";

/**
 * The accounts a CLI offers a copilot pane: account profiles (Claude Code, Gemini, Copilot, Cursor, Kimi, with the
 * Space Gateway pool first where the CLI has one), the Space Gateway pool every Codex pane runs on, or none.
 */
export type CopilotAccounts =
  | { kind: "none" }
  | { kind: "profiles"; list: ListCliAccountProfilesResponse }
  | { kind: "codex-gateway"; accounts: number | null };

export function useCopilotAccounts(runtimeId: string | null): CopilotAccounts | null {
  const [loaded, setLoaded] = useState<{ runtimeId: string; accounts: CopilotAccounts } | null>(null);
  const [quota, setQuota] = useState(peekSharedQuotaMetrics);
  useEffect(() => runtimeId === "cli:codex" ? subscribeSharedQuota(setQuota) : undefined, [runtimeId]);
  useEffect(() => {
    if (!runtimeId || !hasCliAccountProfiles(runtimeId)) return;
    let cancelled = false;
    // Account profiles are an ADMIN listing; without it the CLI starts on its own default.
    api.listCliAccountProfiles(runtimeId)
      .then((list) => { if (!cancelled) setLoaded({ runtimeId, accounts: { kind: "profiles", list } }); })
      .catch(() => { if (!cancelled) setLoaded({ runtimeId, accounts: { kind: "none" } }); });
    return () => { cancelled = true; };
  }, [runtimeId]);
  if (!runtimeId) return { kind: "none" };
  if (runtimeId === "cli:codex") {
    const pool = quota?.codex && !quota.codex.isStale ? quota.codex.data.length : null;
    // With no ChatGPT account in the gateway Codex signs in on its own, as its pane's account menu shows.
    return pool === 0 ? { kind: "none" } : { kind: "codex-gateway", accounts: pool };
  }
  if (!hasCliAccountProfiles(runtimeId)) return { kind: "none" };
  return loaded?.runtimeId === runtimeId ? loaded.accounts : null;
}

/** The profiles in picker order: the Space Gateway pool first, then the CLI's own accounts. */
export function orderedAccountProfiles(list: ListCliAccountProfilesResponse) {
  const gatewayId = list.gatewayProfile?.profileId ?? null;
  return [...list.profiles].sort((a, b) => Number(b.profileId === gatewayId) - Number(a.profileId === gatewayId));
}

/** Whether there is a choice to show: several accounts, or a Space Gateway pool next to the CLI's own sign-in. */
export function accountChoiceShown(accounts: CopilotAccounts | null): boolean {
  if (!accounts || accounts.kind === "none") return false;
  if (accounts.kind === "codex-gateway") return true;
  return accounts.list.profiles.length > 1 || Boolean(accounts.list.gatewayProfile);
}

/** The account a new pane of this CLI starts on when nothing was picked: the ready gateway pool, else this device's last account. */
export function defaultAccountProfileId(runtimeId: string, accounts: CopilotAccounts | null): string | null {
  if (accounts?.kind !== "profiles") return null;
  return cliAccountProfileForPane(accounts.list, readLastCliAccountProfileId(runtimeId), true);
}

/**
 * Account picker of a copilot agent: a select of the CLI's accounts, or the fixed Space Gateway pool of Codex.
 * `value` null shows the CLI's default account (defaultAccountProfileId).
 */
export function AgentAccountField({ runtimeId, runtimeLabel, accounts, value, disabled = false, className = "", onChange }: {
  runtimeId: string;
  runtimeLabel: string;
  accounts: CopilotAccounts | null;
  value: string | null;
  disabled?: boolean;
  className?: string;
  onChange(profileId: string): void;
}) {
  const profiles = useMemo(() => accounts?.kind === "profiles" ? orderedAccountProfiles(accounts.list) : [], [accounts]);
  if (!accountChoiceShown(accounts) || !accounts) return null;
  if (accounts.kind === "codex-gateway") {
    return (
      <div className={`jc-field jc-account-field ${className}`.trim()}>
        <span>{runtimeLabel} account</span>
        <p className="jc-account-fixed" role="note">
          <strong>Space Gateway (pooled)</strong>
          <small>{accounts.accounts ? `Every ${runtimeLabel} pane uses the gateway's ${accounts.accounts} ChatGPT account${accounts.accounts === 1 ? "" : "s"}.` : `Every ${runtimeLabel} pane uses the gateway's ChatGPT accounts.`}</small>
        </p>
      </div>
    );
  }
  const gateway = accounts.kind === "profiles" ? accounts.list.gatewayProfile ?? null : null;
  const ids = profiles.map((profile) => profile.profileId);
  const selected = value && ids.includes(value) ? value : defaultAccountProfileId(runtimeId, accounts) ?? ids[0] ?? "";
  return (
    <label className={`jc-field jc-account-field ${className}`.trim()}>
      <span>{runtimeLabel} account</span>
      <select value={selected} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {profiles.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.displayName}{gateway?.profileId === profile.profileId && !gateway.ready ? " (not ready)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The account a pane switched to this CLI starts on: the default pane account of that CLI, or null when it has none. */
export async function loadDefaultAccountProfileId(runtimeId: string): Promise<string | null> {
  if (!hasCliAccountProfiles(runtimeId)) return null;
  const list = await api.listCliAccountProfiles(runtimeId).catch(() => null);
  return list ? cliAccountProfileForPane(list, readLastCliAccountProfileId(runtimeId), true) : null;
}
