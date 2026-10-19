import { ArrowUp, Crosshair, PanelRight, X } from "../ui-theme/app-icons.js";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent } from "react";
import { projectDotFeedRow, type AgentPaneGoal, type AgentPaneSession, type Artifact, type CodexEnvironment, type CodexThreadResponse, type CollaborationMode,
  type DotFeedItem, type Pane, type PaneCliModelSettings, type PermissionMode, type DotProfile, type DotGoal } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchArtifactsUpdated } from "../../artifact-events.js";
import { SPACE_CLIPBOARD_ITEM_MIME, SPACE_CLIPBOARD_ITEM_TITLE_MIME, captureClipboardText, writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { SPACE_TASK_ITEM_MIME } from "../task-dock/task-events.js";
import { readArtifactDragPayload, resolveArtifactDragFile, type ArtifactDragPayload } from "../artifacts/artifact-drag.js";
import { SPACE_PANE_CONTEXT_MIME } from "../pane-drag/pane-drag.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import {
  readAgentPaneModelSelection,
  writeAgentPaneModelSelection,
  type AgentPaneModelSelection
} from "./agent-pane-model-selection.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";
import { clearAgentPaneDraft, readAgentPaneDraft, writeAgentPaneDraft, type AgentPaneDraftState } from "./agent-pane-draft.js";
import { readDotDraft, writeDotDraft, clearDotDraft } from "./dot-drafts.js";
import { useDotSession } from "./useDotSession.js";
import { DotHeader, dotStatus } from "./DotHeader.js";
import { useDotMood } from "./DotAvatar.js";
import { DotApprovals } from "./DotApprovals.js";
import { DotGoalDialog, DotGoalStrip } from "./DotGoals.js";
import { DotFeed } from "./DotFeed.js";
import { DotInfoCard } from "./DotInfoCard.js";
import { useDotFeed } from "./useDotFeed.js";
import { DOTS_UPDATED_EVENT, openDotSettings, requestDotCall } from "./dot-home-events.js";
import "./dots-chat.css";
import { readChatSubmission, writeChatSubmission, submissionWasRejected, type ChatSubmission } from "./chat-submission.js";
import { DEMO_LOCAL_REPLY } from "../../runtime/SpaceRuntime.js";
import type { VoiceComposerSettings } from "../../voice-settings.js";
import { useVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { CodexComposer } from "./CodexComposer.js";
import { codexThreadNotWrittenYet, codexThreadPending } from "./codex-thread-readiness.js";
import { TaskAcceptanceDialog } from "./TaskAcceptanceDialog.js";
import { captureLiveVisual } from "../live-pane/live-visual-capture.js";
import type { AgentPaneModelProvider } from "@space/contracts";
import { CodexNotification, copyableCodexTranscript, visibleChatMessages, visibleCodexThreadItems } from "./CodexTranscript.js";
import { useTranscriptScroll } from "./useTranscriptScroll.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import {
  AGENT_PANE_ACTION_EVENT,
  AGENT_PANE_ATTACHMENTS_EVENT,
  registerAgentPaneEventTarget
} from "./events.js";
import { takePendingThreadOpen } from "../terminal-pane/cli-resume-intent.js";
import { CLEAN_WORKTREE_PROMPT, PROMOTE_PROMPT } from "../osk-keyboard/cli-shortcuts.js";
import type { AgentPaneActionAvailability } from "./agent-action-availability.js";

const DOT_PANEL_KEY = "space.dotPane.panel.";
const WIDE_DOT_PANE = 880;
// Turns Space starts for the user (approvals, reminders, Goal steps, voice) arrive in the feed as events or tagged messages.
const serverStartedTurn = /^(?:Approved: |Declined: |Scheduled task “|Goal step \d+ of |\(Voice\) |[^\n]{1,80} reports on the task you delegated )/;
function readPanelPreference(paneId: string): boolean | null {
  try { const value = localStorage.getItem(`${DOT_PANEL_KEY}${paneId}`); return value === null ? null : value === "open"; } catch { return null; }
}

export { AGENT_PANE_ACTION_EVENT, AGENT_PANE_ATTACHMENTS_EVENT } from "./events.js";

export interface AgentPaneIdentity {
  sessionId: string | null;
  threadId: string | null;
}

interface AgentPaneProps {
  pane: Pane;
  codexEnvironment: Pick<CodexEnvironment, "isCodexEnabled"> | null;
  workspaceTextSize: number;
  isVisible?: boolean;
  onSessionIdentityChange?: (identity: AgentPaneIdentity | null) => void;
  onWorkingStateChange?: (workingState: { isWorking: boolean }) => void;
  /** Live state the pane actions menu needs to disable items that cannot run. */
  onActionAvailabilityChange?: (availability: AgentPaneActionAvailability) => void;
}

const runningStatuses: AgentPaneSession["runStatus"][] = ["QUEUED", "RUNNING", "INTERRUPTING"];
const AGENT_PANE_SETTINGS_EVENT = "space:agent-pane-settings-updated";
type AgentPaneModelProviderRef = Pick<AgentPaneModelProvider, "providerId" | "configIdPrefix" | "isCurrent" | "isInactive">;

type AgentPaneAction =
  | "upload"
  | "plan"
  | "toggle_plan"
  | "build"
  | "plan_progress"
  | "deploy"
  | "promote"
  | "clean_worktree"
  | "scroll_top"
  | "scroll_bottom"
  | "permissions"
  | "resume"
  | "copy"
  | "reconnect"
  | "interrupt"
  | "save_to_memory"
  | "new_task"
  | "attach_folder"
  | "manage_goal";
type AgentPaneActionDetail =
  | { paneId: string; action: AgentPaneAction }
  | { paneId: string; action: "insert_text"; text: string }
  | { paneId: string; action: "open_thread"; threadId: string };
type AgentModelOption = AgentPaneSession["modelOptions"][number];
type AgentPaneSessionWithModelCatalog = AgentPaneSession & { modelCatalog: PaneCliModelSettings["models"] };

function pickQuickMemorySaveModelConfigId(modelOptions: AgentModelOption[], selectedModelConfigId: string | null | undefined): string | null {
  const exact = modelOptions.find((model) => model.model === "gpt-5-mini" || model.id === "gpt-5-mini");
  if (exact) return exact.id;
  const providerMini = modelOptions.find((model) => /mini/i.test(model.model ?? "") || /mini/i.test(model.displayName ?? ""));
  if (providerMini) return providerMini.id;
  const genericMini = modelOptions.find((model) => /mini/i.test(model.id));
  return genericMini?.id ?? selectedModelConfigId ?? null;
}

function modelConfigProviderKey(modelConfigId: string | null | undefined): string {
  if (!modelConfigId) return "codex";
  if (modelConfigId.startsWith("opencode-v1|")) return "opencode";
  if (modelConfigId.startsWith("cli:")) return modelConfigId.split("-v1|")[0] ?? modelConfigId;
  return "codex";
}

function extractClipboardFiles(event: ClipboardEvent<HTMLElement>): File[] {
  const files = Array.from(event.clipboardData.files ?? []);
  const itemFiles = Array.from(event.clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const byKey = new Map<string, File>();
  const candidates = files.length ? files : itemFiles;
  for (const file of candidates) {
    byKey.set(`${file.name}:${file.size}:${file.type}`, file);
  }
  return Array.from(byKey.values());
}

function isAgentPaneAction(detail: unknown): detail is AgentPaneActionDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const maybeDetail = detail as { paneId?: unknown; action?: unknown };
  return (
    typeof maybeDetail.paneId === "string" &&
    ((maybeDetail.action === "insert_text" && typeof (maybeDetail as { text?: unknown }).text === "string") ||
      maybeDetail.action === "upload" ||
      maybeDetail.action === "plan" ||
      maybeDetail.action === "toggle_plan" ||
      maybeDetail.action === "build" ||
      maybeDetail.action === "plan_progress" ||
      maybeDetail.action === "deploy" ||
      maybeDetail.action === "promote" ||
      maybeDetail.action === "clean_worktree" ||
      maybeDetail.action === "scroll_top" ||
      maybeDetail.action === "scroll_bottom" ||
      maybeDetail.action === "permissions" ||
      maybeDetail.action === "resume" ||
      maybeDetail.action === "copy" ||
      maybeDetail.action === "reconnect" ||
      maybeDetail.action === "interrupt" ||
      maybeDetail.action === "save_to_memory" ||
      maybeDetail.action === "new_task" ||
      maybeDetail.action === "attach_folder" ||
      maybeDetail.action === "manage_goal" ||
      (maybeDetail.action === "open_thread" && typeof (maybeDetail as { threadId?: unknown }).threadId === "string"))
  );
}

function appendClipboardText(current: string, text: string): string {
  if (!current) return text;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${text}`;
}

function isAgentPaneAttachments(detail: unknown): detail is { paneId: string; artifacts: Artifact[] } {
  if (typeof detail !== "object" || detail === null) return false;
  const maybeDetail = detail as { paneId?: unknown; artifacts?: unknown };
  return typeof maybeDetail.paneId === "string" && Array.isArray(maybeDetail.artifacts);
}

function mergeArtifacts(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const byId = new Map<string, Artifact>();
  for (const artifact of [...current, ...incoming]) {
    byId.set(artifact.id, artifact);
  }
  return Array.from(byId.values()).slice(0, 8);
}

function sameFields(current: object, next: object): boolean {
  const currentKeys = Object.keys(current);
  if (currentKeys.length !== Object.keys(next).length) return false;
  return currentKeys.every((key) => (current as Record<string, unknown>)[key] === (next as Record<string, unknown>)[key]);
}

// A running chat re-reads its transcript every 2.5 s. Keep the current object when
// nothing changed so the transcript does not re-render. Items are compared field by
// field, so streamed content growth is still applied; checkedAt is only the read time.
export function sameCodexThread(current: CodexThreadResponse | null, next: CodexThreadResponse): boolean {
  if (!current || current.items.length !== next.items.length || !sameFields(current.thread, next.thread)) return false;
  return current.items.every((item, index) => sameFields(item, next.items[index]!));
}

function nextPromptWithTranscript(current: string, text: string, settings: VoiceComposerSettings): string {
  const transcript = text.trim();
  if (!transcript) return current;
  if (settings.insertMode === "replace") return transcript;
  const existing = current.trimEnd();
  return existing ? `${existing}\n${transcript}` : transcript;
}

function CodexGoalDialog({
  paneTitle,
  goal,
  pending,
  onClose,
  onSave,
  onClear
}: {
  paneTitle: string;
  goal: AgentPaneGoal | null;
  pending: boolean;
  onClose: () => void;
  onSave: (objective: string) => void;
  onClear: () => void;
}) {
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const trimmedObjective = objective.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending && trimmedObjective) onSave(trimmedObjective);
  }

  return (
    <div className="attachment-modal codex-resume-modal" onClick={() => { if (!pending) onClose(); }}>
      <section
        className="attachment-modal-body codex-resume-modal-body"
        role="dialog"
        aria-modal="true"
        aria-label={`Manage goal ${paneTitle}`}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="terminal-upload-modal-close codex-resume-modal-close"
          aria-label="Close goal editor"
          disabled={pending}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
        <div className="codex-resume-modal-header">
          <span className="terminal-upload-modal-label codex-resume-modal-label">
            <Crosshair aria-hidden="true" />
            Goal
          </span>
          <strong>Manage task goal</strong>
          <small>Keep Codex focused on a durable objective for {paneTitle}.</small>
        </div>
        <form className="codex-goal-editor" onSubmit={submit}>
          <label>
            <span>Goal objective</span>
            <textarea
              aria-label="Goal objective"
              autoFocus
              value={objective}
              disabled={pending}
              rows={4}
              onChange={(event) => setObjective(event.currentTarget.value)}
            />
          </label>
          <div>
            {goal ? (
              <button type="button" disabled={pending} onClick={onClear}>Clear goal</button>
            ) : null}
            <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
            <button type="submit" disabled={pending || !trimmedObjective}>Save goal</button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function AgentPane({
  pane,
  codexEnvironment,
  workspaceTextSize,
  isVisible = true,
  onSessionIdentityChange,
  onWorkingStateChange,
  onActionAvailabilityChange
}: AgentPaneProps) {
  const isCodexEnabled = codexEnvironment?.isCodexEnabled ?? true;
  const initialDraft = readAgentPaneDraft(pane.id);
  const [session, setSession] = useState<AgentPaneSession | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // Conversations read successfully at least once, so they are known to exist.
  const loadedThreadIdsRef = useRef(new Set<string>());
  const dotFlow = useDotSession();
  const [dots, setDots] = useState<DotProfile[]>([]);
  const dotsRef = useRef<DotProfile[]>([]);
  const dotsRequestRef = useRef<Promise<DotProfile[]> | null>(null);
  const [dotsError, setDotsError] = useState<string | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [dotGoal, setDotGoal] = useState<DotGoal | null>(null);
  const [goalRevision, setGoalRevision] = useState(0);
  const [panelPreference, setPanelPreference] = useState<boolean | null>(() => readPanelPreference(pane.id));
  const [wide, setWide] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const selectedDot = dots.find(dot => dot.dotId === session?.dotId) ?? null;
  const composerSnapshotRef = useRef<(() => string) | null>(null);
  const loadedDraftDotRef = useRef<string | null>(null);
  const assetOperationsRef = useRef(0);
  const voiceStartingRef = useRef(false);
  const [voiceStarting, setVoiceStarting] = useState(false);
  const pendingThreadOpenRef = useRef<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<CodexThreadResponse | null>(null);
  const [prompt, setPrompt] = useState(initialDraft.prompt);
  const [pending, setPendingState] = useState(false);
  const pendingRef = useRef(false);
  function setPending(value: boolean) { pendingRef.current = value; setPendingState(value); }
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [attachments, setAttachments] = useState<Artifact[]>(initialDraft.attachments);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedRunError, setDismissedRunError] = useState<string | null>(null);
  const retryInFlightRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const [unconfirmedSubmission, setUnconfirmedSubmission] = useState(() => readChatSubmission(pane.id));
  const unconfirmedSubmissionRef = useRef(unconfirmedSubmission);
  const voiceInput = useVoiceInput();
  const voiceOwnerId = `chat:${pane.id}`;
  const [homePinned, setHomePinned] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionsRef = useRef<HTMLElement | null>(null);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [acceptanceDialogOpen, setAcceptanceDialogOpen] = useState(false);
  const [acceptance, setAcceptance] = useState<import("@space/contracts").TaskAcceptance | undefined>(initialDraft.acceptance);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [composerRestoreKey, setComposerRestoreKey] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const turnStartedAtRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const visualCaptureRef = useRef<AbortController | null>(null);
  const lastSessionThreadIdRef = useRef<string | null>(null);
  const refreshModelCatalogRef = useRef<() => Promise<void>>(async () => {});

  // The stored selection is `<configIdPrefix><modelId>|<effort>`; the longest prefix that
  // matches owns it (model ids may themselves contain characters like ":").
  function providerForConfigId(next: AgentPaneSession, configId: string | null): AgentPaneModelProviderRef | null {
    if (!configId) return null;
    return (next.modelProviders ?? [])
      .filter((provider) => configId.startsWith(provider.configIdPrefix))
      .sort((left, right) => right.configIdPrefix.length - left.configIdPrefix.length)[0] ?? null;
  }

  function rememberModelSelection(next: AgentPaneSession): void {
    const configId = next.selectedModelConfigId;
    if (!configId) return;
    const provider = providerForConfigId(next, configId)
      ?? (next.modelProviders ?? []).find((candidate) => candidate.isCurrent)
      ?? null;
    const raw = provider && configId.startsWith(provider.configIdPrefix)
      ? configId.slice(provider.configIdPrefix.length)
      : configId;
    const separator = raw.lastIndexOf("|");
    const modelId = separator > 0 ? raw.slice(0, separator) : raw;
    const reasoningEffort = separator > 0 ? raw.slice(separator + 1) : "";
    if (!modelId || !reasoningEffort) return;
    writeAgentPaneModelSelection(pane.id, {
      modelId,
      reasoningEffort,
      providerId: provider?.providerId ?? null
    });
  }
  const isChatEnabled = session
    ? (session.modelProviders ?? []).length > 0 || (session.modelOptions ?? []).length > 0
    : true;
  const chatDisabledReason = "Enable a Chat provider in Settings";
  const trimmedPrompt = prompt.trim();
  const hasAttachments = attachments.length > 0;
  const canSend =
    isChatEnabled &&
    Boolean(session?.capabilities.canSend) &&
    !pending &&
    !loading && !uploading && !dotFlow.transitioning && !sessionUnavailable && (!session?.dotId || Boolean(selectedDot)) &&
    !unconfirmedSubmission &&
    (trimmedPrompt.length > 0 || hasAttachments);
  const isRunning = Boolean(session && (runningStatuses.includes(session.runStatus) || session.latestRun?.status === "QUEUED" || session.latestRun?.status === "RUNNING"));
  const voiceUnfinished = voiceStarting || (voiceInput.ownerId === voiceOwnerId && ["connecting", "recording", "transcribing"].includes(voiceInput.status));
  const switchBlocked = loading || pending || uploading || voiceUnfinished || isRunning || Boolean(session?.pendingRequest)
    || Boolean(unconfirmedSubmission) || dotFlow.transitioning || sessionUnavailable || Boolean(session?.goal?.status === "active");
  function blockedNow(): boolean {
    return switchBlocked || pendingRef.current || dotFlow.lockedRef.current || sendInFlightRef.current || assetOperationsRef.current > 0 || voiceStartingRef.current;
  }
  function contextToken() {
    return { generation: dotFlow.generationRef.current, sessionId: sessionRef.current?.binding.sessionId, dotId: sessionRef.current?.dotId };
  }
  function contextCurrent(token: ReturnType<typeof contextToken>, allowLocked = false): boolean {
    return dotFlow.isCurrent(token.generation) && (allowLocked || !dotFlow.lockedRef.current)
      && token.sessionId === sessionRef.current?.binding.sessionId && token.dotId === sessionRef.current?.dotId;
  }
  function currentDraft() { return { prompt: composerSnapshotRef.current?.() ?? prompt, attachments: attachments.slice(), acceptance }; }
  function saveDraft(draft: AgentPaneDraftState) {
    if (selectedDot) writeDotDraft(pane.id, selectedDot, draft);
    else if (!session?.dotId) writeAgentPaneDraft(pane.id, draft);
  }
  function clearDraftStorage() {
    if (selectedDot) clearDotDraft(pane.id, selectedDot);
    else if (!session?.dotId) clearAgentPaneDraft(pane.id);
  }
  async function loadDots(): Promise<DotProfile[]> {
    if (dotsRef.current.length === 6) return dotsRef.current;
    if (!dotsRequestRef.current) {
      dotsRequestRef.current = Promise.resolve().then(() => api.dots()).then(response => {
        const profiles = [...response.dots].sort((a, b) => a.slot - b.slot);
        if (profiles.length !== 6 || new Set(profiles.map(dot => dot.slot)).size !== 6) throw Error("Dots unavailable.");
        dotsRef.current = profiles;
        if (dotFlow.isCurrent(dotFlow.generationRef.current)) { setDots(profiles); setDotsError(null); }
        return profiles;
      }).catch(() => {
        if (dotFlow.isCurrent(dotFlow.generationRef.current)) setDotsError("Dots unavailable.");
        return [];
      }).finally(() => { dotsRequestRef.current = null; });
    }
    return dotsRequestRef.current;
  }
  function publishSession(next: AgentPaneSession, newTask = false) {
    if (next.binding.paneId !== pane.id) throw Error("Session pane identity mismatch.");
    const profile = dotsRef.current.find(dot => dot.dotId === next.dotId);
    if (next.dotId && !profile) throw Error("The active Dot is unavailable. Reconnect before sending.");
    const changed = next.binding.sessionId !== sessionRef.current?.binding.sessionId || next.dotId !== sessionRef.current?.dotId;
    if (profile && (loadedDraftDotRef.current !== profile.dotId || newTask)) {
      const draft = newTask ? { prompt: "", attachments: [], acceptance: undefined } : readDotDraft(pane.id, profile);
      loadedDraftDotRef.current = profile.dotId;
      setPrompt(draft.prompt); setAttachments(draft.attachments); setAcceptance(draft.acceptance);
      setComposerRestoreKey(value => value + 1);
      if (newTask) clearDotDraft(pane.id, profile);
    } else if (newTask) { setPrompt(""); setAttachments([]); setAcceptance(undefined); clearDraftStorage(); setComposerRestoreKey(value => value + 1); }
    sessionRef.current = next;
    setSession(next); setSessionUnavailable(false); rememberModelSelection(next);
    if (changed) { setActiveThreadId(null); setThread(null); setThreadLoading(false); setCodexError(null); setError(null); lastSessionThreadIdRef.current = null; setHomePinned(false); }
  }
  async function transitionSession(dot: DotProfile | null, sessionId?: string | null, newTask = false, selectedModelConfigId?: string) {
    const desiredDotId = dot?.dotId;
    let newTaskConfirmed = false;
    await dotFlow.transition({ blocked: blockedNow(), snapshot: currentDraft, save: saveDraft,
      resolve: async () => {
        let target = sessionId;
        if (target === undefined && dot) {
          const history = await api.dotCollection(dot.dotId, "sessions");
          if (history.dotId !== dot.dotId) throw Error("Dot session history identity mismatch.");
          target = history.items.find(item => item.dotId === dot.dotId && item.roomId === pane.roomId)?.sessionId ?? null;
        }
        const next = await api.createAgentSession(pane.id, { dotId: desiredDotId, sessionId: target ?? null,
          ...(target ? {} : { title: session?.binding.title ?? pane.title, threadId: null,
            selectedModelConfigId: selectedModelConfigId ?? session?.selectedModelConfigId ?? null, selectedToolIds: session?.selectedToolIds ?? [] }) });
        if (desiredDotId && next.dotId !== desiredDotId) throw Error("The server did not confirm the selected Dot.");
        newTaskConfirmed = newTask;
        return next;
      },
      reconcile: async () => { await loadDots(); return api.agentSession(pane.id); },
      publish: next => publishSession(next, newTaskConfirmed && (!desiredDotId || next.dotId === desiredDotId) && next.binding.sessionId !== session?.binding.sessionId)
    });
  }
  async function selectDot(dot: DotProfile) {
    if (dot.dotId === sessionRef.current?.dotId) return;
    await transitionSession(dot);
  }
  // The info card docks beside a wide pane and opens over a narrow one; the user's choice is remembered per pane.
  useEffect(() => {
    const node = shellRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWide((entries[0]?.contentRect.width ?? 0) >= WIDE_DOT_PANE));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const panelOpen = panelPreference ?? wide;
  function togglePanel() {
    const next = !panelOpen;
    setPanelPreference(next);
    try { localStorage.setItem(`${DOT_PANEL_KEY}${pane.id}`, next ? "open" : "closed"); } catch { /* the choice lasts for this view only */ }
  }
  useEffect(() => {
    onWorkingStateChange?.({ isWorking: isRunning });
  }, [isRunning, onWorkingStateChange]);
  // Space Dots Stage 8: one continuous feed per Dot across rooms. The current conversation's own
  // messages show at once; the feed (refreshed when a task changes) replaces them by id.
  const feed = useDotFeed({ dotId: selectedDot?.dotId ?? null, roomId: pane.roomId, visible: isVisible && !pane.isMinimized,
    refreshKey: `${session?.binding.sessionId ?? ""}:${session?.latestRun?.runId ?? ""}:${session?.latestRun?.status ?? ""}:${session?.messages.length ?? 0}` });
  const feedItems = useMemo<DotFeedItem[]>(() => {
    const known = new Set(feed.items.map((item) => item.id));
    const newest = feed.items.at(-1)?.createdAt ?? "";
    // Without a Dot (legacy Chat) the conversation is its Codex thread, as before Stage 8.
    const stored = selectedDot ? session?.messages ?? []
      : visibleChatMessages(thread?.items ?? [], session?.messages ?? []).map((item) => ({ ...item, status: "COMPLETED" as const }));
    const live = session && (!selectedDot || session.dotId === selectedDot.dotId) ? stored.flatMap((message) => {
      if (known.has(message.id) || (message.role === "user" && serverStartedTurn.test(message.content))) return [];
      const createdAt = message.createdAt ?? new Date().toISOString();
      if (feed.status === "ready" && createdAt < newest) return [];
      const item = projectDotFeedRow({ id: message.id, role: message.role ?? "assistant", content: message.content, status: message.status, createdAt,
        sessionId: session.binding.sessionId ?? null, roomId: pane.roomId, runId: null, clientRequestId: null, conversationStart: false });
      return item ? [item] : [];
    }) : [];
    return [...feed.items, ...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }, [feed.items, feed.status, session?.messages, session?.threadId, session?.binding.sessionId, session?.dotId, selectedDot?.dotId, pane.roomId, thread]);
  const dotHeaderStatus = dotStatus(session, sessionUnavailable || dotFlow.transitioning, dotGoal?.sessionId === session?.binding.sessionId ? dotGoal?.status : undefined);
  const dotMood = useDotMood(selectedDot?.appearance.character ?? null, selectedDot?.dotId ?? null, dotHeaderStatus, feedItems);
  const runProgress = useMemo(() => {
    // Without a Dot the thread itself is the conversation, so its replies already show as bubbles.
    if (!isRunning || !thread || !selectedDot) return null;
    const since = turnStartedAtRef.current ?? 0;
    const latest = visibleCodexThreadItems(thread.items).filter((item) => item.role === "assistant"
      && (!item.createdAt || Date.parse(item.createdAt) >= since)).at(-1);
    const text = latest?.content.replace(/\s+/g, " ").trim() ?? "";
    return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : null;
  }, [isRunning, thread, selectedDot]);
  const hasVisibleMessages = feedItems.length > 0 || visibleChatMessages(thread?.items ?? [], session?.messages ?? []).length > 0;
  const hasTranscriptContent = isRunning || hasVisibleMessages;
  const actionCanSend = session?.capabilities.canSend !== false;
  const actionCollaborationMode = session?.collaborationMode ?? null;
  useEffect(() => {
    onActionAvailabilityChange?.({
      chatEnabled: isChatEnabled,
      hasSession: Boolean(session),
      locked: dotFlow.transitioning,
      running: isRunning,
      blocked: switchBlocked,
      canSend: actionCanSend,
      hasContent: hasVisibleMessages,
      collaborationMode: actionCollaborationMode,
      pending,
      dotId: session?.dotId ?? null
    });
  }, [actionCanSend, actionCollaborationMode, dotFlow.transitioning, hasVisibleMessages, isChatEnabled, isRunning, onActionAvailabilityChange, pending, session, switchBlocked]);
  const { transcriptRef, followTranscriptRef, handleTranscriptScroll, showJumpToLatest, jumpToLatest } = useTranscriptScroll({
    conversationId: selectedDot?.dotId ?? activeThreadId ?? session?.threadId ?? null,
    hasContent: hasTranscriptContent,
    contentVersion: `${feedItems.length}:${feedItems.at(-1)?.id ?? ""}:${runProgress ?? ""}:${isRunning}`,
    isVisible
  });
  function handleFeedScroll() {
    handleTranscriptScroll();
    const element = transcriptRef.current;
    if (element && element.scrollTop < 80 && feed.nextBefore && !feed.loadingOlder) void feed.loadOlder();
  }
  useEffect(() => {
    if (!isVisible || pane.isMinimized) { setPermissionsOpen(false); visualCaptureRef.current?.abort(); }
  }, [isVisible, pane.isMinimized]);
  useEffect(() => () => visualCaptureRef.current?.abort(), []);

  useEffect(() => {
    if (!permissionsOpen || !isVisible || pane.isMinimized) return;
    const previous = document.activeElement;
    permissionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [permissionsOpen, isVisible, pane.isMinimized]);
  const runErrorMessage = session?.runStatus === "ERROR"
    ? session.statusReason || "The Chat run failed."
    : null;
  const runError = runErrorMessage && runErrorMessage !== dismissedRunError ? runErrorMessage : null;

  useEffect(() => {
    if (session?.runStatus !== "ERROR") setDismissedRunError(null);
  }, [session?.runStatus]);

  useAutoDismiss(notice, setNotice);
  useAutoDismiss(error, setError);
  useAutoDismiss(codexError, setCodexError);

  async function loadSession(showLoading = true) {
    if (dotFlow.lockedRef.current) return;
    const token = contextToken();
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const nextSession = await api.agentSession(pane.id);
      if (!contextCurrent(token)) return;
      await loadDots();
      if (!contextCurrent(token)) return;
      if (token.sessionId && (nextSession.binding.sessionId !== token.sessionId || nextSession.dotId !== token.dotId)) {
        setSessionUnavailable(true); setError("The active Dot session changed. Reconnect before sending."); return;
      }
      const remembered = readAgentPaneModelSelection(pane.id);
      // A Dot's model comes from Settings → Dots, never from this pane's earlier pick.
      if (remembered && !nextSession.selectedModelConfigId && !nextSession.dotId) {
        // The pane was closed and reopened: restore the model the operator had picked
        // instead of silently falling back to the provider default.
        const fallbackSession = await restoreRememberedModelSelection(remembered, nextSession);
        if (!contextCurrent(token)) return;
        publishSession(fallbackSession);
      } else {
        publishSession(nextSession);
      }
      recordLifecycleDebugEvent({
        type: "session_sync",
        scope: "AgentPane",
        detail: `showLoading=${String(showLoading)} runStatus=${nextSession.runStatus} thread=${nextSession.threadId ?? "none"}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    } catch (err) {
      if (!contextCurrent(token)) return;
      setSessionUnavailable(true);
      setError(err instanceof Error ? err.message : "Agent session failed to load");
    } finally {
      if (showLoading && dotFlow.isCurrent(token.generation)) setLoading(false);
    }
  }

  // The stored selection is provider-qualified (`${configIdPrefix}${modelId}|${effort}`),
  // so it can be re-applied directly and stays valid across pane sessions.
  function modelSelectionConfigId(selection: AgentPaneModelSelection, current: AgentPaneSession): string {
    const provider = (current.modelProviders ?? []).find((candidate) => candidate.providerId === selection.providerId)
      ?? (current.modelProviders ?? []).find((candidate) => candidate.isCurrent);
    if (!provider || provider.isInactive) return "";
    return `${provider.configIdPrefix}${selection.modelId}|${selection.reasoningEffort}`;
  }

  async function restoreRememberedModelSelection(
    selection: AgentPaneModelSelection,
    current: AgentPaneSession
  ): Promise<AgentPaneSession> {
    const configId = modelSelectionConfigId(selection, current);
    if (!configId || configId === current.selectedModelConfigId) return current;
    try {
      const updated = await api.updateAgentSettings(pane.id, { selectedModelConfigId: configId });
      return updated;
    } catch {
      // A stale remembered model must never block the pane: keep the server selection.
      return current;
    }
  }

  async function refreshModelCatalog() {
    if (dotFlow.lockedRef.current) return;
    const token = contextToken();
    const nextSession = await api.agentSession(pane.id);
    if (!contextCurrent(token) || nextSession.binding.sessionId !== token.sessionId || nextSession.dotId !== token.dotId) return;
    // Refresh only catalog fields so a read cannot overwrite concurrent run updates.
    setSession(current => current && current.binding.sessionId === session?.binding.sessionId
      && current.selectedModelConfigId === session?.selectedModelConfigId ? {
      ...current,
      modelCatalog: nextSession.modelCatalog,
      modelProviders: nextSession.modelProviders,
      modelOptions: nextSession.modelOptions
    } : current);
  }

  async function reconnectChat() {
    if (dotFlow.lockedRef.current) { await dotFlow.reconcile(async () => { await loadDots(); return api.agentSession(pane.id); }, publishSession); return; }
    if (!isChatEnabled || pending) return;
    if (sessionUnavailable) {
      await dotFlow.transition({ blocked: false, snapshot: currentDraft, save: saveDraft, resolve: () => api.agentSession(pane.id),
        reconcile: () => api.agentSession(pane.id), publish: publishSession });
      return;
    }
    await loadSession(false);
  }

  async function copyChat() {
    const text = selectedDot && feedItems.length
      ? feedItems.map((item) => `${item.author === "USER" ? "You" : selectedDot.name}:\n${item.kind === "EVENT" ? item.summary ?? item.content : item.content}`).join("\n\n")
      : copyableCodexTranscript(thread?.items ?? [], session?.messages ?? []);
    if (!text) {
      setNotice(null);
      setError("There are no visible Chat contents to copy.");
      return;
    }
    setNotice(null);
    try {
      const runtimeKind = await writeClipboardText(text);
      void captureClipboardText({ text, source: "COPY", roomId: pane.roomId, paneId: pane.id, paneTitle: pane.title });
      setError(null);
      setNotice(runtimeKind === "demo" ? DEMO_LOCAL_REPLY : "Chat contents copied.");
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : "Chat copy failed");
    }
  }

  async function openThread(threadId: string, bindToSession = true): Promise<boolean> {
    if (bindToSession) {
      if (blockedNow() || !session) return false;
      if (selectedDot) {
        // Hold the transition lock before the history read, snapshotting the
        // outgoing draft even for session restores through pane actions.
        return dotFlow.transition({ blocked: blockedNow(), snapshot: currentDraft, save: saveDraft,
          resolve: async () => {
            const history = await api.dotCollection(selectedDot.dotId, "sessions");
            const target = history.dotId === selectedDot.dotId ? history.items.find(item => item.dotId === selectedDot.dotId && item.roomId === pane.roomId && item.threadId === threadId) : null;
            if (!target?.sessionId) throw Error("This conversation does not belong to the selected Dot and room.");
            const next = await api.createAgentSession(pane.id, { dotId: selectedDot.dotId, sessionId: target.sessionId });
            if (next.dotId !== selectedDot.dotId) throw Error("Conversation Dot identity mismatch.");
            return next;
          }, reconcile: () => api.agentSession(pane.id), publish: publishSession });
      }
      // Old clients without Dots can only open their active conversation.
      if (threadId !== session.threadId) { setCodexError("This conversation does not belong to the selected Dot and room."); return false; }
    }
    const token = contextToken();
    if (dotFlow.lockedRef.current || threadId !== sessionRef.current?.threadId) return false;
    if (threadId !== activeThreadId) followTranscriptRef.current = true;
    setActiveThreadId(threadId); setHomePinned(false); setCodexError(null);
    // Nothing to read until Codex writes the new conversation; the running task's poll reads it then.
    const notWrittenYet = () => { setThread((current) => current?.thread.id === threadId ? current : null); return false; };
    if (codexThreadPending(sessionRef.current, threadId, loadedThreadIdsRef.current)) return notWrittenYet();
    setThreadLoading(true);
    try {
      const next = await api.codexThread(threadId, "chat");
      if (!contextCurrent(token) || threadId !== sessionRef.current?.threadId) return false;
      loadedThreadIdsRef.current.add(threadId);
      setThread((current) => sameCodexThread(current, next) ? current : next); return true;
    } catch (err) {
      if (!contextCurrent(token)) return false;
      if (codexThreadNotWrittenYet(err, sessionRef.current, threadId, loadedThreadIdsRef.current)) return notWrittenYet();
      setThread(null); setCodexError(err instanceof Error ? err.message : "Codex thread failed to load"); return false;
    } finally { if (contextCurrent(token)) setThreadLoading(false); }
  }

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "AgentPane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "AgentPane",
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    };
  }, [pane.id, pane.mode, pane.title]);

  useEffect(() => {
    if (!dotFlow.lockedRef.current) saveDraft({ prompt, attachments, acceptance });
  }, [attachments, pane.id, prompt, acceptance, selectedDot?.dotId]);

  useEffect(() => {
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    // Keep the latest catalog refresh (with its current session guard) reachable
    // from listeners that are installed once per pane.
    refreshModelCatalogRef.current = refreshModelCatalog;
  });

  // A Dot renamed or reconfigured in Settings → Dots shows here without reopening the pane.
  // A hidden or minimized pane only notes the change and reads the Dots again when it is shown.
  const dotsStaleRef = useRef(false);
  const shownRef = useRef(isVisible && !pane.isMinimized);
  shownRef.current = isVisible && !pane.isMinimized;
  function refreshDots() {
    dotsStaleRef.current = false;
    dotsRef.current = [];
    void loadDots().then(() => { if (!dotFlow.lockedRef.current) void loadSession(false); });
  }
  useEffect(() => {
    const changed = () => { if (shownRef.current) refreshDots(); else dotsStaleRef.current = true; };
    window.addEventListener(DOTS_UPDATED_EVENT, changed);
    return () => window.removeEventListener(DOTS_UPDATED_EVENT, changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);
  useEffect(() => {
    if (isVisible && !pane.isMinimized && dotsStaleRef.current) refreshDots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, pane.isMinimized]);

  useEffect(() => {
    const handleCliRuntimeVisibility = (event: Event) => {
      // A CLI toggled in Settings changes which providers this Chat pane may
      // offer: refresh the catalog so a disabled provider drops out of the model
      // picker and a re-enabled one comes back without reopening the pane.
      if (!readCliRuntimeVisibilityChange(event)) return;
      void refreshModelCatalogRef.current().catch(() => undefined);
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliRuntimeVisibility);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleCliRuntimeVisibility);
  }, [pane.id]);

  useEffect(() => {
    onSessionIdentityChange?.(session ? {
      sessionId: session.binding.sessionId ?? null,
      threadId: session.threadId ?? null
    } : null);
  }, [onSessionIdentityChange, session?.binding.sessionId, session?.threadId]);

  useEffect(() => () => onSessionIdentityChange?.(null), [onSessionIdentityChange, pane.id]);

  useEffect(() => {
    const pendingThreadId = takePendingThreadOpen(pane.id);
    if (!pendingThreadId) return;
    recordLifecycleDebugEvent({
      type: "agent_pane_thread_intent_consumed",
      scope: "AgentPane",
      detail: `pending thread open ${pendingThreadId}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    pendingThreadOpenRef.current = pendingThreadId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (!session || loading || !pendingThreadOpenRef.current) return;
    const threadId = pendingThreadOpenRef.current; pendingThreadOpenRef.current = null;
    void openThread(threadId);
  }, [session?.binding.sessionId, loading]);

  useEffect(() => {
    if (isChatEnabled) return;
    setGoalDialogOpen(false);
    setDragActive(false);
    voiceInput.cancel(voiceOwnerId);
  }, [isChatEnabled, voiceInput.cancel, voiceOwnerId]);

  useEffect(() => {
    if (session?.capabilities.canSend === false) voiceInput.cancel(voiceOwnerId);
  }, [session?.capabilities.canSend, voiceInput.cancel, voiceOwnerId]);

  useEffect(() => {
    if (!isVisible || pane.isMinimized) voiceInput.cancel(voiceOwnerId);
  }, [isVisible, pane.isMinimized, voiceInput.cancel, voiceOwnerId]);

  useEffect(() => () => voiceInput.cancel(voiceOwnerId), [voiceInput.cancel, voiceOwnerId]);

  useEffect(() => {
    const handleSettingsUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; session?: AgentPaneSession }>).detail;
      if (typeof detail?.paneId === "string" && detail.paneId !== pane.id) return;
      if (detail.session) {
        if (dotFlow.lockedRef.current || detail.session.binding.sessionId !== sessionRef.current?.binding.sessionId || detail.session.dotId !== sessionRef.current?.dotId) return;
        setSession(detail.session);
        return;
      }
      void loadSession(false);
    };
    window.addEventListener(AGENT_PANE_SETTINGS_EVENT, handleSettingsUpdate);
    return () => window.removeEventListener(AGENT_PANE_SETTINGS_EVENT, handleSettingsUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (!session || !runningStatuses.includes(session.runStatus)) return;
    // Schedule each poll only after the previous one settled, so slow reads never overlap.
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      // A conversation Codex has not written yet is read only after the session shows that its first turn started.
      const sessionFirst = Boolean(activeThreadId && codexThreadPending(sessionRef.current, activeThreadId, loadedThreadIdsRef.current));
      if (sessionFirst) await Promise.allSettled([loadSession(false)]);
      await Promise.allSettled([sessionFirst ? null : loadSession(false), activeThreadId ? openThread(activeThreadId, false) : null]);
      if (!cancelled) timer = window.setTimeout(poll, 2500);
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, session?.runStatus, activeThreadId]);

  // The last poll can read the session as finished and the thread just before its final message;
  // a finished task therefore reloads its thread once more.
  const previousRunStatusRef = useRef(session?.runStatus);
  useEffect(() => {
    const previous = previousRunStatusRef.current;
    previousRunStatusRef.current = session?.runStatus;
    if (previous && runningStatuses.includes(previous) && session && !runningStatuses.includes(session.runStatus) && activeThreadId) {
      void openThread(activeThreadId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.runStatus, activeThreadId]);

  useEffect(() => {
    const nextThreadId = session?.threadId ?? null;
    if (lastSessionThreadIdRef.current === nextThreadId) return;
    lastSessionThreadIdRef.current = nextThreadId;
    if (!nextThreadId) {
      setActiveThreadId(null);
      setThread(null);
      return;
    }
    if (homePinned) return;
    void openThread(nextThreadId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.threadId, homePinned]);

  useEffect(() => {
    if (!isRunning) {
      turnStartedAtRef.current = null;
      setElapsedSeconds(0);
      return;
    }
    if (turnStartedAtRef.current === null) {
      const lastUserItem = [...(thread?.items ?? [])]
        .reverse()
        .find((item) => item.kind === "message" && item.role === "user");
      const baseTime = lastUserItem?.createdAt ? new Date(lastUserItem.createdAt).getTime() : Date.now();
      turnStartedAtRef.current = Number.isNaN(baseTime) ? Date.now() : baseTime;
    }
  }, [isRunning, thread?.items]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      if (turnStartedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - turnStartedAtRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  async function updateCollaborationMode(collaborationMode: CollaborationMode) {
    if (!isChatEnabled || !session || blockedNow() || !isVisible) return;
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateAgentSettings(pane.id, { collaborationMode });
      if (updated.collaborationMode !== collaborationMode) throw new Error("The provider did not confirm the selected Plan mode.");
      setSession(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent settings update failed");
    } finally {
      setPending(false);
    }
  }

  async function updatePermissions(permissionMode: PermissionMode) {
    if (!session || blockedNow() || !isVisible || pane.isMinimized) return;
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateAgentSettings(pane.id, { permissionMode });
      if (updated.permissionState.effectiveMode !== permissionMode) throw new Error("The provider did not confirm the selected permissions.");
      setSession(updated);
      setPermissionsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Permissions update failed.");
    } finally { setPending(false); }
  }

  async function updateModelConfig(selectedModelConfigId: string): Promise<string | null> {
    if (blockedNow()) throw new Error("Finish or stop the current action before switching Dots.");
    if (!isChatEnabled) {
      throw new Error(chatDisabledReason);
    }
    if (!session?.capabilities.canSelectModel) {
      throw new Error("Model selection is unavailable for this Chat session.");
    }
    const providerChanged = modelConfigProviderKey(session.selectedModelConfigId) !== modelConfigProviderKey(selectedModelConfigId);
    const hasConversation = Boolean(session.threadId || session.messages.some((message) => message.content.trim().length > 0));
    if (providerChanged && hasConversation) {
      // The transition owns its lock before any await. Do not set pending first:
      // blockedNow would then reject our own transition.
      setError(null);
      await transitionSession(selectedDot, null, false, selectedModelConfigId);
      const updated = sessionRef.current;
      if (dotFlow.lockedRef.current || updated?.selectedModelConfigId !== selectedModelConfigId) {
        throw new Error("Model selection is unconfirmed. Reconnect before sending.");
      }
      setNotice(`Started a new ${updated.binding.selectedProviderName ?? "Codex"} Chat task.`);
      return updated.selectedModelConfigId;
    }
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateAgentSettings(pane.id, { selectedModelConfigId });
      setSession(updated);
      rememberModelSelection(updated);
      return updated.selectedModelConfigId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent model update failed";
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setPending(false);
    }
  }

  async function saveGoal(objective: string) {
    if (!isChatEnabled || dotFlow.lockedRef.current || pending || uploading) return;
    setPending(true);
    setError(null);
    try {
      setSession(await api.updateAgentGoal(pane.id, objective));
      setGoalDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal update failed");
    } finally {
      setPending(false);
    }
  }

  async function clearGoal() {
    if (!isChatEnabled || dotFlow.lockedRef.current || pending || uploading) return;
    setPending(true);
    setError(null);
    try {
      setSession(await api.clearAgentGoal(pane.id));
      setGoalDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Goal clear failed");
    } finally {
      setPending(false);
    }
  }

  function rememberSubmission(submission: ChatSubmission | null) {
    unconfirmedSubmissionRef.current = submission;
    setUnconfirmedSubmission(submission);
    return writeChatSubmission(pane.id, submission);
  }

  async function sendSubmission(submission: ChatSubmission, promptToRestore: string, clearDraft: boolean): Promise<boolean> {
    if (sendInFlightRef.current || dotFlow.lockedRef.current || sessionUnavailable) return false;
    const recovering = unconfirmedSubmissionRef.current !== null;
    sendInFlightRef.current = true;
    setPending(true);
    setHomePinned(false);
    setError(null);
    followTranscriptRef.current = true;
    if (!rememberSubmission(submission)) {
      unconfirmedSubmissionRef.current = null;
      setUnconfirmedSubmission(null);
      setError("This browser could not save the request for recovery. Enable session storage before sending.");
      sendInFlightRef.current = false;
      setPending(false);
      return false;
    }
    if (clearDraft) {
      setPrompt("");
      setAttachments([]);
      clearDraftStorage();
    }
    try {
      const requestArgs = [pane.id, submission.content, submission.selectedModelConfigId, submission.selectedToolIds,
        submission.attachments.map(artifact => artifact.id), submission.clientRequestId, submission.acceptance] as const;
      const nextSession = submission.sessionId || submission.dotId
        ? await api.sendAgentMessage(...requestArgs, { sessionId: submission.sessionId, dotId: submission.dotId })
        : await api.sendAgentMessage(...requestArgs);
      if ((submission.dotId && nextSession.dotId !== submission.dotId) || (submission.sessionId && nextSession.binding.sessionId !== submission.sessionId)) throw Error("Submission Dot identity mismatch.");
      const matchesCurrent = (!submission.dotId || submission.dotId === sessionRef.current?.dotId)
        && (!submission.sessionId || submission.sessionId === sessionRef.current?.binding.sessionId);
      // Submission succeeded even if the subsequent transcript read fails.
      rememberSubmission(null);
      if (clearDraft) setAcceptance(undefined);
      if (matchesCurrent) { sessionRef.current = nextSession; setSession(nextSession); }
      else {
        // Recovery can confirm an old receipt after another client selected a
        // different active session. Confirm acceptance without adopting an
        // inactive receipt session as the next send target.
        setSessionUnavailable(true);
        publishSession(await api.agentSession(pane.id));
      }
      if (!clearDraft) {
        // A confirmed request is no longer a draft, whichever conversation is active now.
        composerSnapshotRef.current?.();
        if (JSON.stringify(acceptance) === JSON.stringify(submission.acceptance)) setAcceptance(undefined);
        setPrompt(current => current.trim() === submission.content.trim() ? "" : current);
        setAttachments(current => current.length === submission.attachments.length &&
          current.every((artifact, index) => artifact.id === submission.attachments[index]?.id) ? [] : current);
        const submittedDot = submission.dotId ? dotsRef.current.find(dot => dot.dotId === submission.dotId) : undefined;
        if (submittedDot && readDotDraft(pane.id, submittedDot).prompt.trim() === submission.content.trim()) clearDotDraft(pane.id, submittedDot);
      }
      if (clearDraft) clearDraftStorage();
      const threadId = sessionRef.current?.threadId;
      if (threadId) void openThread(threadId, false);
      return true;
    } catch (err) {
      // A later 401/429/409 does not disprove acceptance of the original
      // request whose acknowledgement was lost. Never discard its identity.
      if (!recovering && submissionWasRejected(err)) rememberSubmission(null);
      if (clearDraft) {
        setPrompt(promptToRestore);
        setComposerRestoreKey(current => current + 1);
        setAttachments(submission.attachments);
        saveDraft({ prompt: promptToRestore, attachments: submission.attachments, acceptance: submission.acceptance });
      }
      setError(err instanceof Error ? err.message : "Request confirmation failed");
      return false;
    } finally {
      sendInFlightRef.current = false;
      setPending(false);
    }
  }

  async function checkSubmission() {
    const submission = unconfirmedSubmissionRef.current;
    if (!submission || pending || sendInFlightRef.current) return;
    // This reuses the frozen request, including model/tools/files. The server
    // returns the accepted run before considering new runtime work.
    await sendSubmission(submission, submission.content, false);
  }

  async function submitMessage(content: string, promptToRestore = prompt): Promise<boolean> {
    if (!isChatEnabled || dotFlow.lockedRef.current || sessionUnavailable || uploading || assetOperationsRef.current > 0 || (!session?.dotId ? false : !selectedDot) || (!content && attachments.length === 0) || pending || sendInFlightRef.current ||
        unconfirmedSubmissionRef.current || session?.capabilities.canSend === false) return false;
    return sendSubmission({ ...(session?.dotId ? { dotId: session.dotId, sessionId: session.binding.sessionId ?? undefined } : {}), clientRequestId: crypto.randomUUID(), content,
      selectedModelConfigId: session?.selectedModelConfigId ?? null, selectedToolIds: session?.selectedToolIds ?? [],
      attachments: attachments.slice(), ...(acceptance ? { acceptance } : {}) }, promptToRestore, true);
  }

  async function submitQuickMessage(content: string, options: { selectedModelConfigId?: string | null } = {}) {
    if (!isChatEnabled || blockedNow() || !content.trim() || pending || sendInFlightRef.current || unconfirmedSubmissionRef.current ||
        session?.capabilities.canSend === false) return;
    setPending(true);
    setError(null);
    try {
      let selection = session;
      if (options.selectedModelConfigId && options.selectedModelConfigId !== selection?.selectedModelConfigId) {
        selection = await api.updateAgentSettings(pane.id, { selectedModelConfigId: options.selectedModelConfigId });
        setSession(selection);
      }
      await sendSubmission({ ...(selection?.dotId ? { dotId: selection.dotId, sessionId: selection.binding.sessionId ?? undefined } : {}), clientRequestId: crypto.randomUUID(), content: content.trim(),
        selectedModelConfigId: selection?.selectedModelConfigId ?? null, selectedToolIds: selection?.selectedToolIds ?? [],
        attachments: [] }, content, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent quick action failed");
    } finally { setPending(false); }
  }

  async function startNewTask() {
    if (!isChatEnabled || blockedNow()) return;
    await transitionSession(selectedDot, null, true);
  }

  async function uploadFiles(files: File[], source: "USER_UPLOAD" | "CLIPBOARD" | "DROP") {
    if (!isChatEnabled || !files.length || dotFlow.lockedRef.current) return;
    const token = contextToken();
    assetOperationsRef.current += 1;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.uploadPaneFiles({ roomId: pane.roomId, paneId: pane.id, source, files });
      if (!contextCurrent(token)) return;
      dispatchArtifactsUpdated(pane.roomId, uploaded.artifacts);
      setAttachments((current) => mergeArtifacts(current, uploaded.artifacts));
    } catch (err) {
      if (contextCurrent(token)) setError(err instanceof Error ? err.message : "Agent file import failed");
    } finally {
      assetOperationsRef.current = Math.max(0, assetOperationsRef.current - 1);
      if (dotFlow.isCurrent(token.generation)) { setUploading(assetOperationsRef.current > 0); setDragActive(false); }
    }
  }

  async function attachVisualContext(source: "screen" | "camera") {
    if (!isChatEnabled || uploading || pending || dotFlow.lockedRef.current || !isVisible || pane.isMinimized) return;
    const token = contextToken();
    const controller = new AbortController();
    visualCaptureRef.current?.abort();
    visualCaptureRef.current = controller;
    assetOperationsRef.current += 1; setUploading(true);
    try {
      const captured = await captureLiveVisual(source, controller.signal);
      if (controller.signal.aborted || !contextCurrent(token)) return;
      const bytes = Uint8Array.from(atob(captured.dataUrl.split(",", 2)[1] ?? ""), (character) => character.charCodeAt(0));
      const file = new File([bytes], captured.filename, { type: "image/jpeg" });
      await uploadFiles([file], "USER_UPLOAD");
      if (!contextCurrent(token)) return;
      setNotice(`${source === "screen" ? "Screen" : "Camera"} image attached. Review it before sending.`);
    } catch (err) {
      if (contextCurrent(token) && !controller.signal.aborted && !(err instanceof DOMException && ["AbortError", "NotAllowedError"].includes(err.name))) {
        setError(err instanceof Error ? err.message : "Visual capture failed");
      }
    } finally {
      if (visualCaptureRef.current === controller) visualCaptureRef.current = null;
      assetOperationsRef.current = Math.max(0, assetOperationsRef.current - 1);
      if (dotFlow.isCurrent(token.generation)) setUploading(assetOperationsRef.current > 0);
    }
  }

  function clearAttachments() {
    setAttachments([]);
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    if (!isChatEnabled || dotFlow.lockedRef.current) return;
    const files = extractClipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFiles(files, "CLIPBOARD");
  }

  async function dropArtifactFile(payload: ArtifactDragPayload) {
    if (dotFlow.lockedRef.current) return;
    const token = contextToken();
    assetOperationsRef.current += 1; setUploading(true);
    try {
      const file = await resolveArtifactDragFile(payload);
      if (!contextCurrent(token)) return;
      await uploadFiles([file], "DROP");
    } catch (err) {
      setDragActive(false);
      if (contextCurrent(token)) setError(err instanceof Error ? err.message : "Agent file drop failed");
    } finally {
      assetOperationsRef.current = Math.max(0, assetOperationsRef.current - 1);
      if (dotFlow.isCurrent(token.generation)) setUploading(assetOperationsRef.current > 0);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!isChatEnabled || dotFlow.lockedRef.current) {
      setDragActive(false);
      return;
    }
    if (event.dataTransfer?.types.includes(SPACE_PANE_CONTEXT_MIME)) {
      setDragActive(false);
      return;
    }
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      event.preventDefault();
      event.stopPropagation();
      void uploadFiles(files, "DROP");
      return;
    }
    const artifactPayload = readArtifactDragPayload(event.dataTransfer ?? null);
    if (artifactPayload) {
      event.preventDefault();
      event.stopPropagation();
      void dropArtifactFile(artifactPayload);
      return;
    }
    const clipboardItemId = event.dataTransfer?.getData(SPACE_CLIPBOARD_ITEM_MIME) ?? "";
    const clipboardTitle = event.dataTransfer?.getData(SPACE_CLIPBOARD_ITEM_TITLE_MIME) ?? "";
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (clipboardItemId && text) {
      event.preventDefault();
      event.stopPropagation();
      setPrompt((current) => appendClipboardText(current, clipboardTitle ? `# ${clipboardTitle}\n\n${text}` : text));
      setDragActive(false);
      return;
    }
    const taskItemId = event.dataTransfer?.getData(SPACE_TASK_ITEM_MIME) ?? "";
    if (taskItemId && text) {
      event.preventDefault();
      event.stopPropagation();
      setPrompt((current) => appendClipboardText(current, text));
      setDragActive(false);
      return;
    }
    setDragActive(false);
  }

  useEffect(() => {
    function handleAgentPaneAction(event: Event) {
      if (!(event instanceof CustomEvent) || !isAgentPaneAction(event.detail) || event.detail.paneId !== pane.id) return;
      if (dotFlow.lockedRef.current && !["copy", "reconnect"].includes(event.detail.action)) return;
      if (!isChatEnabled && event.detail.action !== "copy") return;
      if (event.detail.action === "upload") {
        fileInputRef.current?.click();
        return;
      }
      if (event.detail.action === "attach_folder") {
        folderInputRef.current?.click();
        return;
      }
      if (event.detail.action === "new_task") {
        void startNewTask();
        return;
      }
      if (event.detail.action === "manage_goal") {
        setGoalDialogOpen(true);
        return;
      }
      if (event.detail.action === "open_thread") {
        void openThread(event.detail.threadId);
        return;
      }
      if (event.detail.action === "interrupt") {
        void interrupt();
        return;
      }
      if (event.detail.action === "permissions") {
        if (!isVisible || pane.isMinimized) return;
        // A Dot's permissions are set in Settings → Dots.
        if (session?.dotId) { openDotSettings({ dotId: session.dotId, section: "profile" }); return; }
        setPermissionsOpen(true);
        return;
      }
      if (event.detail.action === "build") {
        void updateCollaborationMode("default");
        return;
      }
      if (event.detail.action === "scroll_top") {
        if (transcriptRef.current) transcriptRef.current.scrollTop = 0;
        return;
      }
      if (event.detail.action === "scroll_bottom") {
        if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
        return;
      }
      if (event.detail.action === "plan_progress" || event.detail.action === "deploy" || event.detail.action === "promote" || event.detail.action === "clean_worktree") {
        if (!isVisible || pane.isMinimized) return;
        void submitQuickMessage(
          event.detail.action === "plan_progress"
            ? "Plan completion percentage"
            : event.detail.action === "deploy"
              ? "Deploy the project to Gitea and GitHub."
              : event.detail.action === "promote"
                ? PROMOTE_PROMPT
                : CLEAN_WORKTREE_PROMPT
        );
        return;
      }
      if (event.detail.action === "toggle_plan") {
        if (!pending && !isRunning) void updateCollaborationMode(session?.collaborationMode === "plan" ? "default" : "plan");
        return;
      }
      if (event.detail.action === "plan") {
        void updateCollaborationMode("plan");
        return;
      }
      if (event.detail.action === "resume") {
        void submitQuickMessage("resume");
        return;
      }
      if (event.detail.action === "copy") {
        void copyChat();
        return;
      }
      if (event.detail.action === "reconnect") {
        void reconnectChat();
        return;
      }
      if (event.detail.action === "insert_text") {
        setPrompt((current) => appendClipboardText(current, event.detail.text));
        return;
      }
      void submitQuickMessage("save to memory", {
        selectedModelConfigId: pickQuickMemorySaveModelConfigId(session?.modelOptions ?? [], session?.selectedModelConfigId ?? null)
      });
    }
    function handleAgentPaneAttachments(event: Event) {
      if (!(event instanceof CustomEvent) || !isAgentPaneAttachments(event.detail) || event.detail.paneId !== pane.id) return;
      if (!isChatEnabled || dotFlow.lockedRef.current) return;
      setAttachments((current) => mergeArtifacts(current, event.detail.artifacts.filter((artifact: Artifact) => artifact.roomId === pane.roomId)));
    }
    window.addEventListener(AGENT_PANE_ACTION_EVENT, handleAgentPaneAction);
    window.addEventListener(AGENT_PANE_ATTACHMENTS_EVENT, handleAgentPaneAttachments);
    const unregisterTarget = registerAgentPaneEventTarget(pane.id);
    return () => {
      unregisterTarget();
      window.removeEventListener(AGENT_PANE_ACTION_EVENT, handleAgentPaneAction);
      window.removeEventListener(AGENT_PANE_ATTACHMENTS_EVENT, handleAgentPaneAttachments);
    };
  }, [activeThreadId, isChatEnabled, isRunning, isVisible, pane.id, pane.title, pane.isMinimized, pending, session, thread]);

  function toggleVoiceCapture() {
    if (!isChatEnabled || dotFlow.lockedRef.current) return;
    if (voiceInput.ownerId === voiceOwnerId && voiceInput.status === "recording") {
      voiceInput.stop(voiceOwnerId);
      return;
    }
    if (blockedNow()) return;
    const token = contextToken();
    voiceStartingRef.current = true; setVoiceStarting(true);
    const basePrompt = composerSnapshotRef.current?.() ?? prompt;
    const settings = voiceInput.settings;
    void voiceInput.start({
      id: voiceOwnerId,
      onTranscriptDelta: (text) => { if (contextCurrent(token)) setPrompt(nextPromptWithTranscript(basePrompt, text, settings)); },
      onTranscriptComplete: async (text) => {
        if (!contextCurrent(token)) return;
        const nextPrompt = nextPromptWithTranscript(basePrompt, text, settings);
        setPrompt(nextPrompt);
        if (!nextPrompt.trim()) return;
        if (!(await submitMessage(nextPrompt.trim(), nextPrompt))) {
          throw new Error("Voice transcript could not be submitted.");
        }
      }
    }).catch(err => { if (contextCurrent(token)) setError(err instanceof Error ? err.message : "Voice input unavailable."); }).finally(() => { voiceStartingRef.current = false; if (dotFlow.isCurrent(token.generation)) setVoiceStarting(false); });
  }

  async function interrupt() {
    if (!isChatEnabled || pending || !session?.capabilities.canInterrupt) return;
    setPending(true);
    setError(null);
    try {
      setSession(await api.interruptAgent(pane.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent interrupt failed");
    } finally {
      setPending(false);
    }
  }

  const voiceOwned = voiceInput.ownerId === voiceOwnerId;
  const voiceDisabled =
    !isChatEnabled ||
    !voiceInput.settings.enabled ||
    !voiceInput.serverSettings?.enabled ||
    voiceInput.settingsLoading ||
    Boolean(voiceInput.ownerId && !voiceOwned) ||
    (voiceOwned && (voiceInput.status === "connecting" || voiceInput.status === "transcribing")) ||
    pending || dotFlow.transitioning || uploading || sessionUnavailable ||
    session?.capabilities.canSend === false;
  const voiceStatusText =
    !voiceOwned
      ? null
      : voiceInput.status === "connecting"
      ? "Connecting"
      : voiceInput.status === "recording"
        ? voiceInput.preview || "Listening"
        : voiceInput.status === "transcribing"
          ? voiceInput.preview || "Transcribing"
          : voiceInput.error;

  async function retryLatestError() {
    if (unconfirmedSubmissionRef.current) { await checkSubmission(); return; }
    if (retryInFlightRef.current || pending || isRunning || dotFlow.lockedRef.current || uploading || voiceUnfinished) return;
    const freshPrompt = composerSnapshotRef.current?.() ?? prompt;
    if (freshPrompt.trim() || attachments.length) {
      setNotice("Your draft is still here. Review it before sending; no task was started.");
      setComposerFocusRequest(current => current + 1);
      return;
    }
    if (session?.capabilities.canSend === false) {
      setNotice("Another attempt is unavailable while this Chat pane is not accepting new messages.");
      return;
    }
    retryInFlightRef.current = true;
    setPending(true);
    setError(null);
    try {
      const original = await api.prepareAgentRetry(pane.id);
      setPrompt(original.content);
      setComposerRestoreKey(current => current + 1);
      setAttachments(original.artifacts);
      setAcceptance(original.acceptance);
      saveDraft({ prompt: original.content, attachments: original.artifacts, acceptance: original.acceptance });
      setComposerFocusRequest(current => current + 1);
      setCodexError(null);
      setDismissedRunError(runError);
      setNotice("Original request and files restored. Review them before sending a new attempt; earlier actions may already have completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The original request could not be restored.");
    } finally {
      retryInFlightRef.current = false;
      setPending(false);
    }
  }
  return (
    <section
      className={dragActive ? "coder-agent-pane vscode-codex-pane drag-active" : "coder-agent-pane vscode-codex-pane"}
      aria-label={`Native agent ${pane.title}`}
      data-agent-pane-id={pane.id}
      data-codex-enabled={isCodexEnabled ? "true" : "false"}
      data-chat-enabled={isChatEnabled ? "true" : "false"}
      data-workspace-text-size={workspaceTextSize}
      data-room-agent-visible={isVisible && !pane.isMinimized ? "true" : "false"}
      style={{ "--codex-workspace-text-size": `${workspaceTextSize}px` } as CSSProperties}
      onPasteCapture={isChatEnabled ? handlePaste : undefined}
      onDrop={isChatEnabled ? handleDrop : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        const isSameRoomPaneDrag = event.dataTransfer.types.includes(SPACE_PANE_CONTEXT_MIME);
        if (isChatEnabled && !isSameRoomPaneDrag) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
    >
      <input
        ref={fileInputRef}
        type="file"
        name={`agent-files-${pane.id}`}
        multiple
        accept="*/*"
        hidden
        disabled={!isChatEnabled}
        onChange={(event) => {
          const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
          event.currentTarget.value = "";
          if (files.length) void uploadFiles(files, "USER_UPLOAD");
        }}
      />
      <input
        ref={(node) => {
          folderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        name={`agent-folders-${pane.id}`}
        multiple
        hidden
        disabled={!isChatEnabled}
        onChange={(event) => {
          const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
          event.currentTarget.value = "";
          if (files.length) void uploadFiles(files, "USER_UPLOAD");
        }}
      />
      <div ref={shellRef} className="codex-chat-shell dots-chat-shell" data-panel={panelOpen ? (wide ? "docked" : "overlay") : "closed"}>
        <div className="dots-home-main">
        <DotHeader dots={dots} selected={selectedDot} status={dotHeaderStatus} mood={dotMood} blocked={switchBlocked}
          motionActive={isVisible && !pane.isMinimized} onSelect={dot => void selectDot(dot)} onManage={() => openDotSettings({ dotId: selectedDot?.dotId })}
          onNewConversation={() => void startNewTask()} newConversationDisabled={switchBlocked || !isChatEnabled}
          onCall={() => { if (selectedDot) requestDotCall({ roomId: pane.roomId, dotId: selectedDot.dotId, dotName: selectedDot.name, slot: selectedDot.slot }); }}
          callDisabledReason={selectedDot ? null : "Choose a Dot first."} panelOpen={panelOpen} onTogglePanel={togglePanel} unread={feed.unread}
          actions={[
            { label: "Dot settings", onSelect: () => openDotSettings({ dotId: selectedDot?.dotId }) },
            { label: "Set a goal", onSelect: () => setGoalDialogOpen(true), disabled: !isChatEnabled || !session },
            { label: "Copy conversation", onSelect: () => void copyChat() },
            ...(dotFlow.transitionError || sessionUnavailable ? [{ label: "Reconnect", onSelect: () => void reconnectChat() }] : [])
          ]} />
        {dotsError ? <p className="dots-switch-hint" role="status">{dotsError} <button type="button" onClick={() => void loadDots()}>Retry</button></p> : null}
        {dotFlow.transitionError ? <p className="dots-switch-hint" role="status">{dotFlow.transitionError}</p> : null}
        {dotFlow.transitionError || sessionUnavailable ? <p className="dots-switch-hint"><button type="button" onClick={() => void reconnectChat()}>Reconnect</button></p> : null}
        <div className="dots-chat-content">
        {session?.collaborationMode === "plan" ? (
          <button
            type="button"
            className="codex-plan-mode-indicator"
            aria-label={`Disable Plan mode ${pane.title}`}
            aria-pressed="true"
            title="Plan mode is active. Click to return to Default mode."
            disabled={pending || !isChatEnabled}
            onClick={() => void updateCollaborationMode("default")}
          >
            <PanelRight aria-hidden="true" />
            <span>Plan mode on</span>
          </button>
        ) : null}
        <div className="chat-transcript-region">
          <div ref={transcriptRef} className="codex-transcript-scroll dots-feed-scroll" onScroll={handleFeedScroll} data-thread-loading={threadLoading ? "true" : "false"}>
            <DotFeed dot={{ name: selectedDot?.name ?? "Dots", character: selectedDot?.appearance.character ?? "astronaut" }} mood={dotMood}
              motion={isVisible && !pane.isMinimized}
              items={feedItems} status={selectedDot ? feed.status : loading ? "loading" : "ready"}
              hasOlder={Boolean(feed.nextBefore)} loadingOlder={feed.loadingOlder} onLoadOlder={() => void feed.loadOlder()} onRetry={() => void feed.refresh()}
              running={isRunning ? { status: session?.runStatus ?? "RUNNING", elapsedSeconds, progress: runProgress } : null}
              latestRun={session?.latestRun ?? null} />
          </div>
        {showJumpToLatest ? <button type="button" className="chat-jump-latest" onClick={jumpToLatest}><ArrowUp aria-hidden="true" />Jump to latest</button> : null}
        </div>
        <DotGoalStrip dot={selectedDot} sessionId={session?.dotId && session.dotId === selectedDot?.dotId ? session.binding.sessionId ?? null : null}
          refreshKey={`${session?.latestRun?.runId ?? ""}:${session?.latestRun?.status ?? ""}:${session?.runStatus ?? ""}:${goalRevision}`}
          visible={isVisible && !pane.isMinimized} onChanged={setDotGoal} />
        <DotApprovals dot={selectedDot} sessionId={session?.dotId && session.dotId === selectedDot?.dotId ? session.binding.sessionId ?? null : null}
          pending={session?.pendingRequest?.kind === "APPROVAL"} onDecided={() => void loadSession(false)} />
        <div className="codex-notification-stack">
          {session?.binding.status === "BLOCKED" ? (
            <CodexNotification tone="warning" message={session.statusReason} />
          ) : null}
          {unconfirmedSubmission ? <CodexNotification tone={pending ? "info" : "warning"}
            title={pending ? "Confirming request" : "Check submission"}
            message={pending ? "Confirming your request…" : "Request confirmation is missing. Check the saved request before sending anything else. This uses the same submission and does not start a second task."}
            onRetry={checkSubmission} retryLabel="Check submission" retryDisabled={pending} /> : null}
          {notice ? <CodexNotification tone="info" message={notice} onDismiss={() => setNotice(null)} /> : null}
          {!unconfirmedSubmission && (error || codexError || runError) ? (
            <CodexNotification
              tone="error"
              message={error ?? codexError ?? runError ?? "Codex error"}
              onRetry={unconfirmedSubmission ? undefined : retryLatestError}
              retryLabel="Review request"
              retryDisabled={pending}
              onDismiss={() => {
                if (error) setError(null);
                if (codexError) setCodexError(null);
                if (runError) setDismissedRunError(runError);
              }}
            />
          ) : null}
          {uploading || dragActive ? (
            <CodexNotification
              tone="info"
              message={uploading ? "Importing files for the next turn" : "Drop files or screenshots to attach"}
            />
          ) : null}
          {voiceStatusText ? (
            <CodexNotification tone={voiceInput.error ? "error" : "info"} message={voiceStatusText} onDismiss={voiceInput.error ? () => voiceInput.clearError(voiceOwnerId) : undefined} />
          ) : null}
        </div>
        <CodexComposer
          variant={session?.dotId ? "dot" : "full"}
          snapshotRef={composerSnapshotRef}
          paneTitle={pane.title}
          isVisible={isVisible}
          disabledReason={session?.dotId && !selectedDot ? "Dot identity unavailable. Reconnect before sending." : dotFlow.transitioning ? "Confirm the selected session before sending" : sessionUnavailable ? "Session status unavailable. Reconnect before sending." : uploading ? "Finish importing files before sending" : unconfirmedSubmission ? "Check the unconfirmed submission first" : isChatEnabled ? null : chatDisabledReason}
          prompt={prompt}
          focusRequestKey={composerFocusRequest}
          restorePromptKey={composerRestoreKey}
          onPromptChange={setPrompt}
          attachments={attachments}
          onRemoveAttachment={(artifactId) => setAttachments((current) => current.filter((artifact) => artifact.id !== artifactId))}
          onClearAttachments={clearAttachments}
          onVoice={toggleVoiceCapture}
          onAddFiles={() => fileInputRef.current?.click()}
          onSetGoal={() => setGoalDialogOpen(true)}
          onVisualContext={(source) => void attachVisualContext(source)}
          onVoicePrewarm={voiceInput.prewarm}
          voiceActive={voiceOwned && voiceInput.status === "recording"}
          voiceDisabled={voiceDisabled}
          isRunning={isRunning}
          canSend={canSend}
          canInterrupt={Boolean(session?.capabilities.canInterrupt)}
          pending={pending || loading || dotFlow.transitioning}
          onSend={(message) => void submitMessage(message ?? trimmedPrompt, message ?? prompt)}
          onStop={() => void interrupt()}
          modelCatalog={(session as AgentPaneSessionWithModelCatalog | null)?.modelCatalog ?? []}
          modelOptions={session?.modelOptions ?? []}
          modelProviders={session?.modelProviders ?? []}
          selectedModelConfigId={session?.selectedModelConfigId ?? null}
          canSelectModel={!session?.dotId && Boolean(session?.capabilities.canSelectModel)}
          onRefreshModelCatalog={refreshModelCatalog}
          onModelConfigChange={updateModelConfig}
        />
        </div>
        </div>
        {panelOpen && selectedDot ? <DotInfoCard dot={selectedDot} roomId={pane.roomId} visible={isVisible && !pane.isMinimized} working={isRunning}
          lastActiveAt={feed.lastActiveAt} roomScoped={feed.scope === "ROOM"} sessionId={session?.dotId === selectedDot.dotId ? session.binding.sessionId ?? null : null}
          onCall={() => requestDotCall({ roomId: pane.roomId, dotId: selectedDot.dotId, dotName: selectedDot.name, slot: selectedDot.slot })} callDisabledReason={null}
          overlay={!wide} onClose={togglePanel} /> : null}
      </div>
      {permissionsOpen && isVisible && !pane.isMinimized ? (
        <div className="attachment-modal codex-resume-modal" onClick={() => setPermissionsOpen(false)} onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); setPermissionsOpen(false); }
          if (event.key === "Tab") {
            const buttons = permissionsRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
            if (!buttons?.length) return;
            const first = buttons[0]!;
            const last = buttons[buttons.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
          <section ref={permissionsRef} className="attachment-modal-body codex-resume-modal-body" role="dialog" aria-modal="true" aria-label="Chat permissions" onClick={event => event.stopPropagation()}>
            <button className="terminal-upload-modal-close codex-resume-modal-close" type="button" aria-label="Close permissions" onClick={() => setPermissionsOpen(false)}><X aria-hidden="true" /></button>
            <div className="codex-resume-modal-header"><strong>Permissions</strong><small>Choose permissions for the next Chat turn.</small></div>
            <p>{session?.permissionState.statusReason ?? "Loading permissions…"}</p>
            {session?.permissionOptions.map(option => (
              <div key={option.mode}>
              <button type="button" key={option.mode} data-permission-mode={option.mode} disabled={pending || isRunning || !option.isAvailable}
                aria-pressed={session.permissionState.effectiveMode === option.mode}
                title={option.statusReason ?? option.description} onClick={() => void updatePermissions(option.mode)}>
                {option.label}{session.permissionState.effectiveMode === option.mode ? " ✓" : ""}
              </button>
              <p>{option.statusReason ?? option.description}</p>
              </div>
            ))}
            {error ? <p role="alert">{error}</p> : null}
          </section>
        </div>
      ) : null}
      {/* A native Codex goal already on this thread stays manageable with its own editor. */}
      {goalDialogOpen && selectedDot && session?.dotId === selectedDot.dotId && session.binding.sessionId && !session.goal ? (
        <DotGoalDialog dot={selectedDot} sessionId={session.binding.sessionId} onClose={() => setGoalDialogOpen(false)}
          onCreated={(goal) => { setGoalDialogOpen(false); setDotGoal(goal); setGoalRevision((value) => value + 1); void loadSession(false); }} />
      ) : goalDialogOpen ? (
        <CodexGoalDialog
          paneTitle={pane.title}
          goal={session?.goal ?? null}
          pending={pending}
          onClose={() => setGoalDialogOpen(false)}
          onSave={(objective) => void saveGoal(objective)}
          onClear={() => void clearGoal()}
        />
      ) : null}
      {acceptanceDialogOpen && <TaskAcceptanceDialog current={acceptance}
        onClose={() => { setAcceptanceDialogOpen(false); setComposerFocusRequest(value => value + 1); }}
        onSave={value => { setAcceptance(value); setAcceptanceDialogOpen(false);
          setComposerFocusRequest(current => current + 1);
          setNotice(value ? "Result check saved for your next message." : "Result check removed."); }} />}
    </section>
  );
}
