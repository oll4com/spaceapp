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
import {
  cliBrowserCdpCloseCodes, cliBrowserCdpPath, cliBrowserCdpProxyIdBase, cliBrowserCdpStatusPath, cliBrowserPasswordRedaction, createCliBrowserCdpTargetFilter,
  createCliBrowserDocumentMarks, readChromeAutomationEndpoint
} from "../src/cli-browser-cdp.js";
import { getApiConfig } from "../src/config.js";
import { registerVaultFenceHooks } from "../src/vault/fence-hooks.js";
import { fakeRepository } from "./support/vault-fakes.js";

vi.setConfig({ testTimeout: 30_000 });
const csrfHeaderName = "x-space-csrf-token";
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Stands in for the managed Chrome: answers every CDP command with an echo result.
async function fakeChrome(answer: (message: { id: number; method: string }) => unknown = (message) => ({ echo: message.method })) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/devtools/browser/test" });
  const received: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const text = data.toString("utf8");
      received.push(text);
      const message = JSON.parse(text) as { id: number; method: string };
      socket.send(JSON.stringify({ id: message.id, result: answer(message) }));
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

async function fixture(chromePort: number, options: { vault?: Parameters<typeof createApp>[0]["vault"] } = {}) {
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
    auth: { sessionSecret: "test-secret-with-enough-length", devLogin: true, secureCookies: false },
    ...(options.vault ? { vault: options.vault } : {})
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

/** `paneId` null: no paneId query, the way a plain CLI pane's wrapper connects (the proxy picks the room's browser pane). */
async function attach(app: Awaited<ReturnType<typeof fixture>>["app"], paneId: string | null, token: string | null) {
  const messages: string[] = [];
  let closed: Promise<number> = Promise.resolve(-1);
  const socket = await app.injectWS(paneId ? `${cliBrowserCdpPath}?paneId=${encodeURIComponent(paneId)}` : cliBrowserCdpPath,
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

  it("never sends a plain CLI pane to the browser another agent of the room drives (6/11: Dana's tools drove Cody's browser)", async () => {
    const chrome = await fakeChrome();
    const { app, store, config, room, token, cliPane, session } = await fixture(chrome.port);
    try {
      const browserPane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
      store.createPaneBrowserSession({ paneId: browserPane.id, roomId: room.id, agentNumber: 2, profileId: "profile:test", profilePath: session.profilePath, viewport: "desktop" });
      const otherPane = store.createPane({ roomId: room.id, title: "Other CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const otherSession = store.createPaneCliSession({ paneId: otherPane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL" });
      const otherToken = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: otherPane.id, cliSessionId: otherSession.sessionId })!;
      const driving = await attach(app, null, otherToken);
      driving.socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      await waitFor(() => driving.messages[0], "the other agent's CDP reply");
      const status = await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(cliPane.id)}`, headers: { [cliBrowserBridgeTokenHeader]: token } });
      expect(status.json()).toMatchObject({ ready: false, reason: "PANE_NOT_FOUND" });
      expect(status.body).not.toContain(browserPane.id);
      const other = await app.inject({ method: "GET", url: cliBrowserCdpStatusPath, headers: { [cliBrowserBridgeTokenHeader]: otherToken } });
      expect(other.json()).toMatchObject({ ready: true, paneId: browserPane.id });
      driving.socket.close(1000, "done");
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("refuses a plain CLI pane's automation while its room's browser pane holds a Vault fence, named or not (Vault review 2026-10-22)", async () => {
    const chrome = await fakeChrome();
    const repository = fakeRepository();
    const { app, store, room, token, session } = await fixture(chrome.port, { vault: { repository: repository as never } });
    try {
      const browserPane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
      store.createPaneBrowserSession({ paneId: browserPane.id, roomId: room.id, agentNumber: 2, profileId: "profile:test", profilePath: session.profilePath, viewport: "desktop" });
      // A fill fenced the room's browser pane; the plain CLI token never names it, the proxy resolves it by default.
      await (repository as unknown as { protectPane(owner: string, paneId: string, fill: unknown): Promise<boolean> })
        .protectPane("user:alice", browserPane.id, { targetId: "target-1", origin: "https://login.example", document: "doc-1" });
      const headers = { [cliBrowserBridgeTokenHeader]: token };
      // Named: the route hook refuses it (VAULT_PROTECTED_SESSION_REQUIRED); unnamed: the proxy's own check (VAULT_PROTECTED).
      for (const url of [cliBrowserCdpStatusPath, `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(browserPane.id)}`]) {
        const status = await app.inject({ method: "GET", url, headers });
        expect(status.statusCode, url).toBe(409);
        expect(status.body, url).toMatch(/VAULT_PROTECTED/);
      }
      expect((await app.inject({ method: "GET", url: cliBrowserCdpStatusPath, headers })).json()).toMatchObject({ ready: false, reason: "VAULT_PROTECTED" });
      expect(await (await attach(app, null, token)).closed).toBe(cliBrowserCdpCloseCodes.VAULT_PROTECTED);
      expect(chrome.received).toHaveLength(0);
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("marks the documents a session scripts or changes in the page's own world, and leaves clicks, typing, snapshots in an isolated world and http(s) navigation clean (Vault review 2026-10-22)", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Array<Record<string, unknown>> = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:browser1", marks });
    const client = (message: Record<string, unknown>) => filter.fromClient(JSON.stringify(message));
    const chrome = (message: Record<string, unknown>) => filter.fromChrome(JSON.stringify(message));
    // The proxy answers its own Page.getFrameTree with the current document, as Chrome would.
    const answerFrameTree = (loaderId: string) => {
      const asked = sent.filter((message) => message.method === "Page.getFrameTree").at(-1)!;
      expect(chrome({ id: asked.id, result: { frameTree: { frame: { id: "frame-1", loaderId } } } })).toBeNull();
    };
    chrome({ method: "Target.attachedToTarget", params: { sessionId: "s1", targetInfo: { targetId: "t1", type: "page" }, waitingForDebugger: false } });
    chrome({ method: "Runtime.executionContextCreated", params: { context: { id: 1, name: "", auxData: { isDefault: true, frameId: "frame-1" } } }, sessionId: "s1" });
    chrome({ method: "Runtime.executionContextCreated", params: { context: { id: 2, name: "__playwright_utility_world__", uniqueId: "u-2", auxData: { isDefault: false, frameId: "frame-1" } } }, sessionId: "s1" });
    // Playwright's snapshots and clicks: the utility world, Input, Accessibility, screenshots, http(s) navigation.
    for (const message of [
      { id: 1, method: "Runtime.callFunctionOn", params: { functionDeclaration: "() => 1", executionContextId: 2 }, sessionId: "s1" },
      { id: 2, method: "Runtime.evaluate", params: { expression: "1", uniqueContextId: "u-2" }, sessionId: "s1" },
      { id: 3, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 1, y: 1 }, sessionId: "s1" },
      { id: 4, method: "Input.insertText", params: { text: "x" }, sessionId: "s1" },
      { id: 5, method: "Accessibility.getFullAXTree", params: {}, sessionId: "s1" },
      { id: 6, method: "Page.captureScreenshot", params: {}, sessionId: "s1" },
      { id: 7, method: "Page.navigate", params: { url: "https://login.example/" }, sessionId: "s1" },
      { id: 8, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "", worldName: "__playwright_utility_world__" }, sessionId: "s1" },
      { id: 9, method: "DOM.getDocument", params: {}, sessionId: "s1" },
      { id: 10, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }
    ]) expect(client(message).forward, message.method).toBe(true);
    expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(0);
    expect(marks.isDirty("pane:browser1", "t1", "loader-1")).toBe(false);
    // Code in the page's own world (no context, or the default one) marks the document the session is on; later documents stay clean.
    expect(client({ id: 11, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "s1" }).forward).toBe(true);
    answerFrameTree("loader-1");
    expect(marks.isDirty("pane:browser1", "t1", "loader-1")).toBe(true);
    expect(marks.isDirty("pane:browser1", "t1", "loader-2")).toBe(false);
    expect(marks.isDirty("pane:browser1", "t2", "loader-1")).toBe(false);
    expect(marks.isDirty("pane:other", "t1", "loader-1")).toBe(false);
    // A DOM change, a call in the default world: the same. An isolated world the session made itself is clean.
    client({ id: 12, method: "DOM.setAttributeValue", params: { nodeId: 1, name: "x", value: "y" }, sessionId: "s1" });
    answerFrameTree("loader-2");
    expect(marks.isDirty("pane:browser1", "t1", "loader-2")).toBe(true);
    client({ id: 13, method: "Page.createIsolatedWorld", params: { frameId: "frame-1", worldName: "mine" }, sessionId: "s1" });
    expect(chrome({ id: 13, result: { executionContextId: 9 }, sessionId: "s1" })).not.toBeNull();
    client({ id: 14, method: "Runtime.evaluate", params: { expression: "1", contextId: 9 }, sessionId: "s1" });
    client({ id: 15, method: "Runtime.callFunctionOn", params: { functionDeclaration: "() => 1", executionContextId: 1 }, sessionId: "s1" });
    answerFrameTree("loader-3");
    expect(marks.isDirty("pane:browser1", "t1", "loader-3")).toBe(true);
    expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(3);
    // A Vault fill's answer names the command that first dirtied each document (28/10: Job Copilot sign-ups after browser_evaluate).
    expect(marks.dirtiedBy("pane:browser1", "t1", "loader-1")).toBe("Runtime.evaluate");
    expect(marks.dirtiedBy("pane:browser1", "t1", "loader-2")).toBe("DOM.setAttributeValue");
    expect(marks.dirtiedBy("pane:browser1", "t1", "loader-3")).toBe("Runtime.callFunctionOn");
    expect(marks.dirtiedBy("pane:browser1", "t1", "loader-9")).toBeNull();
    expect(marks.dirtiedBy("pane:browser1", "t1", null)).toBe("UNKNOWN_DOCUMENT");
    expect(marks.dirtiedBy("pane:other", "t1", "loader-1")).toBeNull();
    // An unknown document fails closed; an authorized main-world init script or non-web navigation latches the pane.
    expect(marks.isDirty("pane:browser1", "t1", null)).toBe(true);
    const latched = createCliBrowserDocumentMarks();
    const second = createCliBrowserCdpTargetFilter(() => undefined, { paneId: "pane:browser2", marks: latched });
    second.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s9", targetInfo: { targetId: "own", type: "page" } } }));
    second.fromClient(JSON.stringify({ id: 1, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "" }, sessionId: "s9" }));
    expect(latched.isDirty("pane:browser2", "any", "loader-9")).toBe(true);
    expect(latched.dirtiedBy("pane:browser2", "any", "loader-9")).toBe("Page.addScriptToEvaluateOnNewDocument");
    const navigated = createCliBrowserDocumentMarks();
    const third = createCliBrowserCdpTargetFilter(() => undefined, { paneId: "pane:browser3", marks: navigated });
    third.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s9", targetInfo: { targetId: "own", type: "page" } } }));
    third.fromClient(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "javascript:void 0" }, sessionId: "s9" }));
    expect(navigated.isDirty("pane:browser3", "any", "loader-9")).toBe(true);
    const unknownSession = createCliBrowserDocumentMarks();
    const fourth = createCliBrowserCdpTargetFilter(() => undefined, { paneId: "pane:browser4", marks: unknownSession });
    expect(fourth.fromClient(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "never-attached" })).forward).toBe(false);
    expect(unknownSession.isDirty("pane:browser4", "any", "loader-9")).toBe(false);
    // Browser-level commands name no document.
    expect(createCliBrowserDocumentMarks().isDirty("pane:none", "t", "l")).toBe(false);
  });

  it("leaves the document clean after a file upload, so the Vault fill that follows types without a reload (31/10: a CV before the password)", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Array<Record<string, unknown>> = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:browser1", marks });
    filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s1", targetInfo: { targetId: "t1", type: "page" }, waitingForDebugger: false } }));
    expect(filter.fromClient(JSON.stringify({ id: 1, method: "DOM.setFileInputFiles", params: { files: ["/var/lib/spaceapp-user/agent-workspace/cv.pdf"], backendNodeId: 7 }, sessionId: "s1" })).forward).toBe(true);
    expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(0);
    expect(marks.isDirty("pane:browser1", "t1", "loader-1")).toBe(false);
    // Any other DOM change still marks it.
    filter.fromClient(JSON.stringify({ id: 2, method: "DOM.setNodeValue", params: { nodeId: 7, value: "x" }, sessionId: "s1" }));
    expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(1);
  });

  it("keeps Playwright calls on observed isolated-world objects clean, while unknown and main-world objects fail closed", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Array<Record<string, unknown>> = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:browser1", marks });
    const client = (message: Record<string, unknown>) => filter.fromClient(JSON.stringify(message));
    const chrome = (message: Record<string, unknown>) => filter.fromChrome(JSON.stringify(message));
    for (const session of ["s1", "s2"]) {
      chrome({ method: "Target.attachedToTarget", params: { sessionId: session, targetInfo: { targetId: session, type: "page" } } });
      chrome({ method: "Runtime.executionContextCreated", params: { context: { id: 2, uniqueId: `${session}-utility`, name: "__playwright_utility_world__", auxData: { isDefault: false } } }, sessionId: session });
    }
    // Real Playwright evaluates its utility script in a known isolated world, then calls it by objectId only.
    client({ id: 1, method: "Runtime.evaluate", params: { expression: "({})", contextId: 2 }, sessionId: "s1" });
    chrome({ id: 1, result: { result: { type: "object", objectId: "utility" } }, sessionId: "s1" });
    client({ id: 2, method: "Runtime.callFunctionOn", params: { objectId: "utility", functionDeclaration: "function() { return {}; }" }, sessionId: "s1" });
    chrome({ id: 2, result: { result: { type: "object", objectId: "element" } }, sessionId: "s1" });
    client({ id: 3, method: "Runtime.callFunctionOn", params: { objectId: "element", functionDeclaration: "function() { return 1; }" }, sessionId: "s1" });
    // Space's challenge helpers resolve a node explicitly into a world the proxy saw this session create.
    client({ id: 7, method: "DOM.resolveNode", params: { backendNodeId: 8, executionContextId: 2 }, sessionId: "s1" });
    chrome({ id: 7, result: { object: { type: "object", objectId: "resolved-isolated" } }, sessionId: "s1" });
    client({ id: 8, method: "Runtime.callFunctionOn", params: { objectId: "resolved-isolated" }, sessionId: "s1" });
    expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(0);
    const expectDirty = (params: Record<string, unknown>, sessionId = "s1") => {
      sent.length = 0;
      client({ id: 20, method: "Runtime.callFunctionOn", params, sessionId });
      expect(sent.filter((message) => message.method === "Page.getFrameTree")).toHaveLength(1);
    };
    // Never infer a context from the opaque objectId, another session, arguments or an extra context hint.
    expectDirty({ objectId: "utility" }, "s2");
    expectDirty({ objectId: "unseen.2.1", executionContextId: 2, arguments: [{ objectId: "utility" }] });
    client({ id: 4, method: "Runtime.evaluate", params: { expression: "({})", contextId: 1 }, sessionId: "s1" });
    chrome({ id: 4, result: { result: { type: "object", objectId: "main" } }, sessionId: "s1" });
    expectDirty({ objectId: "main" });
    client({ id: 9, method: "DOM.resolveNode", params: { backendNodeId: 8 }, sessionId: "s1" });
    chrome({ id: 9, result: { object: { objectId: "resolved-main" } }, sessionId: "s1" });
    expectDirty({ objectId: "resolved-main" });
    // Released objects, destroyed contexts, navigation and detach must not leave reusable safe handles.
    client({ id: 5, method: "Runtime.releaseObject", params: { objectId: "element" }, sessionId: "s1" });
    expectDirty({ objectId: "element" });
    client({ id: 6, method: "Runtime.evaluate", params: { contextId: 2, expression: "({})" }, sessionId: "s1" });
    chrome({ method: "Runtime.executionContextDestroyed", params: { executionContextId: 2, executionContextUniqueId: "s1-utility" }, sessionId: "s1" });
    chrome({ id: 6, result: { result: { objectId: "late" } }, sessionId: "s1" });
    expectDirty({ objectId: "utility" });
    expectDirty({ objectId: "late" });
    expectDirty({ executionContextId: 2 });
    expectDirty({ uniqueContextId: "s1-utility" });
    chrome({ method: "Runtime.executionContextsCleared", params: {}, sessionId: "s2" });
    expectDirty({ executionContextId: 2 }, "s2");
    chrome({ method: "Runtime.executionContextCreated", params: { context: { id: 3, name: "utility", auxData: { isDefault: false } } }, sessionId: "s2" });
    chrome({ method: "Target.detachedFromTarget", params: { sessionId: "s2" } });
    expect(client({ id: 21, method: "Runtime.callFunctionOn", params: { executionContextId: 3 }, sessionId: "s2" }).forward).toBe(false);
    expect(marks.dirtiedBy("pane:browser1", "any", "later-document")).toBeNull();
  });

  it("rejects foreign, detached and unobserved CDP sessions before they can latch another pane's fresh documents", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:mine", marks });
    filter.setOwnPages(["mine"]);
    filter.setForeignPages(["foreign"]);
    const event = (sessionId: string, targetId: string) => JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId, type: "page" } } });
    expect(filter.fromChrome(event("s-mine", "mine"))).not.toBeNull();
    expect(filter.fromChrome(event("s-foreign", "foreign"))).toBeNull();
    filter.fromChrome(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "s-mine" } }));
    sent.length = 0;
    for (const sessionId of ["s-foreign", "s-mine", "another-connections-session"]) {
      const decision = filter.fromClient(JSON.stringify({ id: 1, method: "Runtime.callFunctionOn", params: { objectId: "stale-or-foreign" }, sessionId }));
      expect(decision.forward, sessionId).toBe(false);
      expect(JSON.parse((decision as { reply: string }).reply)).toMatchObject({ id: 1, sessionId, error: { code: -32000 } });
    }
    expect(sent).toEqual([]);
    expect(marks.dirtiedBy("pane:mine", "brand-new-tab", "brand-new-loader")).toBeNull();
    // A second pane's legitimate session still marks only that pane, even when it uses the same Chrome.
    const otherSent: Record<string, unknown>[] = [];
    const other = createCliBrowserCdpTargetFilter((message) => otherSent.push(message), { paneId: "pane:other", marks });
    other.setOwnPages(["foreign"]);
    other.fromChrome(event("s-foreign", "foreign"));
    expect(other.fromClient(JSON.stringify({ id: 2, method: "Runtime.callFunctionOn", params: { objectId: "main-world" }, sessionId: "s-foreign" })).forward).toBe(true);
    other.fromChrome(JSON.stringify({ id: otherSent.at(-1)!.id, result: { frameTree: { frame: { loaderId: "other-loader" } } } }));
    expect(marks.dirtiedBy("pane:other", "foreign", "other-loader")).toBe("Runtime.callFunctionOn");
    expect(marks.dirtiedBy("pane:mine", "brand-new-tab", "brand-new-loader")).toBeNull();
  });

  it("filters browser-session discovery and waits for ownership of new tabs instead of adopting a sibling pane's auto-attach", () => {
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message));
    filter.setOwnPages(["mine"]);
    filter.setForeignPages(["foreign"]);
    filter.fromClient(JSON.stringify({ id: 1, method: "Target.attachToBrowserTarget" }));
    filter.fromChrome(JSON.stringify({ id: 1, result: { sessionId: "browser" } }));
    expect(filter.fromClient(JSON.stringify({ id: 2, method: "Target.getTargets", sessionId: "browser" })).forward).toBe(true);
    const listed = JSON.parse(filter.fromChrome(JSON.stringify({ id: 2, result: { targetInfos: ["mine", "foreign"].map((targetId) => ({ targetId, type: "page" })) }, sessionId: "browser" }))!);
    expect(listed.result.targetInfos).toEqual([{ targetId: "mine", type: "page" }]);
    expect(filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "new-session", targetInfo: { targetId: "unclaimed", type: "page" }, waitingForDebugger: true } }))).toBeNull();
    expect(sent).toMatchObject([{ method: "Runtime.runIfWaitingForDebugger", sessionId: "new-session" }, { method: "Target.detachFromTarget" }]);
    // A Space-created tab is rediscovered once the store confirms this pane owns it.
    expect(filter.setOwnPages(["mine", "unclaimed"])).toBe(true);
  });

  it("scopes nested CDP targets to their owning page and drops hidden session events before exposing contexts", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:mine", marks });
    filter.setOwnPages(["mine"]);
    filter.setForeignPages(["foreign"]);
    const attached = (sessionId: string, targetId: string, parent?: string, type = "page") => JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId, type } }, ...(parent ? { sessionId: parent } : {}) });
    filter.fromChrome(attached("s-mine", "mine"));
    expect(filter.fromChrome(attached("s-foreign", "foreign", "s-mine"))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Runtime.executionContextCreated", sessionId: "s-foreign", params: { context: { id: 2, name: "__playwright_utility_world__", auxData: { isDefault: false } } } }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-worker", targetInfo: { targetId: "worker", type: "worker" }, waitingForDebugger: true }, sessionId: "s-foreign" }))).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({ method: "Runtime.runIfWaitingForDebugger", sessionId: "s-worker" }));
    expect(filter.fromChrome(attached("s-frame", "frame", "s-mine", "iframe"))).not.toBeNull();
    sent.length = 0;
    expect(filter.fromClient(JSON.stringify({ id: 1, method: "Runtime.callFunctionOn", params: { objectId: "main-frame-object" }, sessionId: "s-frame" })).forward).toBe(true);
    expect(sent).toMatchObject([{ method: "Page.getFrameTree", sessionId: "s-mine" }]);
    filter.fromChrome(JSON.stringify({ id: sent[0]!.id, result: { frameTree: { frame: { loaderId: "top-loader" } } } }));
    expect(marks.dirtiedBy("pane:mine", "mine", "top-loader")).toBe("Runtime.callFunctionOn");
    expect(marks.dirtiedBy("pane:mine", "new-tab", "new-loader")).toBeNull();
  });

  it.each(["detach", "foreign", "destroy"])("ignores a late document lookup after %s instead of latching every future tab", (change) => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:mine", marks });
    filter.setOwnPages(["mine"]);
    filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-mine", targetInfo: { targetId: "mine", type: "page" } } }));
    filter.fromClient(JSON.stringify({ id: 1, method: "Runtime.callFunctionOn", params: { objectId: "untrusted" }, sessionId: "s-mine" }));
    if (change === "detach") filter.fromChrome(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "s-mine" } }));
    else if (change === "foreign") filter.setForeignPages(["mine"]);
    else filter.fromChrome(JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "mine" } }));
    filter.fromChrome(JSON.stringify({ id: sent[0]!.id, error: { code: -32001, message: "Session with given id not found" } }));
    expect(marks.dirtiedBy("pane:mine", "fresh-tab", "fresh-loader")).toBeNull();
  });

  it("reports only caller metadata when its own page becomes dirty or latches, once per mark", () => {
    const marks = createCliBrowserDocumentMarks();
    const sent: Record<string, unknown>[] = [];
    const onDirty = vi.fn();
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message), { paneId: "pane:mine", marks, onDirty });
    filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-mine", targetInfo: { targetId: "mine", type: "page" } } }));
    for (let id = 1; id <= 2; id++) {
      filter.fromClient(JSON.stringify({ id, method: "Runtime.callFunctionOn", params: { objectId: "opaque", functionDeclaration: "private page code" }, sessionId: "s-mine" }));
      filter.fromChrome(JSON.stringify({ id: sent.at(-1)!.id, result: { frameTree: { frame: { loaderId: "loader" } } } }));
    }
    filter.fromClient(JSON.stringify({ id: 3, method: "Page.addScriptToEvaluateOnNewDocument", params: { source: "private init code" }, sessionId: "s-mine" }));
    expect(onDirty.mock.calls).toEqual([
      [{ method: "Runtime.callFunctionOn", sessionId: "s-mine", targetId: "mine", loaderId: "loader", scope: "DOCUMENT" }],
      [{ method: "Page.addScriptToEvaluateOnNewDocument", sessionId: "s-mine", targetId: "mine", loaderId: null, scope: "PANE" }]
    ]);
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
    const child = JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-frame", targetInfo: { targetId: "own-frame", type: "iframe" } }, sessionId: "s-mine" });
    expect(filter.fromChrome(child)).toBe(child);
    const ordinary = JSON.stringify({ id: 9, result: { data: "x" } });
    expect(filter.fromChrome(ordinary)).toBe(ordinary);
  });

  it("hides tabs no live pane owns that were open before the client came, so a stuck one cannot hang Playwright (Clara/Nik 2026-10-21)", () => {
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message));
    const page = (targetId: string) => ({ targetId, type: "page", url: "https://programs.example/registration" });
    // A pane whose page list is unknown keeps today's behaviour: unowned tabs pass.
    expect(filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-0", targetInfo: page("legacy"), waitingForDebugger: false } }))).not.toBeNull();
    filter.setOwnPages(["mine"]);
    // Chrome a3140720 held the pane's NVIDIA form and tabs of panes long gone; one blocked on a dialog never answers Page.enable.
    expect(filter.fromClient(JSON.stringify({ id: 5, method: "Target.getTargets", params: {} }))).toEqual({ forward: true });
    const listed = JSON.parse(filter.fromChrome(JSON.stringify({ id: 5, result: { targetInfos: [page("mine"), page("orphan"), { targetId: "sw", type: "service_worker" }] } }))!);
    expect(listed.result.targetInfos.map((info: { targetId: string }) => info.targetId)).toEqual(["mine", "sw"]);
    // Auto-attach to an orphan already open: hidden and detached, never left paused, its later events dropped.
    expect(filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-orphan", targetInfo: page("orphan"), waitingForDebugger: false } }))).toBeNull();
    expect(sent).toEqual([{ id: cliBrowserCdpProxyIdBase + 1, method: "Target.detachFromTarget", params: { sessionId: "s-orphan" } }]);
    expect(filter.fromChrome(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "s-orphan" } }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.targetInfoChanged", params: { targetInfo: page("orphan") } }))).toBeNull();
    expect(filter.fromChrome(JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "orphan" } }))).toBeNull();
    const refused = filter.fromClient(JSON.stringify({ id: 6, method: "Target.attachToTarget", params: { targetId: "orphan", flatten: true } }));
    expect(refused.forward).toBe(false);
    // The pane's own tab and a tab opened while connected (a popup, a new page: Chrome holds it for the debugger) still pass.
    const own = JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-mine", targetInfo: page("mine"), waitingForDebugger: false } });
    expect(filter.fromChrome(own)).toBe(own);
    const popup = JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-popup", targetInfo: { ...page("popup"), openerId: "mine" }, waitingForDebugger: true } });
    expect(filter.fromChrome(popup)).toBe(popup);
    expect(filter.fromClient(JSON.stringify({ id: 7, method: "Target.getTargets", params: {} }))).toEqual({ forward: true });
    const later = JSON.parse(filter.fromChrome(JSON.stringify({ id: 7, result: { targetInfos: [page("mine"), page("popup"), page("orphan")] } }))!);
    expect(later.result.targetInfos.map((info: { targetId: string }) => info.targetId)).toEqual(["mine", "popup"]);
    expect(sent).toHaveLength(1);
  });

  it("reads the pane's own tabs from the store before Chrome answers, and hides the rest of the shared Chrome", async () => {
    const page = (targetId: string) => ({ targetId, type: "page", url: "https://example.com/", attached: false, browserContextId: "ctx" });
    const chrome = await fakeChrome((message) => message.method === "Target.getTargets"
      ? { targetInfos: [page("mine"), page("orphan-with-dialog")] } : { echo: message.method });
    const { app, store, token, jobPane, session } = await fixture(chrome.port);
    try {
      store.updatePaneBrowserSession(session.sessionId, { pages: [{ pageId: "mine", kind: "PAGE", url: "https://example.com/", title: "Registration", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }] });
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
      const reply = await waitFor(() => client.messages.find((text) => JSON.parse(text).id === 1), "the target list");
      expect(JSON.parse(reply).result.targetInfos.map((info: { targetId: string }) => info.targetId)).toEqual(["mine"]);
      client.socket.close(1000, "done");
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("masks password values in Playwright's utility world before the client can use it, and leaves the page's own world alone", () => {
    const sent: Record<string, unknown>[] = [];
    const filter = createCliBrowserCdpTargetFilter((message) => sent.push(message));
    filter.fromChrome(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "s-mine", targetInfo: { targetId: "mine", type: "page" } } }));
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

  it("disconnects an old Chrome when the same profile publishes a new endpoint, then resolves the replacement", async () => {
    const old = await fakeChrome(() => ({ targetInfos: [{ type: "page", targetId: "blank", url: "about:blank" }] }));
    const replacement = await fakeChrome(() => ({ targetInfos: [{ type: "page", targetId: "restored", url: "https://jobs.example/" }] }));
    const { app, token, jobPane, session } = await fixture(old.port);
    try {
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      expect(JSON.parse(await waitFor(() => client.messages[0], "old targets")).result.targetInfos[0].targetId).toBe("blank");
      // The old socket remains healthy: only the profile's endpoint changes during restoration.
      await writeFile(join(session.profilePath, "DevToolsActivePort"), `${replacement.port}\n/devtools/browser/test\n`);
      await waitFor(() => client.socket.readyState === 3 ? true : undefined, "old Chrome disconnect");
      expect(await client.closed).toBe(cliBrowserCdpCloseCodes.BROWSER_CHANGED);
      const again = await attach(app, jobPane.id, token);
      again.socket.send(JSON.stringify({ id: 2, method: "Target.getTargets" }));
      expect(JSON.parse(await waitFor(() => again.messages[0], "replacement targets")).result.targetInfos[0].targetId).toBe("restored");
      expect(old.received).toHaveLength(1);
      again.socket.close();
    } finally {
      await app.close();
      await old.close();
      await replacement.close();
    }
  });

  it("reconnects discovery when a restored target hidden during attachment becomes owned by the pane", async () => {
    const chrome = await fakeChrome(() => ({ targetInfos: [{ type: "page", targetId: "restored", url: "https://jobs.example/" }] }));
    const { app, store, token, jobPane, session } = await fixture(chrome.port);
    const page = (pageId: string) => ({ pageId, kind: "PAGE" as const, url: "https://jobs.example/", title: "Form", isActive: true,
      openerPageId: null, canGoBack: false, canGoForward: false });
    try {
      store.updatePaneBrowserSession(session.sessionId, { pages: [page("before-restart")], activePageId: "before-restart" });
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      expect(JSON.parse(await waitFor(() => client.messages[0], "initial hidden targets")).result.targetInfos).toEqual([]);
      // Same session and Chrome endpoint; the host has now published its restored page inventory.
      store.updatePaneBrowserSession(session.sessionId, { pages: [page("restored")], activePageId: "restored" });
      await waitFor(() => client.socket.readyState === 3 ? true : undefined, "discovery reconnect");
      expect(await client.closed).toBe(cliBrowserCdpCloseCodes.BROWSER_CHANGED);
      const again = await attach(app, jobPane.id, token);
      again.socket.send(JSON.stringify({ id: 2, method: "Target.getTargets" }));
      expect(JSON.parse(await waitFor(() => again.messages[0], "restored targets")).result.targetInfos[0].targetId).toBe("restored");
      again.socket.close();
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it.each(["replaced", "closed", "endpoint missing"])("drops a stale attachment when the session is %s", async (change) => {
    const chrome = await fakeChrome();
    const { app, store, room, token, jobPane, session } = await fixture(chrome.port);
    try {
      const client = await attach(app, jobPane.id, token);
      client.socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      await waitFor(() => client.messages[0], "initial attachment");
      if (change === "endpoint missing") await rm(join(session.profilePath, "DevToolsActivePort"));
      else {
        store.updatePaneBrowserSession(session.sessionId, { isActive: false, status: "CLOSED" });
        if (change === "replaced") store.createPaneBrowserSession({ paneId: jobPane.id, roomId: room.id, agentNumber: 1,
          profileId: session.profileId, profilePath: session.profilePath, viewport: "desktop" });
      }
      await waitFor(() => client.socket.readyState === 3 ? true : undefined, "stale attachment disconnect");
      expect(await client.closed).toBe(change === "closed" ? cliBrowserCdpCloseCodes.BROWSER_NOT_RUNNING : cliBrowserCdpCloseCodes.BROWSER_CHANGED);
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  it("locks the browser to the agent whose handoff waits: others are dropped and refused until it ends (operator nous_msg:4b36b80e)", async () => {
    const chrome = await fakeChrome();
    const { app, store, config, room, token, jobPane } = await fixture(chrome.port);
    try {
      // 6/11: Dino/Max navigated the browser of Dino/Kate's PayPal code handoff and the code was lost. Max is another CLI pane in the room.
      const maxPane = store.createPane({ roomId: room.id, title: "Max", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
      const otherSession = store.createPaneCliSession({
        paneId: maxPane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", status: "RUNNING", purpose: "NORMAL"
      });
      const otherToken = issueCliBrowserBridgeToken(config, { roomId: room.id, paneId: maxPane.id, cliSessionId: otherSession.sessionId })!;
      const command = (as: string, type: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/cli/browser/commands",
        headers: { [cliBrowserBridgeTokenHeader]: as, "content-type": "application/json" }, payload: { targetPaneId: jobPane.id, command: { type, ...extra } } });
      const status = async (as: string) => (await app.inject({ method: "GET", url: `${cliBrowserCdpStatusPath}?paneId=${encodeURIComponent(jobPane.id)}`,
        headers: { [cliBrowserBridgeTokenHeader]: as } })).json();
      const requester = await attach(app, jobPane.id, token);
      const other = await attach(app, jobPane.id, otherToken);
      await waitFor(() => (requester.socket.readyState === requester.socket.OPEN && other.socket.readyState === other.socket.OPEN) || undefined, "both attached");

      expect((await command(token, "REQUEST_HANDOFF", { kind: "CAPTCHA", reason: "Human check before Sign up" })).statusCode).toBe(200);
      expect(await other.closed).toBe(cliBrowserCdpCloseCodes.BROWSER_HANDOFF_PENDING);
      expect(requester.socket.readyState).toBe(requester.socket.OPEN);
      expect(await (await attach(app, jobPane.id, otherToken)).closed).toBe(cliBrowserCdpCloseCodes.BROWSER_HANDOFF_PENDING);
      expect(await status(otherToken)).toMatchObject({ ready: false, reason: "BROWSER_HANDOFF_PENDING" });
      expect(await status(token)).toMatchObject({ ready: true });
      // The others may read, never change the operator's tab; the requester keeps its handoff tools.
      expect((await command(otherToken, "CREATE_PAGE", { url: "https://example.com/" })).statusCode).toBe(409);
      expect((await command(otherToken, "CLOSE_PAGE", { pageId: "page:paypal" })).statusCode).toBe(409);
      expect((await command(otherToken, "HANDOFF_STATUS")).statusCode).toBe(200);
      const action = await app.inject({ method: "POST", url: "/api/cli/browser/actions", headers: { [cliBrowserBridgeTokenHeader]: otherToken, "content-type": "application/json" },
        payload: { actions: [{ toolId: "browser:navigate", targetPaneId: jobPane.id, action: { type: "navigate", url: "https://example.com/" } }] } });
      expect(action.json().results[0]).toMatchObject({ status: "FAILED", statusReason: expect.stringContaining("handoff") });
      expect((await command(otherToken, "CANCEL_HANDOFF")).json()).toMatchObject({ cancelled: false });

      expect((await command(token, "CANCEL_HANDOFF")).json()).toMatchObject({ cancelled: true });
      expect(await status(otherToken)).toMatchObject({ ready: true });
      requester.socket.close();
    } finally {
      await app.close();
      await chrome.close();
    }
  });

  // Operator nous_msg:243370cb (7/11 20:27 ICT): "Solve the check on hub.upcloud.com" reached the operator for an e-mailed code.
  const handoffOnPage = async (page: { host: string; text: string; widget: boolean }) => {
    const chrome = await fakeChrome((message) => ({ "Target.attachToTarget": { sessionId: "s1" }, "Page.getFrameTree": { frameTree: { frame: { id: "f1" } } },
      "Page.createIsolatedWorld": { executionContextId: 1 }, "Runtime.evaluate": { result: { value: page } } } as Record<string, unknown>)[message.method] ?? {});
    const { app, store, room, token, jobPane, session } = await fixture(chrome.port);
    try {
      store.updatePaneBrowserSession(session.sessionId, { currentUrl: `https://${page.host}/verify`, activePageId: "p1", pages: [{ pageId: "p1", kind: "PAGE", url: `https://${page.host}/verify`,
        title: "UpCloud", isActive: true, openerPageId: null, canGoBack: false, canGoForward: false }] });
      const reply = await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers: { [cliBrowserBridgeTokenHeader]: token, "content-type": "application/json" },
        payload: { targetPaneId: jobPane.id, command: { type: "REQUEST_HANDOFF", kind: "CAPTCHA", reason: "hub.upcloud.com: solve the check to continue" } } });
      return { reply: reply.json(), handoffs: await store.listBrowserHandoffRequests(room.id),
        raised: (await store.listEvents(room.id)).filter((event) => event.type === "BROWSER_HANDOFF_REQUESTED") };
    } finally {
      await app.close();
      await chrome.close();
    }
  };

  it("sends an e-mailed code page back to the agent with the mail route: no hands item (UpCloud)", async () => {
    const { reply, handoffs, raised } = await handoffOnPage({ host: "hub.upcloud.com", widget: false,
      text: "Verify your email\nWe have sent a verification code to a•••@example.invalid. Enter the code below to continue.\nVerification code\nResend code" });
    expect(reply).toMatchObject({ status: "MAIL_CODE", message: expect.stringContaining("space_mail_search from:upcloud.com") });
    expect(handoffs).toEqual([]);
    expect(raised).toEqual([]);
  });

  it("hands a real Turnstile check to the operator", async () => {
    const { reply, handoffs, raised } = await handoffOnPage({ host: "hub.upcloud.com", widget: true,
      text: "hub.upcloud.com\nVerify you are human by completing the action below.\nhub.upcloud.com needs to review the security of your connection before proceeding." });
    expect(reply.handoff).toMatchObject({ status: "REQUESTED", reason: expect.stringMatching(/^CAPTCHA: /) });
    expect(handoffs).toHaveLength(1);
    expect(raised).toHaveLength(1);
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
