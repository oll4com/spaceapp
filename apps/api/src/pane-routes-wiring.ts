import type { PaneBrowserSessionResponse } from "@space/contracts";
import type { FastifyInstance } from "fastify";
import type { createClaudeLiveTurnsReader } from "./claude-live-turns.js";
import { isClaudeDirectParityRuntime } from "./cli-parity.js";
import type { NousWiring } from "./nous/wiring.js";
import { createPaneBrowserAccounts } from "./pane-browser-account.js";
import { registerPaneRoutes } from "./pane-routes.js";
import { registerPaneStreamRoutes } from "./pane-stream-routes.js";
import type { createRoomShareAccess } from "./room-shares.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type Stream = D<typeof registerPaneStreamRoutes>; type Panes = D<typeof registerPaneRoutes>; type Accounts = Parameters<typeof createPaneBrowserAccounts>[0];
type PaneRoutesDeps = Omit<Panes, "routeOptions" | "youtubeSessionStarts" | "youtubeAccountOperations" | "initializeNewPaneGoogleAccount" | "paneChanged" | "rememberCliNativeRef">
  & Pick<Accounts, "youtubeAccountStore" | "browserAccountStore" | "readCachedCliAccountIdentity" | "googleAccountBrowserStatuses">
  & {
    defaultRouteRateLimitOptions: Stream["routeOptions"] & Panes["routeOptions"]; defaultWebsocketRateLimitOptions: Stream["websocketRouteOptions"];
    roomShares: Pick<ReturnType<typeof createRoomShareAccess>, "notePaneCreator">; nousRef: { current: Pick<NousWiring, "paneChanged"> | null };
    readClaudeLiveTurns: ReturnType<typeof createClaudeLiveTurnsReader>;
  };

/** The pane routes after the CLI routes in app.ts (moved verbatim, ARCH-001 step 85): the pane stream routes, the pane browser accounts with
 *  their YouTube session and account-operation maps, and the pane routes. Returns the browser control activity and the pane browser account
 *  helpers, which the copilot pane, browser and Dot routes and earlier closures read. */
export function registerPaneRoutesWiring(app: FastifyInstance, deps: PaneRoutesDeps) {
  const { config, store, eventBus, browserSessionManager, cliTerminalManager, cliRuntimeVisibility, taskTitleRepository, taskTitleProviders, taskTitles,
    roomPaneCommands, spaceControl, roomAgentService, assertRootAdmin, defaultRouteRateLimitOptions, defaultWebsocketRateLimitOptions, assertRoomAccess,
    youtubePlaybackStore, readDeepSeekHarnessMaintenanceStatus, roomShares, cliPaneReopener, resumePreviousJobCopilotSession, nousRef, readClaudeLiveTurns,
    youtubeAccountStore, browserAccountStore, readCachedCliAccountIdentity, googleAccountBrowserStatuses } = deps;
  const browserControlActivity = registerPaneStreamRoutes(app, {
    config, store, browserSessionManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions
  });

  const youtubeSessionStarts = new Map<string, Promise<PaneBrowserSessionResponse>>();
  const youtubeAccountOperations = new Map<string, Promise<unknown>>();
  const { withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount, paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn,
    effectivePaneProfileId, previousCopilotPane, initializeNewPaneGoogleAccount, geminiAccountEmails, browserAccountChoices } = createPaneBrowserAccounts({ store, config, log: app.log,
    browserSessionManager, youtubeAccountStore, browserAccountStore, youtubeAccountOperations, readCachedCliAccountIdentity, googleAccountBrowserStatuses });
  registerPaneRoutes(app, {
    config, store, eventBus, browserSessionManager, cliTerminalManager, cliRuntimeVisibility, taskTitleRepository,
    taskTitleProviders, taskTitles, roomPaneCommands, spaceControl, roomAgentService, assertRootAdmin,
    routeOptions: defaultRouteRateLimitOptions, assertRoomAccess, youtubePlaybackStore,
    readDeepSeekHarnessMaintenanceStatus, youtubeSessionStarts, youtubeAccountOperations,
    initializeNewPaneGoogleAccount: async (userId, pane) => { await roomShares.notePaneCreator(pane, userId); await initializeNewPaneGoogleAccount(userId, pane); },
    cliPaneReopener, resumePreviousJobCopilotSession, paneChanged: (change) => nousRef.current?.paneChanged(change), assertPaneMayClose: deps.assertPaneMayClose,
    rememberCliNativeRef: async (session) => { if (isClaudeDirectParityRuntime(session.runtimeId)) await readClaudeLiveTurns(session); }
  });
  return { browserControlActivity, youtubeSessionStarts, youtubeAccountOperations, withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount,
    paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn, effectivePaneProfileId, previousCopilotPane, geminiAccountEmails, browserAccountChoices };
}
