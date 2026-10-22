import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserControlLease, PaneBrowserSession } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { browserAccountTabsFile, googleBrowserProfilePathFor, type BrowserSessionManager } from "../src/browser-sessions.js";
import { cliBrowserBridgeTokenHeader, issueCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { cliBrowserCdpCloseCodes, cliBrowserCdpPath, cliBrowserCdpProxyIdBase, cliBrowserCdpStatusPath, cliBrowserPasswordRedaction, createCliBrowserCdpTargetFilter, readChromeAutomationEndpoint } from "../src/cli-browser-cdp.js";
import { getApiConfig } from "../src/config.js";
import { registerVaultFenceHooks } from "../src/vault/fence-hooks.js";

vi.setConfig({ testTimeout: 30_000 });
const csrfHeaderName = "x-space-csrf-token";
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Stands in for the managed Chrome: answers every CDP command with an echo result.
async function fakeChrome() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/devtools/browser/test" });
  const received: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const text = data.toString("utf8");
      received.push(text);
      const message = JSON.parse(text) as { id: number; method: string };
      socket.send(JSON.stringify({ id: message.id, result: { echo: message.method } }));
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  // WebSocketServer.close() waits for every client, so drop the proxy's upstream sockets first.
  const close = () => new Promise<void>((resolve) => {
    for (const client of server.clients) client.terminate();
    server.close(() => resolve());
  });
  return { received, port, close };
}

function fakeManager(store: InMemorySpaceStore, session: PaneBrowserSession): BrowserSessionManager {
  const response = { session, frame: null, websocket: null };
  const unused = async (): Promise<never> => { throw new Error("unused browser manager method"); };
  return {
    status: () => ({ enabled: true, statusReason: "enabled", defaultUrl: "https://example.com/", checkedAt: "2026-10-12T00:00:00.000Z" }),
    startOrRestore: async () => response,
    getActive: async () => response,
    navigate: async () => response,
    setViewport: async () => response,
    action: async () => ({ session, frame: null, text: null }),
    captureFrame: unused,
    stopPane: async () => undefined,
    stopRoom: async () => undefined,
    closeAll: async () => undefined,
    acquireControl: async (pane, input): Promise<BrowserControlLease> => store.createBrowserControlLease({
      sessionId: session.sessionId, paneId: pane.id, roomId: pane.roomId, holderType: input.holderType, holderId: input.holderId,
      reason: input.reason ?? null, ttlSeconds: input.ttlSeconds ?? 30
    })
  } as unknown as BrowserSessionManager;
}

async function fixture(chromePort: number) {
  const root = await mkdtemp(join(tmpdir(), "space-cli-cdp-"));
  temporaryRoots.push(root);
  const wrapper = join(root, "codex-vscode-parity");
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(wrapper, 0o755);
  const profile = join(root, "profile");
  await mkdir(profile);
  await writeFile(join(profile, "DevToolsActivePort"), `${chromePort}\n/devtools/browser/test\n`, "utf8");
  const config = getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: root,
    SPACE_CLI_HOST_SOCKET: join(root, "pane-host.sock"),
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: join(root, "workspaces"),
    SPACE_BROWSER_SESSIONS_ENABLED: "true",
    SPACE_BROWSER_SESSIONS_PROFILE_ROOT: join(root, "profiles"),
    SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
    SPACE_INTERNAL_API_TOKEN: "internal-token-for-cdp-tests"
  });
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "CDP proxy", initialPaneCount: 0 });
  const cliPane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
  const cliSession = store.createPaneCliSession({
    paneId: cliPane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL"
  });
  const jobPane = store.createPane({ roomId: room.id, title: "Job Applications", mode: "JOB_APPLY", terminalRuntimeId: "cli:codex" });
  const session = store.createPaneBrowserSession({
    paneId: jobPane.id, roomId: room.id, agentNumber: 1, profileId: "profile:test", profilePath: profile, viewport: "desktop"
  });
  const app = await createApp({
    store,
    browserSessionManager: fakeManager(store, session),
    config,
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false }
  });
  const token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: cliPane.id, cliSessionId: cliSession.sessionId })!;
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "space@space.local", password: "space-dev" } });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, store, config, room, token, cliPane, jobPane, session, cookie, csrfToken: csrf.json().csrfToken as string };
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function attach(app: Awaited<ReturnType<typeof fixture>>["app"], paneId: string, token: string | null) {
  const messages: string[] = [];
  let closed: Promise<number> = Promise.resolve(-1);
  const socket = await app.injectWS(`${cliBrowserCdpPath}?paneId=${encodeURIComponent(paneId)}`,
    { headers: token ? { [cliBrowserBridgeTokenHeader]: token } : {} },
    { onInit(ws) { closed = closeCode(ws); ws.on("message", (data) => messages.push(data.toString("utf8"))); } });
  return { socket, messages, closed };
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe("CLI browser CDP proxy", () => {
  it("reads Chrome's DevToolsActivePort and rejects anything else", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-devtools-port-"));
    temporaryRoots.push(root);
    expect(await readChromeAutomationEndpoint(root)).toBeNull();
    await writeFile(join(root, "DevToolsActivePort"), "45677\n/devtools/browser/abc\n", "utf8");
    expect(await readChromeAutomationEndpoint(root)).toBe("ws://127.0.0.1:45677/devtools/browser/abc");
    await writeFile(join(root, "DevToolsActivePort"), "45677\n/etc/passwd\n", "utf8");
    expect(await readChromeAutomationEndpoint(root)).toBeNull();
  });

  it("pipes CDP messages to the pane browser for a valid pane token and refuses the rest", async () => {
    const chrome = await fakeChrome();
    const { app, token, jobPane, cliPane, session } = await fixture(chrome.port);
    try {
      const status = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(jobPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: token } });
      expect(status.json()).toMatchObject({ ready: true, paneId: jobPane.id, sessionId: session.sessionId });

      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
      const reply = await waitFor(() => client.messages[0], "the echoed CDP reply");
      expect(JSON.parse(reply)).toEqual({ id: 7, result: { echo: "Browser.getVersion" } });
      expect(chrome.received).toEqual([JSON.stringify({ id: 7, method: "Browser.getVersion" })]);
      client.socket.close(1000, "done");
      expect(await client.closed).toBe(1000);
      expect(await (await attach(app, jobPane.id, null)).closed).toBe(cliBrowserCdpCloseCodes.TOKEN_INVALID);
      expect(await (await attach(app, jobPane.id, `${token}x`)).closed).toBe(cliBrowserCdpCloseCodes.TOKEN_INVALID);
      expect(await (await attach(app, cliPane.id, token)).closed).toBe(cliBrowserCdpCloseCodes.PANE_NOT_FOUND);
      const unauthenticated = await app.inject({ method: "GET", url: cliBrowserCdpStatusPath });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toMatchObject({ ready: false, reason: "TOKEN_INVALID" });
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("sends a plain CLI pane to its room's browser pane", async () => {
    const chrome = await fakeChrome();
    const { app, store, room, token, cliPane, session } = await fixture(chrome.port);
    try {
      const browserPane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
      const browser = store.createPaneBrowserSession({ paneId: browserPane.id, roomId: room.id, agentNumber: 2, profileId: "profile:test", profilePath: session.profilePath, viewport: "desktop" });
      const status = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(cliPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: token } });
      expect(status.json()).toMatchObject({ ready: true, paneId: browserPane.id, sessionId: browser.sessionId });
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("lets an open T3 Code pane drive its room's pane browser under its T3 principal", async () => {
    const chrome = await fakeChrome();
    const { app, store, config, room, jobPane, session } = await fixture(chrome.port);
    try {
      const t3Pane = store.createPane({ roomId: room.id, title: "T3 Code", mode: "T3CODE" });
      const t3Token = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: t3Pane.id, cliSessionId: `t3code:${t3Pane.id}` })!;
      const status = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(jobPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: t3Token } });
      expect(status.json()).toMatchObject({ ready: true, paneId: jobPane.id, sessionId: session.sessionId });
      const client = await attach(app, jobPane.id, t3Token);
      client.socket.send(JSON.stringify({ id: 3, method: "Browser.getVersion" }));
      expect(JSON.parse(await waitFor(() => client.messages[0], "the echoed CDP reply"))).toEqual({ id: 3, result: { echo: "Browser.getVersion" } });
      client.socket.close(1000, "done");
      expect(await client.closed).toBe(1000);
      store.updatePane(t3Pane.id, { isClosed: true });
      expect(await (await attach(app, jobPane.id, t3Token)).closed).toBe(cliBrowserCdpCloseCodes.TOKEN_INVALID);
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("hides the pages of other panes that share the Chrome and never leaves them paused", () => {
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message));
    filter.setForeignPages(["other-page"]);
    const page = (targetId: string) => ({ targetId, type: "page", url: "https://jobs.example/" });
    // Target.getTargets: only this pane's (and unowned) pages come back.
    expect(filter.fromClient(JSON.stringify({ id: 5, method: "Target.getTargets", params: {} }))).toEqual({ forward: true });
    const listed = JSON.parse(filter.fromChrome(JSON.stringify({ id: 5, result: { targetInfos: [page("mine"), page("other-page"), { targetId: "sw", type: "service_worker" }] } }))!);
    expect(listed.result.targetInfos.map((info: { targetId: string }) => info.targetId)).toEqual(["mine", "sw"]);
    // Commands aimed at another pane's page are answered locally.
    const refused = filter.fromClient(JSON.stringify({ id: 6, method: "Target.attachToTarget", params: { targetId: "other-page", flatten: true } }));
    expect(refused.forward).toBe(false);
    expect(JSON.parse((refused as { reply: string }).reply)).toMatchObject({ id: 6, error: { code: -32000 } });
    expect(filter.fromClient(JSON.stringify({ id: 7, method: "Target.activateTarget", params: { targetId: "mine" } }))).toEqual({ forward: true });
    // An auto-attach to another pane's page is hidden, resumed and detached by the proxy.
    expect(filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-other", targetInfo: page("other-page"), waitingForDebugger: true } }))).toBeNull();
    expect(sent).toEqual([
      { id: cliBrowserCdpProxyIdBase + 1, method: "Runtime.runIfWaitingForDebugger", params: {}, sessionId: "s-other" },
      { id: cliBrowserCdpProxyIdBase + 2, method: "Target.detachFromTarget", params: { sessionId: "s-other" } }
    ]);
    expect(filter.fromChrome(JSON.stringify({ id: cliBrowserCdpProxyIdBase + 1, result: {} }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "s-other" } }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: page("other-page") } }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "other-page" } }))).toBeNull();
    // This pane's pages, child-session events and ordinary replies pass through untouched.
    const own = JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-mine", targetInfo: page("mine"), waitingForDebugger: true } });
    expect(filter.fromChrome(own)).toBe(own);
    const child = JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-frame", targetInfo: { targetId: "other-page", type: "page" } }, sessionId: "s-mine" });
    expect(filter.fromChrome(child)).toBe(child);
    const ordinary = JSON.stringify({ id: 9, result: { data: "x" } });
    expect(filter.fromChrome(ordinary)).toBe(ordinary);
  });

  it("masks password values in Playwright's utility world before the client can use it, and leaves the page's own world alone", () => {
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message));
    const created = (name: string, id: number) => JSON.stringify({ method: "Runtime.executionContextCreated",
      params: { context: { id, origin: "https://login.example", name, uniqueId: `u-${id}`, auxData: { frameId: "frame-1", isDefault: name === "" } } }, sessionId: "s-mine" });
    const utility = created("__playwright_utility_world_page@1", 7);
    expect(filter.fromChrome(utility)).toBe(utility);
    expect(sent).toEqual([{ id: cliBrowserCdpProxyIdBase + 1, method: "Runtime.evaluate",
      params: { expression: cliBrowserPasswordRedaction, contextId: 7, returnByValue: true, silent: true }, sessionId: "s-mine" }]);
    // Older Playwright names the world without a page id; the page's main world and other worlds get nothing.
    expect(filter.fromChrome(created("__playwright_utility_world__", 8))).not.toBeNull();
    for (const name of ["", "extension-world"]) expect(filter.fromChrome(created(name, 9))).not.toBeNull();
    expect(sent.map((message) => (message.params as { contextId: number }).contextId)).toEqual([7, 8]);
    // The proxy's own reply never reaches the client.
    expect(filter.fromChrome(JSON.stringify({ id: cliBrowserCdpProxyIdBase + 1, result: { result: { type: "undefined" } } }))).toBeNull();

    // In a world like Chrome's: password fields read as a mask, other fields and writes are untouched, and a second run is a no-op.
    const world = createContext({});
    runInContext(`globalThis.HTMLInputElement = class { constructor(type, value) { this.type = type; this.raw = value; }
      get value() { return this.raw; } set value(next) { this.raw = next; } }`, world);
    runInContext(cliBrowserPasswordRedaction, world);
    runInContext(cliBrowserPasswordRedaction, world);
    expect(runInContext(`const secret = new HTMLInputElement("password", "synthetic-value"), empty = new HTMLInputElement("password", ""),
      text = new HTMLInputElement("text", "hello"); secret.value = "next-synthetic";
      JSON.stringify([secret.value, secret.raw, empty.value, text.value])`, world))
      .toBe(JSON.stringify(["\u2022".repeat(8), "next-synthetic", "", "hello"]));
  });

  it("hides every tab another pane's Vault fence covers, whichever Chrome the store lists it in", async () => {
    const chrome = await fakeChrome();
    const { app, store, room, token, jobPane, session } = await fixture(chrome.port);
    try {
      // The filled pane runs on another Chrome profile and the store does not list the tab (a handoff page, a stale list).
      const filled = store.createPane({ roomId: room.id, title: "Freelance", mode: "BROWSER" });
      store.createPaneBrowserSession({ paneId: filled.id, roomId: room.id, agentNumber: 2, profileId: "profile:filled", profilePath: `${session.profilePath}-filled`, viewport: "desktop" });
      registerVaultFenceHooks(store, { fenceHandoff: async () => undefined, fencedTargets: async (paneId) => paneId === filled.id ? ["fenced-tab"] : [] });
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "fenced-tab", flatten: true } }));
      client.socket.send(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
      await waitFor(() => (client.messages.length >= 2 ? true : undefined), "both replies");
      expect(JSON.parse(client.messages.find((text) => JSON.parse(text).id === 1)!)).toMatchObject({ id: 1, error: { code: -32000 } });
      expect(chrome.received).toEqual([JSON.stringify({ id: 2, method: "Browser.getVersion" })]);
      client.socket.close(1000, "done");
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("refuses commands for another pane's page of the same Chrome before they reach the browser", async () => {
    const chrome = await fakeChrome();
    const { app, store, room, token, jobPane, session } = await fixture(chrome.port);
    try {
      const otherPane = store.createPane({ roomId: room.id, title: "Browser 2", mode: "BROWSER" });
      const other = store.createPaneBrowserSession({ paneId: otherPane.id, roomId: room.id, agentNumber: 2, profileId: "profile:test", profilePath: session.profilePath, viewport: "desktop" });
      store.updatePaneBrowserSession(other.sessionId, { pages: [{ pageId: "other-page", kind: "PAGE", url: "https://jobs.example/", title: "Other", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }] });
      // A pane whose own Chrome is another one may keep a tab in this Chrome's account.
      const andy = store.createPane({ roomId: room.id, title: "Andy", mode: "MARKETING_COPILOT" });
      const andySession = store.createPaneBrowserSession({ paneId: andy.id, roomId: room.id, agentNumber: 3, profileId: "profile:andy", profilePath: `${session.profilePath}-andy`, viewport: "desktop" });
      store.updatePaneBrowserSession(andySession.sessionId, { pages: [{ pageId: "andy-account-tab", kind: "PAGE", url: "https://mail.example/", title: "Mail", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false, account: { profileId: "google_account:test", label: null } }] });
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "other-page", flatten: true } }));
      client.socket.send(JSON.stringify({ id: 3, method: "Target.attachToTarget", params: { targetId: "andy-account-tab", flatten: true } }));
      client.socket.send(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
      await waitFor(() => (client.messages.length >= 3 ? true : undefined), "every reply");
      expect(JSON.parse(client.messages.find((text) => JSON.parse(text).id === 1)!)).toMatchObject({ id: 1, error: { code: -32000 } });
      expect(JSON.parse(client.messages.find((text) => JSON.parse(text).id === 3)!)).toMatchObject({ id: 3, error: { code: -32000 } });
      expect(chrome.received).toEqual([JSON.stringify({ id: 2, method: "Browser.getVersion" })]);
      client.socket.close(1000, "done");
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("follows the active tab into another Google account's Chrome and reconnects when it moves back", async () => {
    const home = await fakeChrome();
    const main = await fakeChrome();
    const { app, store, config, token, jobPane, session } = await fixture(home.port);
    try {
      // The pane's tab of the main account lives in that account's Chrome (browser-sessions.ts switchPageAccount).
      const identity = { googleAccount: { ownerUserId: "user:operator", accountId: "google_account:main" } };
      const mainProfile = googleBrowserProfilePathFor(config.browserSessionsProfileRoot, identity.googleAccount.ownerUserId, identity.googleAccount.accountId);
      await mkdir(mainProfile, { recursive: true });
      await writeFile(join(mainProfile, "DevToolsActivePort"), `${main.port}\n/devtools/browser/test\n`, "utf8");
      const tabsFile = browserAccountTabsFile(config.browserSessionsProfileRoot, jobPane.id);
      await mkdir(join(tabsFile, ".."), { recursive: true });
      await writeFile(tabsFile, JSON.stringify({ version: 1, accounts: { "google_account:main": identity } }), "utf8");
      const tab = (pageId: string, isActive: boolean, account: { profileId: string; label: string } | null) =>
        ({ pageId, kind: "PAGE" as const, url: "https://x.com/compose/post", title: pageId, isActive, openerPageId: null, canGoBack: false, canGoForward: false, account });
      store.updatePaneBrowserSession(session.sessionId, {
        pages: [tab("linkedin", false, null), tab("x-main", true, { profileId: "google_account:main", label: "spaceappdv@gmail.com" })],
        activePageId: "x-main"
      });

      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      await waitFor(() => client.messages[0], "the main account Chrome's reply");
      expect(main.received).toEqual([JSON.stringify({ id: 1, method: "Browser.getVersion" })]);
      expect(home.received).toEqual([]);

      // The operator or agent brings the pane's own tab back to the front: the client is closed and reconnects at home.
      store.updatePaneBrowserSession(session.sessionId, { pages: [tab("linkedin", true, null), tab("x-main", false, { profileId: "google_account:main", label: "spaceappdv@gmail.com" })], activePageId: "linkedin" });
      expect(await client.closed).toBe(cliBrowserCdpCloseCodes.ACTIVE_TAB_MOVED);
      const again = await attach(app, jobPane.id, token);
      again.socket.send(JSON.stringify({ id: 2, method: "Browser.getVersion" }));
      await waitFor(() => again.messages[0], "the pane's own Chrome's reply");
      expect(home.received).toEqual([JSON.stringify({ id: 2, method: "Browser.getVersion" })]);
      again.socket.close(1000, "done");
    } finally {
      await app.close();
      await home.close();
      await main.close();
    }
  });

  it("drops and refuses automation while an operator holds browser control", async () => {
    const chrome = await fakeChrome();
    const { app, store, token, jobPane, cookie, csrfToken } = await fixture(chrome.port);
    try {
      const client = await attach(app, jobPane.id, token);
      const acquire = await app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(jobPane.id)}/browser/control/acquire`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { holderType: "OPERATOR", holderId: "user:operator", reason: "CAPTCHA handoff" }
      });
      expect(acquire.statusCode).toBe(200);
      expect(await client.closed).toBe(cliBrowserCdpCloseCodes.BROWSER_CONTROL_HELD);
      expect(await (await attach(app, jobPane.id, token)).closed).toBe(cliBrowserCdpCloseCodes.BROWSER_CONTROL_HELD);
      const held = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(jobPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: token } });
      expect(held.json()).toMatchObject({ ready: false, reason: "BROWSER_CONTROL_HELD" });

      const lease = acquire.json().lease as BrowserControlLease;
      store.updateBrowserControlLease(lease.leaseId, { status: "RELEASED" });
      const released = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(jobPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: token } });
      expect(released.json()).toMatchObject({ ready: true });
    } finally {
      await app.close();
      await chrome.close();
    }
  });
});
