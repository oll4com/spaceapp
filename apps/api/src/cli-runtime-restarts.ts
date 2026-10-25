import {
  cliRuntimeRestartAllResultSchema,
  cliRuntimeRestartSessionsResultSchema,
  cliToggleRuntimeIdSchema,
  type AgentRuntime,
  type CliRuntimeRestartAllResult,
  type CliRuntimeRestartSessionsResult,
  type CliToggleRuntimeId,
  type PaneCliSession
} from "@space/contracts";
import { SpaceConflictError, nowIso, type SpaceStore } from "@space/runtime";

export interface CliRuntimeSessionRestarter {
  (session: PaneCliSession, runtime: AgentRuntime, traceId: string): Promise<PaneCliSession>;
}

export interface CliRuntimeRestartPaneGuard {
  (paneId: string, runtimeId: string): Promise<void>;
}

export interface CliRuntimeRestartContext {
  store: SpaceStore;
  traceId: string;
  restarter: CliRuntimeSessionRestarter;
  guardPane: CliRuntimeRestartPaneGuard;
}

export async function restartCliRuntimeSessions(
  context: CliRuntimeRestartContext,
  runtimeId: CliToggleRuntimeId,
  runtime: AgentRuntime
): Promise<CliRuntimeRestartSessionsResult> {
  const sessions = await context.store.listActivePaneCliSessions(runtimeId);
  const requestedSessionIds = sessions
    .filter((session) => session.purpose === "NORMAL")
    .map((session) => session.sessionId);
  const restartedSessionIds: string[] = [];
  const replacementSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  for (const session of sessions) {
    if (session.purpose !== "NORMAL") {
      failedSessionIds.push(session.sessionId);
      continue;
    }
    try {
      await context.guardPane(session.paneId, runtimeId);
      const replacement = await context.restarter(session, runtime, context.traceId);
      if (
        replacement.paneId !== session.paneId ||
        replacement.runtimeId !== runtimeId ||
        replacement.sessionId === session.sessionId
      ) {
        throw new SpaceConflictError(`CLI session ${session.sessionId} returned an invalid restart replacement.`);
      }
      restartedSessionIds.push(session.sessionId);
      replacementSessionIds.push(replacement.sessionId);
    } catch {
      failedSessionIds.push(session.sessionId);
    }
  }
  return cliRuntimeRestartSessionsResultSchema.parse({
    runtimeId,
    requestedSessionIds,
    restartedSessionIds,
    replacementSessionIds,
    failedSessionIds
  });
}

export async function restartAllCliRuntimes(
  context: CliRuntimeRestartContext,
  runtimes: AgentRuntime[],
  isRuntimeRestartable: (runtime: AgentRuntime) => boolean
): Promise<CliRuntimeRestartAllResult> {
  const requestedRuntimes: CliToggleRuntimeId[] = [];
  const restartedSessionIds: string[] = [];
  const replacementSessionIds: string[] = [];
  const failedSessionIds: string[] = [];
  for (const runtime of runtimes) {
    if (!isRuntimeRestartable(runtime)) continue;
    const parsedRuntimeId = cliToggleRuntimeIdSchema.safeParse(runtime.id);
    if (!parsedRuntimeId.success) continue;
    const result = await restartCliRuntimeSessions(context, parsedRuntimeId.data, runtime);
    if (result.requestedSessionIds.length > 0) {
      requestedRuntimes.push(parsedRuntimeId.data);
    }
    restartedSessionIds.push(...result.restartedSessionIds);
    replacementSessionIds.push(...result.replacementSessionIds);
    failedSessionIds.push(...result.failedSessionIds);
  }
  return cliRuntimeRestartAllResultSchema.parse({
    requestedRuntimes,
    restartedSessionIds,
    replacementSessionIds,
    failedSessionIds,
    checkedAt: nowIso()
  });
}
