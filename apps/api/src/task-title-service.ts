import type { NativeTaskTitles } from "./task-title-native.js";
import { createHash } from "node:crypto";
import {
  boundedTaskText,
  cleanTaskText,
  shortTaskTitle,
  isSubstantiveTaskRequest,
  taskRequestFingerprint,
  taskMetadataSchema,
  type Pane,
  type TaskTitleState,
  type TaskMetadata,
  type PaneCliSession,
} from "@space/contracts";
import {
  redactMemoryText,
  type SpaceStore,
  type SpaceEventBus,
} from "@space/runtime";
import type { TaskTitleRepository } from "@space/db";
import {
  readOpenCodeServerControl,
  fetchOpenCodeSessionTitle,
  updateOpenCodeSessionTitle,
  openCodeServerBaseUrl,
} from "@space/opencode-control";
import type { CodexParityService } from "./codex-parity.js";
import {
  TaskTitleProviders,
  TitleProviderFailure,
} from "./task-title-providers.js";

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
}
/** Reconstruct submitted lines, not individual keystrokes or unsubmitted drafts. */
export function submittedTaskRequests(
  chunks: Array<{ stream: string; content: string }>,
): string[] {
  const requests: string[] = [];
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
      if (isSubstantiveTaskRequest(line)) requests.push(cleanTaskText(line));
      line = "";
    } else if (char >= " ") line = (line + char).slice(-8000);
  }
  return requests.slice(-12);
}
const hash = (text: string) =>
  createHash("sha256").update(taskRequestFingerprint(text)).digest("hex");
const safe = (text: string, limit: number) =>
  boundedTaskText(cleanTaskText(redactMemoryText(text)), limit);
export function titleSummaryPrompt(state: TaskTitleState): string {
  // UTF-8 bytes are a conservative token upper bound, including JSON framing.
  const bytes = (value: string, limit: number) => {
    let result = "",
      size = 0;
    for (const point of safe(value, 1800)) {
      size += Buffer.byteLength(point);
      if (size > limit) break;
      result += point;
    }
    return result;
  };
  const context = {
    currentTitle: bytes(state.title, 100),
    latestRequest: bytes(state.request, 800),
    previousSummary: bytes(
      state.previousSummary ?? state.metadata.description,
      260,
    ),
    earlierWork: bytes(state.metadata.earlierWork, 60),
    steps: state.metadata.steps.slice(-2).map((s) => bytes(s, 35)),
  };
  // Reduce by UTF-8 bytes, not UTF-16 length or grapheme count (a single
  // grapheme may contain thousands of combining characters). Every iteration
  // removes data and therefore terminates even with adversarial Unicode.
  for (const key of [
    "steps",
    "earlierWork",
    "currentTitle",
    "previousSummary",
    "latestRequest",
  ] as const) {
    while (Buffer.byteLength(JSON.stringify(context), "utf8") > 1400) {
      if (key === "steps") {
        if (!context.steps.length) break;
        context.steps.pop();
      } else {
        const points = Array.from(context[key]);
        if (!points.length) break;
        context[key] = points
          .slice(0, Math.floor(points.length * 0.75))
          .join("");
      }
    }
  }
  return JSON.stringify(context);
}
export function parseTaskSummary(raw: string) {
  if (raw.length > 12_000) throw new Error("Oversized task metadata");
  const value = JSON.parse(
    raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
  );
  if (
    typeof value.title !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.steps) ||
    value.steps.some((s: unknown) => typeof s !== "string")
  )
    throw new Error("Invalid task metadata");
  const title = shortTaskTitle(value.title),
    description = safe(value.description, 1800);
  if (!title || !description) throw new Error("Empty task metadata");
  return {
    title,
    description,
    steps: value.steps.slice(-5).map((s: string) => safe(s, 220)),
    earlierWork: safe(
      typeof value.earlierWork === "string" ? value.earlierWork : "",
      400,
    ),
  };
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
      now?: () => Date;
      onError?: (error: unknown) => void;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? new Date();
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
  private async reconcileActive() {
    const seen = new Set<string>();
    const rooms = await this.options.store.listRooms();
    for (const room of rooms) {
      for (const pane of await this.options.store.listPanes(room.id)) {
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
          ["cli:codex", "cli:opencode", "cli:qwen", "cli:hermes"].includes(
            pane.terminalRuntimeId ?? "",
          )
        ) {
          this.versions.set(pane.id, stamp);
          this.notify(pane.id);
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
    const pane = await store.getPane(paneId);
    if (pane.isClosed || pane.terminalRuntimeId === "cli:root") return null;
    let sessionId: string,
      runtimeId: string,
      nativeId: string | null = null,
      revisionId: string | null = null,
      key: string,
      accountKey = "default",
      requests: string[] = [],
      nativeTitle: string | null = null,
      nativeManual = false;
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
      requests = (await store.listSpaceAgentMessages(sessionId, 40))
        .filter((m) => m.role === "user")
        .map((m) => m.content);
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
      requests = submittedTaskRequests(
        await store.listPaneCliTranscriptChunks(sessionId, 200),
      );
      if (!requests.length && revision?.firstUserMessage)
        requests = [revision.firstUserMessage];
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
          const response = await fetch(
            `${openCodeServerBaseUrl(control.serverPort, control.serverHost)}/session/${encodeURIComponent(nativeId)}/message?limit=30`,
            {
              headers: {
                authorization: `Basic ${Buffer.from(`${control.serverUsername}:${control.serverPassword}`).toString("base64")}`,
              },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (response.ok) {
            const messages = (await response.json()) as any[];
            const native = messages
              .filter((m) => m.info?.role === "user")
              .map((m) =>
                (m.parts ?? [])
                  .filter(
                    (p: any) => p.type === "text" && !p.synthetic && !p.ignored,
                  )
                  .map((p: any) => p.text)
                  .join(" "),
              );
            if (native.length) requests = native;
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
        if (isSubstantiveTaskRequest(history.value.firstUserMessage ?? ""))
          requests = [history.value.firstUserMessage!];
      }
      if (thread.status === "fulfilled") {
        const native = thread.value.items
          .filter((i) => i.kind === "message" && i.role === "user")
          .map((i) => i.content)
          .filter(isSubstantiveTaskRequest);
        if (native.length) requests = native;
      }
      // Codex's native /resume name is separate from the legacy SQLite title.
      // Read the active thread's name over its exact private CLI socket.
      try {
        nativeTitle = (await this.options.readCodexName?.(sessionId, nativeId)) ?? nativeTitle;
      } catch {}
    }
    // A reused pane that switched native sessions must never inherit mutable metadata.
    if (nativeId) key = `native:${runtimeId}:${accountKey}:${nativeId}`;
    return {
      key,
      pane,
      sessionId,
      runtimeId,
      nativeId,
      revisionId,
      requests: requests.filter(isSubstantiveTaskRequest),
      nativeTitle,
      nativeManual,
    };
  }
  async observe(paneId: string, force = false): Promise<Pane> {
    const context = await this.context(paneId);
    if (!context) return this.options.store.getPane(paneId);
    const request = context.requests.at(-1);
    if (!request || !isSubstantiveTaskRequest(request)) return context.pane;
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
    const cleanNative =
      context.nativeTitle &&
      shortTaskTitle(context.nativeTitle) === context.nativeTitle &&
      !/^(?:New|Child) session|Untitled|^CLI \d/i.test(context.nativeTitle)
        ? context.nativeTitle
        : null;
    if (!force && previous?.requestHash === hash(request)) {
      if (
        cleanNative &&
        ((cleanNative !== previous.lastNativeTitle &&
          cleanNative !== previous.title) ||
          Boolean(context.nativeManual) !==
            Boolean(previous.metadata.nativeTitleManual)) &&
        context.pane.titleSource !== "manual"
      ) {
        const version = previous.version + 1;
        const adopted = {
          ...previous,
          paneId,
          sessionId: context.sessionId,
          revisionId: context.revisionId,
          version,
          title: cleanNative,
          lastNativeTitle: cleanNative,
          metadata: {
            ...previous.metadata,
            version,
            source: "native" as const,
            nativeSyncStatus: "synced" as const,
            nativeTitleManual: context.nativeManual ?? false,
          },
        };
        if (await this.options.repository.enqueue(adopted, previous.version))
          await this.project(adopted);
      } else if (
        previous.paneId !== paneId ||
        previous.sessionId !== context.sessionId
      ) {
        const rebound = {
          ...previous,
          paneId,
          sessionId: context.sessionId,
          revisionId: context.revisionId,
          version: previous.version + 1,
        };
        rebound.metadata = { ...previous.metadata, version: rebound.version };
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
    const initialNative = !previous ? cleanNative : null;
    const title =
      context.nativeManual &&
      context.nativeTitle &&
      !previous?.resetNativeManual
        ? context.nativeTitle
        : force && previous
          ? previous.title
          : (initialNative ?? shortTaskTitle(request, "Task"));
    const allSteps = [
      ...(previous?.metadata.steps ??
        context.requests.slice(-5).map((r) => safe(r, 220))),
      safe(request, 220),
    ];
    const steps = allSteps
      .filter((s, i, all) => all.indexOf(s) === i)
      .slice(-5);
    const metadata: TaskMetadata = taskMetadataSchema.parse({
      taskKey: context.key,
      version,
      description: safe(request, 1800),
      steps,
      earlierWork: safe(
        [previous?.metadata.earlierWork ?? "", ...allSteps.slice(0, -5)]
          .filter(Boolean)
          .join("; "),
        400,
      ),
      source: initialNative ? "native" : "local",
      generationStatus: "pending",
      nativeSyncStatus: context.nativeId ? "pending" : "unsupported",
      nativeTitleManual: context.nativeManual ?? false,
      harnessSessionId:
        context.pane.mode === "HARNESS"
          ? (context.nativeId ?? undefined)
          : undefined,
      preferredCandidateId: previous?.preferredCandidateId ?? null,
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
      requestHash: hash(request),
      request: safe(request, 3000),
      title,
      metadata,
      previousSummary: previous?.metadata.description ?? "",
      resetNativeManual: previous?.resetNativeManual,
      lastNativeTitle: context.nativeTitle,
      dueAt: new Date(
        Math.max(
          this.now().getTime() + 5000,
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
          requestHash: hash(""),
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
        ? { title: shortTaskTitle(state.request), syncOnly: false }
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
    const pane = await this.options.store.getPane(state.paneId);
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
    this.work = this.run().finally(() => {
      this.work = null;
    });
    return this.work;
  }
  private async run() {
    const now = this.now().getTime();
    for (const [paneId, due] of [...this.dirty])
      if (due <= now) {
        this.dirty.delete(paneId);
        try {
          await this.observe(paneId);
        } catch (e) {
          this.options.onError?.(e);
        }
      }
    const lease = await this.options.repository.claim(this.now().toISOString());
    if (!lease) return;
    const state = lease.state;
    const policy = await this.options.repository.getSettings();
    try {
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
      if (latest && hash(latest) !== state.requestHash) {
        await this.observe(state.paneId);
        await this.options.repository.finish(lease, state);
        return;
      }
      const candidates =
        policy.enabled &&
        !state.syncOnly &&
        state.metadata.generationStatus !== "ready"
          ? await this.options.providers.eligible(
              policy,
              state.preferredCandidateId,
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
            const parsed = parseTaskSummary(
              await candidate.generate(
                titleSummaryPrompt(state),
                AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              ),
            );
            state.title =
              context.nativeManual &&
              context.nativeTitle &&
              !state.resetNativeManual
                ? context.nativeTitle
                : parsed.title;
            state.metadata = {
              ...state.metadata,
              ...parsed,
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
      if (!generated && !state.syncOnly)
        state.metadata.generationStatus = deferred ? "deferred" : "unavailable";
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
      state.dueAt = new Date(this.now().getTime() + 300_000).toISOString();
      await this.options.repository.finish(lease, state);
      this.options.onError?.(error);
    }
  }
}
