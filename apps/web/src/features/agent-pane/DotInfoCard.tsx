import { useEffect, useMemo, useState } from "react";
import { buildDotToolCatalog, dotPersonalities, type ChannelsStatus, type DotComputer as DotComputerState, type DotDeliverable, type DotProfile,
  type DotToolInvocation } from "@space/contracts";
import { api } from "../../api.js";
import { ChevronRight, FileText, Monitor, Phone, Slack, X } from "../ui-theme/app-icons.js";
import { DotAvatar } from "./DotAvatar.js";
import { DotComputer } from "./DotComputer.js";
import { DotOutputVersions } from "./DotDeliverables.js";
import { dotArtwork } from "./DotHeader.js";
import { openDotSettings } from "./dot-home-events.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

type Translate = (text: string, vars?: Record<string, string | number>) => string;
const english: Translate = (text, vars) => uiText("en", text, vars);

const REFRESH_MS = 30_000;
/** The computer's picture is a full browser frame: read at most once a minute while the card shows. */
const PICTURE_REFRESH_MS = 60_000;
const toolTitles = new Map(buildDotToolCatalog({ role: "USER", browserSessionsEnabled: true, browserPaneIds: [], mcpTools: [], installedMcpServers: [] })
  .map((tool) => [tool.id, tool.title]));

/** "just now", "5 minutes ago", "1 hour ago", "3 days ago". */
export function dotAgoLabel(at: string, now = Date.now(), t: Translate = english): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t(minutes === 1 ? "{count} minute ago" : "{count} minutes ago", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(hours === 1 ? "{count} hour ago" : "{count} hours ago", { count: hours });
  const days = Math.floor(hours / 24);
  return t(days === 1 ? "{count} day ago" : "{count} days ago", { count: days });
}

/** "Active now", "Active 5 minutes ago", "Active 1 hour ago", "Active 3 days ago". */
export function dotActiveLabel(lastActiveAt: string | null, working: boolean, now = Date.now(), t: Translate = english): string {
  if (working) return t("Active now");
  if (!lastActiveAt) return t("No activity yet");
  const ago = dotAgoLabel(lastActiveAt, now, t);
  return ago === t("just now") ? t("Active just now") : t("Active {ago}", { ago });
}

/** The direct conversation with the Space app in the linked workspace when the server knows its app, else Slack itself. */
export function slackDirectUrl(appUrl: string | null, teamId: string | null): string {
  if (!appUrl?.startsWith("https://slack.com/app_redirect?app=")) return "https://app.slack.com/client";
  return teamId && /^[TE][A-Z0-9]{6,30}$/.test(teamId) && !appUrl.includes("&team=") ? `${appUrl}&team=${teamId}` : appUrl;
}

function useVisibleRead<T>(key: string | null, visible: boolean, read: () => Promise<T>, refreshMs = REFRESH_MS) {
  const [state, setState] = useState<{ key: string | null; value: T | null; failed: boolean }>({ key: null, value: null, failed: false });
  useEffect(() => {
    if (!key || !visible) return;
    let current = true;
    const load = () => void Promise.resolve().then(read).then((value) => { if (current) setState({ key, value, failed: false }); })
      .catch(() => { if (current) setState((previous) => ({ key, value: previous.key === key ? previous.value : null, failed: true })); });
    load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") load(); }, refreshMs);
    return () => { current = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible, refreshMs]);
  return state.key === key ? state : { key, value: null, failed: false };
}

/**
 * The Dot's card, like ChatGPT dot: when it was last active, Call and Slack, its computer,
 * recent actions and the files it delivered. Management lives in Settings → Dots.
 */
export function DotInfoCard({ dot, roomId, visible, working, lastActiveAt, sessionId, onCall, callDisabledReason, onClose, overlay, roomScoped = false }: {
  dot: DotProfile; roomId: string; visible: boolean; working: boolean; lastActiveAt: string | null; sessionId: string | null;
  onCall: () => void; callDisabledReason: string | null; onClose: () => void; overlay: boolean;
  /** An Agent Proof room: the Dot's actions and files from the owner's rooms stay out of it. */
  roomScoped?: boolean;
}) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const [computerOpen, setComputerOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  const computer = useVisibleRead<DotComputerState>(dot.dotId, visible, () => api.dotComputer(dot.dotId));
  const channels = useVisibleRead<ChannelsStatus>("channels", visible, () => api.channels(), 120_000);
  const activity = useVisibleRead<{ dotId: string; items: DotToolInvocation[] }>(roomScoped ? null : dot.dotId, visible, () => api.dotToolInvocations(dot.dotId));
  const outputs = useVisibleRead<{ dotId: string; items: DotDeliverable[] }>(roomScoped ? null : dot.dotId, visible, () => api.dotDeliverables(dot.dotId));
  const slack = channels.value?.providers.find((provider) => provider.provider === "SLACK");
  const slackIdentity = channels.value?.identities.find((identity) => identity.provider === "SLACK");
  const slackLinked = Boolean(slackIdentity);
  const computerStatus = computer.failed && !computer.value ? "Unavailable" : !computer.value ? "Checking…"
    : computer.value.runs.length ? "Working" : "Ready";
  // The Dot's running browser (in an Agent Proof room only its own room's): its latest picture, else the mascot.
  const browser = computer.value?.browsers.find((item) => item.ready && item.sessionId && (!roomScoped || item.roomId === roomId)) ?? null;
  const picture = useVisibleRead<string | null>(browser ? `${browser.paneId}|${browser.sessionId}` : null, visible,
    () => api.browserFrame(browser!.paneId, browser!.sessionId!).then((frame) => frame.screenshotDataUrl), PICTURE_REFRESH_MS);
  const browserPicture = browser ? picture.value : null;
  const recent = (activity.value?.items ?? []).filter((item) => item.dotId === dot.dotId && item.status === "COMPLETED" && item.risk !== "READ").slice(0, 3);
  const latestOutputs = useMemo(() => {
    const latest = new Map<string, DotDeliverable & { artifactId: string }>();
    for (const item of outputs.value?.items ?? []) {
      if (item.dotId !== dot.dotId || !item.artifactId) continue;
      const known = latest.get(item.name);
      if (!known || item.version > known.version) latest.set(item.name, item as DotDeliverable & { artifactId: string });
    }
    return [...latest.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [outputs.value, dot.dotId]);
  const shownOutputs = latestOutputs.slice(0, 3);
  // Show more lists every version of every file, including older versions of the ones shown here.
  const moreOutputs = (outputs.value?.items ?? []).filter((item) => item.dotId === dot.dotId).length > shownOutputs.length;
  return <aside className="dots-info-card" data-overlay={overlay ? "true" : "false"} aria-label={t("{name} details", { name: dot.name })}
    onKeyDown={(event) => { if (event.key === "Escape" && overlay) { event.stopPropagation(); onClose(); } }}>
    {overlay ? <button type="button" className="dots-icon-button dots-info-close" aria-label={t("Close details")} onClick={onClose}><X aria-hidden="true" /></button> : null}
    <div className="dots-info-identity">
      <DotAvatar character={dot.appearance.character} mood={working ? "working" : "idle"} size={52} motion={visible ? "on" : "off"} />
      <div><strong>{dot.name}</strong><span>{dotActiveLabel(lastActiveAt, working, now, t)}</span></div>
    </div>
    <p className="dots-info-personality"><strong>{dotPersonalities[dot.appearance.character].archetype}</strong>
      {dotPersonalities[dot.appearance.character].summary}</p>
    <div className="dots-info-actions">
      <button type="button" onClick={onCall} disabled={Boolean(callDisabledReason)} title={callDisabledReason ? t(callDisabledReason) : t("Call {name}", { name: dot.name })}><Phone aria-hidden="true" />{t("Call")}</button>
      {slack?.configured ? <button type="button" title={slackLinked ? t("Open Slack") : t("Link Slack in Settings → Dots")} onClick={() => {
        if (slackLinked) window.open(slackDirectUrl(slack.appUrl ?? null, slackIdentity?.tenantId ?? null), "_blank", "noopener,noreferrer");
        else openDotSettings({ dotId: dot.dotId, section: "channels" });
      }}><Slack aria-hidden="true" />Slack</button> : null}
    </div>
    <section aria-label={t("Computers")}>
      <h4>{t("Computers")}</h4>
      <button type="button" className="dots-info-computer" onClick={() => setComputerOpen(true)} aria-label={t("Your dot's computer, {status}", { status: t(computerStatus) })}>
        <Monitor aria-hidden="true" />
        <span><strong>{t("Your dot's computer")}</strong><small data-status={computerStatus.toLowerCase()}>{t(computerStatus)}</small></span>
        <img src={browserPicture ?? dotArtwork(dot)} alt="" width="40" height="28" className="dots-info-computer-thumb"
          data-source={browserPicture ? "browser" : "mascot"} title={browserPicture ? browser?.title ?? t("Browser") : undefined} />
      </button>
    </section>
    {roomScoped ? null : <><section aria-label={t("Recent activity")}>
      <h4>{t("Recent activity")}</h4>
      {activity.failed && !activity.value ? <p className="dots-info-empty">{t("Recent activity is unavailable.")}</p>
        : !recent.length ? <p className="dots-info-empty">{t("No recent activity")}</p>
        : <ul className="dots-info-list">{recent.map((item) => <li key={item.invocationId}>
          <span>{item.approvalSummary ?? toolTitles.get(item.toolId) ?? item.toolId}</span>
          <time dateTime={item.completedAt ?? item.startedAt}>{dotAgoLabel(item.completedAt ?? item.startedAt, now, t)}</time>
        </li>)}</ul>}
    </section>
    <section aria-label={t("Outputs")}>
      <h4>{t("Outputs")}</h4>
      {outputs.failed && !outputs.value ? <p className="dots-info-empty">{t("Outputs are unavailable.")}</p>
        : !latestOutputs.length ? <p className="dots-info-empty">{t("No outputs yet")}</p>
        : <ul className="dots-info-list">{shownOutputs.map((item) => <li key={item.name}>
          <a href={api.agentFileDownloadUrl(item.artifactId)} download title={t("{name} (version {version})", { name: item.name, version: item.version })}>
            <FileText aria-hidden="true" /><span>{item.name}</span></a>
        </li>)}</ul>}
      {moreOutputs ? <button type="button" className="dots-info-more" aria-haspopup="dialog" onClick={() => setOutputsOpen(true)}>
        <ChevronRight aria-hidden="true" />{t("Show more")}</button> : null}
    </section></>}
    {computerOpen ? <div className="attachment-modal codex-resume-modal" onClick={() => setComputerOpen(false)}>
      <section className="attachment-modal-body codex-resume-modal-body dots-computer-dialog" role="dialog" aria-modal="true" aria-label={t("{name}'s computer", { name: dot.name })}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setComputerOpen(false); } }}>
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label={t("Close computer")} onClick={() => setComputerOpen(false)}>
          <X aria-hidden="true" /></button>
        <DotComputer dot={dot} roomId={roomId} visible={visible} sessionId={sessionId} />
      </section>
    </div> : null}
    {outputsOpen && !roomScoped ? <div className="attachment-modal codex-resume-modal" onClick={() => setOutputsOpen(false)}>
      <section className="attachment-modal-body codex-resume-modal-body dots-outputs-dialog" role="dialog" aria-modal="true" aria-label={t("{name}'s outputs", { name: dot.name })}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOutputsOpen(false); } }}>
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label={t("Close outputs")} autoFocus onClick={() => setOutputsOpen(false)}>
          <X aria-hidden="true" /></button>
        <h3>{t("Outputs")}</h3>
        <p className="dots-panel-hint">{t("Every version {name} published to Agent Files.", { name: dot.name })}</p>
        <DotOutputVersions dot={dot} items={outputs.value?.items ?? []} />
      </section>
    </div> : null}
  </aside>;
}
