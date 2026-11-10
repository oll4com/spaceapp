import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import { browserCensus, registerBrowserCensusRoutes } from "./browser-census-routes.js";
import { browserAgentOf } from "./browser-control-activity.js";
import { operatorFirstBrowsers, startBrowserReaper } from "./browser-reaper.js";
import { registerCliBrowserBridgeRoutes } from "./cli-browser-bridge-routes.js";
import { browserHandoffPendingReason, createCliBrowserCdpProxy } from "./cli-browser-cdp.js";
import type { SpaceApiConfig } from "./config.js";
import { registerInternalAgentActionRoutes } from "./internal-agent-action-routes.js";
import { settleBrowserHandoffNotifications } from "./notifications/browser-handoff.js";
import { registerPaneBrowserRoutes } from "./pane-browser-routes.js";
import { registerPaneCliSessionRoutes } from "./pane-cli-session-routes.js";
import { isBrowserPane } from "./pane-guards.js";
import { registerPaneBrowserFrameRoutes } from "./pane-stream-routes.js";
import { recordAudit } from "./request-audit.js";
import { registerVault } from "./vault/wiring.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type Bridge = D<typeof registerCliBrowserBridgeRoutes>; type PaneBrowser = D<typeof registerPaneBrowserRoutes>; type CliSessions = D<typeof registerPaneCliSessionRoutes>;
type Vault = D<typeof registerVault>; type Census = D<typeof registerBrowserCensusRoutes>; type AgentActions = D<typeof registerInternalAgentActionRoutes>;
type BrowserRoutesDeps = Pick<Bridge, "paneBrowserAccounts" | "marketingCopilotService" | "freelanceCopilotService" | "designService" | "videoService" | "appStudioService"
    | "securityCopilotService" | "monitoringCopilotService" | "mailCampaignsService">
  & Pick<PaneBrowser, "readGeminiAccountProfileDetails" | "youtubePlaybackStore" | "youtubeAccountStore" | "browserAccountStore" | "youtubeSessionStarts"
    | "youtubeAccountOperations" | "withYouTubeAccountLock" | "youtubeAccountOwner" | "selectedGoogleBrowserAccount" | "paneGoogleAccountSelection"
    | "resolvePaneBrowserAccount" | "adoptPaneSignIn" | "effectivePaneProfileId" | "browserAccountChoices" | "previousCopilotPane">
  & Pick<CliSessions, "deletingCliAccountProfileKeys" | "cliAccountProfileKey" | "codexCliModeDefaultsService" | "spaceAgentAdapter" | "cliRuntimeRegistryCache"
    | "cliTerminalManager" | "assertCliHttpMutationControl" | "resolveOpenCodeServerControl" | "resumePaneCliTask" | "spaceControl" | "assertRootAdmin"
    | "assertPaneCliRuntimeEnabled" | "cliAccountBalancer" | "cliPaneReopener" | "claudeDirectPins" | "resolveCliSessionAccountProfile" | "loadNativeCliModels">
  & {
    config: SpaceApiConfig; store: SpaceStore; eventBus: SpaceEventBus; auth: Vault["auth"];
    options: Bridge["options"] & { vault?: Vault["overrides"]; videoEngine?: PaneBrowser["videoEngine"] };
    browserSessionManager: Bridge["browserSessionManager"] & PaneBrowser["browserSessionManager"] & Vault["browser"] & Census["browserSessionManager"];
    cliRuntimeVisibility: Bridge["cliRuntimeVisibility"] & CliSessions["cliRuntimeVisibility"] & AgentActions["cliRuntimeVisibility"];
    browserControlActivity: NonNullable<Bridge["controlActivity"]> & PaneBrowser["controlActivity"] & Census["controlActivity"];
    nousRef: NonNullable<Bridge["nous"]>; connectorCrypto: Vault["crypto"]; geminiAccountEmails: Census["geminiEmails"];
    jobApplyService: NonNullable<Bridge["jobApplyService"]>; mailCopilotService: NonNullable<Bridge["mailCopilotService"]>;
    notificationService: Parameters<typeof settleBrowserHandoffNotifications>[0]["notifications"]; roomActionExecutor: AgentActions["roomActionExecutor"];
    cliUserHosting: { onUserCliHost: CliSessions["onUserCliHost"] };
    vaultKeySaved?: Vault["keySaved"];
    vaultKeysReconcile?: Vault["reconcileKeys"];
    defaultRouteRateLimitOptions: Bridge["routeOptions"] & PaneBrowser["routeOptions"] & CliSessions["routeOptions"] & Vault["routeOptions"] & Census["routeOptions"]
      & AgentActions["routeOptions"] & D<typeof registerPaneBrowserFrameRoutes>["routeOptions"] & Parameters<ReturnType<typeof createCliBrowserCdpProxy>["register"]>[1];
  };

/** The browser routes (moved verbatim from app.ts, ARCH-001 step 78): the Vault, the CLI browser bridge, the CLI CDP proxy with its Vault fence,
 * the browser census, the pane browser routes, the internal agent actions, the pane browser frames and the pane CLI session routes, in the order
 * app.ts registered them. Returns the Vault, which later routes and Nous read. */
export function registerBrowserRoutes(app: FastifyInstance, deps: BrowserRoutesDeps) {
  const { config, auth, store, eventBus, options, browserSessionManager, cliRuntimeVisibility, browserControlActivity, nousRef, defaultRouteRateLimitOptions,
    connectorCrypto, effectivePaneProfileId, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService, videoService, appStudioService,
    securityCopilotService, monitoringCopilotService, mailCampaignsService, jobApplyService, mailCopilotService, geminiAccountEmails, readGeminiAccountProfileDetails,
    youtubePlaybackStore, youtubeAccountStore, browserAccountStore, youtubeSessionStarts, youtubeAccountOperations, withYouTubeAccountLock, youtubeAccountOwner,
    selectedGoogleBrowserAccount, paneGoogleAccountSelection, resolvePaneBrowserAccount, adoptPaneSignIn, browserAccountChoices, previousCopilotPane,
    notificationService, roomActionExecutor, deletingCliAccountProfileKeys, cliAccountProfileKey, codexCliModeDefaultsService, spaceAgentAdapter,
    cliRuntimeRegistryCache, cliTerminalManager, assertCliHttpMutationControl, resolveOpenCodeServerControl, resumePaneCliTask, spaceControl, assertRootAdmin,
    assertPaneCliRuntimeEnabled, cliAccountBalancer, cliPaneReopener, claudeDirectPins, resolveCliSessionAccountProfile, cliUserHosting, loadNativeCliModels } = deps;
  const vault = registerVault(app, { config, auth, store, browser: browserSessionManager, routeOptions: defaultRouteRateLimitOptions, overrides: options.vault, paneAccount: effectivePaneProfileId, crypto: connectorCrypto, controlActivity: browserControlActivity, keySaved: deps.vaultKeySaved, reconcileKeys: deps.vaultKeysReconcile,
    // The CDP proxy is made below; it is asked only per fill, long after start.
    documentDirty: (paneId, targetId, document) => cliBrowserCdpProxy.documentDirty(paneId, targetId, document), documentDirtiedBy: (paneId, targetId, document) => cliBrowserCdpProxy.documentDirtiedBy(paneId, targetId, document) });
  registerCliBrowserBridgeRoutes(app, {
    options, config, store, eventBus, browserSessionManager, cliRuntimeVisibility, controlActivity: browserControlActivity, vault, nous: nousRef,
    dropOtherAgents: (paneId, keep) => { cliBrowserCdpProxy.closeForPane(paneId, "BROWSER_HANDOFF_PENDING", browserHandoffPendingReason, keep); },
    routeOptions: defaultRouteRateLimitOptions, paneBrowserAccounts, marketingCopilotService, freelanceCopilotService, designService, videoService, appStudioService, securityCopilotService, monitoringCopilotService, mailCampaignsService, jobApplyService: config.optionalModules.has("job-copilot") ? jobApplyService : undefined, mailCopilotService: config.optionalModules.has("mail-copilot") ? mailCopilotService : undefined
  });

  // CLI agents attach element-level automation to a pane browser through this proxy; operator control drops it.
  const cliBrowserCdpProxy = createCliBrowserCdpProxy({
    store,
    config,
    isBrowserPane,
    controlActivity: browserControlActivity,
    assertRuntimeEnabled: (runtimeId) => cliRuntimeVisibility.assertEnabled(runtimeId),
    vaultProtection: vault.protection,
    log: app.log,
    onConnected: (request, resolution) => {
      browserControlActivity.noteAgent(resolution.pane.id, resolution.claims.paneId);
      return recordAudit(store, request, {
        action: "pane.cli.browser_cdp_attach",
        targetType: "pane",
        targetId: resolution.pane.id,
        metadata: { roomId: resolution.claims.roomId, cliPaneId: resolution.claims.paneId, cliSessionId: resolution.claims.cliSessionId, sessionId: resolution.session.sessionId }
      });
    }
  });
  cliBrowserCdpProxy.register(app, defaultRouteRateLimitOptions); vault.protection.onProtected((paneId) => cliBrowserCdpProxy.closeForPane(paneId, "VAULT_PROTECTED", "This browser is protected for the Vault."));

  registerBrowserCensusRoutes(app, { store, browserSessionManager, controlActivity: browserControlActivity, cdpConnectionCount: (paneId) => cliBrowserCdpProxy.connectionCount(paneId), geminiEmails: geminiAccountEmails, routeOptions: defaultRouteRateLimitOptions });
  // Operator 5/11 14:47 BKK: unused browsers close by themselves, and an agent browser never refuses the operator's (browser-reaper.ts).
  const census = () => browserCensus({ store, agentOf: (paneId) => browserAgentOf(store, browserControlActivity, paneId, cliBrowserCdpProxy.connectionCount(paneId) > 0) });
  const usedAt = (paneId: string) => browserControlActivity.usedAt(paneId);
  const operatorBrowsers = operatorFirstBrowsers(browserSessionManager, { store, census, usedAt, noteUse: (paneId) => browserControlActivity.noteUse(paneId),
    warn: (error) => app.log.warn({ err: error }, "A browser could not yield to the operator.") });
  const reaper = startBrowserReaper({ store, census, usedAt, stopPane: (paneId, traceId) => browserSessionManager.stopPane(paneId, traceId),
    warn: (error, paneId) => app.log.warn({ err: error, paneId }, "Browser reaper failed.") });
  app.addHook("onClose", async () => reaper.stop());
  paneBrowserAccounts.current = registerPaneBrowserRoutes(app, {
    config, readGeminiAccountProfileDetails, store, browserSessionManager: operatorBrowsers, routeOptions: defaultRouteRateLimitOptions, cliBrowserCdpProxy,
    controlActivity: browserControlActivity, youtubePlaybackStore, youtubeAccountStore, browserAccountStore, youtubeSessionStarts, youtubeAccountOperations,
    withYouTubeAccountLock, youtubeAccountOwner, selectedGoogleBrowserAccount, paneGoogleAccountSelection,
    resolvePaneBrowserAccount, adoptPaneSignIn, effectivePaneProfileId, browserAccountChoices, previousCopilotPane, videoEngine: options.videoEngine,
    onJobCopilotAccountSelected: async (userId, email) => { await jobApplyService.setGoogleAccount(userId, email); },
    onControlReleased: (paneId) => void settleBrowserHandoffNotifications({ store, notifications: notificationService }, paneId)
      .catch((error: unknown) => app.log.warn({ err: error, paneId }, "Browser handoff notifications could not be settled after a release."))
  });

  registerInternalAgentActionRoutes(app, {
    config, store, browserSessionManager, cliRuntimeVisibility, roomActionExecutor, vaultProtection: vault.protection,
    routeOptions: defaultRouteRateLimitOptions
  });

  registerPaneBrowserFrameRoutes(app, {
    store, browserSessionManager: operatorBrowsers, routeOptions: defaultRouteRateLimitOptions, youtubeSessionStarts,
    youtubeAccountOperations
  });

  registerPaneCliSessionRoutes(app, {
    config, deletingCliAccountProfileKeys, cliAccountProfileKey, store, eventBus, codexCliModeDefaultsService,
    spaceAgentAdapter, cliRuntimeRegistryCache, cliTerminalManager, assertCliHttpMutationControl,
    cliRuntimeVisibility, resolveOpenCodeServerControl, resumePaneCliTask, spaceControl, assertRootAdmin,
    assertPaneCliRuntimeEnabled, routeOptions: defaultRouteRateLimitOptions, cliAccountBalancer, cliPaneReopener, claudeDirectPins, resolveCliSessionAccountProfile,
    loadNativeCliModels, onUserCliHost: cliUserHosting.onUserCliHost
  });
  return { vault };
}
