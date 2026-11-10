import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntimeRegistry, CopilotLaunchSettings } from "@space/contracts";
import { api } from "../../api.js";
import { DockNotice } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Bot } from "../ui-theme/app-icons.js";
import { accountChoiceShown, defaultAccountProfileId, orderedAccountProfiles, useCopilotAccounts } from "./AgentAccountField.js";
import type { CopilotKind } from "./copilot-kind.js";
import { copilotAccountFor, copilotAgentLabel, copilotRuntimeOptions, defaultCopilotRuntimeId, saveCopilotLaunch } from "./copilot-runtimes.js";

/**
 * Settings → <copilot>: the agent (CLI and account) every new pane of this copilot opens with, on every device, and
 * whether the launch dialog asks each time. The launch dialog's "Remember" and a pane's "Set as default" write the same setting.
 */
export function CopilotSettingsCard({ kind }: { kind: CopilotKind }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const languageRef = useRef(language);
  languageRef.current = language; // read at error time, so a language change never refetches
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
      .catch((caught: unknown) => { if (!cancelled) { setLaunch(null); setError(caught instanceof Error ? caught.message : uiText(languageRef.current, "Settings could not be loaded.")); } });
    api.cliRuntimes().then((next) => { if (!cancelled) setRegistry(next); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [kind]);

  function save(next: CopilotLaunchSettings | null) {
    const previous = launch;
    setLaunch(next);
    setError(null);
    void saveCopilotLaunch(kind, next).catch((caught: unknown) => {
      setLaunch(previous);
      setError(caught instanceof Error ? caught.message : t("The {kind} default could not be saved.", { kind: kind.label }));
    });
  }

  const loading = launch === undefined || !registry;
  const accountValue = runtimeId && profiles.some((profile) => profile.profileId === launch?.accountProfileId)
    ? launch!.accountProfileId! : runtimeId ? defaultAccountProfileId(runtimeId, accounts) ?? "" : "";

  return (
    <section className={`agent-settings-card settings-flat-card ${kind.controlPrefix}-settings-card`} aria-label={t("{kind} settings", { kind: kind.label })} aria-busy={loading}>
      <div className="agent-settings-section-title settings-flat-heading">
        <Bot aria-hidden="true" />
        <span>
          <strong>{kind.label}</strong>
          <small>{loading ? t("Loading…") : launch ? t(launch.askOnLaunch ? "New panes open with {agent} after asking." : "New panes open with {agent}.", { agent: runtimeLabel }) : t("New panes ask which agent to use.")}</small>
        </span>
      </div>
      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>{t("Default agent")}</strong>
          <small>{t(kind.agentDescription)}</small>
        </span>
        <select aria-label={t("Default {kind} agent", { kind: kind.label })} name={`${kind.controlPrefix}-default-agent`} value={runtimeId ?? ""} disabled={loading}
          onChange={(event) => {
            const next = event.target.value;
            // A new CLI starts on its own default account until one is picked below.
            save(next ? { runtimeId: next, accountProfileId: null, askOnLaunch: launch?.askOnLaunch ?? false } : null);
          }}>
          <option value="">{runtimeId ? t("None (ask every time)") : t("Not chosen yet (ask)")}</option>
          {options.map(({ runtime, ready, recommended }) => (
            <option key={runtime.id} value={runtime.id} disabled={!ready && runtime.id !== runtimeId}>
              {runtime.displayName}{recommended ? ` (${t("recommended")})` : ""}{ready ? "" : ` (${t("not ready")})`}
            </option>
          ))}
        </select>
      </label>
      {runtimeId && accountChoiceShown(accounts) ? (
        accounts?.kind === "codex-gateway" ? (
          <div className="settings-flat-row">
            <span className="settings-flat-row-copy">
              <strong>{t("{agent} account", { agent: runtimeLabel })}</strong>
              <small>{accounts.accounts ? t("Space Gateway (pooled): every {agent} pane uses the gateway's ChatGPT accounts ({count}).", { agent: runtimeLabel, count: accounts.accounts }) : t("Space Gateway (pooled): every {agent} pane uses the gateway's ChatGPT accounts.", { agent: runtimeLabel })}</small>
            </span>
          </div>
        ) : (
          <label className="settings-flat-row">
            <span className="settings-flat-row-copy">
              <strong>{t("{agent} account", { agent: runtimeLabel })}</strong>
              <small>{t("The account the agent's CLI starts on. Space Gateway (pooled) spreads the work over the gateway's accounts.")}</small>
            </span>
            <select aria-label={t("{agent} account", { agent: runtimeLabel })} name={`${kind.controlPrefix}-default-account`} value={accountValue}
              onChange={(event) => launch && save({ ...launch, accountProfileId: copilotAccountFor(launch.runtimeId, event.target.value) })}>
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.displayName}{gateway?.profileId === profile.profileId && !gateway.ready ? ` (${t("not ready")})` : ""}
                </option>
              ))}
            </select>
          </label>
        )
      ) : null}
      <SpaceToggle className="settings-flat-row settings-flat-toggle-row" name={`${kind.controlPrefix}-ask-on-launch`} label={t("Ask which agent every time")}
        detail={launch && !launch.askOnLaunch ? t("New {kind} panes open at once with the default agent.", { kind: kind.label }) : t("Each new {kind} pane shows the agent chooser first.", { kind: kind.label })}
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
