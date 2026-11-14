import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { ChannelsStatus, DotModelChoices, DotPermissionMode, DotProactiveUsage, DotProfile, DotUserSettings, UpdateDotUserSettings } from "@space/contracts";
import { api } from "../../api.js";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { DotChannels } from "./DotChannels.js";
import { DotConnections } from "./DotConnections.js";
import { DotEvaluationSection } from "./DotEvaluation.js";
import { DotAvatar } from "./DotAvatar.js";
import { DotPanels } from "./DotPanels.js";
import { DotPersonalityPanel } from "./DotPersonality.js";
import { DotModelSelect, DotProfileForm } from "./DotSettings.js";
import { announceDotsUpdated, type DotSettingsSection } from "./dot-home-events.js";
import { claimSettingsRequest } from "../settings/SettingsDisclosure.js";
import { ChevronRight } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import "./dots-chat.css";

type DotTab = "Profile" | "Personality" | "Reminders and goals" | "Memory" | "Tools" | "Activity" | "Evaluation";
const tabForSection: Partial<Record<DotSettingsSection, DotTab>> = { profile: "Profile", reminders: "Reminders and goals", memory: "Memory", tools: "Tools",
  evaluation: "Evaluation" };
export interface DotSettingsRequest { dotId?: string; section?: DotSettingsSection; nonce: number }

/** The folded parts of Settings → Dots; the basics for all Dots always show. */
type DotsPart = "messages" | "accounts" | "channels" | "each";
function partForRequest(request: DotSettingsRequest | null): DotsPart | null {
  if (!request) return null;
  if (request.section === "proactive") return "messages";
  if (request.section === "accounts") return "accounts";
  if (request.section === "channels") return "channels";
  return request.dotId || (request.section && tabForSection[request.section]) ? "each" : null;
}

const usd = (amount: number) => `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
/** What the Dot's own messages cost in model use: measured tokens, and an estimate only for priced calls (Stage 7). */
export function proactiveUsageText(usage: DotProactiveUsage, t: (text: string, vars?: Record<string, string | number>) => string = (text, vars) => uiText("en", text, vars)): string {
  const window = t(usage.days === 1 ? "Model use, last {count} day" : "Model use, last {count} days", { count: usage.days });
  if (!usage.calls) return t("{window}: no check needed the model.", { window });
  const calls = `${t(usage.calls === 1 ? "{count} model call" : "{count} model calls", { count: usage.calls })}${usage.failedCalls ? ` (${t("{count} failed", { count: usage.failedCalls })})` : ""}`;
  const tokens = `${t("{count} tokens", { count: usage.totalTokens.toLocaleString("en-US") })}${usage.measuredCalls < usage.calls
    ? ` (${t("{count} without a usage report", { count: usage.calls - usage.measuredCalls })})` : ""}`;
  const cost = usage.estimatedCostUsd === null ? `${t("cost unknown")}${usage.unknownCostReason ? `: ${usage.unknownCostReason}` : "."}`
    : `${t("about {amount}", { amount: usd(usage.estimatedCostUsd) })}${usage.unknownCostCalls ? ` ${t("for {count} of them; the others have no price", { count: usage.estimatedCalls })}` : ""}`
      + ` (${usage.priceCatalogVersions.join(", ")}).`;
  return t("{window}: {calls}, {tokens}, {cost}", { window, calls, tokens, cost });
}

/** A folded part with a one-line summary; its content mounts (and loads) when opened. */
function DotsPartCard({ title, summary, open, onToggle, partRef, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; partRef?: Ref<HTMLDivElement>; children: ReactNode;
}) {
  return <div ref={partRef} className="dots-part" data-open={open}>
    <button type="button" className="dots-part-toggle" aria-expanded={open} onClick={onToggle}>
      <span><strong>{title}</strong><small>{summary}</small></span>
      <ChevronRight aria-hidden="true" />
    </button>
    {open ? <div className="dots-part-body">{children}</div> : null}
  </div>;
}

/**
 * SpaceApp Settings → Dots: everything that configures the Dots, so the Dot pane stays a conversation.
 * Settings for all Dots first (default Dot, approvals, default model and permissions, accounts, Slack and
 * Teams), then each Dot's profile, reminders, memory, tools, activity and (ADMIN) evaluation.
 */
export function DotsSettingsCard({ roomId, isAdmin, request = null }: { roomId: string | null; isAdmin: boolean; request?: DotSettingsRequest | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [dots, setDots] = useState<DotProfile[] | null>(null);
  const [settings, setSettings] = useState<DotUserSettings | null>(null);
  const [choices, setChoices] = useState<DotModelChoices | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // A request from a Dot pane applies once; Settings remounts on every opening and must not replay it.
  const [freshRequest] = useState(() => request && claimSettingsRequest("dots-card", request.nonce) ? request : null);
  const [selectedId, setSelectedId] = useState<string | null>(freshRequest?.dotId ?? null);
  const [tab, setTab] = useState<DotTab>((freshRequest?.section && tabForSection[freshRequest.section]) || "Profile");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "status" | "alert"; text: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [openParts, setOpenParts] = useState<Set<DotsPart>>(() => new Set(([partForRequest(freshRequest)].filter(Boolean) as DotsPart[])));
  const togglePart = (part: DotsPart) => setOpenParts((current) => {
    const next = new Set(current);
    if (next.has(part)) next.delete(part); else next.add(part);
    return next;
  });
  const proactiveRef = useRef<HTMLDivElement>(null);
  const accountsRef = useRef<HTMLDivElement>(null);
  const channelsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    setFailed(false);
    void Promise.all([api.dots(), api.dotSettings()]).then(([list, saved]) => {
      if (!current) return;
      setDots([...list.dots].sort((a, b) => a.slot - b.slot)); setSettings(saved.settings);
    }).catch(() => { if (current) setFailed(true); });
    // Models load separately: a slow catalog never holds back the rest.
    void api.dotModels().then((value) => { if (current) setChoices(value); }).catch(() => { if (current) setChoices({ providers: [] }); });
    return () => { current = false; };
  }, [retry]);
  useEffect(() => {
    if (!request || (request !== freshRequest && !claimSettingsRequest("dots-card", request.nonce))) return;
    if (request.dotId) setSelectedId(request.dotId);
    const target = request.section ? tabForSection[request.section] : undefined;
    if (target) setTab(target);
    const part = partForRequest(request);
    if (part) setOpenParts((current) => new Set(current).add(part));
    const ref = request.section === "accounts" ? accountsRef : request.section === "channels" ? channelsRef : request.section === "proactive" ? proactiveRef : null;
    window.setTimeout(() => ref?.current?.scrollIntoView?.({ block: "start" }), 0);
  }, [request?.nonce]);
  // Whether "Also send to Slack" can work: Space has a Slack app and the user linked a Slack account.
  const [channels, setChannels] = useState<ChannelsStatus | null>(null);
  const [usage, setUsage] = useState<DotProactiveUsage | "unavailable" | null>(null);
  const messagesOpen = openParts.has("messages");
  useEffect(() => {
    if (!messagesOpen) return;
    let current = true;
    void api.channels().then((value) => { if (current) setChannels(value); }).catch(() => undefined);
    void api.dotProactiveUsage(7).then((value) => { if (current) setUsage(value); }).catch(() => { if (current) setUsage("unavailable"); });
    return () => { current = false; };
  }, [messagesOpen]);
  const selected = dots?.find((dot) => dot.dotId === selectedId) ?? dots?.[0] ?? null;
  useEffect(() => {
    let current = true;
    setSessionId(null);
    if (!selected) return;
    // New reminders run in the Dot's latest conversation in the current room (never a proof or another room's).
    if (!roomId) return;
    void api.dotCollection(selected.dotId, "sessions").then((result) => {
      if (current && result.dotId === selected.dotId) {
        setSessionId(result.items.find((item) => item.dotId === selected.dotId && item.roomId === roomId)?.sessionId ?? null);
      }
    }).catch(() => undefined);
    return () => { current = false; };
  }, [selected?.dotId, roomId]);
  async function save(patch: UpdateDotUserSettings) {
    if (saving) return;
    setSaving(true); setNotice(null);
    try {
      const result = await api.updateDotSettings(patch);
      setSettings(result.settings);
      announceDotsUpdated();
      setNotice({ tone: "status", text: t("Saved.") });
    } catch (error) {
      setNotice({ tone: "alert", text: error instanceof Error ? error.message : t("The setting could not be saved.") });
    } finally { setSaving(false); }
  }
  if (failed) return <section className="dots-settings" aria-label={t("Dots settings")}><p role="status">{t("Dots settings are unavailable.")}</p>
    <button type="button" onClick={() => setRetry((value) => value + 1)}>{t("Retry")}</button></section>;
  if (!dots || !settings) return <section className="dots-settings" aria-label={t("Dots settings")}><p role="status">{t("Loading Dots…")}</p></section>;
  const slackConfigured = Boolean(channels?.providers.some((provider) => provider.provider === "SLACK" && provider.configured));
  const slackLinked = Boolean(channels?.identities.some((identity) => identity.provider === "SLACK"));
  const tabs: DotTab[] = ["Profile", "Personality", "Reminders and goals", "Memory", "Tools", "Activity", ...(isAdmin && roomId ? ["Evaluation" as const] : [])];
  function moveTab(event: KeyboardEvent, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setTab(tabs[next]!);
    (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next])?.focus();
  }
  return <section className="dots-settings" aria-label={t("Dots settings")}>
    <section className="dots-settings-group" aria-label={t("All Dots")}>
      <h4>{t("All Dots")}</h4>
      <label className="dots-settings-field"><span>{t("Default Dot")}<InfoTip text={t("A new Chat pane opens with this Dot.")} label={t("About {label}", { label: t("Default Dot") })} /></span>
        <select aria-label={t("Default Dot")} value={settings.defaultDotId ?? ""} disabled={saving}
          onChange={(event) => void save({ defaultDotId: event.currentTarget.value || null })}>
          <option value="">{t("{name} (first Dot)", { name: dots[0]?.name ?? t("First Dot") })}</option>
          {dots.slice(1).map((dot) => <option key={dot.dotId} value={dot.dotId}>{dot.name}</option>)}
        </select></label>
      <SpaceToggle name="dots-confirm-external" label={t("Ask before sending email or creating events")} checked={settings.confirmExternalActions} disabled={saving}
        help="On: every email and calendar event waits for your approval in the Dot's conversation. Off: Dots send email and create events when you ask them to, without asking again."
        onChange={(checked) => void save({ confirmExternalActions: checked })} />
      <label className="dots-settings-field"><span>{t("Default model")}<InfoTip text={t("Used by every Dot without its own model.")} label={t("About {label}", { label: t("Default model") })} /></span>
        <DotModelSelect label="Default model for Dots" value={settings.defaultModelConfigId ?? ""} choices={choices} disabled={saving}
          defaultLabel="Chat default" onChange={(value) => void save({ defaultModelConfigId: value || null })} /></label>
      <label className="dots-settings-field"><span>{t("Default permissions")}<InfoTip text={t("How much a Dot may do without asking you. Approve for me lets a reviewer approve workspace actions; Full access runs without prompts.")} label={t("About {label}", { label: t("Default permissions") })} /></span>
        <select aria-label={t("Default permissions for Dots")} value={settings.defaultPermissionMode ?? ""} disabled={saving}
          onChange={(event) => void save({ defaultPermissionMode: (event.currentTarget.value || null) as DotPermissionMode | null })}>
          <option value="">{t("Chat default")}</option><option value="approve_for_me">{t("Approve for me")}</option><option value="full_access">{t("Full access")}</option>
        </select></label>
      {notice ? <p className="dots-settings-notice" role={notice.tone}>{notice.text}</p> : null}
    </section>
    <DotsPartCard partRef={proactiveRef} title={t("Messages from your Dot")} open={openParts.has("messages")} onToggle={() => togglePart("messages")}
      summary={settings.proactive.enabled ? t("On: a Dot tells you about new email and upcoming events.") : t("Off: Dots write only when you message them.")}>
    <section className="dots-settings-group" aria-label={t("Messages from your Dot")}>
      <SpaceToggle name="dots-proactive" label={t("Let a Dot message me about new email and upcoming events")} checked={settings.proactive.enabled} disabled={saving}
        help="It reads only, and writes in its conversation when something needs you: account security, replies due, bills, travel, meetings soon."
        onChange={(enabled) => void save({ proactive: { enabled } })} />
      {settings.proactive.enabled ? <>
        <label className="dots-settings-field"><span>{t("Dot that writes")}<InfoTip text={t("The Dot that writes these messages in its own conversation.")} label={t("About {label}", { label: t("Dot that writes") })} /></span>
          <select aria-label={t("Dot that writes")} value={settings.proactive.dotId ?? ""} disabled={saving}
            onChange={(event) => void save({ proactive: { dotId: event.currentTarget.value || null } })}>
            <option value="">{t("Default Dot")}</option>
            {dots.map((dot) => <option key={dot.dotId} value={dot.dotId}>{dot.name}</option>)}
          </select></label>
        <SpaceToggle compact name="dots-proactive-email" label={t("New email")} help="The Dot tells you about new email that needs you." checked={settings.proactive.email} disabled={saving}
          onChange={(email) => void save({ proactive: { email } })} />
        <SpaceToggle compact name="dots-proactive-calendar" label={t("Upcoming events")} help="The Dot tells you about calendar events coming soon." checked={settings.proactive.calendar} disabled={saving}
          onChange={(calendar) => void save({ proactive: { calendar } })} />
        <label className="dots-settings-field"><span>{t("Check every")}<InfoTip text={t("How often the Dot looks at your email and calendar for something to tell you.")} label={t("About {label}", { label: t("Check every") })} /></span>
          <select aria-label={t("Check every")} value={settings.proactive.intervalMinutes} disabled={saving}
            onChange={(event) => void save({ proactive: { intervalMinutes: Number(event.currentTarget.value) } })}>
            {[30, 60, 120, 240, 480].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? t("{count} minutes", { count: minutes }) : t(minutes === 60 ? "{count} hour" : "{count} hours", { count: minutes / 60 })}</option>)}
          </select></label>
        <label className="dots-settings-field"><span>{t("At most per day")}<InfoTip text={t("The most messages the Dot writes to you in one day.")} label={t("About {label}", { label: t("At most per day") })} /></span>
          <select aria-label={t("At most per day")} value={settings.proactive.maxPerDay} disabled={saving}
            onChange={(event) => void save({ proactive: { maxPerDay: Number(event.currentTarget.value) } })}>
            {[1, 3, 5, 10, 20].map((count) => <option key={count} value={count}>{t(count === 1 ? "{count} message" : "{count} messages", { count })}</option>)}
          </select></label>
        <SpaceToggle compact name="dots-proactive-quiet" label={t("Quiet hours")} help="In your time zone (Settings → Date and time). Nothing is checked during quiet hours." checked={Boolean(settings.proactive.quietHours)} disabled={saving}
          onChange={(on) => void save({ proactive: { quietHours: on ? { start: "23:00", end: "08:00" } : null } })} />
        {settings.proactive.quietHours ? <div className="dots-settings-quiet" role="group" aria-label={t("Quiet hours")}>
          <label><span>{t("From")}</span><input type="time" aria-label={t("Quiet hours from")} value={settings.proactive.quietHours.start} disabled={saving}
            onChange={(event) => { const start = event.currentTarget.value; if (/^\d{2}:\d{2}$/.test(start)) void save({ proactive: { quietHours: { ...settings.proactive.quietHours!, start } } }); }} /></label>
          <label><span>{t("To")}</span><input type="time" aria-label={t("Quiet hours to")} value={settings.proactive.quietHours.end} disabled={saving}
            onChange={(event) => { const end = event.currentTarget.value; if (/^\d{2}:\d{2}$/.test(end)) void save({ proactive: { quietHours: { ...settings.proactive.quietHours!, end } } }); }} /></label>
        </div> : null}
        {slackConfigured || settings.proactive.alsoSlack ? <SpaceToggle compact name="dots-proactive-slack" label={t("Also send to Slack")}
          checked={settings.proactive.alsoSlack} disabled={saving || (!settings.proactive.alsoSlack && !slackLinked)}
          help="The same message, as a direct message from the Space app."
          detail={slackLinked ? undefined : t("Link your Slack account under Slack and Teams first.")}
          onChange={(alsoSlack) => void save({ proactive: { alsoSlack } })} /> : null}
      </> : null}
      {usage ? <p className="dots-settings-usage">{usage === "unavailable" ? t("Model use is unavailable.") : proactiveUsageText(usage, t)}</p> : null}
    </section>
    </DotsPartCard>
    <DotsPartCard partRef={accountsRef} title={t("Connected accounts")} summary={t("Email and calendar accounts your Dots may use.")}
      open={openParts.has("accounts")} onToggle={() => togglePart("accounts")}>
      <div className="dots-settings-group"><DotConnections /></div>
    </DotsPartCard>
    <DotsPartCard partRef={channelsRef} title={t("Slack and Teams")} summary={t("Message your Dots from Slack or Teams.")}
      open={openParts.has("channels")} onToggle={() => togglePart("channels")}>
      <div className="dots-settings-group"><DotChannels /></div>
    </DotsPartCard>
    <DotsPartCard title={t("Each Dot")} summary={t("One Dot's name, personality, style, model, reminders, memory and tools.")}
      open={openParts.has("each")} onToggle={() => togglePart("each")}>
    <section className="dots-settings-group" aria-label={t("Each Dot")}>
      <div className="dots-settings-picker" role="group" aria-label={t("Choose a Dot to set up")}>
        {dots.map((dot) => <button key={dot.dotId} type="button" aria-pressed={selected?.dotId === dot.dotId} onClick={() => setSelectedId(dot.dotId)}>
          <DotAvatar character={dot.appearance.character} size={28} motion="hover" /><span>{dot.name}</span></button>)}
      </div>
      {selected ? <>
        <div className="dots-settings-tabs" role="tablist" aria-label={t("{name} settings", { name: selected.name })}>
          {tabs.map((value, index) => <button key={value} type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => moveTab(event, index)} onClick={() => setTab(value)}>{t(value)}</button>)}
        </div>
        <div role="tabpanel" aria-label={t("{name}: {tab}", { name: selected.name, tab: t(tab) })}>
          {tab === "Profile" ? <DotProfileForm key={selected.dotId} dot={selected} choices={choices}
            onSaved={(saved) => setDots((current) => current?.map((dot) => dot.dotId === saved.dotId ? saved : dot) ?? current)} />
            : tab === "Personality" ? <DotPersonalityPanel key={selected.dotId} dot={selected} />
            : tab === "Reminders and goals" ? <>
              {sessionId ? null : <p className="dots-settings-notice">{t("To add a reminder, open a conversation with {name} in this room first.", { name: selected.name })}</p>}
              <DotPanels key={selected.dotId} tab="Tasks" dot={selected} session={null} sessionId={sessionId} roomId={roomId} /></>
            : tab === "Memory" ? <DotPanels key={selected.dotId} tab="Memory" dot={selected} session={null} roomId={roomId} />
            : tab === "Tools" ? <DotPanels key={selected.dotId} tab="Tools" dot={selected} session={null} roomId={roomId} />
            : tab === "Activity" ? <DotPanels key={selected.dotId} tab="Activity" dot={selected} session={null} roomId={roomId} />
            : roomId ? <DotEvaluationSection key={selected.dotId} dot={selected} roomId={roomId} /> : null}
        </div>
      </> : null}
    </section>
    </DotsPartCard>
  </section>;
}
