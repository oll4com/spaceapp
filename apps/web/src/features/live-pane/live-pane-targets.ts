import { resolvePaneByName } from "@space/contracts";

/** A pane as Space Control's inspect returns it (loose JSON): only the fields Live reads. */
export interface InspectedPane {
  id: string;
  paneName?: string;
  title?: string;
  mode?: string;
  runtimeId?: string;
  terminalRuntimeId?: string;
  status?: string;
  isClosed?: boolean;
  isMinimized?: boolean;
  isMaximized?: boolean;
  isUnused?: boolean;
  hasUserInput?: boolean;
  paneId?: string;
  runtime?: string;
  state?: string;
  modelId?: string;
  effectiveModelId?: string;
  configuredModelId?: string;
  order?: number;
  categoryColor?: string | null;
  mediaTitle?: string | null;
  titleSource?: string;
  nativeTaskRef?: unknown;
}

/** Tool arguments as the voice model sent them: loose JSON read field by field across ~150 call sites. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- one named escape hatch instead of inline `any`s
export type LiveToolArgs = Record<string, any>;

/** A Space Control receipt as far as prompt receipts read it (loose JSON). */
type ReceiptEvidence = { turnId?: string; nativeTaskRef?: string; watchId?: string };
type PromptReceipt = { results?: Array<{ paneId?: string; status?: string; detail?: string; evidence?: ReceiptEvidence & { result?: ReceiptEvidence } }> };

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
  roomId: string, panes: InspectedPane[], args: LiveToolArgs, scope: LivePaneGroupScope,
  promptOnly: boolean, livePaneId?: string
): string[] {
  const explicitNames = args.paneNames !== undefined || args.paneName !== undefined;
  const explicit = args.paneIds !== undefined || args.paneId !== undefined || explicitNames;
  const ofType = (p: InspectedPane) => !args.cliType || String(p.terminalRuntimeId || p.runtimeId || p.mode).toLowerCase().replace(/^cli:/, "") === String(args.cliType).toLowerCase().replace(/^cli:/, "");
  if (args.targetGroup !== undefined && args.targetGroup !== "lastOpened") throw Error("Unknown targetGroup.");
  if (args.targetGroup && (args.all || args.filter || args.unusedOnly))
    throw Error("targetGroup cannot be combined with all, filter or unusedOnly. Nothing was submitted.");
  let ids: unknown[];
  // Pane names or IDs the user said win over a group the model added alongside them.
  if (args.targetGroup && !explicit) {
    const key = keyFor(roomId, scope);
    if (!key) throw Error("The authenticated Live session identity is unavailable.");
    let remembered = groups.get(key);
    if (!remembered) {
      try { const stored: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null"); if (Array.isArray(stored)) remembered = stored; } catch { /* best-effort: nothing to do if it fails */ }
    }
    if (!remembered?.length) throw Error("No last-opened pane group exists for this room and Live session.");
    // Panes of the group closed since it was opened drop out and cliType only narrows; the group never widens.
    ids = remembered.filter(id => panes.some(p => p.id === id && !p.isClosed && ofType(p)));
    if (!ids.length) throw Error(args.cliType ? "No open pane of the last-opened group has that CLI type. Nothing was submitted."
      : "Every pane of the last-opened group is closed. Nothing was submitted.");
  } else if (explicit) {
    if (args.paneIds !== undefined && !Array.isArray(args.paneIds)) throw Error("paneIds must be an array.");
    if (args.paneNames !== undefined && !Array.isArray(args.paneNames)) throw Error("paneNames must be an array.");
    const idsFromNames: string[] = [];
    if (explicitNames) {
      const names = [
        ...(Array.isArray(args.paneNames) ? args.paneNames : args.paneNames ? [args.paneNames] : []),
        ...(args.paneName ? [args.paneName] : [])
      ];
      for (const name of names) {
        const found = resolvePaneByName(panes, String(name));
        if (!found) {
          throw Error(`Unknown or unavailable target pane name: "${name}". Nothing was submitted.`);
        }
        idsFromNames.push(found.id);
      }
    }
    const explicitIds = [...(args.paneIds ?? []), ...(args.paneId !== undefined ? [args.paneId] : [])];
    if (explicitIds.length > 0 && idsFromNames.length > 0) {
      const idSet = new Set(explicitIds);
      const nameIdSet = new Set(idsFromNames);
      const overlap = [...idSet].filter((id) => nameIdSet.has(id));
      if (!overlap.length) throw Error("Target paneIds and paneNames conflict.");
      ids = overlap;
    } else {
      ids = explicitIds.length > 0 ? explicitIds : idsFromNames;
    }
    if (!ids.length) throw Error("No explicit pane IDs or pane names were provided.");
  } else {
    if (!args.all && !args.cliType) throw Error("Select paneIds, targetGroup, cliType, or all:true.");
    ids = panes.filter(p => !p.isClosed && p.id !== livePaneId && p.mode !== "LIVE" &&
      (!promptOnly || p.mode === "TERMINAL" || p.mode === "CHAT") && ofType(p))
      .map(p => p.id);
  }
  const invalid = ids.filter(id => typeof id !== "string" || !id.trim() || !panes.some(p =>
    p.id === id && !p.isClosed && p.id !== livePaneId && p.mode !== "LIVE" &&
    (!promptOnly || p.mode === "TERMINAL" || p.mode === "CHAT")));
  if (invalid.length) throw Error(`Invalid or unavailable target pane IDs: ${invalid.map(String).join(", ")}. Nothing was submitted.`);
  return [...new Set(ids as string[])];
}

export function livePromptPaneReceipts(paneIds: string[], receipt: PromptReceipt | null | undefined, panes?: InspectedPane[]) {
  return paneIds.map(paneId => {
    const pane = panes?.find(p => p.id === paneId);
    const result = receipt?.results?.find((entry) => entry.paneId === paneId);
    const evidence = result?.evidence?.result ?? result?.evidence;
    return {
      paneId,
      paneName: pane?.paneName ?? null,
      submission: result?.status === "COMPLETED" ? "ACCEPTED" : result?.status ?? "PENDING",
      detail: result?.detail ?? "Waiting for the executor receipt.",
      nativeTaskRef: evidence?.turnId ?? evidence?.nativeTaskRef ?? null,
      watchId: evidence?.watchId ?? null,
      taskCompleted: false
    };
  });
}
