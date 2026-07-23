import {
  SpaceNotFoundError,
  redactMemoryText,
  type CliTaskRevisionRecord,
  type PaneCliTaskHistoryRecord,
  type SpaceStore
} from "@space/runtime";
import type { PaneCliSession, PaneCliTranscriptChunk } from "@space/contracts";

export interface UnifiedCliTask {
  id: string;
  taskId: string;
  revisionId: string;
  title: string;
  runtimeId: string;
  providerId: string;
  providerLabel: string;
  modelProvider: string;
  preview: string;
  firstUserMessage: string;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  updatedAt: string;
  recencyAt: string;
  archived: false;
  source: "space";
  threadSource: string;
  rolloutPath: null;
}

export interface UnifiedCliTaskListResponse {
  tasks: UnifiedCliTask[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ResolvedSpaceCliTask extends UnifiedCliTask {
  revision: CliTaskRevisionRecord;
  session: PaneCliSession;
  transcript: PaneCliTranscriptChunk[];
}

const runtimeProviderLabels: Record<string, string> = {
  "cli:codex": "Codex",
  "cli:claude": "Claude Code",
  "cli:gemini": "Gemini",
  "cli:opencode": "OpenCode",
  "cli:qwen": "Qwen Code",
  "cli:kimi": "Kimi Code",
  "cli:grok": "Grok Build",
  "cli:deepseek": "DeepSeek"
};

const ansiEscapePattern = /\u001b(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;

function cleanTaskText(value: string, maxLength: number): string {
  return redactMemoryText(value)
    .replace(ansiEscapePattern, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function providerLabel(runtimeId: string, providerId: string): string {
  return runtimeProviderLabels[runtimeId] ?? providerId;
}

function normalizeTask(record: PaneCliTaskHistoryRecord): UnifiedCliTask {
  const firstUserMessage = cleanTaskText(record.revision.firstUserMessage || record.firstUserMessage, 2_000);
  const preview = cleanTaskText(record.revision.preview || record.preview, 2_000) || firstUserMessage;
  const title = cleanTaskText(record.revision.displayTitle || record.paneTitle, 300) ||
    firstUserMessage.slice(0, 120) ||
    "Space CLI task";
  return {
    id: record.taskId,
    taskId: record.taskId,
    revisionId: record.revision.revisionId,
    title,
    runtimeId: record.revision.runtimeId,
    providerId: record.revision.providerId,
    providerLabel: providerLabel(record.revision.runtimeId, record.revision.providerId),
    modelProvider: record.revision.providerId,
    preview,
    firstUserMessage,
    cwd: record.revision.cwd ?? record.session.cwd,
    model: record.revision.modelId,
    reasoningEffort: record.revision.reasoningEffort,
    updatedAt: record.revision.updatedAt,
    recencyAt: record.recencyAt,
    archived: false,
    source: "space",
    threadSource: record.revision.runtimeId,
    rolloutPath: null
  };
}

export class UnifiedCliTaskRegistry {
  constructor(private readonly store: SpaceStore) {}

  async listAllTasks(options?: {
    page?: number;
    pageSize?: number;
    includeArchived?: boolean;
    q?: string;
    runtimeIds?: string[];
  }): Promise<UnifiedCliTaskListResponse> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 50;
    const result = await this.store.listPaneCliTaskHistory({
      page,
      pageSize,
      query: options?.q,
      runtimeIds: options?.runtimeIds
    });
    return {
      tasks: result.items.map(normalizeTask),
      total: result.total,
      page,
      pageSize
    };
  }

  async getTask(taskIdOrLegacyThreadId: string, runtimeIds?: string[]): Promise<ResolvedSpaceCliTask> {
    const legacySession =
      (await this.store.getPaneCliSession(taskIdOrLegacyThreadId)) ??
      (await this.store.getLatestPaneCliSessionByCodexThreadId(taskIdOrLegacyThreadId));
    const logicalTask =
      (await this.store.getCliTask(taskIdOrLegacyThreadId)) ??
      (legacySession?.cliTaskId ? await this.store.getCliTask(legacySession.cliTaskId) : null);
    const revision = logicalTask?.currentRevisionId
      ? await this.store.getCliTaskRevision(logicalTask.currentRevisionId)
      : null;
    const session = revision?.latestSpaceSessionId
      ? await this.store.getPaneCliSession(revision.latestSpaceSessionId)
      : legacySession;
    if (!session || (runtimeIds && !runtimeIds.includes(revision?.runtimeId ?? session.runtimeId))) {
      throw new SpaceNotFoundError(`Space CLI task ${taskIdOrLegacyThreadId} was not found.`);
    }
    if (session.purpose !== "NORMAL") {
      throw new SpaceNotFoundError(`Space CLI task ${taskIdOrLegacyThreadId} was not found.`);
    }
    const [pane, transcript] = await Promise.all([
      this.store.getPane(session.paneId),
      this.store.listPaneCliTranscriptChunks(session.sessionId)
    ]);
    const transcriptFirstUserMessage = transcript.find(
      (chunk) => chunk.stream === "stdin" && chunk.content.trim()
    )?.content;
    const firstUserMessage = transcriptFirstUserMessage ?? revision?.firstUserMessage ?? "";
    if (!firstUserMessage && !revision?.nativeTaskRef) {
      throw new SpaceNotFoundError(`Space CLI task ${taskIdOrLegacyThreadId} has no resumable transcript.`);
    }
    const preview = [...transcript]
      .reverse()
      .find((chunk) => (chunk.stream === "stdout" || chunk.stream === "stderr") && chunk.content.trim())
      ?.content ?? revision?.preview ?? firstUserMessage;
    const resolvedRevision: CliTaskRevisionRecord = revision ?? {
      revisionId: session.cliTaskRevisionId ?? session.sessionId,
      taskId: session.cliTaskId ?? session.sessionId,
      runtimeId: session.runtimeId,
      providerId: session.providerId,
      agentId: session.agentId,
      nativeTaskRef: session.codexThreadId,
      sourceRevisionId: null,
      latestSpaceSessionId: session.sessionId,
      displayTitle: pane.title,
      firstUserMessage,
      preview,
      cwd: session.cwd,
      modelId: session.modelId,
      reasoningEffort: session.reasoningEffort,
      createdAt: session.startedAt,
      updatedAt: session.updatedAt
    };
    const record: PaneCliTaskHistoryRecord = {
      taskId: logicalTask?.taskId ?? session.cliTaskId ?? session.sessionId,
      revision: resolvedRevision,
      session,
      paneTitle: pane.title,
      firstUserMessage,
      preview,
      recencyAt: transcript.at(-1)?.createdAt ?? session.updatedAt
    };
    return { ...normalizeTask(record), revision: resolvedRevision, session, transcript };
  }
}
