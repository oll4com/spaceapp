import { mkdir, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const geminiNativeConversationIdPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const geminiProcessTreeMaxProcesses = 2_048;
const geminiProcessTreeMaxTasks = 512;
const geminiConversationPattern = /(?:presence|conversations)\/([0-9a-fA-F-]{36})\.(?:lock|db)/;
const geminiPaneConversationsDir = "/opt/spaceapp/var/gemini-pane-conversations";

export function normalizeGeminiPaneId(paneId: string): string {
  return paneId.replace(/^pane:+/, "");
}

function candidatePaneFilePaths(paneId: string): string[] {
  const cleanId = normalizeGeminiPaneId(paneId);
  return [
    join(geminiPaneConversationsDir, `pane-${cleanId}.json`),
    join(geminiPaneConversationsDir, `pane-pane:${cleanId}.json`),
    join(geminiPaneConversationsDir, `pane-${paneId}.json`)
  ];
}

export async function writeGeminiPaneConversation(paneId: string, conversationId: string): Promise<void> {
  if (!geminiNativeConversationIdPattern.test(conversationId)) return;
  try {
    await mkdir(geminiPaneConversationsDir, { recursive: true, mode: 0o777 });
    const cleanId = normalizeGeminiPaneId(paneId);
    for (const filePath of candidatePaneFilePaths(paneId)) {
      const prior = await readFile(filePath, "utf8").then(raw => JSON.parse(raw)).catch(() => null);
      // Do not destroy the launcher's current session/PID/profile binding
      // when verification merely re-observes the same native conversation.
      if (prior?.conversationId === conversationId && prior?.paneId === `pane:${cleanId}` && prior?.sessionId && prior?.pid) continue;
      const data = JSON.stringify({ conversationId, paneId: `pane:${cleanId}`, timestamp: Date.now() });
      await writeFile(filePath, data, { mode: 0o666 }).catch(() => {});
    }
  } catch {
    // Non-blocking write failure
  }
}

export async function readGeminiPaneConversation(paneId: string, maxAgeMs = 86_400_000): Promise<string | null> {
  for (const filePath of candidatePaneFilePaths(paneId)) {
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as { conversationId?: string; timestamp?: number };
      if (
        typeof parsed.conversationId === "string" &&
        geminiNativeConversationIdPattern.test(parsed.conversationId) &&
        typeof parsed.timestamp === "number" &&
        Date.now() - parsed.timestamp <= maxAgeMs
      ) {
        return parsed.conversationId;
      }
    } catch {
      // Check next candidate
    }
  }
  return null;
}

export async function clearGeminiPaneConversation(paneId: string): Promise<void> {
  for (const filePath of candidatePaneFilePaths(paneId)) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore missing file
    }
  }
}

export async function readGeminiNativeConversationIdFromProcessTree(
  rootPid: number,
  procRoot = "/proc"
): Promise<string | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  try {
    const pending = [rootPid];
    const visited = new Set<number>();
    const conversationIds = new Set<string>();

    while (pending.length > 0 && visited.size < geminiProcessTreeMaxProcesses) {
      const pid = pending.shift();
      if (!pid || visited.has(pid)) continue;
      visited.add(pid);

      try {
        const fds = await readdir(join(procRoot, String(pid), "fd"));
        for (const fd of fds) {
          try {
            const target = await readlink(join(procRoot, String(pid), "fd", fd));
            const match = target.match(geminiConversationPattern);
            const conversationId = match?.[1];
            if (conversationId && geminiNativeConversationIdPattern.test(conversationId)) {
              conversationIds.add(conversationId);
            }
          } catch {
            // Ignore disappearing fds
          }
        }
      } catch {
        // Process may exit or permission denied
      }

      try {
        const taskIds = (await readdir(join(procRoot, String(pid), "task"))).slice(0, geminiProcessTreeMaxTasks);
        for (const taskId of taskIds) {
          const children = (await readFile(join(procRoot, String(pid), "task", taskId, "children"), "utf8").catch(() => ""))
            .trim()
            .split(/\s+/)
            .map((value) => Number.parseInt(value, 10))
            .filter((value) => Number.isSafeInteger(value) && value > 0);
          pending.push(...children);
        }
      } catch {
        // Ignore errors when reading children
      }
    }

    return conversationIds.size >= 1 ? [...conversationIds][0]! : null;
  } catch {
    return null;
  }
}
