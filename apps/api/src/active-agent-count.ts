import { CLI_PANE_TYPES, type PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

// Every CLI pane counts: isCliTurnActive reads native turn state where a CLI has one
// (Codex, OpenCode, Gemini, Claude) and the TUI's own running indicator otherwise.
const observableCliRuntimeIds = CLI_PANE_TYPES.map((type) => type.id);

export type ActiveAgentCountProvider = () => Promise<number>;

export interface ActiveAgentCountProviderOptions {
  store: SpaceStore;
  isCliTurnActive: (session: PaneCliSession) => Promise<boolean>;
}

export function createActiveAgentCountProvider(
  options: ActiveAgentCountProviderOptions
): ActiveAgentCountProvider {
  return async () => {
    const [chatAgentCount, activeCliSessions] = await Promise.all([
      options.store.countActiveSpaceAgentSessions(),
      options.store.listActivePaneCliSessionsForRuntimes(observableCliRuntimeIds)
    ]);
    const cliSessions = activeCliSessions.filter((session) => session.purpose === "NORMAL");
    const activeCliTurns = await Promise.all(
      cliSessions.map((session) => options.isCliTurnActive(session).catch(() => false))
    );
    return chatAgentCount + activeCliTurns.filter(Boolean).length;
  };
}
