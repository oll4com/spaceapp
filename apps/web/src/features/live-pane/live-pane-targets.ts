export interface LivePaneGroupScope { userId?: string; liveSessionId?: string }
const groups = new Map<string, string[]>();
const keyFor = (roomId: string, scope: LivePaneGroupScope) => scope.userId && scope.liveSessionId
  ? `space.live.lastOpened:${JSON.stringify([scope.userId, roomId, scope.liveSessionId])}` : undefined;

export function rememberLivePaneGroup(roomId: string, paneIds: string[], scope: LivePaneGroupScope) {
  const key = keyFor(roomId, scope);
  if (!key) return;
  const ids = [...new Set(paneIds)];
  groups.set(key, ids);
  try { sessionStorage.setItem(key, JSON.stringify(ids)); } catch { /* In-memory reconnect still works. */ }
}

/** Resolve every explicit ID before any effect. Never broaden a missing selection. */
export function resolveLivePaneTargets(
  roomId: string, panes: any[], args: Record<string, any>, scope: LivePaneGroupScope,
  promptOnly: boolean, livePaneId?: string
): string[] {
  const explicit = args.paneIds !== undefined || args.paneId !== undefined;
  if (args.targetGroup !== undefined && args.targetGroup !== "lastOpened") throw Error("Unknown targetGroup.");
  if (args.targetGroup && (explicit || args.all || args.cliType || args.filter || args.unusedOnly))
    throw Error("targetGroup cannot be combined with another selection.");
  let ids: unknown[];
  if (args.targetGroup) {
    const key = keyFor(roomId, scope);
    if (!key) throw Error("The authenticated Live session identity is unavailable.");
    let remembered = groups.get(key);
    if (!remembered) {
      try { const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null"); if (Array.isArray(stored)) remembered = stored; } catch {}
    }
    if (!remembered?.length) throw Error("No last-opened pane group exists for this room and Live session.");
    ids = remembered;
  } else if (explicit) {
    if (args.paneIds !== undefined && !Array.isArray(args.paneIds)) throw Error("paneIds must be an array.");
    ids = [...(args.paneIds ?? []), ...(args.paneId !== undefined ? [args.paneId] : [])];
    if (!ids.length) throw Error("No explicit pane IDs were provided.");
  } else {
    if (!args.all && !args.cliType) throw Error("Select paneIds, targetGroup, cliType, or all:true.");
    ids = panes.filter(p => !p.isClosed && p.id !== livePaneId && p.mode !== "LIVE" &&
      (!promptOnly || p.mode === "TERMINAL" || p.mode === "CHAT") &&
      (!args.cliType || String(p.terminalRuntimeId || p.runtimeId || p.mode).toLowerCase().replace(/^cli:/, "") === String(args.cliType).toLowerCase().replace(/^cli:/, "")))
      .map(p => p.id);
  }
  const invalid = ids.filter(id => typeof id !== "string" || !id.trim() || !panes.some(p =>
    p.id === id && !p.isClosed && p.id !== livePaneId && p.mode !== "LIVE" &&
    (!promptOnly || p.mode === "TERMINAL" || p.mode === "CHAT")));
  if (invalid.length) throw Error(`Invalid or unavailable target pane IDs: ${invalid.map(String).join(", ")}. Nothing was submitted.`);
  return [...new Set(ids as string[])];
}

export function livePromptPaneReceipts(paneIds: string[], receipt: any) {
  return paneIds.map(paneId => {
    const result = receipt?.results?.find((entry: any) => entry.paneId === paneId);
    const evidence = result?.evidence?.result ?? result?.evidence;
    return { paneId, submission: result?.status === "COMPLETED" ? "ACCEPTED" : result?.status ?? "PENDING",
      detail: result?.detail ?? "Waiting for the executor receipt.",
      nativeTaskRef: evidence?.turnId ?? evidence?.nativeTaskRef ?? null,
      watchId: evidence?.watchId ?? null, taskCompleted: false };
  });
}
