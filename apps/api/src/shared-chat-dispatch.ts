import { cliToggleRuntimeIds, type Pane, type PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

// Shared chat dispatch rules (group conversation):
//  - Every OPERATOR message wakes every CLI runtime that has an eligible pane
//    (at most ONE pane per runtime: the most recently updated idle pane), so
//    a real group conversation happens in the Shared Chat dock.
//  - cli:codex is ALWAYS excluded from dispatch.
//  - cli:deepseek is excluded by default (it is the operator's working pane)
//    and is woken ONLY when the message explicitly mentions @deepseek.
//  - Replies posted by agents (senderType=agent or messages carrying
//    metadata.runtimeId) never trigger dispatch at all and are never parsed
//    for mentions — answers only ever land in the dock.

export const SHARED_CHAT_DISPATCH_EXCLUDED_RUNTIME_IDS: ReadonlySet<string> = new Set(["cli:codex"]);

export const SHARED_CHAT_MENTION_ONLY_RUNTIME_IDS: ReadonlySet<string> = new Set(["cli:deepseek"]);

export const SHARED_CHAT_MENTION_KEYS: ReadonlyMap<string, string> = new Map(
  cliToggleRuntimeIds.map((runtimeId) => [runtimeId.slice("cli:".length), runtimeId])
);

const MENTION_KEY_ALTERNATION = Array.from(SHARED_CHAT_MENTION_KEYS.keys())
  .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const MENTION_PATTERN = new RegExp(`(?:^|[\\s,;:!?.()[\\]{}"'<>])@(${MENTION_KEY_ALTERNATION})(?=$|[\\s,;:!?.()[\\]{}"'<>])`, "gi");

export function parseSharedChatMentions(content: string): Set<string> {
  const mentions = new Set<string>();
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    const runtimeId = SHARED_CHAT_MENTION_KEYS.get(key);
    if (runtimeId) mentions.add(runtimeId);
  }
  return mentions;
}

export function resolveSharedChatDispatchRuntimeIds(content: string): Set<string> {
  const mentions = parseSharedChatMentions(content);
  const runtimeIds = new Set<string>();
  for (const runtimeId of cliToggleRuntimeIds) {
    if (SHARED_CHAT_DISPATCH_EXCLUDED_RUNTIME_IDS.has(runtimeId)) continue;
    if (SHARED_CHAT_MENTION_ONLY_RUNTIME_IDS.has(runtimeId) && !mentions.has(runtimeId)) continue;
    runtimeIds.add(runtimeId);
  }
  return runtimeIds;
}

export interface SharedChatDispatchTarget {
  session: PaneCliSession;
  pane: Pane;
}

function eligibleTargets(sessions: PaneCliSession[], panesForRoom: Map<string, Pane[]>): SharedChatDispatchTarget[] {
  const targets: SharedChatDispatchTarget[] = [];
  for (const session of sessions) {
    if (!session.isActive || session.status === "EXITED" || session.status === "ERROR") continue;
    if (session.purpose !== "NORMAL") continue;
    const pane = panesForRoom.get(session.roomId)?.find((candidate) => candidate.id === session.paneId);
    if (!pane || pane.isClosed || pane.status === "RUNNING") continue;
    targets.push({ session, pane });
  }
  return targets;
}

export async function pickSharedChatDispatchTarget(
  store: SpaceStore,
  runtimeId: string
): Promise<SharedChatDispatchTarget | null> {
  let sessions: PaneCliSession[];
  try {
    sessions = await store.listActivePaneCliSessions(runtimeId);
  } catch {
    return null;
  }
  const panesForRoom = new Map<string, Pane[]>();
  for (const session of sessions) {
    if (panesForRoom.has(session.roomId)) continue;
    try {
      panesForRoom.set(session.roomId, await store.listPanes(session.roomId, true));
    } catch {
      panesForRoom.set(session.roomId, []);
    }
  }
  const targets = eligibleTargets(sessions, panesForRoom);
  if (!targets.length) return null;
  targets.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
  return targets[0] ?? null;
}

export function buildSharedChatDispatchPrompt(content: string, label: string, runtimeId: string): string {
  return (
    [
      "The operator wrote in the Shared Chat (the group conversation of all agents):",
      content.slice(0, 600),
      "",
      "Reply to them in the Shared Chat by running from the shell:",
      `/opt/spaceapp/scripts/space-chat-post.sh --label ${JSON.stringify(label)} --runtime ${JSON.stringify(runtimeId)} --text 'your reply in English'`,
      "Do not start any other tasks for this message. If it does not concern you at all, do not reply."
    ].join("\n") + "\r"
  );
}
