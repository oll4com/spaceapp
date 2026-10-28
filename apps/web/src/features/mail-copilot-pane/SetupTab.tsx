import { useEffect, useState, type CSSProperties } from "react";
import { MAIL_COPILOT_AUTONOMY_LEVELS, mailCopilotConsentUrl, type ConnectorAccountSummary, type CopilotLaunchSettings, type MailCopilotAutonomy, type MailCopilotPaneMetadata, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { Bell, BellOff } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { GmailConsentActions, gmailAccessLabel } from "./AccountsView.js";
import { senderHue, senderInitial } from "./MailClient.js";

const AUTONOMY_TEXT: Record<MailCopilotAutonomy, { label: string; detail: string }> = {
  ASSIST: { label: "Assist", detail: "Sorts and archives the inbox on its own; drafts replies and asks, you send. It learns from every reply and action of yours." },
  RULES: { label: "Rules", detail: "Sorts the inbox on its own; replies alone only under rules you approved, everything else is a review." },
  FULL: { label: "Full", detail: "Acts on its own judgement within the hourly cap; you follow along in Activity." }
};

export type SetupStep = "accounts" | "autonomy" | "agent";

/** Setup: which accounts the pane works with and which of them notify, how far the agent acts alone, notifications, and the pane's agent. */
export function SetupTab({ pane, settings, accounts, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault }: {
  pane: Pane;
  settings: MailCopilotPaneMetadata;
  accounts: ConnectorAccountSummary[];
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  /** Changes after each agent switch, so the Agent step reloads the pane's account. */
  accountRevision?: number;
  onSettingsChange(settings: MailCopilotPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("accounts");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  // The Agent step shows the account this pane's CLI runs on now (the terminal's account menu changes it too).
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);

  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.mailCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function save(label: string, next: MailCopilotPaneMetadata) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      const response = await api.updateMailCopilotSettings(pane.id, next);
      onSettingsChange(response.metadata);
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }

  const patch = (label: string, update: Partial<MailCopilotPaneMetadata["settings"]>) => void save(label, { ...settings, settings: { ...settings.settings, ...update } });
  const notifications = settings.settings.notifications;
  const muted = (email: string) => notifications.mutedAccounts.some((entry) => entry.toLowerCase() === email.toLowerCase());
  const isShown = (email: string) => settings.settings.accounts.length === 0 || settings.settings.accounts.includes(email);
  const shown = accounts.filter((account) => isShown(account.email));
  const notifying = shown.filter((account) => !muted(account.email)).length;

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["accounts", "autonomy", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{id === "accounts" ? "Accounts" : id === "autonomy" ? "Autonomy" : "Agent"}
          </button>
        ))}
      </nav>

      {step === "accounts" ? (
        <div className="jc-form">
          <section className="mc-notify-card" data-on={notifications.newMail ? "true" : "false"} aria-label="New mail notifications">
            <span className="mc-notify-card-icon" aria-hidden="true">{notifications.newMail ? <Bell /> : <BellOff />}</span>
            <SpaceToggle compact label="New mail notifications" checked={notifications.newMail} disabled={busy}
              detail={!notifications.newMail ? "Off for every account." : `On for ${notifying} of ${shown.length} account${shown.length === 1 ? "" : "s"}. The bell on an account mutes it.`}
              onChange={(checked) => patch("Notifications", { notifications: { ...notifications, newMail: checked } })} />
          </section>
          <p className="jc-muted">The accounts this pane shows and the copilot works with. With none chosen it uses every Google account allowed for Space.</p>
          {accounts.length === 0 ? <p className="jc-muted">No Google account is allowed for Space yet.</p> : (
            <ul className="mc-setup-accounts" aria-label="Accounts">
              {accounts.map((account) => {
                const access = gmailAccessLabel(account);
                const on = isShown(account.email);
                const notify = on && notifications.newMail && !muted(account.email);
                return (
                  <li key={account.accountId} className="mc-setup-account" data-shown={on ? "true" : "false"}>
                    <span className="mc-avatar sm" style={{ "--avatar-hue": senderHue({ name: "", address: account.email }) } as CSSProperties} aria-hidden="true">{senderInitial({ name: "", address: account.email })}</span>
                    <span className="mc-setup-account-copy">
                      <strong>{account.email}</strong>
                      <small data-access={access}>{access === "full" ? "Full Gmail access" : access === "read" ? "Read-only: allow full access for replies, labels and archive" : "No Gmail access yet"}</small>
                    </span>
                    <SpaceToggle compact label="Show" ariaLabel={`Show ${account.email} in this pane`} checked={on} disabled={busy}
                      onChange={(checked) => {
                        const all = accounts.map((entry) => entry.email);
                        const chosen = settings.settings.accounts;
                        const current = chosen.length === 0 ? all : chosen;
                        const next = checked ? [...new Set([...current, account.email])] : current.filter((email) => email !== account.email);
                        patch("Accounts", { accounts: next.length === all.length ? [] : next });
                      }} />
                    <button type="button" className="mc-notify-button" aria-pressed={notify} disabled={busy || !on || !notifications.newMail}
                      aria-label={`New mail notifications from ${account.email}`}
                      title={!notifications.newMail ? "New mail notifications are off for every account" : !on ? "Not shown in this pane" : notify ? "Notifies on new mail" : "No notifications for this account"}
                      onClick={() => patch("Notifications", { notifications: { ...notifications,
                        mutedAccounts: notify ? [...notifications.mutedAccounts, account.email] : notifications.mutedAccounts.filter((email) => email.toLowerCase() !== account.email.toLowerCase()) } })}>
                      {notify ? <Bell /> : <BellOff />}
                    </button>
                    {access !== "full" ? <div className="mc-setup-account-consent"><GmailConsentActions email={account.email} /></div> : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="jc-actions"><a className="jc-button" href={mailCopilotConsentUrl()}>Allow another Google account</a></div>
        </div>
      ) : null}

      {step === "autonomy" ? (
        <div className="jc-form">
          <div className="jc-chips" role="radiogroup" aria-label="Autonomy">
            {MAIL_COPILOT_AUTONOMY_LEVELS.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={settings.settings.autonomy === level} className={`jc-chip${settings.settings.autonomy === level ? " selected" : ""}`}
                disabled={busy} onClick={() => patch("Autonomy", { autonomy: level })}>{AUTONOMY_TEXT[level].label}</button>
            ))}
          </div>
          <p className="jc-muted">{AUTONOMY_TEXT[settings.settings.autonomy].detail}</p>
          <div className="jc-form-grid">
            <label className="jc-field"><span>Backlog (hours)</span>
              <input type="number" min={1} max={336} value={settings.settings.backlogHours} disabled={busy}
                onChange={(event) => patch("Backlog", { backlogHours: Math.max(1, Math.min(336, Number.parseInt(event.target.value, 10) || 24)) })} /></label>
            <label className="jc-field"><span>Daily inbox sort (hour, your time zone)</span>
              <input type="number" min={0} max={23} value={settings.settings.dailyRunHour} disabled={busy}
                onChange={(event) => patch("Daily sort", { dailyRunHour: Math.max(0, Math.min(23, Number.parseInt(event.target.value, 10) || 0)) })} /></label>
            <label className="jc-field"><span>Sends per hour (cap)</span>
              <input type="number" min={0} max={200} value={settings.settings.sendsPerHour} disabled={busy}
                onChange={(event) => patch("Send cap", { sendsPerHour: Math.max(0, Math.min(200, Number.parseInt(event.target.value, 10) || 0)) })} /></label>
          </div>
          <label className="jc-field"><span>Signature for replies the copilot drafts (optional)</span>
            <textarea rows={2} defaultValue={settings.settings.signature ?? ""} disabled={busy} onBlur={(event) => {
              const value = event.target.value.trim();
              if ((value || null) !== settings.settings.signature) patch("Signature", { signature: value || null });
            }} /></label>
          <SpaceToggle label="Paused" detail="The copilot opens no new work item while paused; the mailbox keeps working." checked={settings.settings.paused} disabled={busy} onChange={(checked) => patch("Paused", { paused: checked })} />
          <SpaceToggle label="Needs-you notifications" detail="Reviews, questions and rule proposals the copilot waits on." checked={settings.settings.notifications.needsYou} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...settings.settings.notifications, needsYou: checked } })} />
          <SpaceToggle label="Telegram" detail="Needs-you moments also go to the paired Telegram bot (Settings → Telegram)." checked={settings.settings.notifications.telegram} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...settings.settings.notifications, telegram: checked } })} />
        </div>
      ) : null}

      {step === "agent" ? (
        <div className="jc-form">
          <label className="jc-field">
            <span>Copilot agent</span>
            <select value={runtimeId ?? ""} disabled={switching} onChange={(event) => {
              const next = event.target.value;
              if (next && next !== runtimeId) onSwitchAgent(next);
            }}>
              {!runtimeId ? <option value="">Choose a CLI…</option> : null}
              {runtimeOptions.map(({ runtime, ready, recommended }) => (
                <option key={runtime.id} value={runtime.id} disabled={!ready}>{runtime.displayName}{recommended ? " (recommended)" : ""}{ready ? "" : ` — ${runtime.statusReason}`}</option>
              ))}
            </select>
          </label>
          {runtimeId ? (
            <AgentAccountField runtimeId={runtimeId} runtimeLabel={runtimeLabel} accounts={cliAccounts} value={paneAccount} disabled={switching}
              onChange={(profileId) => onSwitchAgent(runtimeId, profileId)} />
          ) : null}
          <p className="jc-muted">Switching the agent or its account restarts this pane's CLI session. Claude Code is recommended for long, tool-heavy loops.</p>
          <div className="jc-default-agent">
            <p className="jc-muted" role="status">
              {launch && !launch.askOnLaunch
                ? `New Mail Copilot panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Mail Copilot panes ask which agent to use."} Change it in Settings → Mail Copilot.
            </p>
            <button type="button" className="jc-button" disabled={!runtimeId || switching || isDefault} onClick={() => {
              onSetDefault();
              if (runtimeId) setLaunch({ runtimeId, accountProfileId: paneAccount, askOnLaunch: false });
            }}>{isDefault ? "This is your default agent" : "Set as default"}</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
