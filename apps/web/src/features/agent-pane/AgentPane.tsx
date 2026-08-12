import { Crosshair, PanelRight, X } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type UIEvent } from "react";
import type { AgentPaneGoal, AgentPaneSession, Artifact, CodexEnvironment, CodexThreadResponse, CollaborationMode, Pane, PaneCliModelSettings } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchArtifactsUpdated } from "../../artifact-events.js";
import { SPACE_CLIPBOARD_ITEM_MIME, SPACE_CLIPBOARD_ITEM_TITLE_MIME, captureClipboardText, writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { SPACE_TASK_ITEM_MIME } from "../task-dock/task-events.js";
import { readArtifactDragPayload, resolveArtifactDragFile, type ArtifactDragPayload } from "../artifacts/artifact-drag.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { clearAgentPaneDraft, readAgentPaneDraft, writeAgentPaneDraft } from "./agent-pane-draft.js";
import { DEMO_LOCAL_REPLY } from "../../runtime/SpaceRuntime.js";
import type { VoiceComposerSettings } from "../../voice-settings.js";
import { useVoiceInput } from "../voice-input/VoiceInputProvider.js";
import { CodexComposer } from "./CodexComposer.js";
import { CodexNotification, CodexTranscript, copyableCodexTranscript } from "./CodexTranscript.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import {
  AGENT_PANE_ACTION_EVENT,
  AGENT_PANE_ATTACHMENTS_EVENT,
  registerAgentPaneEventTarget
} from "./events.js";
import { takePendingThreadOpen } from "../terminal-pane/cli-resume-intent.js";

export { AGENT_PANE_ACTION_EVENT, AGENT_PANE_ATTACHMENTS_EVENT } from "./events.js";

export interface AgentPaneIdentity {
  sessionId: string | null;
  threadId: string | null;
}

interface AgentPaneProps {
  pane: Pane;
  codexEnvironment: CodexEnvironment | null;
  workspaceTextSize: number;
  isVisible?: boolean;
  onSessionIdentityChange?: (identity: AgentPaneIdentity | null) => void;
}

const runningStatuses: AgentPaneSession["runStatus"][] = ["QUEUED", "RUNNING", "INTERRUPTING"];
const AGENT_PANE_SETTINGS_EVENT = "space:agent-pane-settings-updated";
type AgentPaneAction =
  | "upload"
  | "plan"
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
  onSessionIdentityChange
}: AgentPaneProps) {
  const isCodexEnabled = codexEnvironment?.isCodexEnabled ?? true;
  const codexDisabledReason = "Enable Codex in Settings";
  const initialDraft = readAgentPaneDraft(pane.id);
  const [session, setSession] = useState<AgentPaneSession | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<CodexThreadResponse | null>(null);
  const [prompt, setPrompt] = useState(initialDraft.prompt);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [attachments, setAttachments] = useState<Artifact[]>(initialDraft.attachments);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const voiceInput = useVoiceInput();
  const voiceOwnerId = `chat:${pane.id}`;
  const [homePinned, setHomePinned] = useState(false);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const turnStartedAtRef = useRef<number | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const lastSessionThreadIdRef = useRef<string | null>(null);
  const followTranscriptRef = useRef(true);
  const trimmedPrompt = prompt.trim();
  const hasAttachments = attachments.length > 0;
  const canSend =
    isCodexEnabled &&
    Boolean(session?.capabilities.canSend) &&
    !pending &&
    (trimmedPrompt.length > 0 || hasAttachments);
  const isRunning = Boolean(session && runningStatuses.includes(session.runStatus));
  const runError = session?.runStatus === "ERROR"
    ? session.statusReason || "The Chat run failed."
    : null;

  useAutoDismiss(notice, setNotice);
  useAutoDismiss(error, setError);
  useAutoDismiss(codexError, setCodexError);

  async function loadSession(showLoading = true) {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const nextSession = await api.agentSession(pane.id);
      setSession(nextSession);
      recordLifecycleDebugEvent({
        type: "session_sync",
        scope: "AgentPane",
        detail: `showLoading=${String(showLoading)} runStatus=${nextSession.runStatus} thread=${nextSession.threadId ?? "none"}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent session failed to load");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function reconnectChat() {
    if (!isCodexEnabled || pending) return;
    setError(null);
    setNotice(null);
    try {
      const nextSession = await api.agentSession(pane.id);
      setSession(nextSession);
      const threadId = nextSession.threadId ?? activeThreadId;
      if (threadId && !(await openThread(threadId, false))) return;
      setNotice("Chat reconnected.");
    } catch (err) {
      setNotice(null);
      setError(err instanceof Error ? err.message : "Chat reconnect failed");
    }
  }

  async function copyChat() {
    const text = copyableCodexTranscript(thread?.items ?? []);
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
    followTranscriptRef.current = true;
    setActiveThreadId(threadId);
    setHomePinned(false);
    setThreadLoading(true);
    setCodexError(null);
    try {
      if (bindToSession && isCodexEnabled && session && !isRunning && session.threadId !== threadId) {
        setPending(true);
        try {
          setSession(
            await api.createAgentSession(pane.id, {
              title: session.binding.title,
              sessionId: session.binding.sessionId ?? undefined,
              threadId,
              selectedModelConfigId: session.selectedModelConfigId ?? null,
              selectedToolIds: session.selectedToolIds ?? []
            })
          );
        } finally {
          setPending(false);
        }
      }
      setThread(await api.codexThread(threadId, "chat"));
      return true;
    } catch (err) {
      setThread(null);
      setCodexError(err instanceof Error ? err.message : "Codex thread failed to load");
      return false;
    } finally {
      setThreadLoading(false);
    }
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
    writeAgentPaneDraft(pane.id, { prompt, attachments });
  }, [attachments, pane.id, prompt]);

  useEffect(() => {
    void loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    void openThread(pendingThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (isCodexEnabled) return;
    setGoalDialogOpen(false);
    setDragActive(false);
    voiceInput.cancel(voiceOwnerId);
  }, [isCodexEnabled, voiceInput.cancel, voiceOwnerId]);

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
    const interval = window.setInterval(() => {
      void loadSession(false);
      if (activeThreadId) void openThread(activeThreadId, false);
    }, 2500);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, session?.runStatus, activeThreadId]);

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

  useEffect(() => {
    if (transcriptRef.current && followTranscriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [thread?.items.length, threadLoading, session?.runStatus]);

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    followTranscriptRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  async function updateCollaborationMode(collaborationMode: CollaborationMode) {
    if (!isCodexEnabled || !session) return;
    setPending(true);
    setError(null);
    try {
      setSession(await api.updateAgentSettings(pane.id, { collaborationMode }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent settings update failed");
    } finally {
      setPending(false);
    }
  }

  async function updateModelConfig(selectedModelConfigId: string): Promise<string | null> {
    if (!isCodexEnabled) {
      throw new Error(codexDisabledReason);
    }
    if (!session?.capabilities.canSelectModel) {
      throw new Error("Model selection is unavailable for this Chat session.");
    }
    setPending(true);
    setError(null);
    try {
      const updated = await api.updateAgentSettings(pane.id, { selectedModelConfigId });
      setSession(updated);
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
    if (!isCodexEnabled) return;
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
    if (!isCodexEnabled) return;
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

  async function submitMessage(content: string, promptToRestore = prompt): Promise<boolean> {
    const attachmentsToSend = attachments.slice();
    if (
      !isCodexEnabled ||
      (!content && attachmentsToSend.length === 0) ||
      pending ||
      session?.capabilities.canSend === false
    ) return false;
    followTranscriptRef.current = true;
    setPending(true);
    setHomePinned(false);
    setError(null);
    setPrompt("");
    if (attachmentsToSend.length) setAttachments([]);
    clearAgentPaneDraft(pane.id);
    try {
      const nextSession = await api.sendAgentMessage(
        pane.id,
        content,
        session?.selectedModelConfigId ?? null,
        session?.selectedToolIds ?? [],
        attachmentsToSend.map((artifact) => artifact.id)
      );
      setSession(nextSession);
      setPrompt("");
      clearAgentPaneDraft(pane.id);
      if (nextSession.threadId) {
        await openThread(nextSession.threadId, false);
      } else if (activeThreadId) {
        await openThread(activeThreadId, false);
      }
      return true;
    } catch (err) {
      setPrompt(promptToRestore);
      if (attachmentsToSend.length) setAttachments(attachmentsToSend);
      writeAgentPaneDraft(pane.id, { prompt: promptToRestore, attachments: attachmentsToSend });
      setError(err instanceof Error ? err.message : "Agent message failed");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function submitQuickMessage(content: string, options: { selectedModelConfigId?: string | null } = {}) {
    if (!isCodexEnabled || !content.trim() || pending || session?.capabilities.canSend === false) return;
    setPending(true);
    setHomePinned(false);
    setError(null);
    try {
      let nextSelectedModelConfigId = session?.selectedModelConfigId ?? null;
      let nextSelectedToolIds = session?.selectedToolIds ?? [];
      if (options.selectedModelConfigId && options.selectedModelConfigId !== nextSelectedModelConfigId) {
        const updatedSession = await api.updateAgentSettings(pane.id, {
          selectedModelConfigId: options.selectedModelConfigId
        });
        setSession(updatedSession);
        nextSelectedModelConfigId = updatedSession.selectedModelConfigId ?? options.selectedModelConfigId;
        nextSelectedToolIds = updatedSession.selectedToolIds ?? nextSelectedToolIds;
      }
      const nextSession = await api.sendAgentMessage(
        pane.id,
        content.trim(),
        nextSelectedModelConfigId,
        nextSelectedToolIds,
        []
      );
      setSession(nextSession);
      if (nextSession.threadId) {
        await openThread(nextSession.threadId, false);
      } else if (activeThreadId) {
        await openThread(activeThreadId, false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent quick action failed");
    } finally {
      setPending(false);
    }
  }

  async function startNewTask() {
    if (!isCodexEnabled || pending || isRunning) return;
    setPending(true);
    setError(null);
    try {
      const nextSession = await api.createAgentSession(pane.id, {
        title: session?.binding.title ?? pane.title,
        sessionId: null,
        threadId: null,
        selectedModelConfigId: session?.selectedModelConfigId ?? null,
        selectedToolIds: session?.selectedToolIds ?? []
      });
      setSession(nextSession);
      setActiveThreadId(null);
      setThread(null);
      setHomePinned(true);
      setPrompt("");
      setAttachments([]);
      clearAgentPaneDraft(pane.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "New Codex task failed");
    } finally {
      setPending(false);
    }
  }

  async function uploadFiles(files: File[], source: "USER_UPLOAD" | "CLIPBOARD" | "DROP") {
    if (!isCodexEnabled || !files.length) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.uploadPaneFiles({ roomId: pane.roomId, paneId: pane.id, source, files });
      dispatchArtifactsUpdated(pane.roomId, uploaded.artifacts);
      setAttachments((current) => mergeArtifacts(current, uploaded.artifacts));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent file import failed");
    } finally {
      setUploading(false);
      setDragActive(false);
    }
  }

  function clearAttachments() {
    setAttachments([]);
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    if (!isCodexEnabled) return;
    const files = extractClipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFiles(files, "CLIPBOARD");
  }

  async function dropArtifactFile(payload: ArtifactDragPayload) {
    try {
      const file = await resolveArtifactDragFile(payload);
      await uploadFiles([file], "DROP");
    } catch (err) {
      setDragActive(false);
      setError(err instanceof Error ? err.message : "Agent file drop failed");
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!isCodexEnabled) {
      setDragActive(false);
      return;
    }
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length) {
      void uploadFiles(files, "DROP");
      return;
    }
    const artifactPayload = readArtifactDragPayload(event.dataTransfer ?? null);
    if (artifactPayload) {
      void dropArtifactFile(artifactPayload);
      return;
    }
    const clipboardItemId = event.dataTransfer?.getData(SPACE_CLIPBOARD_ITEM_MIME) ?? "";
    const clipboardTitle = event.dataTransfer?.getData(SPACE_CLIPBOARD_ITEM_TITLE_MIME) ?? "";
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (clipboardItemId && text) setPrompt((current) => appendClipboardText(current, clipboardTitle ? `# ${clipboardTitle}\n\n${text}` : text));
    const taskItemId = event.dataTransfer?.getData(SPACE_TASK_ITEM_MIME) ?? "";
    if (taskItemId && text) setPrompt((current) => appendClipboardText(current, text));
    setDragActive(false);
  }

  useEffect(() => {
    function handleAgentPaneAction(event: Event) {
      if (!(event instanceof CustomEvent) || !isAgentPaneAction(event.detail) || event.detail.paneId !== pane.id) return;
      if (!isCodexEnabled && event.detail.action !== "copy") return;
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
      if (!isCodexEnabled) return;
      setAttachments((current) => mergeArtifacts(current, event.detail.artifacts));
    }
    window.addEventListener(AGENT_PANE_ACTION_EVENT, handleAgentPaneAction);
    window.addEventListener(AGENT_PANE_ATTACHMENTS_EVENT, handleAgentPaneAttachments);
    const unregisterTarget = registerAgentPaneEventTarget(pane.id);
    return () => {
      unregisterTarget();
      window.removeEventListener(AGENT_PANE_ACTION_EVENT, handleAgentPaneAction);
      window.removeEventListener(AGENT_PANE_ATTACHMENTS_EVENT, handleAgentPaneAttachments);
    };
  }, [activeThreadId, isCodexEnabled, isRunning, pane.id, pane.title, pending, session, thread]);

  function toggleVoiceCapture() {
    if (!isCodexEnabled) return;
    if (voiceInput.ownerId === voiceOwnerId && voiceInput.status === "recording") {
      voiceInput.stop(voiceOwnerId);
      return;
    }
    const basePrompt = prompt;
    const settings = voiceInput.settings;
    void voiceInput.start({
      id: voiceOwnerId,
      onTranscriptDelta: (text) => setPrompt(nextPromptWithTranscript(basePrompt, text, settings)),
      onTranscriptComplete: async (text) => {
        const nextPrompt = nextPromptWithTranscript(basePrompt, text, settings);
        setPrompt(nextPrompt);
        if (!nextPrompt.trim()) return;
        if (!(await submitMessage(nextPrompt.trim(), nextPrompt))) {
          throw new Error("Voice transcript could not be submitted.");
        }
      }
    });
  }

  async function interrupt() {
    if (!isCodexEnabled || pending || !session?.capabilities.canInterrupt) return;
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
    !isCodexEnabled ||
    !voiceInput.settings.enabled ||
    !voiceInput.serverSettings?.enabled ||
    voiceInput.settingsLoading ||
    Boolean(voiceInput.ownerId && !voiceOwned) ||
    (voiceOwned && (voiceInput.status === "connecting" || voiceInput.status === "transcribing")) ||
    pending ||
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

  function retryLatestError() {
    setError(null);
    setCodexError(null);
    void loadSession(false);
    if (activeThreadId) void openThread(activeThreadId, false);
  }
  return (
    <section
      className={dragActive ? "coder-agent-pane vscode-codex-pane drag-active" : "coder-agent-pane vscode-codex-pane"}
      aria-label={`Native agent ${pane.title}`}
      data-agent-pane-id={pane.id}
      data-codex-enabled={isCodexEnabled ? "true" : "false"}
      data-workspace-text-size={workspaceTextSize}
      style={{ "--codex-workspace-text-size": `${workspaceTextSize}px` } as CSSProperties}
      onPasteCapture={isCodexEnabled ? handlePaste : undefined}
      onDrop={isCodexEnabled ? handleDrop : undefined}
      onDragOver={(event) => {
        event.preventDefault();
        if (isCodexEnabled) setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
    >
      <input
        ref={fileInputRef}
        type="file"
        name={`agent-files-${pane.id}`}
        multiple
        hidden
        disabled={!isCodexEnabled}
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
        disabled={!isCodexEnabled}
        onChange={(event) => {
          const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
          event.currentTarget.value = "";
          if (files.length) void uploadFiles(files, "USER_UPLOAD");
        }}
      />
      <div className="codex-chat-shell">
        {session?.collaborationMode === "plan" ? (
          <button
            type="button"
            className="codex-plan-mode-indicator"
            aria-label={`Disable Plan mode ${pane.title}`}
            aria-pressed="true"
            title="Plan mode is active. Click to return to Default mode."
            disabled={pending || !isCodexEnabled}
            onClick={() => void updateCollaborationMode("default")}
          >
            <PanelRight aria-hidden="true" />
            <span>Plan mode on</span>
          </button>
        ) : null}
        <div
          ref={transcriptRef}
          className={`codex-transcript-scroll${session?.collaborationMode === "plan" ? " has-plan-mode" : ""}`}
          onScroll={handleTranscriptScroll}
        >
          <CodexTranscript items={thread?.items ?? []} isRunning={isRunning} loading={threadLoading || loading} elapsedSeconds={elapsedSeconds} />
        </div>
        <div className="codex-notification-stack">
          {session?.binding.status === "BLOCKED" ? (
            <CodexNotification tone="warning" message={session.statusReason} />
          ) : null}
          {notice ? <CodexNotification tone="info" message={notice} onDismiss={() => setNotice(null)} /> : null}
          {error || codexError || runError ? (
            <CodexNotification
              tone="error"
              message={error ?? codexError ?? runError ?? "Codex error"}
              onRetry={retryLatestError}
              onDismiss={error || codexError
                ? () => {
                  setError(null);
                  setCodexError(null);
                }
                : undefined}
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
          paneTitle={pane.title}
          disabledReason={isCodexEnabled ? null : codexDisabledReason}
          prompt={prompt}
          onPromptChange={setPrompt}
          attachments={attachments}
          onRemoveAttachment={(artifactId) => setAttachments((current) => current.filter((artifact) => artifact.id !== artifactId))}
          onClearAttachments={clearAttachments}
          onVoice={toggleVoiceCapture}
          onVoicePrewarm={voiceInput.prewarm}
          voiceActive={voiceOwned && voiceInput.status === "recording"}
          voiceDisabled={voiceDisabled}
          isRunning={isRunning}
          canSend={canSend}
          canInterrupt={Boolean(session?.capabilities.canInterrupt)}
          pending={pending}
          onSend={() => void submitMessage(trimmedPrompt)}
          onStop={() => void interrupt()}
          modelCatalog={(session as AgentPaneSessionWithModelCatalog | null)?.modelCatalog ?? []}
          modelOptions={session?.modelOptions ?? []}
          modelProviders={session?.modelProviders ?? []}
          selectedModelConfigId={session?.selectedModelConfigId ?? null}
          canSelectModel={Boolean(session?.capabilities.canSelectModel)}
          onModelConfigChange={updateModelConfig}
        />
      </div>
      {goalDialogOpen ? (
        <CodexGoalDialog
          paneTitle={pane.title}
          goal={session?.goal ?? null}
          pending={pending}
          onClose={() => setGoalDialogOpen(false)}
          onSave={(objective) => void saveGoal(objective)}
          onClear={() => void clearGoal()}
        />
      ) : null}
    </section>
  );
}
