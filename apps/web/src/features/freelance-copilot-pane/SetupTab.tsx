import { useEffect, useState, type FormEvent } from "react";
import {
  effectiveFreelanceAutonomy, FREELANCE_ACCOUNT_STATUSES, FREELANCE_CHANNEL_LABELS, FREELANCE_CHANNEL_LOGIN_URLS, FREELANCE_CHANNELS, FREELANCE_COPILOT_AUTONOMY_LEVELS,
  FREELANCE_EGRESS_LABELS, FREELANCE_EGRESS_ROUTES, type CliGlobalEgressStatus, type FreelanceEgressRoute,
  type CopilotLaunchSettings, type FreelanceAccount, type FreelanceChannel, type FreelanceChannelSettings, type FreelanceCopilotAutonomy, type FreelanceCopilotPaneMetadata, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export const AUTONOMY_TEXT: Record<FreelanceCopilotAutonomy, { label: string; detail: string }> = {
  ASSIST: { label: "Assist", detail: "Drafts and asks; nothing is sent until you approve it." },
  RULES: { label: "Rules", detail: "Sends alone only under rules you approved; everything else is a review." },
  FULL: { label: "Full", detail: "Sends proposals and answers clients on its own judgement within each platform's daily cap and the Connects budget; clients who want to go ahead come to you." }
};
export const ACCOUNT_STATUS_LABEL: Record<FreelanceAccount["status"], string> = { NOT_STARTED: "Not started", IN_PROGRESS: "Registering", NEEDS_OPERATOR: "Needs you", ACTIVE: "Active", BLOCKED: "Blocked" };

export type SetupStep = "platforms" | "mailbox" | "autonomy" | "agent";
const STEP_LABEL: Record<SetupStep, string> = { platforms: "Platforms", mailbox: "Mailbox", autonomy: "Autonomy", agent: "Agent" };
/** A route's name with its state from Settings → CLI VPN route (shown to admins; others see the name only). */
function routeLabel(route: FreelanceEgressRoute, egress: CliGlobalEgressStatus | null): string {
  if (route === "direct" || !egress) return FREELANCE_EGRESS_LABELS[route];
  const profile = egress.profiles[route];
  return `${FREELANCE_EGRESS_LABELS[route]} · ${profile.status === "CONNECTED" ? `connected${profile.egressIpv4 ? ` ${profile.egressIpv4}` : ""}` : "not connected"}`;
}
const clamp = (value: string, min: number, max: number, fallback: number) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));

/** The work@example.invalid IMAP mailbox: connected once, the password stays on the server. */
function MailboxStep() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.freelanceMailbox>> | null>(null);
  const [form, setForm] = useState({ host: "mail.spaceapp.dev", port: "993", user: "work@example.invalid", password: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = () => api.freelanceMailbox().then(setStatus, () => setStatus(null));
  useEffect(() => { void load(); }, []);
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !form.password) return;
    setBusy(true);
    setMessage(null);
    api.connectFreelanceMailbox({ host: form.host.trim(), port: clamp(form.port, 1, 65535, 993), secure: true, user: form.user.trim(), password: form.password })
      .then(() => { setForm({ ...form, password: "" }); setMessage("Mailbox connected."); return load(); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The mailbox could not be connected."))
      .finally(() => setBusy(false));
  };
  return (
    <div className="jc-form">
      <p className="jc-muted">Every platform account signs up with its own alias (upwork@, contra@, fiverr@, toptal@, arc@, braintrust@example.invalid); all of them deliver into one mailbox the copilot reads for codes, job alerts and client messages. The password is stored sealed on the server and never reaches the agent.</p>
      <p role="status">{status?.connected ? `Connected: ${status.config?.user} on ${status.config?.host}` : "Not connected."}</p>
      <form className="jc-form" onSubmit={connect}>
        <div className="jc-form-grid">
          <label className="jc-field"><span>IMAP host</span><input value={form.host} disabled={busy} onChange={(event) => setForm({ ...form, host: event.target.value })} /></label>
          <label className="jc-field"><span>Port</span><input type="number" min={1} max={65535} value={form.port} disabled={busy} onChange={(event) => setForm({ ...form, port: event.target.value })} /></label>
        </div>
        <label className="jc-field"><span>User</span><input value={form.user} autoComplete="off" disabled={busy} onChange={(event) => setForm({ ...form, user: event.target.value })} /></label>
        <label className="jc-field"><span>Password</span><input type="password" value={form.password} autoComplete="new-password" disabled={busy} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy || !form.password || !form.host.trim() || !form.user.trim()}>{status?.connected ? "Reconnect" : "Connect"}</button>
          {status?.connected ? <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void api.disconnectFreelanceMailbox().then(load)}>Disconnect</button> : null}
        </div>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}

/** Setup: the platforms (accounts, caps), the mailbox, how far the copilot acts alone, and the pane's agent. */
export function SetupTab({ pane, settings, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault, onOpenBrowser }: {
  pane: Pane;
  /** The pane browser was sent to a login page (phones show the browser tab). */
  onOpenBrowser?(): void;
  settings: FreelanceCopilotPaneMetadata;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  accountRevision?: number;
  onSettingsChange(settings: FreelanceCopilotPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("platforms");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<FreelanceAccount[]>([]);
  const [egress, setEgress] = useState<CliGlobalEgressStatus | null>(null);
  const [launch, setLaunch] = useState<CopilotLaunchSettings | null>(null);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const runtimeLabel = runtimeId ? copilotAgentLabel(runtimeId, runtimeOptions.find((option) => option.runtime.id === runtimeId)?.runtime) : "";
  const cliAccounts = useCopilotAccounts(step === "agent" ? runtimeId : null);
  const [paneAccount, setPaneAccount] = useState<string | null>(null);
  const isDefault = Boolean(launch && runtimeId && launch.runtimeId === runtimeId && !launch.askOnLaunch && (launch.accountProfileId ?? null) === paneAccount);

  useEffect(() => {
    if (step !== "platforms") return;
    let cancelled = false;
    api.freelanceAccounts().then((response) => { if (!cancelled) setAccounts(response.accounts); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [step]);
  useEffect(() => {
    if (step !== "platforms" && step !== "autonomy") return;
    let cancelled = false;
    api.cliGlobalEgress().then((status) => { if (!cancelled) setEgress(status); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [step]);
  useEffect(() => {
    if (step !== "agent") return;
    let cancelled = false;
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.freelanceCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function save(label: string, next: FreelanceCopilotPaneMetadata) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      onSettingsChange((await api.updateFreelanceCopilotSettings(pane.id, next)).metadata);
      // New routes take effect when the pane's Chrome restarts (same page, sign-ins stay).
      const routes = (metadata: FreelanceCopilotPaneMetadata) => JSON.stringify([metadata.settings.browserEgress, FREELANCE_CHANNELS.map((id) => metadata.settings.channels[id].egress)]);
      if (routes(next) !== routes(settings)) dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "restart", roomId: pane.roomId });
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }
  const patch = (label: string, update: Partial<FreelanceCopilotPaneMetadata["settings"]>) => void save(label, { ...settings, settings: { ...settings.settings, ...update } });
  const patchChannel = (id: FreelanceChannel, update: Partial<FreelanceChannelSettings>) =>
    patch(FREELANCE_CHANNEL_LABELS[id], { channels: { ...settings.settings.channels, [id]: { ...settings.settings.channels[id], ...update } } });
  const setAccountStatus = (channel: FreelanceChannel, status: FreelanceAccount["status"]) => {
    api.updateFreelanceAccount(pane.id, { channel, status })
      .then((response) => setAccounts((current) => current.map((entry) => entry.channel === channel ? response.account : entry)))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The account could not be updated."));
  };
  const { connectsBudget, notifications } = settings.settings;

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["platforms", "mailbox", "autonomy", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{STEP_LABEL[id]}
          </button>
        ))}
      </nav>

      {step === "platforms" ? (
        <div className="jc-form">
          <p className="jc-muted">Each platform leaves from a route of Settings → CLI VPN route (default: the pane's route, Thailand); a route that is down stops that platform's pages instead of leaving from this server. Where the copilot finds clients for oll4.com. One account per platform, signed up with the platform's alias. The copilot registers and keeps the profile up to date; identity checks, phone, payout, tax forms, CAPTCHAs and interviews come to you in this pane's browser.</p>
          <ul className="mk-channels" aria-label="Platforms">
            {FREELANCE_CHANNELS.map((id) => {
              const channel = settings.settings.channels[id];
              const label = FREELANCE_CHANNEL_LABELS[id];
              const account = accounts.find((entry) => entry.channel === id);
              return (
                <li key={id} className="mk-channel" data-enabled={channel.enabled ? "true" : "false"}>
                  <SpaceToggle label={label} detail={channel.enabled ? `Acts as ${AUTONOMY_TEXT[effectiveFreelanceAutonomy(settings.settings, id)].label} here${account?.email ? ` · ${account.email}` : ""}` : "Off: the copilot does not work here"}
                    checked={channel.enabled} disabled={busy} onChange={(checked) => patchChannel(id, { enabled: checked })} />
                  {channel.enabled ? (
                    <div className="fl-account-row">
                      <label className="jc-field"><span>Account</span>
                        <select value={account?.status ?? "NOT_STARTED"} aria-label={`${label} account status`} onChange={(event) => setAccountStatus(id, event.target.value as FreelanceAccount["status"])}>
                          {FREELANCE_ACCOUNT_STATUSES.map((status) => <option key={status} value={status}>{ACCOUNT_STATUS_LABEL[status]}</option>)}
                        </select></label>
                      <button type="button" className="jc-button ghost mk-channel-login" disabled={busy} title={`Open ${label}'s login page in this pane's browser`}
                        onClick={() => void api.navigateBrowser(pane.id, FREELANCE_CHANNEL_LOGIN_URLS[id]).then(() => onOpenBrowser?.(), (error: unknown) => setMessage(error instanceof Error ? error.message : "The browser could not open the page."))}>Log in to {label}</button>
                      {account?.profileUrl ? <a className="jc-button ghost" href={account.profileUrl} target="_blank" rel="noreferrer noopener">Profile</a> : null}
                    </div>
                  ) : null}
                  {account?.notes && channel.enabled ? <p className="jc-muted">{account.notes}</p> : null}
                  <div className="mk-channel-limits">
                    <label className="jc-field"><span>Leaves from</span>
                      <select value={channel.egress} disabled={busy || !channel.enabled} aria-label={`${label} leaves from`}
                        onChange={(event) => patchChannel(id, { egress: event.target.value as FreelanceEgressRoute | "pane" })}>
                        <option value="pane">Pane route ({FREELANCE_EGRESS_LABELS[settings.settings.browserEgress]})</option>
                        {FREELANCE_EGRESS_ROUTES.map((route) => <option key={route} value={route}>{routeLabel(route, egress)}</option>)}
                      </select></label>
                    <label className="jc-field"><span>Highest autonomy</span>
                      <select value={channel.autonomyCap} disabled={busy || !channel.enabled} aria-label={`${label} highest autonomy`}
                        onChange={(event) => patchChannel(id, { autonomyCap: event.target.value as FreelanceCopilotAutonomy })}>
                        {FREELANCE_COPILOT_AUTONOMY_LEVELS.map((level) => <option key={level} value={level}>{AUTONOMY_TEXT[level].label}</option>)}
                      </select></label>
                    <label className="jc-field"><span>Sends a day</span>
                      <input type="number" min={0} max={100} value={channel.dailyCap} disabled={busy || !channel.enabled} aria-label={`${label} sends a day`}
                        onChange={(event) => patchChannel(id, { dailyCap: clamp(event.target.value, 0, 100, 0) })} /></label>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {step === "mailbox" ? <MailboxStep /> : null}

      {step === "autonomy" ? (
        <div className="jc-form">
          <div className="jc-chips" role="radiogroup" aria-label="Autonomy">
            {FREELANCE_COPILOT_AUTONOMY_LEVELS.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={settings.settings.autonomy === level} className={`jc-chip${settings.settings.autonomy === level ? " selected" : ""}`}
                disabled={busy} onClick={() => patch("Autonomy", { autonomy: level })}>{AUTONOMY_TEXT[level].label}</button>
            ))}
          </div>
          <p className="jc-muted">{AUTONOMY_TEXT[settings.settings.autonomy].detail}</p>
          <p className="jc-muted">Upwork and Fiverr do not allow tools that send proposals or messages without a person pressing Send; under Full the risk to those accounts is yours. Lower a platform to Assist in Platforms at any time.</p>
          <SpaceToggle label="Paused" detail="The copilot opens no new work item and sends nothing while paused; the browser keeps working." checked={settings.settings.paused} disabled={busy} onChange={(checked) => patch("Paused", { paused: checked })} />
          <div className="jc-form-grid">
            <label className="jc-field"><span>Connects a day (0: no limit)</span>
              <input type="number" min={0} max={1000} value={connectsBudget.perDay} disabled={busy} onChange={(event) => patch("Connects budget", { connectsBudget: { ...connectsBudget, perDay: clamp(event.target.value, 0, 1000, 0) } })} /></label>
            <label className="jc-field"><span>Connects in 30 days (0: no limit)</span>
              <input type="number" min={0} max={20000} value={connectsBudget.perMonth} disabled={busy} onChange={(event) => patch("Connects budget", { connectsBudget: { ...connectsBudget, perMonth: clamp(event.target.value, 0, 20000, 0) } })} /></label>
            <label className="jc-field"><span>Lowest hourly rate (USD)</span>
              <input type="number" min={0} max={1000} value={settings.settings.rateFloorHourly} disabled={busy} onChange={(event) => patch("Hourly floor", { rateFloorHourly: clamp(event.target.value, 0, 1000, 35) })} /></label>
            <label className="jc-field"><span>Other sites leave from</span>
              <select value={settings.settings.browserEgress} disabled={busy} aria-label="Pane route" onChange={(event) => patch("Pane route", { browserEgress: event.target.value as FreelanceEgressRoute })}>
                {FREELANCE_EGRESS_ROUTES.map((route) => <option key={route} value={route}>{routeLabel(route, egress)}</option>)}
              </select></label>
          </div>
          <SpaceToggle label="Follow-ups" detail="A short follow-up 3 and 7 days after a proposal nobody answered." checked={settings.settings.followUps} disabled={busy} onChange={(checked) => patch("Follow-ups", { followUps: checked })} />
          <SpaceToggle label="Client-ready notifications" detail="A client who wants to go ahead: the moment you take over." checked={notifications.clientReady} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...notifications, clientReady: checked } })} />
          <SpaceToggle label="Needs-you notifications" detail="Reviews, questions, accounts and failed sends the copilot waits on." checked={notifications.needsYou} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...notifications, needsYou: checked } })} />
          <SpaceToggle label="Telegram" detail="Those notifications also go to the paired Telegram bot (Settings → Telegram)." checked={notifications.telegram} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...notifications, telegram: checked } })} />
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
                ? `New Freelance Copilot panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Freelance Copilot panes ask which agent to use."} Change it in Settings → Freelance Copilot.
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
