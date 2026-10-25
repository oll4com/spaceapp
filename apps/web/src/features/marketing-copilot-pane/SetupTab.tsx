import { useEffect, useState } from "react";
import {
  effectiveMarketingAutonomy, MARKETING_CHANNEL_LABELS, MARKETING_CHANNELS, MARKETING_COPILOT_AUTONOMY_LEVELS,
  type CopilotLaunchSettings, type MarketingChannel, type MarketingChannelSettings, type MarketingCopilotAutonomy, type MarketingCopilotPaneMetadata, type Pane
} from "@space/contracts";
import { api } from "../../api.js";
import { AgentAccountField, useCopilotAccounts } from "../copilot-kit/AgentAccountField.js";
import { copilotAgentLabel, loadPaneAccountProfileId, type CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

export const AUTONOMY_TEXT: Record<MarketingCopilotAutonomy, { label: string; detail: string }> = {
  ASSIST: { label: "Assist", detail: "Drafts and asks; nothing is published until you approve it." },
  RULES: { label: "Rules", detail: "Publishes alone only under rules you approved; everything else is a review." },
  FULL: { label: "Full", detail: "Publishes on its own judgement within each channel's cap and limit; you follow along in Activity." }
};

export type SetupStep = "channels" | "autonomy" | "agent";

/** Where the operator logs in once per channel in the pane browser (the profile keeps the session). */
const CHANNEL_LOGIN_URL: Partial<Record<MarketingChannel, string>> = {
  X: "https://x.com/login", LINKEDIN: "https://www.linkedin.com/login", REDDIT: "https://www.reddit.com/login", HACKER_NEWS: "https://news.ycombinator.com/login",
  PRODUCT_HUNT: "https://www.producthunt.com/login", DEVTO: "https://dev.to/enter", YOUTUBE: "https://studio.youtube.com", GITHUB: "https://github.com/login"
};

const clamp = (value: string, min: number, max: number, fallback: number) => Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));

/** Setup: the channels the copilot may use (cap and limit each), how far it acts alone, and the pane's agent. */
export function SetupTab({ pane, settings, runtimeOptions, switching, accountRevision = 0, onSettingsChange, onSwitchAgent, onSetDefault, onOpenBrowser }: {
  pane: Pane;
  /** The pane browser was sent to a login page (phones show the browser tab). */
  onOpenBrowser?(): void;
  settings: MarketingCopilotPaneMetadata;
  runtimeOptions: CopilotRuntimeOption[];
  switching: boolean;
  /** Changes after each agent switch, so the Agent step reloads the pane's account. */
  accountRevision?: number;
  onSettingsChange(settings: MarketingCopilotPaneMetadata): void;
  onSwitchAgent(runtimeId: string, accountProfileId?: string): void;
  onSetDefault(): void;
}) {
  const [step, setStep] = useState<SetupStep>("channels");
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
    api.userSettings().then((user) => { if (!cancelled) setLaunch(user.marketingCopilot ?? null); }).catch(() => undefined);
    void loadPaneAccountProfileId(pane.id, runtimeId).then((accountProfileId) => { if (!cancelled) setPaneAccount(accountProfileId); });
    return () => { cancelled = true; };
  }, [accountRevision, pane.id, runtimeId, step]);

  async function save(label: string, next: MarketingCopilotPaneMetadata) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    onSettingsChange(next);
    try {
      const response = await api.updateMarketingCopilotSettings(pane.id, next);
      onSettingsChange(response.metadata);
      setMessage(`${label} saved.`);
    } catch (error) {
      onSettingsChange(settings);
      setMessage(error instanceof Error ? error.message : `${label} could not be saved.`);
    } finally {
      setBusy(false);
    }
  }

  const patch = (label: string, update: Partial<MarketingCopilotPaneMetadata["settings"]>) => void save(label, { ...settings, settings: { ...settings.settings, ...update } });
  const patchChannel = (id: MarketingChannel, update: Partial<MarketingChannelSettings>) =>
    patch(MARKETING_CHANNEL_LABELS[id], { channels: { ...settings.settings.channels, [id]: { ...settings.settings.channels[id], ...update } } });

  return (
    <div className="jc-setup" role="tabpanel" id="jc-panel-setup" aria-labelledby="jc-tab-setup">
      <nav className="jc-steps" aria-label="Setup steps">
        {(["channels", "autonomy", "agent"] as const).map((id, index) => (
          <button key={id} type="button" className={`jc-step${step === id ? " selected" : ""}`} aria-current={step === id ? "step" : undefined} onClick={() => setStep(id)}>
            <span className="jc-step-index">{index + 1}</span>{id === "channels" ? "Channels" : id === "autonomy" ? "Autonomy" : "Agent"}
          </button>
        ))}
      </nav>

      {step === "channels" ? (
        <div className="jc-form">
          <p className="jc-muted">Where the copilot promotes SpaceApp, always on your own accounts. Each channel has a highest autonomy and a publishing limit that hold whatever the pane's autonomy is. Log in once per channel in this pane's browser; the copilot hands you the browser whenever a site asks for a login, a code or a CAPTCHA.</p>
          <ul className="mk-channels" aria-label="Channels">
            {MARKETING_CHANNELS.map((id) => {
              const channel = settings.settings.channels[id];
              const label = MARKETING_CHANNEL_LABELS[id];
              return (
                <li key={id} className="mk-channel" data-enabled={channel.enabled ? "true" : "false"}>
                  <SpaceToggle label={label} detail={channel.enabled ? `Acts as ${AUTONOMY_TEXT[effectiveMarketingAutonomy(settings.settings, id)].label} here` : "Off: the copilot does not post here"}
                    checked={channel.enabled} disabled={busy} onChange={(checked) => patchChannel(id, { enabled: checked })} />
                  {CHANNEL_LOGIN_URL[id] && channel.enabled ? (
                    <button type="button" className="jc-button ghost mk-channel-login" disabled={busy} title={`Open ${label}'s login page in this pane's browser`}
                      onClick={() => void api.navigateBrowser(pane.id, CHANNEL_LOGIN_URL[id]!).then(() => onOpenBrowser?.(), (error: unknown) => setMessage(error instanceof Error ? error.message : "The browser could not open the page."))}>Log in to {label}</button>
                  ) : null}
                  <div className="mk-channel-limits">
                    <label className="jc-field"><span>Highest autonomy</span>
                      <select value={channel.autonomyCap} disabled={busy || !channel.enabled} aria-label={`${label} highest autonomy`}
                        onChange={(event) => patchChannel(id, { autonomyCap: event.target.value as MarketingCopilotAutonomy })}>
                        {MARKETING_COPILOT_AUTONOMY_LEVELS.map((level) => <option key={level} value={level}>{AUTONOMY_TEXT[level].label}</option>)}
                      </select></label>
                    <label className="jc-field"><span>Posts</span>
                      <input type="number" min={0} max={50} value={channel.posts} disabled={busy || !channel.enabled} aria-label={`${label} posts per period`}
                        onChange={(event) => patchChannel(id, { posts: clamp(event.target.value, 0, 50, 0) })} /></label>
                    <label className="jc-field"><span>Per days</span>
                      <input type="number" min={1} max={90} value={channel.perDays} disabled={busy || !channel.enabled} aria-label={`${label} period in days`}
                        onChange={(event) => patchChannel(id, { perDays: clamp(event.target.value, 1, 90, 1) })} /></label>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {step === "autonomy" ? (
        <div className="jc-form">
          <div className="jc-chips" role="radiogroup" aria-label="Autonomy">
            {MARKETING_COPILOT_AUTONOMY_LEVELS.map((level) => (
              <button key={level} type="button" role="radio" aria-checked={settings.settings.autonomy === level} className={`jc-chip${settings.settings.autonomy === level ? " selected" : ""}`}
                disabled={busy} onClick={() => patch("Autonomy", { autonomy: level })}>{AUTONOMY_TEXT[level].label}</button>
            ))}
          </div>
          <p className="jc-muted">{AUTONOMY_TEXT[settings.settings.autonomy].detail}</p>
          <p className="jc-muted">The copilot never votes, likes or asks for upvotes, never messages people in bulk and only uses your own accounts. Login, two-step codes and CAPTCHAs are handed to you.</p>
          <SpaceToggle label="Paused" detail="The copilot opens no new work item while paused, and approved posts wait; the browser keeps working." checked={settings.settings.paused} disabled={busy} onChange={(checked) => patch("Paused", { paused: checked })} />
          <SpaceToggle label="Release campaigns" detail="A new SpaceApp version proposes its release campaign for you to approve." checked={settings.settings.releaseCampaigns} disabled={busy}
            onChange={(checked) => patch("Release campaigns", { releaseCampaigns: checked })} />
          <SpaceToggle label="Needs-you notifications" detail="Reviews, questions, proposals and failed publications the copilot waits on." checked={settings.settings.notifications.needsYou} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...settings.settings.notifications, needsYou: checked } })} />
          <SpaceToggle label="Published notifications" detail="A notification with the link for every post the copilot publishes." checked={settings.settings.notifications.published} disabled={busy}
            onChange={(checked) => patch("Notifications", { notifications: { ...settings.settings.notifications, published: checked } })} />
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
                ? `New Marketing Copilot panes open with ${copilotAgentLabel(launch.runtimeId, runtimeOptions.find((option) => option.runtime.id === launch.runtimeId)?.runtime)}${launch.accountProfileId ? ` (${launch.accountProfileId} account)` : ""} without asking.`
                : "New Marketing Copilot panes ask which agent to use."} Change it in Settings → Marketing Copilot.
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
