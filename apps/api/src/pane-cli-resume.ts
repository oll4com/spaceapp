import { codexThreadIdSchema, resumePaneCliSessionResponseSchema, type AuthUser, type Pane } from "@space/contracts";
import { makeSpaceId, nowIso, SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceEventBus, type SpaceStore } from "@space/runtime";
import type { FastifyRequest } from "fastify";
import { resolveNativeTaskResume } from "./cli-native-task-resume.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { discoverAgentRuntimes, findRuntime, isCliRuntimeTerminalLaunchable } from "./cli-runtimes.js";
import type { createCliSessionAccounts } from "./cli-session-account-profile.js";
import { findSafeCodexThreadId, type CliTerminalManager, type CodexThreadFinder } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { buildSharedCliTaskContext } from "./codex-history-titles.js";
import type { CodexHistoryAccessCoordinator } from "./codex-history-purge.js";
import type { CodexParityService } from "./codex-parity.js";
import { availableNativeCodexThreadId, paneTitleFromCliTaskTitle } from "./pane-codex-thread.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import { getLatestRoomEvent } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import type { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";

/**
 * Resumes a Space CLI task in a pane: the exact native task history when the runtime has it (a Codex thread still running in
 * another pane is focused there instead), else a fresh session of the pane's CLI given the task's bounded context. The pane's
 * old session is held for its successor, and its terminals follow the new one; a resume that fails sends the old exit at once.
 */
/** The session whose account a resumed task keeps. Job Copilot keeps the task's account; a Gemini conversation lives in its
 * account's store, so `agy --conversation <id>` finds it only there (EXT-G-6, 2/11 dev: a resume on main opened another conversation). */
export function resumeAccountSource<S>(pane: Pick<Pane, "mode">, runtimeId: string, sourceTask: { runtimeId: string; session: S }): S | null {
  if (sourceTask.runtimeId !== runtimeId) return null;
  return pane.mode === "JOB_APPLY" || runtimeId === "cli:gemini" ? sourceTask.session : null;
}

export function createPaneCliResume(options: {
  store: SpaceStore;
  eventBus: Pick<SpaceEventBus, "publish">;
  config: SpaceApiConfig;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "assertEnabled">;
  unifiedCliTaskRegistry: Pick<UnifiedCliTaskRegistry, "getTask">;
  visibleCliRuntimeIds: () => Promise<string[]>;
  codexParity: CodexParityService;
  codexHistoryAccessCoordinator: Pick<CodexHistoryAccessCoordinator, "withHistoryAttachment">;
  resolveCliSessionAccountProfile: ReturnType<typeof createCliSessionAccounts>["resolveCliSessionAccountProfile"];
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<unknown>;
  findCodexThreadId?: CodexThreadFinder;
}) {
  const { store, eventBus, config, cliTerminalManager, cliRuntimeVisibility, unifiedCliTaskRegistry, visibleCliRuntimeIds, codexParity,
    codexHistoryAccessCoordinator, resolveCliSessionAccountProfile, assertRoomAccess } = options;
  async function resumePaneCliTask(pane: Pane, input: { taskId?: string; threadId?: string; accountProfileId?: string | null }, traceId: string, request?: FastifyRequest, requireNative = false) {
    const active = await store.getActivePaneCliSession(pane.id);
    const targetRuntimeId = pane.terminalRuntimeId ?? "cli:codex";
    await cliRuntimeVisibility.assertEnabled(targetRuntimeId);
    const sourceTaskReference = input.taskId ?? input.threadId;
    if (!sourceTaskReference) throw new SpaceNotFoundError("Space CLI task reference was not provided.");
    const sourceTask = await unifiedCliTaskRegistry.getTask(sourceTaskReference, await visibleCliRuntimeIds());
    if (requireNative && sourceTask.session.roomId !== pane.roomId) throw new SpaceConflictError("Room Agent can resume only tasks belonging to this room.");
    const paneTitle = paneTitleFromCliTaskTitle(sourceTask.title);
    const registry = await discoverAgentRuntimes(config);
    const runtime = findRuntime(registry, targetRuntimeId);
    if (!runtime) {
      throw new SpaceNotFoundError(`CLI runtime ${targetRuntimeId} was not found.`);
    }
    if (!runtime.capabilities.includes("CLI")) {
      throw new SpaceConflictError(`Runtime ${runtime.id} does not support CLI sessions.`);
    }
    if (!isCliRuntimeTerminalLaunchable(runtime)) {
      throw new SpaceFeatureDisabledError("CLI_RUNTIME_DISABLED", runtime.statusReason, {
        runtimeId: runtime.id,
        status: runtime.status
      });
    }
    if (active?.purpose === "LOGIN") {
      throw new SpaceConflictError("Cancel or complete CLI login before resuming a CLI task in this pane.");
    }
    const parsedNativeThreadId = codexThreadIdSchema.safeParse(sourceTask.revision.nativeTaskRef);
    const nativeThreadId = await availableNativeCodexThreadId(
      codexParity,
      runtime.id === "cli:codex" && sourceTask.runtimeId === "cli:codex" && parsedNativeThreadId.success
        ? parsedNativeThreadId.data
        : null
    );
    // Exact task-history resume for every other runtime comes from its registered resolver.
    const nativeResume = await resolveNativeTaskResume(runtime.id, { sourceTask, pane });
    const exactNativeResume = Boolean(nativeThreadId || nativeResume);
    if (requireNative && !exactNativeResume) throw new SpaceConflictError("Exact native resume is unavailable; the existing pane was preserved.");
    const mode = exactNativeResume
      ? "NATIVE_RESUME" as const
      : sourceTask.runtimeId === runtime.id
        ? "SPACE_FALLBACK" as const
        : "CROSS_RUNTIME_SHARE" as const;

    const resumeOperation = async () => {
      const stoppedSessionIds = new Set<string>();
      const stopSession = async (sessionId: string, statusReason: string) => {
        if (stoppedSessionIds.has(sessionId)) return;
        stoppedSessionIds.add(sessionId);
        cliTerminalManager.holdExitForReplacement(sessionId);
        await cliTerminalManager.interrupt(sessionId, undefined, traceId);
        await store.updatePaneCliSession(sessionId, { status: "EXITED", statusReason, isActive: false, endedAt: nowIso() }, traceId);
      };

      if (nativeThreadId) {
        const threadOwner = await store.getActivePaneCliSessionByCodexThreadId(nativeThreadId);
        let owner = threadOwner;
        if (!owner) {
          for (const candidate of await store.listActivePaneCliSessions("cli:codex")) {
            if (candidate.status !== "RUNNING") continue;
            const heldThread = await (options.findCodexThreadId ?? findSafeCodexThreadId)({
              paneId: candidate.paneId, sessionId: candidate.sessionId, cwd: candidate.cwd
            });
            if (heldThread === nativeThreadId) { owner = candidate; break; }
          }
        }
        if (owner && (owner.status === "RUNNING" || owner.status === "IDLE")) {
          if (request) await assertRoomAccess(owner.roomId, request.user);
          if (requireNative && owner.roomId !== pane.roomId) {
            throw new SpaceConflictError("The task is already active in another room.");
          }
          const ownerPane = await store.getPane(owner.paneId);
          if (ownerPane.isClosed) throw new SpaceConflictError("The task is still active in a closed pane. Reopen that pane to continue.");
          return resumePaneCliSessionResponseSchema.parse({
            ...(await buildPaneCliSessionResponse({
              store, runtime, sessionId: owner.sessionId, includeWebsocket: false,
              tokenTtlMs: config.cliTokenTtlMs,
              issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
            })),
            pane: ownerPane, mode: "NATIVE_RESUME", focusExisting: true
          });
        }
      }
      if (active) {
        await stopSession(active.sessionId, "CLI session replaced to resume a previous task.");
      }

      const allocatedAtNs = process.hrtime.bigint();
      const nextSessionId = makeSpaceId("cli_session");
      const sameRuntime = sourceTask.runtimeId === runtime.id;
      const accountProfileId = await resolveCliSessionAccountProfile({
        paneId: pane.id, runtimeId: runtime.id, accountProfileId: input.accountProfileId, previousSession: active,
        sourceSession: resumeAccountSource(pane, runtime.id, sourceTask)
      });
      const allocatedSession = await store.createPaneCliSession(
        {
          sessionId: nextSessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          runtimeId: runtime.id,
          providerId: runtime.providerId,
          agentId: runtime.agentId,
          modelId: sameRuntime
            ? sourceTask.revision.modelId ?? pane.modelId ?? runtime.defaultModelId
            : pane.modelId ?? runtime.defaultModelId,
          reasoningEffort: sameRuntime ? sourceTask.revision.reasoningEffort : pane.reasoningEffort,
          launchMode: exactNativeResume ? "RESUME" : "FRESH",
          cwd: sameRuntime ? sourceTask.revision.cwd ?? pane.cwd ?? "/etc" : pane.cwd ?? "/etc",
          codexThreadId: null,
          cliTaskId: sourceTask.taskId,
          accountProfileId,
          status: "IDLE",
          statusReason: "CLI session allocated; waiting for terminal transport attach."
        },
        traceId
      );
      cliTerminalManager.recordSessionAllocation(allocatedSession.sessionId, allocatedAtNs);

      if (nativeResume?.afterAllocate) {
        await nativeResume.afterAllocate(pane.id);
      }

      if (nativeThreadId) {
        await store.claimPaneCliCodexThread(
          allocatedSession.sessionId,
          nativeThreadId,
          "HISTORY_TRANSFER",
          traceId
        );
      }
      let session = (await store.getPaneCliSession(allocatedSession.sessionId)) ?? allocatedSession;
      if (session.cliTaskRevisionId) {
        await store.updateCliTaskRevision(
          session.cliTaskRevisionId,
          {
            displayTitle: paneTitle,
            firstUserMessage: sourceTask.firstUserMessage,
            preview: sourceTask.preview,
            cwd: session.cwd,
            modelId: session.modelId,
            reasoningEffort: session.reasoningEffort,
            ...(nativeThreadId
              ? { nativeTaskRef: nativeThreadId }
              : nativeResume?.persistAsNativeTaskRef
                ? { nativeTaskRef: nativeResume.ref }
                : {})
          },
          traceId
        );
      }
      await store.appendPaneCliTranscriptChunk(
        {
          sessionId: session.sessionId,
          paneId: pane.id,
          roomId: pane.roomId,
          sequence: 0,
          stream: "system",
          content: exactNativeResume
            ? `Resuming ${sourceTask.title} from exact ${runtime.displayName} task history.`
            : `Loaded bounded untrusted context from Space CLI task ${sourceTask.title} into a fresh ${runtime.displayName} session.`
        },
        traceId
      );
      if (!exactNativeResume) {
        const sharedContext = buildSharedCliTaskContext({
          sourceTaskId: sourceTask.taskId,
          sourceRuntimeLabel: sourceTask.providerLabel,
          sourceTitle: sourceTask.title,
          sourceFirstUserMessage: sourceTask.firstUserMessage,
          targetRuntimeLabel: runtime.displayName,
          transcript: sourceTask.transcript
        });
        const inputKey = `shared-history:${sourceTask.taskId}:${session.sessionId}`;
        // Hermes 0.22 reads an Enter inside a multi-character read as a newline, so its context stayed an unsent draft
        // (ADAPTER-013, dev 4/11): it is typed and submitted like every Space Control prompt.
        if (runtime.id === "cli:hermes") await submitCliPrompt(cliTerminalManager, session.sessionId, sharedContext.replace(/\r$/, ""), traceId, inputKey);
        else await cliTerminalManager.sendInput(
          session.sessionId,
          // omp 18 holds a paste of 100+ lines on a menu unless its submit shares the paste's read (ADAPTER-013, dev 4/11);
          // the context carries no escape sequences, so the paste cannot end early.
          runtime.id === "cli:omp" ? `\u001b[200~${sharedContext.replace(/\r$/, "")}\u001b[201~\r` : sharedContext,
          traceId,
          null,
          inputKey
        );
        session = (await store.getPaneCliSession(session.sessionId)) ?? session;
      }
      const updatedPane = await store.updatePane(
        pane.id,
        // A copilot, Design or App Studio pane keeps its own title; its name (e.g. "Cody") is the pane name either way.
        { ...(pane.mode === "TERMINAL" ? { title: paneTitle } : {}), cwd: session.cwd, terminalRuntimeId: runtime.id },
        traceId
      );
      const latestEvent = await getLatestRoomEvent(store, updatedPane.roomId);
      if (latestEvent) eventBus.publish(latestEvent);
      if (active) cliTerminalManager.announceReplacement(active.sessionId, session.sessionId);

      if (request) await recordAudit(store, request, {
        action: "pane.cli.resume",
        targetType: "pane",
        targetId: pane.id,
        metadata: {
          roomId: pane.roomId,
          runtimeId: runtime.id,
          sessionId: session.sessionId,
          mode,
          sourceTaskId: sourceTask.taskId,
          sourceRevisionId: sourceTask.revision.revisionId,
          targetRevisionId: session.cliTaskRevisionId,
          sourceRuntimeId: sourceTask.runtimeId,
          codexThreadId: nativeThreadId,
          ...nativeResume?.auditMetadata
        }
      });
      return resumePaneCliSessionResponseSchema.parse({
        ...(await buildPaneCliSessionResponse({
          store,
          runtime,
          sessionId: session.sessionId,
          includeWebsocket: Boolean(request),
          tokenTtlMs: config.cliTokenTtlMs,
          issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
        })),
        pane: updatedPane,
        mode
      });
    };

    // A resume that failed after the hold sends the old session's exit at once: there is no successor to follow.
    return (nativeThreadId ? codexHistoryAccessCoordinator.withHistoryAttachment(resumeOperation) : resumeOperation()).catch((error: unknown) => {
      if (active) cliTerminalManager.announceReplacement(active.sessionId, null);
      throw error;
    });
  }
  return { resumePaneCliTask };
}
