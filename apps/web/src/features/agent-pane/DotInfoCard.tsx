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

const REFRESH_MS = 30_000;
/** The computer's picture is a full browser frame: read at most once a minute while the card shows. */
const PICTURE_REFRESH_MS = 60_000;
const toolTitles = new Map(buildDotToolCatalog({ role: "USER", browserSessionsEnabled: true, browserPaneIds: [], mcpTools: [], installedMcpServers: [] })
  .map((tool) => [tool.id, tool.title]));

/** "Active now", "Active 5 minutes ago", "Active 1 hour ago", "Active 3 days ago". */
export function dotActiveLabel(lastActiveAt: string | null, working: boolean, now = Date.now()): string {
  if (working) return "Active now";
  if (!lastActiveAt) return "No activity yet";
  const minutes = Math.max(0, Math.floor((now - Date.parse(lastActiveAt)) / 60_000));
  if (minutes < 1) return "Active just now";
  if (minutes < 60) return `Active ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days} day${days === 1 ? "" : "s"} ago`;
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
  return <aside className="dots-info-card" data-overlay={overlay ? "true" : "false"} aria-label={`${dot.name} details`}
    onKeyDown={(event) => { if (event.key === "Escape" && overlay) { event.stopPropagation(); onClose(); } }}>
    {overlay ? <button type="button" className="dots-icon-button dots-info-close" aria-label="Close details" onClick={onClose}><X aria-hidden="true" /></button> : null}
    <div className="dots-info-identity">
      <DotAvatar character={dot.appearance.character} mood={working ? "working" : "idle"} size={52} motion={visible ? "on" : "off"} />
      <div><strong>{dot.name}</strong><span>{dotActiveLabel(lastActiveAt, working, now)}</span></div>
    </div>
    <p className="dots-info-personality"><strong>{dotPersonalities[dot.appearance.character].archetype}</strong>
      {dotPersonalities[dot.appearance.character].summary}</p>
    <div className="dots-info-actions">
      <button type="button" onClick={onCall} disabled={Boolean(callDisabledReason)} title={callDisabledReason ?? `Call ${dot.name}`}><Phone aria-hidden="true" />Call</button>
      {slack?.configured ? <button type="button" title={slackLinked ? "Open Slack" : "Link Slack in Settings → Dots"} onClick={() => {
        if (slackLinked) window.open(slackDirectUrl(slack.appUrl ?? null, slackIdentity?.tenantId ?? null), "_blank", "noopener,noreferrer");
        else openDotSettings({ dotId: dot.dotId, section: "channels" });
      }}><Slack aria-hidden="true" />Slack</button> : null}
    </div>
    <section aria-label="Computers">
      <h4>Computers</h4>
      <button type="button" className="dots-info-computer" onClick={() => setComputerOpen(true)} aria-label={`Your dot's computer, ${computerStatus}`}>
        <Monitor aria-hidden="true" />
        <span><strong>Your dot's computer</strong><small data-status={computerStatus.toLowerCase()}>{computerStatus}</small></span>
        <img src={browserPicture ?? dotArtwork(dot)} alt="" width="40" height="28" className="dots-info-computer-thumb"
          data-source={browserPicture ? "browser" : "mascot"} title={browserPicture ? browser?.title ?? "Browser" : undefined} />
      </button>
    </section>
    {roomScoped ? null : <><section aria-label="Recent activity">
      <h4>Recent activity</h4>
      {activity.failed && !activity.value ? <p className="dots-info-empty">Recent activity is unavailable.</p>
        : !recent.length ? <p className="dots-info-empty">No recent activity</p>
        : <ul className="dots-info-list">{recent.map((item) => <li key={item.invocationId}>
          <span>{item.approvalSummary ?? toolTitles.get(item.toolId) ?? item.toolId}</span>
          <time dateTime={item.completedAt ?? item.startedAt}>{dotActiveLabel(item.completedAt ?? item.startedAt, false, now).replace(/^Active /, "")}</time>
        </li>)}</ul>}
    </section>
    <section aria-label="Outputs">
      <h4>Outputs</h4>
      {outputs.failed && !outputs.value ? <p className="dots-info-empty">Outputs are unavailable.</p>
        : !latestOutputs.length ? <p className="dots-info-empty">No outputs yet</p>
        : <ul className="dots-info-list">{shownOutputs.map((item) => <li key={item.name}>
          <a href={api.agentFileDownloadUrl(item.artifactId)} download title={`${item.name} (version ${item.version})`}>
            <FileText aria-hidden="true" /><span>{item.name}</span></a>
        </li>)}</ul>}
      {moreOutputs ? <button type="button" className="dots-info-more" aria-haspopup="dialog" onClick={() => setOutputsOpen(true)}>
        <ChevronRight aria-hidden="true" />Show more</button> : null}
    </section></>}
    {computerOpen ? <div className="attachment-modal codex-resume-modal" onClick={() => setComputerOpen(false)}>
      <section className="attachment-modal-body codex-resume-modal-body dots-computer-dialog" role="dialog" aria-modal="true" aria-label={`${dot.name}'s computer`}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setComputerOpen(false); } }}>
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label="Close computer" onClick={() => setComputerOpen(false)}>
          <X aria-hidden="true" /></button>
        <DotComputer dot={dot} roomId={roomId} visible={visible} sessionId={sessionId} />
      </section>
    </div> : null}
    {outputsOpen && !roomScoped ? <div className="attachment-modal codex-resume-modal" onClick={() => setOutputsOpen(false)}>
      <section className="attachment-modal-body codex-resume-modal-body dots-outputs-dialog" role="dialog" aria-modal="true" aria-label={`${dot.name}'s outputs`}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOutputsOpen(false); } }}>
        <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label="Close outputs" autoFocus onClick={() => setOutputsOpen(false)}>
          <X aria-hidden="true" /></button>
        <h3>Outputs</h3>
        <p className="dots-panel-hint">Every version {dot.name} published to Agent Files.</p>
        <DotOutputVersions dot={dot} items={outputs.value?.items ?? []} />
      </section>
    </div> : null}
  </aside>;
}
