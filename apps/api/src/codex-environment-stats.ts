import type { FastifyInstance } from "fastify";
import type { CodexEnvironment } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { HostStatsProvider } from "./host-stats.js";

/**
 * What the Codex environment route reports about Space itself: rooms, Chat panes with an agent session (and how many
 * are running), CLI and browser panes, and the host stats, which the route omits (logged) when they cannot be read.
 */
export function createCodexEnvironmentStats(app: FastifyInstance, options: {
  store: SpaceStore;
  hostStatsProvider: HostStatsProvider;
}) {
  const { store, hostStatsProvider } = options;
  async function readCodexEnvironmentSpaceStats(): Promise<NonNullable<CodexEnvironment["spaceStats"]>> {
    const checkedAt = new Date().toISOString();
    const rooms = await store.listRooms();
    const panes = (await Promise.all(rooms.map((room) => store.listPanes(room.id)))).flat();
    const chatPanes = panes.filter((pane) => pane.mode === "CHAT");
    const agentPaneSessions = await Promise.all(
      chatPanes.map(async (pane) => {
        const session = await store.getActiveSpaceAgentSession(pane.id);
        if (!session?.isActive) {
          return { hasSession: false, isRunning: false };
        }
        const latestRun = await store.getLatestSpaceAgentRun(session.sessionId);
        return {
          hasSession: true,
          isRunning: session.status === "RUNNING" || latestRun?.status === "QUEUED" || latestRun?.status === "RUNNING"
        };
      })
    );

    return {
      roomCount: rooms.length,
      agentPaneCount: agentPaneSessions.filter((session) => session.hasSession).length,
      activeAgentPaneCount: agentPaneSessions.filter((session) => session.isRunning).length,
      cliPaneCount: panes.filter((pane) => pane.mode === "TERMINAL").length,
      chatPaneCount: chatPanes.length,
      browserPaneCount: panes.filter((pane) => pane.mode === "BROWSER").length,
      checkedAt
    };
  }

  async function readCodexEnvironmentHostStats(): Promise<CodexEnvironment["hostStats"] | undefined> {
    try {
      return await hostStatsProvider();
    } catch (error) {
      app.log.warn({ err: error }, "Codex environment host stats collection failed.");
      return undefined;
    }
  }

  return { readCodexEnvironmentSpaceStats, readCodexEnvironmentHostStats };
}
