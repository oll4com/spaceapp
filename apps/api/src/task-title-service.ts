import { qwenNativeSessionIdPattern, type NativeTaskTitles } from "./task-title-native.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  boundedTaskText,
  cleanTaskText,
  shortTaskTitle,
  isSubstantiveTaskRequest,
  taskRequestFingerprint,
  taskMetadataSchema,
  taskTopicsMax,
  titleEchoesRequest,
  type Pane,
  type TaskTitleState,
  type TaskMetadata,
  type TaskTopic,
  type PaneCliSession,
} from "@space/contracts";
import {
  hasTaskImageReference,
  readableTaskImages,
  taskImageReferences,
  type TaskImageScope,
} from "./task-title-images.js";
import {
  redactMemoryText,
  SpaceNotFoundError,
  type SpaceStore,
  type SpaceEventBus,
} from "@space/runtime";
import type { TaskTitleRepository } from "@space/db";
import {
  readOpenCodeServerControl,
  fetchOpenCodeSessionTitle,
  updateOpenCodeSessionTitle,
  fetchOpenCodeSessionMessages,
} from "@space/opencode-control";
import type { CodexParityService } from "./codex-parity.js";
import {
  TaskTitleProviders,
  TitleProviderFailure,
} from "./task-title-providers.js";

/** Fixed categories only: never log provider messages, prompts, URLs or SQL. */
export function taskTitleFailureCode(error: unknown): string {
  if (error instanceof SpaceNotFoundError) return "NOT_FOUND";
  if (error instanceof TitleProviderFailure) return "PROVIDER_REJECTED";
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (["40001", "40P01", "23505"].includes(String(code))) return "STORE_CONFLICT";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "08006", "57P01", "53300"].includes(String(code))) return "STORE_UNAVAILABLE";
  return "UNEXPECTED";
}

export interface TaskTitleContext {
  key: string;
  pane: Pane;
  sessionId: string;
  runtimeId: string;
  nativeId: string | null;
  revisionId: string | null;
  requests: string[];
  nativeTitle: string | null;
  nativeManual?: boolean;
  /** Validated image uploads attached to the latest request. */
  images?: string[];
}
/** The request text of a submission that is only an attached image. */
export const imageOnlyTaskRequest = "Attached image";
export interface SubmittedTaskEntry {
  text: string;
  /** Raw submitted line, kept only when it names an image upload. */
  raw: string | null;
}
/**
 * Reconstruct submitted lines, not individual keystrokes or unsubmitted drafts.
 * A submission naming an image upload counts even with a short instruction
 * such as "fix this", because the image carries the task.
 */
export function submittedTaskEntries(
  chunks: Array<{ stream: string; content: string }>,
): SubmittedTaskEntry[] {
  const entries: SubmittedTaskEntry[] = [];
  let line = "";
  let pasted = false;
  const input = chunks
    .filter((c) => c.stream === "stdin")
    .map((c) => c.content)
    .join("");
  for (let i = 0; i < input.length; i++) {
    if (input.startsWith("\x1b[200~", i)) {
      pasted = true;
      i += 5;
      continue;
    }
    if (input.startsWith("\x1b[201~", i)) {
      pasted = false;
      i += 5;
      continue;
    }
    const char = input[i]!;
    if (char === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(input.slice(i));
      if (match) {
        i += match[0].length - 1;
        continue;
      }
    }
    if (char === "\x7f" || char === "\b") {
      line = Array.from(line).slice(0, -1).join("");
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (pasted) {
        line += " ";
        continue;
      }
      const image = hasTaskImageReference(line);
      if (isSubstantiveTaskRequest(line) || image)
        entries.push({ text: cleanTaskText(line) || imageOnlyTaskRequest, raw: image ? line : null });
      line = "";
    } else if (char >= " ") line = (line + char).slice(-8000);
  }
  return entries.slice(-12);
}
export function submittedTaskRequests(
  chunks: Array<{ stream: string; content: string }>,
): string[] {
  return submittedTaskEntries(chunks)
    .filter((entry) => isSubstantiveTaskRequest(entry.text))
    .map((entry) => entry.text);
}
/** Plan handoff prompts end with "Plan ID: <clipboard item id>" (see TerminalPane). */
export function extractReferencedPlanId(request: string): string | null {
  const match = /Plan ID:\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,127})/i.exec(request);
  const id = match?.[1]?.replace(/[.:]+$/, "");
  return id && id.length >= 8 ? id : null;
}
/** Images change the request: "fix this" with another screenshot is new work. */
export function taskRequestHash(text: string, images: readonly string[] = []) {
  const digest = createHash("sha256").update(taskRequestFingerprint(text));
  if (images.length) digest.update(`\n${images.map((image) => basename(image)).join("\n")}`);
  return digest.digest("hex");
}
const safe = (text: string, limit: number) =>
  boundedTaskText(cleanTaskText(redactMemoryText(text)), limit);
const titleLines = (topics: readonly TaskTopic[]) => topics.slice(-5).map((topic) => topic.title);
export const titlePromptMaxBytes = 4000;
export function titleSummaryPrompt(
  state: TaskTitleState,
  attachments: { shown?: number; unseen?: number } = {},
): string {
  // UTF-8 bytes are a conservative token upper bound, including JSON framing.
  const bytes = (value: string, limit: number) => {
    let result = "",
      size = 0;
    for (const point of safe(value, 3000)) {
      size += Buffer.byteLength(point);
      if (size > limit) break;
      result += point;
    }
    return result;
  };
  const requests = (state.pendingRequests?.length ? state.pendingRequests : [state.request]).slice(-3);
  const context: {
    topics: Array<{ title: string; summary: string }>;
    earlierWork: string;
    newRequests: string[];
    attachedImages?: number;
    unseenImages?: string;
  } = {
    topics: (state.metadata.topics ?? []).slice(-4).map((topic) => ({
      title: bytes(topic.title, 120),
      summary: bytes(topic.summary, 240),
    })),
    earlierWork: bytes(state.metadata.earlierWork, 160),
    newRequests: requests.map((request, index) =>
      bytes(request, index === requests.length - 1 ? 1600 : 320),
    ),
    ...(attachments.shown ? { attachedImages: attachments.shown } : {}),
    ...(attachments.unseen
      ? { unseenImages: `${attachments.unseen} attached image(s) could not be shown; name the task from the text.` }
      : {}),
  };
  // Reduce by UTF-8 bytes, not UTF-16 length or grapheme count (a single
  // grapheme may contain thousands of combining characters). Every iteration
  // removes data and therefore terminates even with adversarial Unicode.
  const oversized = () => Buffer.byteLength(JSON.stringify(context), "utf8") > titlePromptMaxBytes;
  while (oversized() && context.topics.length) context.topics.shift();
  const shorten = (value: string) => {
    const points = Array.from(value);
    return points.slice(0, Math.floor(points.length * 0.75)).join("");
  };
  while (oversized() && context.earlierWork) context.earlierWork = shorten(context.earlierWork);
  while (oversized() && context.newRequests.length > 1) context.newRequests.shift();
  while (oversized() && context.newRequests[0]) context.newRequests[0] = shorten(context.newRequests[0]);
  return JSON.stringify(context);
}
/** The model's verdict for the latest request: same work, or a new summarized title line. */
export function parseTaskSummary(raw: string) {
  if (raw.length > 12_000) throw new Error("Oversized task metadata");
  const unfenced = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  // Some models wrap the object in a sentence; take the outermost object only.
  const body = unfenced.startsWith("{") ? unfenced : unfenced.slice(unfenced.indexOf("{"), unfenced.lastIndexOf("}") + 1);
  const value = JSON.parse(body);
  const summaryText = typeof value?.summary === "string" ? value.summary : value?.description;
  if (typeof value?.title !== "string" || typeof summaryText !== "string")
    throw new Error("Invalid task metadata");
  const title = shortTaskTitle(value.title),
    summary = safe(summaryText, 400);
  if (!title || !summary) throw new Error("Empty task metadata");
  // Some models rename the flag; "isNewTopic": false means the same work.
  return { sameTopic: value.sameTopic === true || value.isNewTopic === false, title, summary };
}

/** How each CLI type labels the title it saved for the task. */
const nativeTitleLabels: Record<string, string> = {
  "cli:claude": "Claude Code",
  "cli:codex": "Codex",
  codex: "Codex",
  "cli:opencode": "OpenCode",
  opencode: "OpenCode",
  "cli:qwen": "Qwen Code",
  "cli:hermes": "Hermes",
  harness: "Harness",
};
/** Space can rename the task inside these CLIs; others only report their title. */
const writableNativeTitleRuntimes = new Set(["cli:codex", "codex", "cli:opencode", "opencode", "cli:qwen", "cli:hermes", "harness"]);
/**
 * CLIs whose saved title is a real summary (Claude Code's AI title, OpenCode's
 * generated session title, a named Codex thread). It becomes the first line.
 */
const trustedFirstTitleRuntimes = new Set(["cli:claude", "cli:codex", "codex", "cli:opencode", "opencode"]);
// Defaults, and envelope tags such as "<send_user_message_question_reply>".
const placeholderNativeTitle = /^(?:New|Child) session|Untitled|^CLI \d|^<[^<>]+>$/i;
/** A CLI title usable as a pane title: short, not a placeholder, not an echo of the prompt. */
export function usableNativeTitle(context: Pick<TaskTitleContext, "nativeTitle" | "nativeManual" | "requests">, ownTitle?: string | null) {
  const native = context.nativeTitle;
  if (!native || shortTaskTitle(native) !== native || placeholderNativeTitle.test(native)) return null;
  if (!context.nativeManual && native !== ownTitle && titleEchoesRequest(native, context.requests)) return null;
  return native;
}
/** The CLI's saved title as shown to the user (may be longer than a pane title). */
export function displayedNativeTitle(context: Pick<TaskTitleContext, "nativeTitle" | "nativeManual" | "requests">, ownTitle?: string | null) {
  const native = context.nativeTitle ? boundedTaskText(cleanTaskText(context.nativeTitle), 160) : "";
  if (!native || placeholderNativeTitle.test(native)) return null;
  if (!context.nativeManual && native !== ownTitle && titleEchoesRequest(native, context.requests)) return null;
  return native;
}
function trustedFirstTitle(context: TaskTitleContext, ownTitle?: string | null) {
  return trustedFirstTitleRuntimes.has(context.runtimeId) ? usableNativeTitle(context, ownTitle) : null;
}

export class TaskTitleService {
  private dirty = new Map<string, number>();
  private versions = new Map<string, string>();
  private reconciliation: Promise<void> | null = null;
  private startup: Promise<void> | null = null;
  private harnessBindings = new Map<string, Promise<Pane>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private work: Promise<void> | null = null;
  private retryAt = 0;
  private consecutiveFailures = 0;
  private stopped = false;
  private abort = new AbortController();
  constructor(
    private options: {
      store: SpaceStore;
      nativeTitles?: Pick<NativeTaskTitles, "metadata">;
      repository: TaskTitleRepository;
      providers: TaskTitleProviders;
      codex: CodexParityService;
      eventBus: SpaceEventBus;
      opencodeStateRoot?: string;
      loadContext?: (paneId: string) => Promise<TaskTitleContext | null>;
      harness?: {
        read: (
          paneId: string,
          sessionId?: string,
        ) => Promise<{
          sessionId: string;
          requests: string[];
          title: string | null;
        } | null>;
        rename: (
          paneId: string,
          sessionId: string,
          title: string,
        ) => Promise<void>;
      };
      resolveCodexThread?: (session: PaneCliSession) => Promise<string | null>;
      readCodexName?: (sessionId: string, threadId: string) => Promise<string | null>;
      renameCodex?: (
        sessionId: string,
        threadId: string,
        title: string,
      ) => Promise<void>;
      /** Claude Code's own saved session title (read-only: Space cannot rename it). */
      readClaudeTitle?: (session: PaneCliSession) => Promise<{
        nativeId: string;
        title: string | null;
        manual: boolean;
        /** The session's typed prompts from its transcript, oldest first. */
        requests?: string[];
      } | null>;
      /** Root of `cli-uploads`; without it attached images are not read. */
      artifactRoot?: string;
      /** False for a pane whose summary would run on someone else's model accounts (MU-002); it keeps its local title. */
      summaryAllowed?: (paneId: string) => Promise<boolean>;
      now?: () => Date;
      onError?: (error: unknown) => void;
    },
  ) {}
  private imageScope(pane: Pane, cwd: string | null = null): TaskImageScope | null {
    return this.options.artifactRoot
      ? { artifactRoot: this.options.artifactRoot, roomId: pane.roomId, paneId: pane.id, cwd: cwd ?? pane.cwd ?? null }
      : null;
  }
  private now() {
    return this.options.now?.() ?? new Date();
  }
  private async paneIfPresent(paneId: string): Promise<Pane | null> {
    try {
      return await this.options.store.getPane(paneId);
    } catch (error) {
      if (error instanceof SpaceNotFoundError) return null;
      throw error;
    }
  }
  private async targetWasDeleted(paneId: string, error: unknown) {
    // A missing related session or a failed store read is still an error.
    return error instanceof SpaceNotFoundError &&
      (await this.paneIfPresent(paneId)) === null;
  }
  notify(paneId: string) {
    if (!this.dirty.has(paneId))
      this.dirty.set(paneId, this.now().getTime() + 5000);
  }
  async start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.options.onError?.(e)),
      1000,
    );
    this.timer.unref();
    this.reconcileTimer = setInterval(
      () => void this.reconcile().catch((e) => this.options.onError?.(e)),
      30_000,
    );
    this.reconcileTimer.unref();
    this.startup = Promise.all([
      this.options.providers.refresh(),
      this.reconcile(),
    ]).then(() => {});
    await this.startup;
  }
  async close() {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    await Promise.allSettled([
      this.work,
      this.reconciliation,
      this.startup,
      ...this.harnessBindings.values(),
    ]);
    await this.options.repository.dispose();
  }
  async reconcile() {
    if (this.stopped) return;
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileActive().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }
  private async panesIfRoomPresent(roomId: string): Promise<Pane[]> {
    try {
      return await this.options.store.listPanes(roomId);
    } catch (error) {
      if (!(error instanceof SpaceNotFoundError)) throw error;
      try {
        await this.options.store.getRoom(roomId);
      } catch (roomError) {
        if (roomError instanceof SpaceNotFoundError) return [];
        throw roomError;
      }
      throw error;
    }
  }
  private async reconcileActive() {
    const seen = new Set<string>();
    const rooms = await this.options.store.listRooms();
    for (const room of rooms) {
      for (const pane of await this.panesIfRoomPresent(room.id)) {
        try {
          if (this.stopped) return;
          if (
            pane.isClosed ||
            !["TERMINAL", "CHAT", "HARNESS"].includes(pane.mode)
          )
            continue;
          if (pane.mode === "HARNESS") {
            this.notify(pane.id);
            continue;
          }
          const session =
            pane.mode === "CHAT"
              ? await this.options.store.getActiveSpaceAgentSession(pane.id)
              : await this.options.store.getActivePaneCliSession(pane.id);
          if (!session) continue;
          seen.add(pane.id);
          const chunks =
            pane.mode === "CHAT"
              ? await this.options.store.listSpaceAgentMessages(
                  session.sessionId,
                  1,
                )
              : await this.options.store.listPaneCliTranscriptChunks(
                  session.sessionId,
                  1,
                );
          const stamp = `${session.sessionId}:${chunks.at(-1)?.createdAt ?? ""}`;
          if (
            this.versions.get(pane.id) !== stamp ||
            !pane.taskMetadata ||
            ["cli:codex", "cli:opencode", "cli:qwen", "cli:hermes", "cli:claude"].includes(
              pane.terminalRuntimeId ?? "",
            )
          ) {
            this.versions.set(pane.id, stamp);
            this.notify(pane.id);
          }
        } catch (error) {
          // A pane may close between listing it and reading its session.
          if (!(await this.targetWasDeleted(pane.id, error))) throw error;
        }
      }
    }
    for (const id of this.versions.keys())
      if (!seen.has(id)) this.versions.delete(id);
    if (!this.stopped) await this.options.providers.refresh();
  }
  async context(paneId: string): Promise<TaskTitleContext | null> {
    if (this.options.loadContext) return this.options.loadContext(paneId);
    const { store, codex } = this.options;
    const pane = await this.paneIfPresent(paneId);
    if (!pane || pane.isClosed || pane.terminalRuntimeId === "cli:root") return null;
    let sessionId: string,
      runtimeId: string,
      nativeId: string | null = null,
      revisionId: string | null = null,
      key: string,
      accountKey = "default",
      requests: string[] = [],
      nativeTitle: string | null = null,
      nativeManual = false,
      images: string[] = [],
      cwd: string | null = null;
    // Submissions that named an image upload, matched to the latest request below.
    let imageEntries: Array<{ text: string; raw: string }> = [];
    if (pane.mode === "HARNESS") {
      const native = await this.options.harness?.read(
        pane.id,
        pane.taskMetadata?.harnessSessionId,
      );
      if (!native) return null;
      return {
        key: `harness:${pane.id}:${native.sessionId}`,
        pane,
        sessionId: native.sessionId,
        runtimeId: "harness",
        nativeId: native.sessionId,
        revisionId: null,
        requests: native.requests.filter(isSubstantiveTaskRequest),
        nativeTitle: native.title,
      };
    }
    if (pane.mode === "CHAT") {
      const session = await store.getActiveSpaceAgentSession(pane.id);
      if (!session) return null;
      sessionId = session.sessionId;
      runtimeId = session.selectedProviderId ?? "cli:codex";
      nativeId =
        runtimeId === "codex" || runtimeId === "cli:codex"
          ? session.threadId
          : null;
      key = `chat:${session.sessionId}`;
      const messages = (await store.listSpaceAgentMessages(sessionId, 40))
        .filter((m) => m.role === "user");
      requests = messages.map((m) => m.content);
      const last = messages.at(-1);
      if (last && hasTaskImageReference(last.content))
        imageEntries = [{ text: last.content, raw: last.content }];
    } else if (pane.mode === "TERMINAL") {
      const session = await store.getActivePaneCliSession(pane.id);
      if (!session || session.purpose !== "NORMAL") return null;
      sessionId = session.sessionId;
      runtimeId = session.runtimeId;
      revisionId = session.cliTaskRevisionId;
      accountKey = session.accountProfileId ?? "default";
      const revision = revisionId
        ? await store.getCliTaskRevision(revisionId)
        : null;
      nativeId = session.codexThreadId ?? revision?.nativeTaskRef ?? null;
      if (!nativeId && runtimeId === "cli:codex")
        nativeId = (await this.options.resolveCodexThread?.(session)) ?? null;
      key = `cli:${runtimeId}:${session.accountProfileId ?? "default"}:${session.cliTaskId ?? sessionId}`;
      cwd = session.cwd ?? null;
      const entries = submittedTaskEntries(
        await store.listPaneCliTranscriptChunks(sessionId, 200),
      );
      requests = entries.map((entry) => entry.text);
      imageEntries = entries.flatMap((entry) => entry.raw ? [{ text: entry.text, raw: entry.raw }] : []);
      if (!requests.length && revision?.firstUserMessage)
        requests = [revision.firstUserMessage];
      if (runtimeId === "cli:claude" && this.options.readClaudeTitle) {
        try {
          const claude = await this.options.readClaudeTitle(session);
          if (claude?.nativeId) {
            nativeId = claude.nativeId;
            nativeTitle = claude.title;
            nativeManual = claude.manual;
            // A resumed pane starts a new CLI session whose stdin may hold only
            // "continue"; Claude's transcript keeps every prompt of the task.
            if (claude.requests?.some(isSubstantiveTaskRequest)) requests = claude.requests;
          }
        } catch {}
      }
      if (this.options.nativeTitles) {
        try {
          const native = await this.options.nativeTitles.metadata(
            session,
            undefined,
            this.abort.signal,
          );
          if (native?.nativeId) {
            nativeId = native.nativeId;
            nativeTitle = native.title ?? null;
            nativeManual = native.manual ?? false;
            if (native.requests?.length) requests = native.requests;
            // The bridge proved this session belongs to the pane's process, so host-loss
            // restore and task-history resume can reopen it exactly (`qwen --resume <id>`).
            if (
              runtimeId === "cli:qwen" &&
              revisionId &&
              revision &&
              revision.nativeTaskRef !== native.nativeId &&
              qwenNativeSessionIdPattern.test(native.nativeId)
            ) {
              await this.options.store.updateCliTaskRevision(
                revisionId,
                { nativeTaskRef: native.nativeId },
                "trace:qwen-native-ref",
              );
            }
          }
        } catch {}
      }
    } else return null;
    if (runtimeId === "cli:opencode" || runtimeId === "opencode") {
      const control = await readOpenCodeServerControl(
        sessionId,
        this.options.opencodeStateRoot,
      );
      if (control) {
        nativeId = control.nativeSessionId;
        try {
          nativeTitle =
            (await fetchOpenCodeSessionTitle(control, nativeId))?.title ?? null;
          const history = await fetchOpenCodeSessionMessages(control, nativeId, 30).catch(() => null);
          if (history) {
            const messages = (history as any[])
              .filter((m) => m.info?.role === "user");
            const native = messages.map((m) =>
                (m.parts ?? [])
                  .filter(
                    (p: any) => p.type === "text" && !p.synthetic && !p.ignored,
                  )
                  .map((p: any) => p.text)
                  .join(" "),
              );
            if (native.length) requests = native;
            // OpenCode attaches pasted images as file parts of the message.
            const files = (messages.at(-1)?.parts ?? [])
              .filter((p: any) => p.type === "file" && typeof p.url === "string")
              .map((p: any) => { try { return decodeURI(p.url); } catch { return ""; } })
              .join(" ");
            if (native.length && hasTaskImageReference(files))
              imageEntries = [{ text: native.at(-1)!, raw: files }];
          }
        } catch {}
      }
    } else if (
      (runtimeId === "cli:codex" || runtimeId === "codex") &&
      nativeId
    ) {
      const [thread, history] = await Promise.allSettled([
        codex.getThread(nativeId, { presentation: "chat" }),
        codex.getHistoryThread(nativeId),
      ]);
      if (history.status === "fulfilled") {
        nativeTitle = history.value.title;
        if (pane.mode !== "CHAT" && isSubstantiveTaskRequest(history.value.firstUserMessage ?? ""))
          requests = [history.value.firstUserMessage!];
      }
      if (thread.status === "fulfilled") {
        const native = thread.value.items
          .filter((i) => i.kind === "message" && i.role === "user")
          .map((i) => i.content)
          .filter(isSubstantiveTaskRequest);
        if (pane.mode !== "CHAT" && native.length) requests = native;
      }
      // Codex's native /resume name is separate from the legacy SQLite title.
      // Read the active thread's name over its exact private CLI socket.
      try {
        nativeTitle = (await this.options.readCodexName?.(sessionId, nativeId)) ?? nativeTitle;
      } catch {}
      // Native Chat receives a tool envelope before the real user prompt. Its
      // automatic first-line title must not become the pane title. Durable Chat
      // user messages are authoritative, including intentional operator quotes.
      const envelopeHeading = /^(?:Space (?:private clipboard|private task|shared chat|managed browser) tools selected|Space workspace directory|Attached Space artifacts for this user message)(?:[:\s]|$)/;
      if (pane.mode === "CHAT" && nativeTitle && envelopeHeading.test(nativeTitle)
        && !requests.some(request => envelopeHeading.test(request.trim()))) nativeTitle = null;
    }
    // A reused pane that switched native sessions must never inherit mutable metadata.
    if (nativeId) key = `native:${runtimeId}:${accountKey}:${nativeId}`;
    // Images belong to the latest request only when that exact submission named them.
    const latest = requests.at(-1);
    const imageEntry = imageEntries.at(-1);
    const scope = this.imageScope(pane, cwd);
    if (scope && latest !== undefined && imageEntry &&
      taskRequestFingerprint(cleanTaskText(imageEntry.text) || imageOnlyTaskRequest) ===
        taskRequestFingerprint(cleanTaskText(latest) || imageOnlyTaskRequest))
      images = taskImageReferences(imageEntry.raw, scope);
    return {
      key,
      pane,
      sessionId,
      runtimeId,
      nativeId,
      revisionId,
      requests: requests.filter((request, index, all) =>
        isSubstantiveTaskRequest(request) || (index === all.length - 1 && images.length > 0)),
      nativeTitle,
      nativeManual,
      images,
    };
  }
  /**
   * Bind the first "Plan ID: <id>" reference that names an existing PLAN to
   * this pane. Any clipboard item id format is accepted (clipboard:…,
   * clip-plan-…); references to unknown items are skipped.
   */
  private async bindReferencedPlan(context: TaskTitleContext): Promise<string | null> {
    const planIds = context.requests
      .map((req) => extractReferencedPlanId(req))
      .filter((id): id is string => Boolean(id));
    if (planIds.length === 0) return null;
    let ownerUserId: string | null = null;
    try {
      ownerUserId = (await this.options.store.getRoom(context.pane.roomId))?.ownerUserId ?? null;
    } catch {}
    if (!ownerUserId) return planIds[0]!;
    for (const planId of new Set(planIds)) {
      try {
        await this.options.store.updateClipboardItemProgress(ownerUserId, planId, {
          paneId: context.pane.id,
          roomId: context.pane.roomId,
          paneTitle: context.pane.paneName ?? context.pane.title
        } as any);
        return planId;
      } catch (error) {
        if (error instanceof SpaceNotFoundError) continue;
        // Managed plans own their pane binding; the reference is still valid.
        return planId;
      }
    }
    return null;
  }
  async observe(paneId: string, force = false): Promise<Pane> {
    const context = await this.context(paneId);
    if (!context) return this.options.store.getPane(paneId);
    const request = context.requests.at(-1);
    const images = context.images ?? [];
    if (!request || (!isSubstantiveTaskRequest(request) && !images.length)) return context.pane;
    const requestHash = taskRequestHash(request, images);
    let previous = await this.options.repository.get(context.key);
    // Preserve paid-for summaries when a temporary binding acquires its native ID.
    const priorKey = context.pane.taskMetadata?.taskKey;
    if (!previous && priorKey && priorKey !== context.key) {
      const temporary = await this.options.repository.get(priorKey);
      if (
        temporary &&
        !temporary.nativeId &&
        temporary.sessionId === context.sessionId &&
        temporary.runtimeId === context.runtimeId
      ) {
        const migrated = {
          ...temporary,
          key: context.key,
          budgetKey: temporary.budgetKey ?? temporary.key,
          nativeId: context.nativeId,
          version: 1,
          metadata: { ...temporary.metadata, taskKey: context.key, version: 1 },
          dueAt: this.now().toISOString(),
        };
        if (await this.options.repository.enqueue(migrated, 0))
          previous = migrated;
      }
    }
    const cleanNative = usableNativeTitle(context, previous?.title);
    const shownNative = displayedNativeTitle(context, previous?.title);
    const nativeTitleLabel = nativeTitleLabels[context.runtimeId] ?? null;
    // A placeholder or envelope tag adopted before it was recognized as one
    // is summarized again, as "Regenerate summary" would.
    const repair =
      !force &&
      context.pane.titleSource !== "manual" &&
      // Once only: a failed retry must not repeat on every observation.
      previous?.metadata.generationStatus === "ready" &&
      placeholderNativeTitle.test(previous?.title ?? "");
    if (repair) force = true;
    if (!force && previous?.requestHash === requestHash) {
      const topics = previous.metadata.topics ?? [];
      const manualChanged =
        Boolean(context.nativeManual) !== Boolean(previous.metadata.nativeTitleManual);
      const nativeChanged =
        cleanNative !== null &&
        cleanNative !== previous.lastNativeTitle &&
        cleanNative !== previous.title;
      // A rename inside a writable CLI renames the current line. A read-only
      // CLI's own title (Claude Code) names only the first line.
      const adopt =
        cleanNative !== null &&
        (manualChanged || nativeChanged) &&
        context.pane.titleSource !== "manual" &&
        (writableNativeTitleRuntimes.has(context.runtimeId) ||
          Boolean(context.nativeManual) ||
          (trustedFirstTitleRuntimes.has(context.runtimeId) && topics.length <= 1));
      if (adopt) {
        const version = previous.version + 1;
        const renamed: TaskTopic[] = topics.length
          ? [...topics.slice(0, -1), { ...topics.at(-1)!, title: cleanNative!, source: "native" }]
          : topics;
        const adopted: TaskTitleState = {
          ...previous,
          paneId,
          sessionId: context.sessionId,
          revisionId: context.revisionId,
          version,
          title: cleanNative!,
          lastNativeTitle: cleanNative,
          metadata: {
            ...previous.metadata,
            version,
            topics: renamed,
            steps: renamed.length ? titleLines(renamed) : previous.metadata.steps,
            source: "native" as const,
            nativeSyncStatus: writableNativeTitleRuntimes.has(context.runtimeId)
              ? ("synced" as const)
              : previous.metadata.nativeSyncStatus,
            nativeTitleManual: context.nativeManual ?? false,
            nativeTitle: shownNative,
            nativeTitleLabel,
          },
        };
        if (await this.options.repository.enqueue(adopted, previous.version))
          await this.project(adopted);
      } else if (
        previous.paneId !== paneId ||
        previous.sessionId !== context.sessionId ||
        // A failed native read reports no title; it never clears a known one.
        (shownNative !== null && (previous.metadata.nativeTitle ?? null) !== shownNative)
      ) {
        const rebound = {
          ...previous,
          paneId,
          sessionId: context.sessionId,
          revisionId: context.revisionId,
          version: previous.version + 1,
        };
        rebound.metadata = {
          ...previous.metadata,
          version: rebound.version,
          nativeTitle: shownNative ?? previous.metadata.nativeTitle ?? null,
          nativeTitleLabel,
        };
        if (await this.options.repository.enqueue(rebound, previous.version))
          await this.project(rebound);
      } else if (
        context.pane.taskMetadata?.taskKey !== previous.key ||
        context.pane.taskMetadata?.version !== previous.version ||
        context.pane.taskMetadata?.generationStatus !== previous.metadata.generationStatus ||
        context.pane.taskMetadata?.nativeSyncStatus !== previous.metadata.nativeSyncStatus ||
        context.pane.taskMetadata?.updatedAt !== previous.metadata.updatedAt
      )
        await this.project(previous);
      return this.options.store.getPane(paneId);
    }
    const version = (previous?.version ?? 0) + 1,
      now = this.now().toISOString();
    const firstTitle = trustedFirstTitle(context, previous?.title);
    // Until the model has summarized the request, the raw prompt is never the
    // title: keep the current line, else the CLI's own title, else a neutral name.
    const title =
      context.nativeManual &&
      context.nativeTitle &&
      !previous?.resetNativeManual
        ? context.nativeTitle
        : previous
          ? previous.title
          : (firstTitle ?? cleanNative ?? "New task");
    const fingerprint = taskRequestFingerprint(request);
    const pendingRequests = force
      ? [request]
      : [
          ...(previous?.pendingRequests ?? []).filter(
            (pending) => taskRequestFingerprint(pending) !== fingerprint,
          ),
          request,
        ].slice(-3);

    const extractedPlanId = await this.bindReferencedPlan(context);
    const planId = extractedPlanId ?? (previous?.metadata as { planId?: string | null } | undefined)?.planId ?? null;
    const topics = previous?.metadata.topics ?? [];

    const metadata: TaskMetadata = taskMetadataSchema.parse({
      taskKey: context.key,
      version,
      description: previous?.metadata.description ?? "",
      steps: previous?.metadata.steps ?? [],
      earlierWork: previous?.metadata.earlierWork ?? "",
      topics,
      source: previous?.metadata.source ?? (firstTitle ? "native" : "local"),
      generationStatus: "pending",
      nativeSyncStatus: context.nativeId ? "pending" : "unsupported",
      nativeTitleManual: context.nativeManual ?? false,
      nativeTitle: shownNative ?? previous?.metadata.nativeTitle ?? null,
      nativeTitleLabel,
      harnessSessionId:
        context.pane.mode === "HARNESS"
          ? (context.nativeId ?? undefined)
          : undefined,
      preferredCandidateId: previous?.preferredCandidateId ?? null,
      planId,
      updatedAt: now,
    });
    const state: TaskTitleState = {
      key: context.key,
      budgetKey: previous?.budgetKey ?? context.key,
      version,
      paneId,
      sessionId: context.sessionId,
      runtimeId: context.runtimeId,
      nativeId: context.nativeId,
      revisionId: context.revisionId,
      requestHash,
      request: safe(request, 3000),
      title,
      metadata,
      images,
      pendingRequests: pendingRequests.map((pending) => safe(pending, 3000)),
      regenerateLatest: force && topics.length > 0,
      resetNativeManual: previous?.resetNativeManual,
      lastNativeTitle: previous ? previous.lastNativeTitle ?? null : cleanNative,
      // The first summary runs at once; later ones keep the per-task minute gap.
      dueAt: new Date(
        Math.max(
          this.now().getTime() + (previous ? 3000 : 0),
          previous?.lastAttemptAt
            ? Date.parse(previous.lastAttemptAt) + 60_000
            : 0,
        ),
      ).toISOString(),
      lastAttemptAt: previous?.lastAttemptAt ?? null,
      preferredCandidateId: previous?.preferredCandidateId ?? null,
    };
    if (await this.options.repository.enqueue(state, previous?.version ?? 0))
      await this.project(state);
    return this.options.store.getPane(paneId);
  }
  bindHarnessSession(paneId: string, sessionId: string): Promise<Pane> {
    const prior = this.harnessBindings.get(paneId);
    const operation = (async () => {
      await prior?.catch(() => {});
      const pane = await this.options.store.getPane(paneId);
      if (
        pane.mode !== "HARNESS" ||
        pane.isClosed ||
        !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(sessionId)
      )
        throw Error("Invalid Harness task binding.");
      if (
        (pane.taskMetadata?.harnessSessionId ??
          `space-pane-${pane.id.slice(5)}`) === sessionId
      )
        return pane;
      const native = await this.options.harness?.read(paneId, sessionId);
      if (native?.sessionId !== sessionId)
        throw Error("Harness task is unavailable.");
      const currentPane = await this.options.store.getPane(paneId);
      if (this.stopped || currentPane.isClosed || currentPane.mode !== "HARNESS")
        throw Error("Harness pane is unavailable.");
      const metadata = taskMetadataSchema.parse({
        taskKey: `harness:${paneId}:${sessionId}`,
        version: 0,
        description: "",
        steps: [],
        source: "native",
        generationStatus: "unavailable",
        nativeSyncStatus: "pending",
        harnessSessionId: sessionId,
        updatedAt: this.now().toISOString(),
      });
      await this.options.store.updatePane(paneId, {
        taskMetadata: metadata,
        ...(currentPane.titleSource !== "manual"
          ? { title: shortTaskTitle(native.title ?? "", "Task") }
          : {}),
      });
      const event = await this.options.store.getLatestEvent(pane.roomId);
      if (event) this.options.eventBus.publish(event);
      return this.observe(paneId);
    })();
    this.harnessBindings.set(paneId, operation);
    void operation
      .finally(() => {
        if (this.harnessBindings.get(paneId) === operation)
          this.harnessBindings.delete(paneId);
      })
      .catch(() => {});
    return operation;
  }
  async policyChanged() {
    if (this.stopped) return;
    const policy = await this.options.repository.getSettings();
    if (!policy.enabled) return;
    for (const room of await this.options.store.listRooms())
      for (const pane of await this.options.store.listPanes(room.id)) {
        if (
          pane.isClosed ||
          !pane.taskMetadata ||
          pane.taskMetadata.generationStatus === "ready"
        )
          continue;
        const state = await this.options.repository.get(
          pane.taskMetadata.taskKey,
        );
        if (!state || state.dueAt || !state.request) continue;
        const version = state.version + 1;
        await this.options.repository.enqueue(
          {
            ...state,
            version,
            metadata: { ...state.metadata, version },
            dueAt: this.now().toISOString(),
          },
          state.version,
        );
      }
  }
  async setPreference(paneId: string, candidateId: string | null) {
    const context = await this.context(paneId);
    if (!context) return this.options.store.getPane(paneId);
    await this.observe(paneId);
    const state = await this.options.repository.get(context.key);
    if (!state) return this.options.store.getPane(paneId);
    const version = state.version + 1;
    const updated = {
      ...state,
      version,
      preferredCandidateId: candidateId,
      metadata: {
        ...state.metadata,
        version,
        preferredCandidateId: candidateId,
      },
    };
    if (await this.options.repository.enqueue(updated, state.version))
      await this.project(updated);
    return this.options.store.getPane(paneId);
  }
  async requestSync(paneId: string, resetNativeManual = false) {
    const context = await this.context(paneId);
    if (!context) return;
    let state = await this.options.repository.get(context.key);
    if (!state) {
      await this.observe(paneId);
      state = await this.options.repository.get(context.key);
      if (!state && context.nativeId) {
        const now = this.now().toISOString();
        const initial: TaskTitleState = {
          key: context.key,
          version: 1,
          paneId,
          sessionId: context.sessionId,
          runtimeId: context.runtimeId,
          nativeId: context.nativeId,
          revisionId: context.revisionId,
          requestHash: taskRequestHash(""),
          request: "",
          title: context.pane.title,
          dueAt: null,
          lastAttemptAt: null,
          preferredCandidateId: null,
          metadata: taskMetadataSchema.parse({
            taskKey: context.key,
            version: 1,
            description: "",
            steps: [],
            source: "local",
            generationStatus: "unavailable",
            nativeSyncStatus: "pending",
            updatedAt: now,
          }),
        };
        if (await this.options.repository.enqueue(initial, 0)) state = initial;
      }
      if (!state) {
        this.notify(paneId);
        return;
      }
    }
    const version = state.version + 1;
    const updated = {
      ...state,
      version,
      syncOnly: true,
      resetNativeManual,
      ...(resetNativeManual && context.nativeManual && state.request
        ? { title: state.metadata.topics?.at(-1)?.title ?? shortTaskTitle(state.request), syncOnly: false }
        : {}),
      metadata: {
        ...state.metadata,
        version,
        ...(resetNativeManual && context.nativeManual && state.request
          ? { generationStatus: "pending" as const }
          : {}),
        nativeSyncStatus: "pending" as const,
      },
      dueAt: this.now().toISOString(),
    };
    if (await this.options.repository.enqueue(updated, state.version))
      await this.project(updated);
  }
  private async project(state: TaskTitleState) {
    const pane = await this.paneIfPresent(state.paneId);
    if (!pane) return;
    const active =
      pane.mode === "HARNESS"
        ? {
            sessionId:
              pane.taskMetadata?.harnessSessionId ??
              `space-pane-${pane.id.slice(5)}`,
          }
        : pane.mode === "CHAT"
          ? await this.options.store.getActiveSpaceAgentSession(pane.id)
          : await this.options.store.getActivePaneCliSession(pane.id);
    if (!active || active.sessionId !== state.sessionId || pane.isClosed)
      return;
    const canonical = await this.options.repository.get(state.key);
    if (canonical?.version !== state.version) return;
    const updated = await this.options.store.applyTaskTitle(state);
    if (!updated) return;
    const event = await this.options.store.getLatestEvent(pane.roomId);
    if (event) this.options.eventBus.publish(event);
  }

  private async nativeSync(
    state: TaskTitleState,
  ): Promise<TaskMetadata["nativeSyncStatus"]> {
    if (!state.nativeId) return "unsupported";
    const context = await this.context(state.paneId);
    const canonical = await this.options.repository.get(state.key);
    if (
      !context ||
      context.key !== state.key ||
      context.sessionId !== state.sessionId ||
      canonical?.version !== state.version
    )
      return "pending";
    const pane = context.pane;
    const title = pane.titleSource === "manual" ? pane.title : state.title;
    try {
      if (
        this.options.nativeTitles &&
        ["cli:qwen", "cli:hermes"].includes(state.runtimeId)
      ) {
        const session = await this.options.store.getActivePaneCliSession(
          state.paneId,
        );
        if (!session || session.sessionId !== state.sessionId) return "pending";
        const result = await this.options.nativeTitles.metadata(
          session,
          {
            nativeId: state.nativeId,
            title,
            manual: pane.titleSource === "manual",
            resetManual: state.resetNativeManual,
          },
          this.abort.signal,
        );
        return result?.nativeId === state.nativeId && result.title === title
          ? "synced"
          : "failed";
      }
      if (state.runtimeId === "harness" && this.options.harness) {
        await this.options.harness.rename(state.paneId, state.sessionId, title);
        return "synced";
      }
      if (state.runtimeId === "cli:codex" || state.runtimeId === "codex") {
        // The authoritative name may already match after a prior write timed
        // out. Confirm it before issuing another mutation or retaining failure.
        if (this.options.readCodexName &&
          await this.options.readCodexName(state.sessionId, state.nativeId) === title)
          return "synced";
        if (this.options.renameCodex) {
          await this.options.renameCodex(
            state.sessionId,
            state.nativeId,
            title,
          );
          return "synced";
        }
        if (
          (await this.options.codex.getHistoryThread(state.nativeId)).title !==
          title
        )
          await this.options.codex.renameThread(state.nativeId, title);
        return (await this.options.codex.getHistoryThread(state.nativeId))
          .title === title
          ? "synced"
          : "failed";
      }
      if (
        state.runtimeId === "cli:opencode" ||
        state.runtimeId === "opencode"
      ) {
        const control = await readOpenCodeServerControl(
          state.sessionId,
          this.options.opencodeStateRoot,
        );
        if (!control || control.nativeSessionId !== state.nativeId)
          return "pending";
        if (
          (await fetchOpenCodeSessionTitle(control, state.nativeId))?.title !==
          title
        )
          await updateOpenCodeSessionTitle(control, state.nativeId, title);
        return (await fetchOpenCodeSessionTitle(control, state.nativeId))
          ?.title === title
          ? "synced"
          : "failed";
      }
      return "unsupported";
    } catch {
      return "failed";
    }
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.work) return this.work;
    if (this.now().getTime() < this.retryAt) return;
    this.work = this.run()
      .then(() => {
        this.consecutiveFailures = 0;
        this.retryAt = 0;
      })
      .catch((error) => {
        this.consecutiveFailures = Math.min(this.consecutiveFailures + 1, 5);
        this.retryAt = this.now().getTime() + Math.min(60_000, 5_000 * 2 ** (this.consecutiveFailures - 1));
        throw error;
      })
      .finally(() => {
        this.work = null;
      });
    return this.work;
  }
  /**
   * Apply one summary verdict: the first request becomes line 1 (named by a
   * trusted CLI title when one exists), the same work changes nothing, and
   * different work appends a new summarized line. `parsed` null is the local
   * fallback when no model could summarize.
   */
  private applyTitleLine(
    state: TaskTitleState,
    context: TaskTitleContext,
    parsed: { sameTopic: boolean; title: string; summary: string } | null,
    hasImages: boolean,
  ) {
    const topics = [...(state.metadata.topics ?? [])];
    const requests = state.pendingRequests?.length ? state.pendingRequests : [state.request];
    const at = this.now().toISOString();
    const line = (title: string, source: TaskTopic["source"]): TaskTopic => ({
      title,
      summary: parsed?.summary ?? "",
      source,
      at,
      ...(hasImages ? { hasImages: true } : {}),
    });
    const fallback = shortTaskTitle(requests.at(-1) ?? "", "Task");
    let earlierWork = state.metadata.earlierWork;
    const last = topics.at(-1);
    if (!last) {
      const native = trustedFirstTitle(context, state.title);
      topics.push(native ? line(native, "native") : parsed ? line(parsed.title, "ai") : line(fallback, "local"));
    } else if (parsed && (state.regenerateLatest || last.source === "local")) {
      // Regenerate, or replace a local placeholder line once a model answers.
      topics[topics.length - 1] = { ...line(parsed.title, "ai"), at: last.at };
    } else if (parsed?.sameTopic && !last.summary) {
      // A line named by the CLI before any model answered gets its summary now.
      topics[topics.length - 1] = { ...last, summary: parsed.summary };
    } else if (parsed ? !parsed.sameTopic : fallback !== last.title) {
      topics.push(parsed ? line(parsed.title, "ai") : line(fallback, "local"));
      while (topics.length > taskTopicsMax) {
        const dropped = topics.shift()!;
        earlierWork = safe([earlierWork, dropped.title].filter(Boolean).join("; "), 400);
      }
    }
    const current = topics.at(-1)!;
    state.title =
      context.nativeManual && context.nativeTitle && !state.resetNativeManual
        ? context.nativeTitle
        : current.title;
    state.metadata = {
      ...state.metadata,
      topics,
      description: current.summary || state.metadata.description,
      steps: titleLines(topics),
      earlierWork,
    };
    state.pendingRequests = [];
    state.regenerateLatest = false;
  }
  private async run() {
    const now = this.now().getTime();
    for (const [paneId, due] of [...this.dirty])
      if (due <= now) {
        this.dirty.delete(paneId);
        try {
          await this.observe(paneId);
        } catch (e) {
          if (!(await this.targetWasDeleted(paneId, e)))
            this.options.onError?.(e);
        }
      }
    const lease = await this.options.repository.claim(this.now().toISOString());
    if (!lease) return;
    const state = lease.state;
    try {
      const policy = await this.options.repository.getSettings();
      const context = await this.context(state.paneId);
      if (
        !context ||
        context.key !== state.key ||
        context.sessionId !== state.sessionId
      ) {
        await this.options.repository.finish(lease, { ...state, dueAt: null });
        return;
      }
      const latest = context.requests.at(-1);
      if (latest && taskRequestHash(latest, context.images ?? []) !== state.requestHash) {
        await this.observe(state.paneId);
        await this.options.repository.finish(lease, state);
        return;
      }
      const wantsSummary =
        policy.enabled &&
        !state.syncOnly &&
        state.metadata.generationStatus !== "ready" &&
        (await this.options.summaryAllowed?.(state.paneId) ?? true);
      const scope = this.imageScope(context.pane);
      const images = wantsSummary && scope && state.images?.length
        ? await readableTaskImages(state.images, scope)
        : [];
      const candidates = wantsSummary
        ? await this.options.providers.eligible(
            policy,
            state.preferredCandidateId,
            { images: images.length > 0 },
          )
        : [];
      let generated = state.metadata.generationStatus === "ready",
        deferred = false;
      let deferredUntil: number | null = null;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 65_000);
      const signal = AbortSignal.any([controller.signal, this.abort.signal]);
      try {
        for (const candidate of candidates.slice(0, 2)) {
          if (signal.aborted) break;
          const cooldowns = await this.options.repository.cooldowns(
            this.now().toISOString(),
          );
          if (
            cooldowns[candidate.id] ||
            cooldowns[`provider:${candidate.providerId}`]
          )
            continue;
          if (
            !(await this.options.repository.reserveAttempt(
              state.budgetKey ?? state.key,
              candidate.id,
              this.now().toISOString(),
              policy,
              lease.leaseId,
            ))
          ) {
            deferred = true;
            const attempted = await this.options.repository.latestAttempt(
              state.budgetKey ?? state.key,
            );
            if (
              attempted &&
              Date.parse(attempted) + 60_000 > this.now().getTime()
            )
              deferredUntil = Date.parse(attempted) + 60_000;
            break;
          }
          state.lastAttemptAt = this.now().toISOString();
          try {
            const shown = candidate.vision ? images : [];
            const parsed = parseTaskSummary(
              await candidate.generate(
                titleSummaryPrompt(state, { shown: shown.length, unseen: images.length - shown.length }),
                AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
                shown.length ? shown : undefined,
              ),
            );
            this.applyTitleLine(state, context, parsed, images.length > 0);
            state.metadata = {
              ...state.metadata,
              source: "ai",
              generationStatus: "ready",
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              updatedAt: this.now().toISOString(),
            };
            generated = true;
            break;
          } catch (error) {
            const delay =
              error instanceof TitleProviderFailure
                ? error.retryAfterSeconds
                : 300;
            const id =
              error instanceof TitleProviderFailure &&
              [401, 403, 429].includes(error.status)
                ? `provider:${candidate.providerId}`
                : candidate.id;
            await this.options.repository.cooldown(
              id,
              new Date(this.now().getTime() + delay * 1000).toISOString(),
            );
          }
        }
      } finally {
        clearTimeout(timeout);
      }
      if (!generated && !state.syncOnly) {
        state.metadata.generationStatus = deferred ? "deferred" : "unavailable";
        // No model result: show a local title line rather than nothing. With
        // summaries switched off every new request gets its own local line.
        const topics = state.metadata.topics ?? [];
        if (!topics.length || (!policy.enabled && state.pendingRequests?.length))
          this.applyTitleLine(state, context, null, Boolean(state.images?.length));
      }
      const current = await this.options.repository.get(state.key);
      if (current?.version !== state.version) {
        await this.options.repository.finish(lease, state);
        return;
      }
      state.metadata.nativeSyncStatus = await this.nativeSync(state);
      state.metadata.nativeTitleManual =
        state.metadata.nativeSyncStatus === "synced" && state.resetNativeManual
          ? false
          : (context.nativeManual ?? false);
      if (state.metadata.nativeSyncStatus === "synced")
        state.lastNativeTitle =
          context.pane.titleSource === "manual"
            ? context.pane.title
            : state.title;
      if (state.metadata.nativeSyncStatus === "synced")
        state.resetNativeManual = false;
      const retrySync = ["failed", "pending"].includes(
        state.metadata.nativeSyncStatus,
      );
      state.dueAt =
        state.syncOnly || generated || !policy.enabled
          ? retrySync
            ? new Date(this.now().getTime() + 300_000).toISOString()
            : null
          : new Date(
              deferredUntil ??
                this.now().getTime() + (deferred ? 3_600_000 : 300_000),
            ).toISOString();
      // A manual rename must not turn an unavailable summary into a new model request.
      if (!retrySync) {
        if (
          state.syncOnly &&
          state.metadata.generationStatus === "pending" &&
          policy.enabled
        )
          state.dueAt = new Date(this.now().getTime() + 60_000).toISOString();
        state.syncOnly = false;
      }
      if (await this.options.repository.finish(lease, state))
        await this.project(state);
    } catch (error) {
      const deleted = await this.targetWasDeleted(state.paneId, error);
      // Retain the task's history, but retire work whose pane was removed.
      state.dueAt = deleted ? null : new Date(this.now().getTime() + 300_000).toISOString();
      await this.options.repository.finish(lease, state);
      if (!deleted) this.options.onError?.(error);
    }
  }
}
