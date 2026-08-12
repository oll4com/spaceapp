import type { PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

const observableCliRuntimeIds = ["cli:opencode", "cli:codex"] as const;

export type ActiveAgentCountProvider = () => Promise<number>;

export interface ActiveAgentCountProviderOptions {
  store: SpaceStore;
  isCliTurnActive: (session: PaneCliSession) => Promise<boolean>;
}

export function createActiveAgentCountProvider(
  options: ActiveAgentCountProviderOptions
): ActiveAgentCountProvider {
  return async () => {
    const [chatAgentCount, cliSessionLists] = await Promise.all([
      options.store.countActiveSpaceAgentSessions(),
      Promise.all(
        observableCliRuntimeIds.map((runtimeId) =>
          options.store.listActivePaneCliSessions(runtimeId)
        )
      )
    ]);
    const cliSessions = cliSessionLists
      .flat()
      .filter((session) => session.purpose === "NORMAL");
    const activeCliTurns = await Promise.all(
      cliSessions.map((session) => options.isCliTurnActive(session).catch(() => false))
    );
    return chatAgentCount + activeCliTurns.filter(Boolean).length;
  };
}
