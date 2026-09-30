import { createContext } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import type { OskCliCommand } from "../osk-keyboard/cli-shortcuts.js";

export const CliShortcutUserContext = createContext<string | null>(null);
const KEY_PREFIX = "space.cliShortcutUsage.v1.";
type Counts = Record<string, number>;

function readCounts(userId: string | null): Counts {
  if (!userId) return {};
  try {
    const value: unknown = JSON.parse(getSpaceRuntime().platform.localStorage.getItem(KEY_PREFIX + encodeURIComponent(userId)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, count]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(id) && Number.isSafeInteger(count) && (count as number) >= 0
    ));
  } catch { return {}; }
}

export function recordCliShortcutUse(userId: string | null, commandId: string): void {
  if (!userId || !/^[a-z][a-z0-9_]{0,63}$/.test(commandId)) return;
  try {
    const counts = readCounts(userId);
    counts[commandId] = Math.min(Number.MAX_SAFE_INTEGER, (counts[commandId] ?? 0) + 1);
    getSpaceRuntime().platform.localStorage.setItem(KEY_PREFIX + encodeURIComponent(userId), JSON.stringify(counts));
  } catch { /* Storage availability must not block a terminal shortcut. */ }
}

export function rankCliShortcuts(commands: readonly OskCliCommand[], userId: string | null): OskCliCommand[] {
  const counts = readCounts(userId);
  return commands.map((command, index) => ({ command, index })).sort((a, b) => {
    if (a.command.id === "continue") return b.command.id === "continue" ? a.index - b.index : -1;
    if (b.command.id === "continue") return 1;
    return (counts[b.command.id] ?? 0) - (counts[a.command.id] ?? 0) || a.index - b.index;
  }).map(({ command }) => command);
}
