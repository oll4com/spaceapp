import type {} from "./request-context.js";
import type { FastifyRequest } from "fastify";
import { cliLoginResponseSchema, type Pane, type PaneCliSession } from "@space/contracts";
import { SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import { type createAgentRuntimeRegistryCache, findRuntime, isCliRuntimeLoginLaunchable } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { buildPaneCliSessionResponse } from "./pane-cli-session-response.js";
import { getLatestRoomEvent } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";

/**
 * Opens a terminal login for a CLI in a room: reuses the room's login pane and its live login session when there is one,
 * else opens a TERMINAL pane and a LOGIN session in /etc, schedules the login timeout and audits room.cli.login.
 * Shared by the CLI account routes and the CLI auth handoff routes.
 */
export function createCliLoginOpener(options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read">;
  cliTerminalManager: CliTerminalManager;
}) {
  const { config, store, eventBus, cliRuntimeVisibility, cliRuntimeRegistryCache, cliTerminalManager } = options;
  const openCliLogin = async (
    request: FastifyRequest,
    roomId: string,
    runtimeId: string
  ) => {
    const startedAtMs = Date.now();
    await cliRuntimeVisibility.assertEnabled(runtimeId);
    await store.getRoom(roomId);

    const loginRuntimeIds = new Set([
      "cli:codex",
      "cli:claude",
      "cli:gemini",
      "cli:qwen",
      "cli:autohand",
      "cli:kimi",
      "cli:grok",
      "cli:deepseek",
      "cli:cursor",
      "cli:copilot"
    ]);
    if (!loginRuntimeIds.has(runtimeId)) {
      throw new SpaceConflictError(`CLI runtime ${runtimeId} does not support terminal login.`);
    }

    const registry = await cliRuntimeRegistryCache.read();
    const runtime = findRuntime(registry, runtimeId);
    if (!runtime) throw new SpaceNotFoundError(`CLI runtime ${runtimeId} was not found.`);
    if (!runtime.capabilities.includes("CLI") || !isCliRuntimeLoginLaunchable(runtime)) {
      throw new SpaceFeatureDisabledError("CLI_LOGIN_UNAVAILABLE", runtime.authReason, {
        runtimeId: runtime.id,
        authState: runtime.authState
      });
    }

    let pane: Pane | null = null;
    let latestLoginSession: PaneCliSession | null = null;
    for (const candidate of await store.listPanes(roomId)) {
      if (candidate.mode !== "TERMINAL" || candidate.terminalRuntimeId !== runtime.id) continue;
      const activeCandidateSession = await store.getActivePaneCliSession(candidate.id);
      if (activeCandidateSession?.purpose === "NORMAL") continue;
      const candidateLoginSession = (await store.listPaneCliSessions(candidate.id, 20))
        .find((session) => session.runtimeId === runtime.id && session.purpose === "LOGIN");
      if (!candidateLoginSession) continue;
      pane = candidate;
      latestLoginSession = candidateLoginSession;
      break;
    }

    const reused = pane !== null;
    if (!pane) {
      await cliRuntimeVisibility.assertEnabled(runtime.id);
      pane = await store.createPane(
        {
          roomId,
          title: runtime.displayName,
          mode: "TERMINAL",
          terminalRuntimeId: runtime.id,
          cwd: "/etc"
        },
        request.requestIdForSpace
      );
      const latestEvent = await getLatestRoomEvent(store, roomId);
      if (latestEvent) eventBus.publish(latestEvent);
    }

    const reusableSession = latestLoginSession?.isActive &&
      latestLoginSession.status !== "EXITED" && latestLoginSession.status !== "ERROR"
      ? latestLoginSession
      : null;
    await cliRuntimeVisibility.assertEnabled(runtime.id);
    const allocatedAtNs = reusableSession ? null : process.hrtime.bigint();
    const session = reusableSession ?? await store.createPaneCliSession(
      {
        paneId: pane.id,
        roomId: pane.roomId,
        runtimeId: runtime.id,
        providerId: runtime.providerId,
        agentId: runtime.agentId,
        modelId: null,
        reasoningEffort: pane.reasoningEffort,
        launchMode: "FRESH",
        purpose: "LOGIN",
        cwd: "/etc",
        codexThreadId: null,
        status: "IDLE",
        statusReason: "CLI login allocated; waiting for terminal transport attach."
      },
      request.requestIdForSpace
    );
    if (allocatedAtNs !== null) cliTerminalManager.recordSessionAllocation(session.sessionId, allocatedAtNs);
    cliTerminalManager.scheduleLoginTimeout(session);

    await recordAudit(store, request, {
      action: "room.cli.login",
      targetType: "runtime",
      targetId: runtime.id,
      metadata: {
        runtimeId: runtime.id,
        outcome: reusableSession ? "REUSED_ACTIVE" : reused ? "RETRIED" : "OPENED",
        durationMs: Math.min(300_000, Date.now() - startedAtMs)
      }
    });

    return cliLoginResponseSchema.parse({
      pane,
      session: await buildPaneCliSessionResponse({
        store,
        runtime,
        sessionId: session.sessionId,
        includeWebsocket: true,
        includeTranscript: false,
        tokenTtlMs: config.cliTokenTtlMs,
        issueTicket: (paneId, sessionId, ttlMs) => cliTerminalManager.issueTicket(paneId, sessionId, ttlMs)
      }),
      reused
    });
  };

  return openCliLogin;
}
