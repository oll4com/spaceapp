import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]>, proxyCalls: [] as unknown[][], protectedListeners: [] as Array<(paneId: string) => void>,
    settled: [] as unknown[], settleFails: false };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/vault/wiring.js", async (orig) => ({ ...await orig<object>(), registerVault: rec("vault", {
  repository: "vault-repo", protection: { name: "protection", onProtected: (listener: (paneId: string) => void) => { captured.order.push("onProtected"); captured.protectedListeners.push(listener); } } }) }));
vi.mock("../src/cli-browser-bridge-routes.js", async (orig) => ({ ...await orig<object>(), registerCliBrowserBridgeRoutes: rec("bridge") }));
vi.mock("../src/cli-browser-cdp.js", async (orig) => ({ ...await orig<object>(), createCliBrowserCdpProxy: (deps: unknown) => {
  captured.order.push("cdpProxy"); captured.args.cdpProxy = [deps];
  const call = (name: string) => (...args: unknown[]) => { captured.proxyCalls.push([name, ...args]); return `${name}-result`; };
  return { register: (...args: unknown[]) => { captured.order.push("cdpRegister"); captured.args.cdpRegister = args; }, documentDirty: call("documentDirty"),
    documentDirtiedBy: call("documentDirtiedBy"), closeForPane: call("closeForPane"), connectionCount: call("connectionCount") };
} }));
vi.mock("../src/browser-census-routes.js", async (orig) => ({ ...await orig<object>(), registerBrowserCensusRoutes: rec("census") }));
vi.mock("../src/pane-browser-routes.js", async (orig) => ({ ...await orig<object>(), registerPaneBrowserRoutes: rec("paneBrowser", { control: "pane-browser-accounts" }) }));
vi.mock("../src/internal-agent-action-routes.js", async (orig) => ({ ...await orig<object>(), registerInternalAgentActionRoutes: rec("agentActions") }));
vi.mock("../src/pane-stream-routes.js", async (orig) => ({ ...await orig<object>(), registerPaneBrowserFrameRoutes: rec("frames") }));
vi.mock("../src/pane-cli-session-routes.js", async (orig) => ({ ...await orig<object>(), registerPaneCliSessionRoutes: rec("cliSessions") }));
vi.mock("../src/notifications/browser-handoff.js", async (orig) => ({ ...await orig<object>(), settleBrowserHandoffNotifications: async (deps: unknown, paneId: string) => {
  captured.settled.push({ deps, paneId }); if (captured.settleFails) throw new Error("settle failed"); return 1;
} }));

const { registerBrowserRoutes } = await import("../src/browser-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {}, proxyCalls: [], protectedListeners: [], settled: [], settleFails: false }); });

function wire(modules: string[] = ["job-copilot", "mail-copilot"]) {
  const warnings: unknown[] = [];
  const audits: unknown[] = [];
  const noted: unknown[] = [];
  const accountsSelected: unknown[] = [];
  const app = { log: { warn: (...args: unknown[]) => { warnings.push(args); }, info: () => {} }, addHook: () => {} };
  const deps = {
    config: { optionalModules: new Set(modules) }, auth: { sessionSecret: "s".repeat(32) }, eventBus: { bus: true },
    store: { upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }), recordAuditEvent: async (event: unknown) => { audits.push(event); } },
    options: { vault: { overrides: true }, videoEngine: "video-engine" }, browserSessionManager: { browsers: true },
    cliRuntimeVisibility: { assertEnabled: (runtimeId: string) => { noted.push(`enabled:${runtimeId}`); } },
    browserControlActivity: { noteAgent: (...args: unknown[]) => { noted.push(args); } }, nousRef: { current: null },
    defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, connectorCrypto: { crypto: true }, effectivePaneProfileId: "effective-profile",
    paneBrowserAccounts: { current: null as unknown }, marketingCopilotService: "marketing", freelanceCopilotService: "freelance", designService: "design",
    videoService: "video", appStudioService: "app-studio", securityCopilotService: "security", monitoringCopilotService: "monitoring", mailCampaignsService: "campaigns",
    jobApplyService: { setGoogleAccount: async (...args: unknown[]) => { accountsSelected.push(args); } }, mailCopilotService: "mail",
    geminiAccountEmails: "gemini-emails", readGeminiAccountProfileDetails: "gemini-details", youtubePlaybackStore: "playback", youtubeAccountStore: "youtube-accounts",
    browserAccountStore: "browser-accounts", youtubeSessionStarts: "session-starts", youtubeAccountOperations: "account-operations", withYouTubeAccountLock: "lock",
    youtubeAccountOwner: "owner", selectedGoogleBrowserAccount: "selected", paneGoogleAccountSelection: "selection", resolvePaneBrowserAccount: "resolve",
    adoptPaneSignIn: "adopt", browserAccountChoices: "choices", previousCopilotPane: "previous", notificationService: { notifications: true },
    roomActionExecutor: "room-actions", deletingCliAccountProfileKeys: "deleting", cliAccountProfileKey: "profile-key", codexCliModeDefaultsService: "codex-defaults",
    spaceAgentAdapter: "agent", cliRuntimeRegistryCache: "registry", cliTerminalManager: "terminal", assertCliHttpMutationControl: "mutation-control",
    resolveOpenCodeServerControl: "opencode", resumePaneCliTask: "resume", spaceControl: "space-control", assertRootAdmin: "root-admin",
    assertPaneCliRuntimeEnabled: "runtime-enabled", cliAccountBalancer: "balancer", cliPaneReopener: "reopener", claudeDirectPins: "pins",
    resolveCliSessionAccountProfile: "session-profile", cliUserHosting: { onUserCliHost: "user-cli-host" }
  };
  const result = registerBrowserRoutes(app as never, deps as never);
  return { result, deps, warnings, audits, noted, accountsSelected };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, never>;
const call = <T = unknown>(value: unknown, ...args: unknown[]) => (value as (...args: unknown[]) => T)(...args);

describe("browser routes wiring (ARCH-001 step 78)", () => {
  it("registers in app.ts's order, returns the Vault and sets the pane browser accounts", () => {
    const { result, deps } = wire();
    expect(captured.order).toEqual(["vault", "bridge", "cdpProxy", "cdpRegister", "onProtected", "census", "paneBrowser", "agentActions", "frames", "cliSessions"]);
    expect(result.vault).toMatchObject({ repository: "vault-repo" });
    expect(deps.paneBrowserAccounts.current).toEqual({ control: "pane-browser-accounts" });
    expect(arg("vault")).toMatchObject({ browser: deps.browserSessionManager, overrides: { overrides: true }, paneAccount: "effective-profile", crypto: { crypto: true } });
    expect(arg("bridge")).toMatchObject({ vault: result.vault, nous: deps.nousRef, controlActivity: deps.browserControlActivity, mailCampaignsService: "campaigns" });
    expect(arg("cdpRegister", 0)).toBeDefined();
    expect(arg("cdpRegister", 1)).toBe(deps.defaultRouteRateLimitOptions);
    expect(arg("agentActions").vaultProtection).toBe(result.vault.protection);
    expect(arg("cliSessions")).toMatchObject({ onUserCliHost: "user-cli-host", claudeDirectPins: "pins", resolveCliSessionAccountProfile: "session-profile" });
    expect(arg("frames")).toMatchObject({ youtubeSessionStarts: "session-starts", youtubeAccountOperations: "account-operations" });
  });

  it("gives the bridge the Job and Mail Copilot services only with their modules", () => {
    wire();
    expect(arg("bridge")).toMatchObject({ jobApplyService: expect.objectContaining({ setGoogleAccount: expect.any(Function) }), mailCopilotService: "mail" });
    captured.order = [];
    wire([]);
    expect(arg("bridge").jobApplyService).toBeUndefined();
    expect(arg("bridge").mailCopilotService).toBeUndefined();
  });

  it("the Vault asks the CDP proxy about dirty documents, and its fence closes the pane's CDP connections", () => {
    wire();
    expect(call(arg("vault").documentDirty, "pane:browser1", "target-1", "doc-1")).toBe("documentDirty-result");
    expect(call(arg("vault").documentDirtiedBy, "pane:browser1", "target-1", "doc-1")).toBe("documentDirtiedBy-result");
    captured.protectedListeners[0]!("pane:browser1");
    expect(call(arg("census").cdpConnectionCount, "pane:browser1")).toBe("connectionCount-result");
    expect(captured.proxyCalls).toEqual([["documentDirty", "pane:browser1", "target-1", "doc-1"], ["documentDirtiedBy", "pane:browser1", "target-1", "doc-1"],
      ["closeForPane", "pane:browser1", "VAULT_PROTECTED", "This browser is protected for the Vault."], ["connectionCount", "pane:browser1"]]);
  });

  it("the CDP proxy checks the runtime, holds the Vault fence and audits each attach", async () => {
    const { result, audits, noted } = wire();
    const proxy = arg("cdpProxy", 0) as unknown as { vaultProtection: unknown; assertRuntimeEnabled: (id: string) => void; isBrowserPane: unknown;
      onConnected: (request: unknown, resolution: unknown) => Promise<void> };
    expect(proxy.vaultProtection).toBe(result.vault.protection);
    expect(proxy.isBrowserPane).toEqual(expect.any(Function));
    proxy.assertRuntimeEnabled("cli:codex");
    await proxy.onConnected({ user: { id: "user:owner01", email: "o@x.test", role: "ADMIN" } }, { pane: { id: "pane:browser1" },
      claims: { roomId: "room:room0001", paneId: "pane:cli00001", cliSessionId: "cli_session:0001" }, session: { sessionId: "browser-session-1" } });
    expect(noted).toEqual(["enabled:cli:codex", ["pane:browser1", "pane:cli00001"]]);
    expect(audits).toEqual([expect.objectContaining({ actorUserId: "user:owner01:stored", action: "pane.cli.browser_cdp_attach", targetType: "pane", targetId: "pane:browser1",
      metadata: { roomId: "room:room0001", cliPaneId: "pane:cli00001", cliSessionId: "cli_session:0001", sessionId: "browser-session-1" } })]);
  });

  it("the pane browser routes set the Job Copilot account, settle handoff notices on release and log a failed settle", async () => {
    const { deps, warnings, accountsSelected } = wire();
    const paneBrowser = arg("paneBrowser");
    expect(paneBrowser).toMatchObject({ videoEngine: "video-engine", cliBrowserCdpProxy: expect.objectContaining({ register: expect.any(Function) }), effectivePaneProfileId: "effective-profile" });
    await call(paneBrowser.onJobCopilotAccountSelected, "user:owner01", "me@x.test");
    expect(accountsSelected).toEqual([["user:owner01", "me@x.test"]]);
    call(paneBrowser.onControlReleased, "pane:browser1");
    await vi.waitFor(() => expect(captured.settled).toEqual([{ deps: { store: deps.store, notifications: deps.notificationService }, paneId: "pane:browser1" }]));
    captured.settleFails = true;
    call(paneBrowser.onControlReleased, "pane:browser2");
    await vi.waitFor(() => expect(warnings).toHaveLength(1));
    expect(warnings[0]).toEqual([expect.objectContaining({ paneId: "pane:browser2" }), "Browser handoff notifications could not be settled after a release."]);
  });
});
