import { appendFile, mkdir } from "node:fs/promises";
import { PANE_CATALOG_VERSION, paneCountsSchema, PANE_TYPES, isAgentRuntimeReady, type AntigravityUsageAccountList, type Pane } from "@space/contracts";
import { SpaceConflictError, makeSpaceId, type SpaceStore } from "@space/runtime";
import type { createCliSessionAccounts } from "./cli-session-account-profile.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { createAgentRuntimeRegistryCache } from "./cli-runtimes.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { createRoomPaneCommands } from "./room-pane-commands.js";
import type { createSpaceControlPaneActions } from "./space-control-pane-actions.js";
import type { ControlActor } from "./space-control-settings.js";
import type { ResourceAction } from "./space-control-resources.js";
import { youtubeBrowserPlayback, type YouTubePlaybackStore } from "./youtube-playback-state.js";

// R84 12/11 (5 panes.open failures in 7 d on "job-copilot", "jobcopilot", "job", "mail_copilot"): a key is read as a type's id, label or
// alias, or the one type whose names it starts; a key that fits none names the types.
export function paneCountsByName(counts: unknown) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return counts;
  const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = PANE_TYPES.flatMap(type => [type.typeId, type.label, ...type.aliases].map(name => [compact(name), type.typeId] as const));
  const resolved: Record<string, unknown> = {};
  for (const [key, count] of Object.entries(counts)) {
    const want = compact(key);
    const exact = PANE_TYPES.find(type => type.typeId === key)?.typeId ?? names.find(([name]) => name === want)?.[1];
    const started = want.length >= 3 ? [...new Set(names.filter(([name]) => name.startsWith(want)).map(([, typeId]) => typeId))] : [];
    const typeId = exact ?? (started.length === 1 ? started[0] : undefined);
    if (!typeId) throw new SpaceConflictError(`Unknown pane type '${key}'. Use one of: ${PANE_TYPES.map(type => type.typeId).join(", ")}`);
    resolved[typeId] = typeof resolved[typeId] === "number" && typeof count === "number" ? (resolved[typeId] as number) + count : count;
  }
  return resolved;
}

type SpaceControlPanesOpenDeps = {
  store: SpaceStore;
  cliTerminalManager: CliTerminalManager;
  cliRuntimeRegistryCache: Pick<ReturnType<typeof createAgentRuntimeRegistryCache>, "read" | "readFresh">;
  cliRuntimeVisibility: Pick<CliRuntimeVisibilityPolicy, "enabledRuntimeIds">;
  gatewayCliAccounts: Pick<ReturnType<typeof createCliSessionAccounts>["gatewayCliAccounts"], "openProfileId">;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  roomPaneCommands: Pick<ReturnType<typeof createRoomPaneCommands>, "execute">;
  youtubePlaybackStore: Pick<YouTubePlaybackStore, "save">;
} & Pick<ReturnType<typeof createSpaceControlPaneActions>, "controlSend">;

/**
 * Space Control's panes.open: the requested pane counts checked against the catalog and the room's free slots (clipped in
 * catalog order to fit), unavailable CLI types dropped, a Gemini pane bound to the Google account with the most quota left
 * (or the one asked for) and given the task prompt, YouTube panes given their video; with debug on, every refusal answers
 * an incident report (also kept in the live voice logs) instead of an error.
 */
export function createSpaceControlPanesOpen(deps: SpaceControlPanesOpenDeps) {
  const { store, cliTerminalManager, cliRuntimeRegistryCache, cliRuntimeVisibility, gatewayCliAccounts, antigravityUsageProvider, roomPaneCommands,
    youtubePlaybackStore, controlSend } = deps;
  async function openControlPanes(actor: ControlActor, roomId: string, action: ResourceAction) {
    const recordDebugIncident = async (incident: Record<string, unknown>) => {
      try {
        const dir = "/opt/spaceapp/var/live-voice-logs";
        await mkdir(dir, { recursive: true });
        await appendFile(`${dir}/debug-incidents.jsonl`, JSON.stringify(incident) + "\n", "utf8");
      } catch (err) {
        console.warn("Failed to write debug incident log:", err);
      }
    };

    const isDebug = Boolean((action.input as any)?.debug);
    const originalCounts = paneCountsSchema.parse(paneCountsByName(action.input.counts));
    const supportedTypeIds = new Set(PANE_TYPES.map(t => t.typeId));
    for(const [id,count] of Object.entries(originalCounts)) {
      if(count>0&&!supportedTypeIds.has(id as any)) {
        const err = `Unsupported pane runtime requested: '${id}'. Supported types: ${Array.from(supportedTypeIds).join(', ')}`;
        if (isDebug) {
          const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const diagnosis = {
            incidentId,
            timestamp: new Date().toISOString(),
            operation: "panes.open",
            roomId,
            counts: originalCounts,
            failureReason: err,
            probableCause: `Pane type '${id}' is not in the system catalog`,
            recommendedFix: `Choose from supported pane types: ${Array.from(supportedTypeIds).join(', ')}`,
            agentHandoffPrompt: `Space agent incident report ${incidentId}: Requested invalid pane type '${id}' in room ${roomId}.`
          };
          void recordDebugIncident(diagnosis);
          return { status: "FAILED", isError: true, error: err, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
        }
        throw new SpaceConflictError(err);
      }
    }

    // Fast visible path: parallel preflights (room + panes + runtimes in one round).
    const [room, allPanes, cachedRegistry, enabledIds] = await Promise.all([
      store.getRoom(roomId),
      store.listPanes(roomId, false),
      cliRuntimeRegistryCache.read().catch(() => ({ data: [] })),
      cliRuntimeVisibility.enabledRuntimeIds().catch(() => [])
    ]);
    let registry = cachedRegistry;
    const activePanes = allPanes.filter(p => !p.isClosed);
    const totalRequested = Object.values(originalCounts).reduce((s, c) => s + (typeof c === "number" ? c : 0), 0);
    const slots = Math.max(0, room.paneCap - activePanes.length);
    if (slots <= 0) {
      const overMsg = `Room capacity exceeded: room currently has ${activePanes.length} open panes, maximum capacity is ${room.paneCap} panes. No free slots for ${totalRequested} requested panes.`;
      const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const diagnosis = {
        incidentId,
        timestamp: new Date().toISOString(),
        operation: "panes.open",
        roomId,
        counts: originalCounts,
        roomCapacity: { currentOpen: activePanes.length, maxAllowed: room.paneCap, requested: totalRequested, freeSlots: 0 },
        failureReason: overMsg,
        probableCause: `Room maximum capacity of ${room.paneCap} panes has been reached.`,
        recommendedFix: `Close unused panes or adjust paneCap in settings.`,
        agentHandoffPrompt: `Space agent incident report ${incidentId}: Room ${roomId} capacity exceeded (${activePanes.length}/${room.paneCap} panes). Cannot open ${totalRequested} new panes. Close idle panes.`
      };
      void recordDebugIncident(diagnosis);
      if (isDebug) {
        return { status: "FAILED", isError: true, error: overMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
      }
      throw new SpaceConflictError(overMsg);
    }
    // Fill-up-to-cap: clip counts in catalog order when request exceeds free slots.
    let counts: Record<string, number> = { ...(originalCounts as Record<string, number>) };
    let clipped = false;
    if (totalRequested > slots) {
      const effective: Record<string, number> = {};
      let remaining = slots;
      for (const t of PANE_TYPES) {
        const asked = (originalCounts as Record<string, number>)[t.typeId] ?? 0;
        if (!asked || asked <= 0) continue;
        if (remaining <= 0) break;
        const take = Math.min(asked, remaining);
        if (take > 0) effective[t.typeId] = take;
        remaining -= take;
      }
      counts = effective;
      clipped = true;
    }

    // Preflight CLI runtimes readiness check (effective counts only).
    // Default policy: unavailable types are treated as non-existent — drop them
    // silently and open the rest instead of failing the whole batch.
    const enabledSet = new Set(enabledIds);
    // 4/11 lab: a sign-in outside Space's login flow leaves "login required" cached; a type about to be dropped is read fresh once.
    const notReady = (data: typeof cachedRegistry.data) => Object.entries(counts).some(([id, count]) => {
      const runtimeId = count > 0 ? PANE_TYPES.find(p => p.typeId === id)?.runtimeId : undefined;
      const runtime = runtimeId && enabledSet.has(runtimeId) ? data.find((r) => r.id === runtimeId) : undefined;
      return !!runtime && !isAgentRuntimeReady(runtime);
    });
    if (notReady(registry.data)) registry = await cliRuntimeRegistryCache.readFresh().catch(() => registry);
    const runtimesMap = new Map(registry.data.map((r: any) => [r.id, r]));
    const droppedUnavailable: Array<{ typeId: string; label: string; reason: string }> = [];

    for (const [id, count] of Object.entries(counts)) {
      if (!count || count <= 0) continue;
      const def = PANE_TYPES.find(p => p.typeId === id);
      if (def?.runtimeId) {
        const runtime = runtimesMap.get(def.runtimeId);
        if (!enabledSet.has(def.runtimeId) || (runtime && !isAgentRuntimeReady(runtime))) {
          droppedUnavailable.push({ typeId: id, label: def.label, reason: "Unavailable." });
          delete counts[id];
          continue;
        }
      }
    }
    if (Object.keys(counts).length === 0) {
      throw new SpaceConflictError(`Nothing to open: all requested pane types are currently unavailable.`);
    }

    const geminiGateway = counts.gemini ? await gatewayCliAccounts.openProfileId("cli:gemini", (action.input as any)?.accountProfileId) : null;
    let selectedGeminiAccount: { id: string; email: string | null; remainingPercent: number | null } | null = geminiGateway ? { id: geminiGateway, email: null, remainingPercent: null } : null;
    if (!geminiGateway && counts.gemini && counts.gemini > 0) {
      const usageList = await antigravityUsageProvider().catch(() => ({ data: [] }));
      const availableAccounts = usageList.data.filter((acc) => {
        const isConnected = acc.status === "CONNECTED";
        const rem5h = acc.gemini?.fiveHourRemainingPercent ?? 0;
        const remWeekly = acc.gemini?.weeklyRemainingPercent ?? 0;
        return isConnected && rem5h > 0 && remWeekly > 0;
      });
      const requestedProfileId = typeof (action.input as any)?.accountProfileId === "string" ? (action.input as any).accountProfileId : null;
      if (requestedProfileId) {
        const match = availableAccounts.find((a) => a.id === requestedProfileId);
        if (!match) {
          const requestedAcc = usageList.data.find((a) => a.id === requestedProfileId);
          const reason = requestedAcc ? `Account ${requestedProfileId} quota exhausted or status is ${requestedAcc.status}.` : `Account ${requestedProfileId} not found.`;
          const errMsg = `Requested Gemini Google account is not available: ${reason}`;
          if (isDebug) {
            const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const diagnosis = {
              incidentId,
              timestamp: new Date().toISOString(),
              operation: "panes.open",
              roomId,
              counts,
              failureReason: errMsg,
              probableCause: "Gemini account quota exhausted or account disconnected",
              recommendedFix: "Select another connected Google account or wait for quota reset",
              agentHandoffPrompt: `Space agent incident report ${incidentId}: Gemini account ${requestedProfileId} unavailable in room ${roomId}. ${reason}`
            };
            void recordDebugIncident(diagnosis);
            return { status: "FAILED", isError: true, error: errMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
          }
          throw new SpaceConflictError(errMsg);
        }
        selectedGeminiAccount = { id: match.id, email: match.email, remainingPercent: match.gemini?.fiveHourRemainingPercent ?? null };
      } else {
        if (availableAccounts.length === 0) {
          const exhaustedReset = usageList.data.find((a) => a.status === "CONNECTED" && a.gemini?.fiveHourResetAt)?.gemini?.fiveHourResetAt;
          const resetMsg = exhaustedReset ? ` (next reset at ${exhaustedReset})` : "";
          const errMsg = `No Google account with available quota/tokens found for Gemini CLI${resetMsg}. Fallback: wait for quota reset or check licenses.`;
          if (isDebug) {
            const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const diagnosis = {
              incidentId,
              timestamp: new Date().toISOString(),
              operation: "panes.open",
              roomId,
              counts,
              failureReason: errMsg,
              probableCause: "All Gemini Google accounts have exhausted their 5h or weekly quotas",
              recommendedFix: "Wait for quota reset or connect additional Google accounts in Space App",
              agentHandoffPrompt: `Space agent incident report ${incidentId}: All Google accounts exhausted for Gemini CLI in room ${roomId}.${resetMsg}`
            };
            void recordDebugIncident(diagnosis);
            return { status: "FAILED", isError: true, error: errMsg, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
          }
          throw new SpaceConflictError(errMsg);
        }
        availableAccounts.sort((a, b) => (b.gemini?.fiveHourRemainingPercent ?? 0) - (a.gemini?.fiveHourRemainingPercent ?? 0));
        const best = availableAccounts[0]!;
        selectedGeminiAccount = { id: best.id, email: best.email, remainingPercent: best.gemini?.fiveHourRemainingPercent ?? null };
      }
    }

    let batchResult: any;
    try {
      batchResult = await roomPaneCommands.execute(roomId,actor.id,{requestId:makeSpaceId("control_open"),catalogVersion:PANE_CATALOG_VERSION,action:{type:"OPEN_PANES",counts}},makeSpaceId("trace"));
    } catch (err: any) {
      const errDetail = err?.message || String(err);
      const incidentId = `dbg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const diagnosis = {
        incidentId,
        timestamp: new Date().toISOString(),
        operation: "panes.open",
        roomId,
        counts,
        failureReason: errDetail,
        probableCause: errDetail.includes("capped") ? "Room maximum pane limit reached" :
                       errDetail.includes("disabled") ? "Target CLI runtime is disabled in settings" :
                       errDetail.includes("login") || errDetail.includes("OAuth") ? "Target CLI requires OAuth authentication" :
                       "Room pane command execution failed",
        recommendedFix: errDetail.includes("capped") ? "Close unused panes" :
                        errDetail.includes("disabled") ? "Enable runtime in CLI settings" :
                        "Check server logs and runtime configuration",
        agentHandoffPrompt: `Space agent incident report ${incidentId}: Failed to open panes ${JSON.stringify(counts)} in room ${roomId}. Error: ${errDetail}.`
      };
      void recordDebugIncident(diagnosis);
      if (isDebug) {
        return { status: "FAILED", isError: true, error: errDetail, debugIncidentId: incidentId, debugDiagnosis: diagnosis, agentHandoffPrompt: diagnosis.agentHandoffPrompt };
      }
      throw err;
    }

    const taskPrompt = typeof (action.input as any)?.taskPrompt === "string" ? (action.input as any).taskPrompt :
      typeof (action.input as any)?.prompt === "string" ? (action.input as any).prompt : null;
    let taskDelivered = false;
    let promptResult: unknown = null;
    if (selectedGeminiAccount && batchResult?.data) {
      const createdPanes = Array.isArray(batchResult.data) ? batchResult.data : [];
      const geminiPanes = createdPanes.filter((p: Pane) => p.terminalRuntimeId === "cli:gemini");
      if (geminiPanes.length > 0) {
        if (taskPrompt) {
          // Explicit task: bind accounts in parallel, deliver prompt once. Still parallel, not sequential.
          const bindings = await Promise.all(geminiPanes.map(async (p: Pane) => {
            try {
              const cliSession = await cliTerminalManager.ensurePaneControlReady(p, makeSpaceId("trace"), { accountProfileId: selectedGeminiAccount.id });
              await store.updatePaneCliSession(cliSession.sessionId, { accountProfileId: selectedGeminiAccount.id }, makeSpaceId("trace"));
              return { paneId: p.id, ok: true, sessionId: cliSession.sessionId };
            } catch (err) {
              return { paneId: p.id, ok: false, error: (err as Error)?.message ?? String(err) };
            }
          }));
          const firstOk = bindings.find((b: any) => b?.ok);
          if (firstOk) {
            try {
              const target = geminiPanes.find((p: Pane) => p.id === (firstOk as any).paneId) ?? geminiPanes[0]!;
              promptResult = await controlSend(target, taskPrompt, makeSpaceId("trace"));
              taskDelivered = true;
            } catch {}
          }
        } else {
          // Fast visible path: do not block MCP response on CLI spawn. Bind lazily in background.
          void (async () => {
            await Promise.all(geminiPanes.map(async (p: Pane) => {
              try {
                const cliSession = await cliTerminalManager.ensurePaneControlReady(p, makeSpaceId("trace"), { accountProfileId: selectedGeminiAccount.id });
                await store.updatePaneCliSession(cliSession.sessionId, { accountProfileId: selectedGeminiAccount.id }, makeSpaceId("trace"));
              } catch {}
            }));
          })().catch(() => {});
        }
      }
    }

    const createdPanes = Array.isArray(batchResult?.data) ? batchResult.data : [];
    const rawYoutubeUrl = typeof (action.input as any)?.youtubeUrl === "string" ? (action.input as any).youtubeUrl.trim() : null;
    const rawVideoTitle = typeof (action.input as any)?.videoTitle === "string" ? (action.input as any).videoTitle.trim() : null;
    if (rawYoutubeUrl && createdPanes.length > 0) {
      const ytPanes = createdPanes.filter((p: Pane) => p.mode === "YOUTUBE");
      if (ytPanes.length > 0) {
        // Parallel, best-effort; cheap metadata only, no playback blocking.
        await Promise.all(ytPanes.map(async (yp: Pane) => {
          const pb = youtubeBrowserPlayback(rawYoutubeUrl, rawVideoTitle);
          if (pb) {
            try {
              const ypRoom = await store.getRoom(yp.roomId);
              const ownerId = ypRoom.kind === "AGENT_PROOF" ? `${actor.id}:proof:${yp.roomId}` : actor.id;
              await youtubePlaybackStore.save(ownerId, yp.id, pb);
            } catch {}
          }
          if (rawVideoTitle) {
            try {
              await store.updatePane(yp.id, { title: rawVideoTitle.slice(0, 100) }, makeSpaceId("trace"));
            } catch {}
          }
        }));
      }
    }

    const totalOpened = Array.isArray(batchResult?.data) ? batchResult.data.length : 0;
    return {
      ...batchResult,
      skipped: [...(Array.isArray(batchResult?.skipped) ? batchResult.skipped : []), ...droppedUnavailable],
      ...(selectedGeminiAccount ? { selectedGoogleAccount: selectedGeminiAccount, taskDelivered, promptResult } : {}),
      fill: {
        requested: totalRequested,
        opened: totalOpened,
        clipped,
        freeSlotsBefore: slots,
        effectiveCounts: counts,
        originalCounts,
      },
      ...(isDebug ? { debug: true, diagnosticStatus: "PASSED" } : {})
    };
  }
  return { openControlPanes };
}
