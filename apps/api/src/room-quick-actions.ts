import type { BrowserHostActorContext } from "@space/browser-host";
import type { Pane, RoomQuickCommand } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";

export interface RoomQuickActionResult {
  summary: string;
  operationId?: string;
  pending?: boolean;
  failed?: boolean;
  music?: Extract<RoomQuickCommand, { type: "MUSIC" }>;
}
export function createRoomQuickActions(options: {
  store: SpaceStore;
  assertRuntimeEnabled(runtimeId: string): Promise<void>;
  navigate(pane: Pane, url: string, traceId: string, actor?: BrowserHostActorContext): Promise<void>;
  publish(roomId: string): Promise<void>;
}) {
  return async (roomId: string, command: RoomQuickCommand, traceId: string, actor?: BrowserHostActorContext): Promise<RoomQuickActionResult> => {
    const { store } = options;
    if (command.type === "MUSIC") return { summary: "Sending the playback command…", music: command };
    if (command.type === "OPEN_PANES") {
      if (command.mode === "TERMINAL") await options.assertRuntimeEnabled(command.runtimeId!);
      if (command.mode === "CHAT") await options.assertRuntimeEnabled("cli:codex");
      const panes = await store.createPanes(Array.from({ length: command.count }, () => ({
        roomId, title: command.mode === "TERMINAL" ? `${command.runtimeId!.slice(4)} CLI` : command.mode === "CHAT" ? "Codex Chat" : command.mode === "YOUTUBE" ? "YouTube" : "Browser",
        mode: command.mode, ...(command.mode === "TERMINAL" ? { terminalRuntimeId: command.runtimeId, cwd: "/etc" } : {})
      })), traceId);
      await options.publish(roomId);
      return { summary: `Opened ${panes.length} ${command.mode === "TERMINAL" ? command.runtimeId!.slice(4) + " CLI" : command.mode.toLowerCase()} pane${panes.length === 1 ? "" : "s"}.` };
    }
    const browsers = (await store.listPanes(roomId)).filter(pane => pane.mode === "BROWSER" && !pane.isClosed);
    const selected = command.paneId ? browsers.find(pane => pane.id === command.paneId) : undefined;
    if (command.paneId && !selected) throw new SpaceConflictError("The selected browser is not an open browser in this room.");
    if (!selected && browsers.length > 1) throw new SpaceConflictError("Several browser panes are open. Specify the target browser in your request.");
    const pane = selected ?? browsers[0] ?? await store.createPane({ roomId, title: "Search", mode: "BROWSER" }, traceId);
    await options.publish(roomId);
    const url = new URL(command.engine === "YOUTUBE" ? "https://www.youtube.com/results" : "https://www.google.com/search");
    url.searchParams.set(command.engine === "YOUTUBE" ? "search_query" : "q", command.query);
    await options.navigate(pane, url.toString(), traceId, actor);
    return { summary: `Opened ${command.engine === "YOUTUBE" ? "YouTube" : "Google"} search for “${command.query}”.` };
  };
}
