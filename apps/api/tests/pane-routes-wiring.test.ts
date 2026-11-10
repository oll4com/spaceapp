import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec, accounts } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  const accounts = { withYouTubeAccountLock: "lock", youtubeAccountOwner: "owner", selectedGoogleBrowserAccount: "selected", paneGoogleAccountSelection: "selection",
    resolvePaneBrowserAccount: "resolve", adoptPaneSignIn: "adopt", effectivePaneProfileId: "profile", previousCopilotPane: "previous", geminiAccountEmails: "gemini",
    browserAccountChoices: "choices",
    initializeNewPaneGoogleAccount: async (userId: string, pane: { id: string }) => { captured.order.push(`initialize:${userId}:${pane.id}`); } };
  return { captured, rec, accounts };
});
vi.mock("../src/pane-stream-routes.js", async (orig) => ({ ...await orig<object>(), registerPaneStreamRoutes: rec("paneStream", "control-activity") }));
vi.mock("../src/pane-browser-account.js", async (orig) => ({ ...await orig<object>(), createPaneBrowserAccounts: rec("paneBrowserAccounts", accounts) }));
vi.mock("../src/pane-routes.js", async (orig) => ({ ...await orig<object>(), registerPaneRoutes: rec("paneRoutes") }));

const { registerPaneRoutesWiring } = await import("../src/pane-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {} }); });

function wire() {
  const app = { log: { warn: () => undefined } };
  const nousRef: { current: { paneChanged: (change: unknown) => void } | null } = { current: null };
  const deps = {
    config: "config", store: "store", eventBus: "events", browserSessionManager: "browsers", cliTerminalManager: "terminals", cliRuntimeVisibility: "visibility",
    taskTitleRepository: "title-repository", taskTitleProviders: "title-providers", taskTitles: "titles", roomPaneCommands: "pane-commands", spaceControl: "control",
    roomAgentService: "room-agent", assertRootAdmin: "root-admin", defaultRouteRateLimitOptions: { config: { rateLimit: 1 } },
    defaultWebsocketRateLimitOptions: { config: { rateLimit: 2 }, websocket: true }, assertRoomAccess: "room-access", youtubePlaybackStore: "playback",
    readDeepSeekHarnessMaintenanceStatus: "harness-status", cliPaneReopener: "reopener", resumePreviousJobCopilotSession: "resume-job", nousRef,
    roomShares: { notePaneCreator: async (pane: { id: string }, userId: string) => { captured.order.push(`creator:${userId}:${pane.id}`); } },
    readClaudeLiveTurns: async (session: { id: string }) => { captured.order.push(`claudeTurns:${session.id}`); },
    youtubeAccountStore: "youtube-accounts", browserAccountStore: "browser-accounts", readCachedCliAccountIdentity: "identity",
    googleAccountBrowserStatuses: "google-statuses"
  };
  const result = registerPaneRoutesWiring(app as never, deps as never);
  return { app, deps, nousRef, result };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, unknown>;

describe("pane routes wiring (ARCH-001 step 85)", () => {
  it("registers the pane stream routes, the pane browser accounts and the pane routes in app.ts's order", () => {
    const { app } = wire();
    expect(captured.order).toEqual(["paneStream", "paneBrowserAccounts", "paneRoutes"]);
    expect(captured.args.paneStream![0]).toBe(app);
    expect(captured.args.paneRoutes![0]).toBe(app);
    expect(arg("paneStream")).toEqual({ config: "config", store: "store", browserSessionManager: "browsers", routeOptions: { config: { rateLimit: 1 } },
      websocketRouteOptions: { config: { rateLimit: 2 }, websocket: true } });
  });

  it("shares one account-operation map and one YouTube session map between the accounts, the pane routes and the caller", () => {
    const { app, result } = wire();
    const browserAccounts = arg("paneBrowserAccounts", 0);
    expect(browserAccounts).toEqual({ store: "store", config: "config", log: app.log, browserSessionManager: "browsers", youtubeAccountStore: "youtube-accounts",
      browserAccountStore: "browser-accounts", youtubeAccountOperations: result.youtubeAccountOperations, readCachedCliAccountIdentity: "identity",
      googleAccountBrowserStatuses: "google-statuses" });
    expect(result.youtubeAccountOperations).toBeInstanceOf(Map);
    expect(result.youtubeSessionStarts).toBeInstanceOf(Map);
    expect(arg("paneRoutes")).toMatchObject({ youtubeSessionStarts: result.youtubeSessionStarts, youtubeAccountOperations: result.youtubeAccountOperations,
      config: "config", store: "store", eventBus: "events", browserSessionManager: "browsers", cliTerminalManager: "terminals", cliRuntimeVisibility: "visibility",
      taskTitleRepository: "title-repository", taskTitleProviders: "title-providers", taskTitles: "titles", roomPaneCommands: "pane-commands",
      spaceControl: "control", roomAgentService: "room-agent", assertRootAdmin: "root-admin", routeOptions: { config: { rateLimit: 1 } },
      assertRoomAccess: "room-access", youtubePlaybackStore: "playback", readDeepSeekHarnessMaintenanceStatus: "harness-status", cliPaneReopener: "reopener",
      resumePreviousJobCopilotSession: "resume-job" });
  });

  it("returns the control activity and the account helpers, keeping the new-pane initializer inside", () => {
    const { result } = wire();
    const { initializeNewPaneGoogleAccount: _inside, ...helpers } = accounts;
    expect(result).toEqual({ browserControlActivity: "control-activity", youtubeSessionStarts: result.youtubeSessionStarts,
      youtubeAccountOperations: result.youtubeAccountOperations, ...helpers });
    expect(result).not.toHaveProperty("initializeNewPaneGoogleAccount");
  });

  it("records the pane's creator before its Google account, reaches Nous when it is set, and reads Claude live turns only for Claude", async () => {
    const { nousRef } = wire();
    const panes = arg("paneRoutes") as Record<string, (...args: never[]) => unknown>;
    captured.order = [];
    await (panes.initializeNewPaneGoogleAccount as (userId: string, pane: { id: string }) => Promise<void>)("user:a", { id: "pane:1" });
    expect(captured.order).toEqual(["creator:user:a:pane:1", "initialize:user:a:pane:1"]);
    const paneChanged = panes.paneChanged as (change: unknown) => void;
    expect(() => paneChanged({ paneId: "pane:1" })).not.toThrow();
    const changes: unknown[] = [];
    nousRef.current = { paneChanged: (change) => changes.push(change) };
    paneChanged({ paneId: "pane:2" });
    expect(changes).toEqual([{ paneId: "pane:2" }]);
    captured.order = [];
    const remember = panes.rememberCliNativeRef as (session: { id: string; runtimeId: string }) => Promise<void>;
    await remember({ id: "cli:codex-session", runtimeId: "cli:codex" });
    await remember({ id: "cli:claude-session", runtimeId: "cli:claude" });
    expect(captured.order).toEqual(["claudeTurns:cli:claude-session"]);
  });
});
