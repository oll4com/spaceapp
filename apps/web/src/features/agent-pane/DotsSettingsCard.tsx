import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { ChannelsStatus, DotModelChoices, DotPermissionMode, DotProactiveUsage, DotProfile, DotUserSettings, UpdateDotUserSettings } from "@space/contracts";
import { api } from "../../api.js";
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
export function proactiveUsageText(usage: DotProactiveUsage): string {
  const window = `Model use, last ${usage.days} day${usage.days === 1 ? "" : "s"}`;
  if (!usage.calls) return `${window}: no check needed the model.`;
  const calls = `${usage.calls} model call${usage.calls === 1 ? "" : "s"}${usage.failedCalls ? ` (${usage.failedCalls} failed)` : ""}`;
  const tokens = `${usage.totalTokens.toLocaleString("en-US")} tokens${usage.measuredCalls < usage.calls
    ? ` (${usage.calls - usage.measuredCalls} without a usage report)` : ""}`;
  const cost = usage.estimatedCostUsd === null ? `cost unknown${usage.unknownCostReason ? `: ${usage.unknownCostReason}` : "."}`
    : `about ${usd(usage.estimatedCostUsd)}${usage.unknownCostCalls ? ` for ${usage.estimatedCalls} of them; the others have no price` : ""}`
      + ` (${usage.priceCatalogVersions.join(", ")}).`;
  return `${window}: ${calls}, ${tokens}, ${cost}`;
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
      setNotice({ tone: "status", text: "Saved." });
    } catch (error) {
      setNotice({ tone: "alert", text: error instanceof Error ? error.message : "The setting could not be saved." });
    } finally { setSaving(false); }
  }
  if (failed) return <section className="dots-settings" aria-label="Dots settings"><p role="status">Dots settings are unavailable.</p>
    <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></section>;
  if (!dots || !settings) return <section className="dots-settings" aria-label="Dots settings"><p role="status">Loading Dots…</p></section>;
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
  return <section className="dots-settings" aria-label="Dots settings">
    <section className="dots-settings-group" aria-label="All Dots">
      <h4>All Dots</h4>
      <label className="dots-settings-field"><span>Default Dot</span>
        <select aria-label="Default Dot" value={settings.defaultDotId ?? ""} disabled={saving}
          onChange={(event) => void save({ defaultDotId: event.currentTarget.value || null })}>
          <option value="">{dots[0]?.name ?? "First Dot"} (first Dot)</option>
          {dots.slice(1).map((dot) => <option key={dot.dotId} value={dot.dotId}>{dot.name}</option>)}
        </select>
        <small>A new Chat pane opens with this Dot.</small></label>
      <SpaceToggle name="dots-confirm-external" label="Ask before sending email or creating events" checked={settings.confirmExternalActions} disabled={saving}
        detail={settings.confirmExternalActions ? "Every email and calendar event waits for your approval in the Dot's conversation."
          : "Dots send email and create events when you ask them to, without asking again."}
        onChange={(checked) => void save({ confirmExternalActions: checked })} />
      <label className="dots-settings-field"><span>Default model</span>
        <DotModelSelect label="Default model for Dots" value={settings.defaultModelConfigId ?? ""} choices={choices} disabled={saving}
          defaultLabel="Chat default" onChange={(value) => void save({ defaultModelConfigId: value || null })} />
        <small>Used by every Dot without its own model.</small></label>
      <label className="dots-settings-field"><span>Default permissions</span>
        <select aria-label="Default permissions for Dots" value={settings.defaultPermissionMode ?? ""} disabled={saving}
          onChange={(event) => void save({ defaultPermissionMode: (event.currentTarget.value || null) as DotPermissionMode | null })}>
          <option value="">Chat default</option><option value="approve_for_me">Approve for me</option><option value="full_access">Full access</option>
        </select>
        <small>How much a Dot may do without asking you. Approve for me lets a reviewer approve workspace actions; Full access runs without prompts.</small></label>
      {notice ? <p className="dots-settings-notice" role={notice.tone}>{notice.text}</p> : null}
    </section>
    <DotsPartCard partRef={proactiveRef} title="Messages from your Dot" open={openParts.has("messages")} onToggle={() => togglePart("messages")}
      summary={settings.proactive.enabled ? "On: a Dot tells you about new email and upcoming events." : "Off: Dots write only when you message them."}>
    <section className="dots-settings-group" aria-label="Messages from your Dot">
      <SpaceToggle name="dots-proactive" label="Let a Dot message me about new email and upcoming events" checked={settings.proactive.enabled} disabled={saving}
        detail={settings.proactive.enabled ? "It reads only, and writes in its conversation when something needs you: account security, replies due, bills, travel, meetings soon."
          : "Dots write only when you message them."}
        onChange={(enabled) => void save({ proactive: { enabled } })} />
      {settings.proactive.enabled ? <>
        <label className="dots-settings-field"><span>Dot that writes</span>
          <select aria-label="Dot that writes" value={settings.proactive.dotId ?? ""} disabled={saving}
            onChange={(event) => void save({ proactive: { dotId: event.currentTarget.value || null } })}>
            <option value="">Default Dot</option>
            {dots.map((dot) => <option key={dot.dotId} value={dot.dotId}>{dot.name}</option>)}
          </select></label>
        <SpaceToggle compact name="dots-proactive-email" label="New email" checked={settings.proactive.email} disabled={saving}
          onChange={(email) => void save({ proactive: { email } })} />
        <SpaceToggle compact name="dots-proactive-calendar" label="Upcoming events" checked={settings.proactive.calendar} disabled={saving}
          onChange={(calendar) => void save({ proactive: { calendar } })} />
        <label className="dots-settings-field"><span>Check every</span>
          <select aria-label="Check every" value={settings.proactive.intervalMinutes} disabled={saving}
            onChange={(event) => void save({ proactive: { intervalMinutes: Number(event.currentTarget.value) } })}>
            {[30, 60, 120, 240, 480].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}</option>)}
          </select></label>
        <label className="dots-settings-field"><span>At most per day</span>
          <select aria-label="At most per day" value={settings.proactive.maxPerDay} disabled={saving}
            onChange={(event) => void save({ proactive: { maxPerDay: Number(event.currentTarget.value) } })}>
            {[1, 3, 5, 10, 20].map((count) => <option key={count} value={count}>{count} message{count === 1 ? "" : "s"}</option>)}
          </select></label>
        <SpaceToggle compact name="dots-proactive-quiet" label="Quiet hours" checked={Boolean(settings.proactive.quietHours)} disabled={saving}
          onChange={(on) => void save({ proactive: { quietHours: on ? { start: "23:00", end: "08:00" } : null } })} />
        {settings.proactive.quietHours ? <div className="dots-settings-quiet" role="group" aria-label="Quiet hours">
          <label><span>From</span><input type="time" aria-label="Quiet hours from" value={settings.proactive.quietHours.start} disabled={saving}
            onChange={(event) => { const start = event.currentTarget.value; if (/^\d{2}:\d{2}$/.test(start)) void save({ proactive: { quietHours: { ...settings.proactive.quietHours!, start } } }); }} /></label>
          <label><span>To</span><input type="time" aria-label="Quiet hours to" value={settings.proactive.quietHours.end} disabled={saving}
            onChange={(event) => { const end = event.currentTarget.value; if (/^\d{2}:\d{2}$/.test(end)) void save({ proactive: { quietHours: { ...settings.proactive.quietHours!, end } } }); }} /></label>
          <small>In your time zone (Settings → Date and time). Nothing is checked during quiet hours.</small>
        </div> : null}
        {slackConfigured || settings.proactive.alsoSlack ? <SpaceToggle compact name="dots-proactive-slack" label="Also send to Slack"
          checked={settings.proactive.alsoSlack} disabled={saving || (!settings.proactive.alsoSlack && !slackLinked)}
          detail={slackLinked ? "The same message, as a direct message from the Space app." : "Link your Slack account under Slack and Teams first."}
          onChange={(alsoSlack) => void save({ proactive: { alsoSlack } })} /> : null}
      </> : null}
      {usage ? <p className="dots-settings-usage">{usage === "unavailable" ? "Model use is unavailable." : proactiveUsageText(usage)}</p> : null}
    </section>
    </DotsPartCard>
    <DotsPartCard partRef={accountsRef} title="Connected accounts" summary="Email and calendar accounts your Dots may use."
      open={openParts.has("accounts")} onToggle={() => togglePart("accounts")}>
      <div className="dots-settings-group"><DotConnections /></div>
    </DotsPartCard>
    <DotsPartCard partRef={channelsRef} title="Slack and Teams" summary="Message your Dots from Slack or Teams."
      open={openParts.has("channels")} onToggle={() => togglePart("channels")}>
      <div className="dots-settings-group"><DotChannels /></div>
    </DotsPartCard>
    <DotsPartCard title="Each Dot" summary="One Dot's name, personality, style, model, reminders, memory and tools."
      open={openParts.has("each")} onToggle={() => togglePart("each")}>
    <section className="dots-settings-group" aria-label="Each Dot">
      <div className="dots-settings-picker" role="group" aria-label="Choose a Dot to set up">
        {dots.map((dot) => <button key={dot.dotId} type="button" aria-pressed={selected?.dotId === dot.dotId} onClick={() => setSelectedId(dot.dotId)}>
          <DotAvatar character={dot.appearance.character} size={28} motion="hover" /><span>{dot.name}</span></button>)}
      </div>
      {selected ? <>
        <div className="dots-settings-tabs" role="tablist" aria-label={`${selected.name} settings`}>
          {tabs.map((value, index) => <button key={value} type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => moveTab(event, index)} onClick={() => setTab(value)}>{value}</button>)}
        </div>
        <div role="tabpanel" aria-label={`${selected.name}: ${tab}`}>
          {tab === "Profile" ? <DotProfileForm key={selected.dotId} dot={selected} choices={choices}
            onSaved={(saved) => setDots((current) => current?.map((dot) => dot.dotId === saved.dotId ? saved : dot) ?? current)} />
            : tab === "Personality" ? <DotPersonalityPanel key={selected.dotId} dot={selected} />
            : tab === "Reminders and goals" ? <>
              {sessionId ? null : <p className="dots-settings-notice">To add a reminder, open a conversation with {selected.name} in this room first.</p>}
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
