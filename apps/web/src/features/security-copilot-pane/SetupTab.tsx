import { useEffect, useState } from "react";
import type { CopilotLaunchSettings, Pane, SecurityCopilotPaneMetadata } from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import type { SecurityHostView } from "./types.js";

type SetupStep = "autonomy" | "hosts" | "notifications" | "agent";
const STEP_LABELS: Record<SetupStep, string> = { autonomy: "Autonomy", hosts: "Hosts", notifications: "Notifications", agent: "Agent" };
const HOST_STATUS_TEXT: Record<SecurityHostView["status"], string> = { ACTIVE: "active", STOPPED: "stopped", UNREACHABLE: "unreachable" };
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Setup: how autonomous the copilot is, which hosts it leaves alone, the public addresses it checks, notifications and the agent. */
export function SetupTab({ pane, settings, hosts, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: SecurityCopilotPaneMetadata;
  hosts: SecurityHostView[];
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: SecurityCopilotPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [step, setStep] = useState<SetupStep>("autonomy");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const [address, setAddress] = useState({ ip: "", alias: "" });
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);
  const current = settings.settings;

  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.securityCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function patch(label: string, update: Partial<SecurityCopilotPaneMetadata["settings"]>) {
    if (busy) return;
    const next = { ...settings, settings: { ...current, ...update } };
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateSecurityCopilotSettings(pane.id, next)).metadata);
      setMessage(t("{label} saved.", { label: t(label) }));
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : t("{label} could not be saved.", { label: t(label) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label={t("Setup steps")}>
        {(["autonomy", "hosts", "notifications", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{t(STEP_LABELS[id])}
          </button>
        ))}
      </nav>

      {step === "autonomy" ? (
        <div className="jc-form">
          <SpaceToggle label={t("Fully autonomous")} detail={t("On: backed-up package, service, config, WAF, container and code fixes run on their own. Off (Assist): every change waits for your approval. Reboots, restarts that end your sessions, deletes and free-form commands always wait for you.")}
            checked={current.autonomy === "FULL"} disabled={busy} onChange={(checked) => void patch("Autonomy", { autonomy: checked ? "FULL" : "ASSIST" })} />
          <SpaceToggle label={t("Paused")} detail={t("The copilot takes no new work and makes no change while paused.")} checked={current.paused} disabled={busy} onChange={(checked) => void patch("Paused", { paused: checked })} />
          <p className="jc-muted">{t("A stable hotfix of SpaceApp's own code goes ahead without you only when Nous may approve security hotfixes (Settings → Assistants & AI → Nous).")}</p>
        </div>
      ) : null}

      {step === "hosts" ? (
        <div className="jc-form">
          <section className="jc-form-section" aria-label={t("Hosts the copilot works on")}>
            <h4>{t("Hosts")}</h4>
            {hosts.map((host) => (
              <SpaceToggle key={host.id} label={host.label} detail={`${host.alias}${host.status === "ACTIVE" ? "" : ` · ${t(HOST_STATUS_TEXT[host.status])}`}`} checked={!current.excludedHosts.includes(host.id)} disabled={busy}
                onChange={(checked) => void patch("Hosts", { excludedHosts: checked ? current.excludedHosts.filter((id) => id !== host.id) : [...current.excludedHosts, host.id] })} />
            ))}
            {!hosts.length ? <p className="jc-muted">{t("The copilot discovers the hosts on its first run.")}</p> : null}
          </section>
          <section className="jc-form-section" aria-label={t("Public addresses")}>
            <h4>{t("Public addresses")}</h4>
            <p className="jc-muted">{t("Checked against what the internet sees (Shodan InternetDB) every 30 minutes.")}</p>
            <ul className="sc-addresses">
              {current.publicAddresses.map((entry) => (
                <li key={entry.ip}>{entry.ip} → {entry.alias}
                  <button type="button" className="jc-button" disabled={busy} onClick={() => void patch("Public addresses", { publicAddresses: current.publicAddresses.filter((item) => item.ip !== entry.ip) })}>{t("Remove")}</button></li>
              ))}
            </ul>
            <div className="sc-address-form">
              <label className="jc-field"><span>{t("IPv4 address")}</span><input value={address.ip} maxLength={15} placeholder="192.0.2.10" onChange={(event) => setAddress({ ...address, ip: event.target.value.trim() })} /></label>
              <label className="jc-field"><span>{t("Host that serves it")}</span>
                <select value={address.alias} onChange={(event) => setAddress({ ...address, alias: event.target.value })}>
                  <option value="">{t("Choose a host…")}</option>
                  {hosts.map((host) => <option key={host.id} value={host.alias}>{host.label}</option>)}
                </select>
              </label>
              <button type="button" className="jc-button" disabled={busy || !IPV4.test(address.ip) || !address.alias || current.publicAddresses.some((entry) => entry.ip === address.ip)}
                onClick={() => void patch("Public addresses", { publicAddresses: [...current.publicAddresses, address] }).then(() => setAddress({ ip: "", alias: "" }))}>{t("Add")}</button>
            </div>
          </section>
        </div>
      ) : null}

      {step === "notifications" ? (
        <div className="jc-form">
          <SpaceToggle label={t("Needs-you notifications")} detail={t("Critical findings, changes waiting for your approval and questions. Exploited findings and failed fixes always alert you.")} checked={current.notifications.needsYou} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, needsYou: checked } })} />
          <SpaceToggle label={t("Fixed notifications")} detail={t("A notification for every verified fix.")} checked={current.notifications.fixed} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, fixed: checked } })} />
          <SpaceToggle label="Telegram" detail={t("These notifications also go to the paired Telegram bot (Settings → Telegram).")} checked={current.notifications.telegram} disabled={busy}
            onChange={(checked) => void patch("Notifications", { notifications: { ...current.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>{t("Security engineer")}</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => { const next = event.target.value; if (next && next !== runtimeId) onSwitchAgent(next); }}>
              {!runtimeId ? <option value="">{t("Choose a CLI…")}</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? ` ${t("(recommended)")}` : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching} onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} /> : null}
          <p className="jc-muted">{t("Switching the security engineer or its account restarts this pane's CLI session; findings, actions and memory stay. Claude Code is recommended.")}</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? (() => {
                  const agent = copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime);
                  return launch.accountProfileId ? t("New Security Copilot panes open with {agent} ({account} account) without asking.", { agent, account: launch.accountProfileId })
                    : t("New Security Copilot panes open with {agent} without asking.", { agent });
                })()
                : t("New Security Copilot panes ask which security engineer to use.")} {t("Change it in Settings → Security Copilot.")}
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? t("This is your default security engineer") : t("Set as default")}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
