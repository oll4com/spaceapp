import { useEffect, useMemo, useState } from "react";
import type { AgentRuntimeRegistry, CopilotLaunchSettings } from "@space/contracts";
import { api } from "../../api.js";
import { DockNotice } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Bot } from "../ui-theme/app-icons.js";
import { accountChoiceShown, defaultAccountProfileId, orderedAccountProfiles, useCopilotAccounts } from "./AgentAccountField.js";
import type { CopilotKind } from "./copilot-kind.js";
import { copilotAccountFor, copilotAgentLabel, copilotRuntimeOptions, defaultCopilotRuntimeId, saveCopilotLaunch } from "./copilot-runtimes.js";

/**
 * Settings → <copilot>: the agent (CLI and account) every new pane of this copilot opens with, on every device, and
 * whether the launch dialog asks each time. The launch dialog's "Remember" and a pane's "Set as default" write the same setting.
 */
export function CopilotSettingsCard({ kind }: { kind: CopilotKind }) {
  const [registry, setRegistry] = useState<AgentRuntimeRegistry | null>(() => api.cliRuntimesSnapshot());
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => copilotRuntimeOptions(registry, kind), [kind, registry]);
  const runtimeId = launch?.runtimeId ?? null;
  const accounts = useCopilotAccounts(runtimeId);
  const profiles = useMemo(() => accounts?.kind === "profiles" ? orderedAccountProfiles(accounts.list) : [], [accounts]);
  const gateway = accounts?.kind === "profiles" ? accounts.list.gatewayProfile ?? null : null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, options.find((option) => option.runtime.id === runtimeId)?.runtime) : "";

  useEffect(() => {
    let cancelled = false;
    api.userSettings().then((settings) => { if (!cancelled) setLaunch(kind.remembered(settings)); })
      .catch((caught: unknown) => { if (!cancelled) { setLaunch(null); setError(caught instanceof Error ? caught.message : "Settings could not be loaded."); } });
    api.cliRuntimes().then((next) => { if (!cancelled) setRegistry(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [kind]);

  function save(next: CopilotLaunchSettings | null) {
    const previous = launch;
    setLaunch(next);
    setError(null);
    void saveCopilotLaunch(kind, next).catch((caught: unknown) => {
      setLaunch(previous);
      setError(caught instanceof Error ? caught.message : `The ${kind.label} default could not be saved.`);
    });
  }

  const loading = launch === undefined || !registry;
  const accountValue = runtimeId && profiles.some((profile) => profile.profileId === launch?.accountProfileId)
    ? launch!.accountProfileId! : runtimeId ? defaultAccountProfileId(runtimeId, accounts) ?? "" : "";

  return (
    <section className={`agent-settings-card settings-flat-card ${kind.controlPrefix}-settings-card`} aria-label={`${kind.label} settings`} aria-busy={loading}>
      <div className="agent-settings-section-title settings-flat-heading">
        <Bot aria-hidden="true" />
        <span>
          <strong>{kind.label}</strong>
          <small>{loading ? "Loading…" : launch ? `New panes open with ${runtimeLabel}${launch.askOnLaunch ? " after asking" : ""}.` : "New panes ask which agent to use."}</small>
        </span>
      </div>
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Default agent</strong>
          <small>{kind.agentDescription}</small>
        </span>
        <select aria-label={`Default ${kind.label} agent`} name={`${kind.controlPrefix}-default-agent`} value={runtimeId ?? ""} disabled={loading}
          onChange={(event) => {
            const next = event.target.value;
            // A new CLI starts on its own default account until one is picked below.
            save(next ? { runtimeId: next, accountProfileId: null, askOnLaunch: launch?.askOnLaunch ?? false } : null);
          }}>
          <option value="">{runtimeId ? "None (ask every time)" : "Not chosen yet (ask)"}</option>
          {options.map(({ runtime, ready, recommended }) => (
            <option key={runtime.id} value={runtime.id} disabled={!ready && runtime.id !== runtimeId}>
              {runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : " (not ready)"}
            </option>
          ))}
        </select>
      </label>
      {runtimeId && accountChoiceShown(accounts) ? (
        accounts?.kind === "codex-gateway" ? (
          <div className="settings-flat-row">
            <span className="settings-flat-row-copy">
              <strong>{runtimeLabel} account</strong>
              <small>Space Gateway (pooled): every {runtimeLabel} pane uses the gateway's ChatGPT accounts{accounts.accounts ? ` (${accounts.accounts})` : ""}.</small>
            </span>
          </div>
        ) : (
          <label className="settings-flat-row">
            <span className="settings-flat-row-copy">
              <strong>{runtimeLabel} account</strong>
              <small>The account the agent's CLI starts on. Space Gateway (pooled) spreads the work over the gateway's accounts.</small>
            </span>
            <select aria-label={`${runtimeLabel} account`} name={`${kind.controlPrefix}-default-account`} value={accountValue}
              onChange={(event) => launch && save({ ...launch, accountProfileId: copilotAccountFor(launch.runtimeId, event.target.value) })}>
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.displayName}{gateway?.profileId === profile.profileId && !gateway.ready ? " (not ready)" : ""}
                </option>
              ))}
            </select>
          </label>
        )
      ) : null}
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name={`${kind.controlPrefix}-ask-on-launch`} label="Ask which agent every time"
        detail={launch && !launch.askOnLaunch ? `New ${kind.label} panes open at once with the default agent.` : `Each new ${kind.label} pane shows the agent chooser first.`}
        checked={!launch || launch.askOnLaunch} disabled={loading}
        onChange={(checked) => {
          if (launch) { save({ ...launch, askOnLaunch: checked }); return; }
          // Turning asking off needs an agent: the recommended ready CLI.
          const fallback = defaultCopilotRuntimeId(options);
          if (!checked && fallback) save({ runtimeId: fallback, accountProfileId: null, askOnLaunch: false });
        }} />
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
    </section>
  );
}
