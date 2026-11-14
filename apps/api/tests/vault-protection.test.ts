import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySiteSigninsRepository } from "@space/db";
import Fastify from "fastify";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { generateVaultTransportKey, newVaultHandle, openWithVaultPrivateKey, sealVaultEnvelope, vaultBase64url, vaultHostSignupRequestSchema, vaultRandomBytes, VAULT_CARD_ROLES, type Pane, type VaultHostTarget } from "@space/contracts";
import { createBrowserControlActivity } from "../src/browser-control-activity.js";
import { pageReadout } from "../src/browser-page-readout.js";
import { captureMaskedScreenshot } from "../src/browser-sessions.js";
import { issueCliBrowserBridgeToken, cliBrowserBridgeTokenHeader } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { createVaultAgent } from "../src/vault/agent.js";
import { VaultBrokerRefusedError } from "../src/vault/broker-client.js";
import { assertVaultBrowserActionAllowed, createVaultProtection, registerVaultFences, vaultFillPageGone, type VaultOpenPage, type VaultProtectionStore } from "../src/vault/protection.js";
import { fenceCompletedHandoff, vaultFencedTargets } from "../src/vault/fence-hooks.js";
import { registerVault, registerVaultAgentBridge, type VaultModule } from "../src/vault/wiring.js";
import { SENTINEL, enrollment, fakeRepository, itemRecord } from "./support/vault-fakes.js";

// Operator decision 2026-10-18 (plan clipboard:Ml8zElMcc4Ac): one switch lets agents and Nous use the Vault. A fill protects
// its browser by itself (no operator step), agents keep navigation, clicks and typing but never read it back, and the
// protection lifts once the filled page is gone. Synthetic values only.
const config = getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "vault-protection-internal-token" });
const PROTECTED = "pane:protected01";
const OTHER = "pane:otherpane01";
const LOGIN = "https://login.example";
const page = (patch: Partial<VaultHostTarget> = {}): VaultHostTarget =>
  ({ eligible: true, reason: null, targetId: "target-1", frameId: "frame-1", origin: LOGIN, document: "doc-1", ...patch });

const tabs = (active: string, ...others: string[]): VaultOpenPage[] =>
  [{ pageId: active, isActive: true }, ...others.map((pageId) => ({ pageId, isActive: false }))];

function memoryProtection(live: () => VaultHostTarget = () => page(), pages?: () => VaultOpenPage[]) {
  const rows = new Map<string, { owner: string; fill: any }>();
  const store: VaultProtectionStore = {
    protectPane: async (owner, paneId, fill) => { if (rows.has(paneId) && rows.get(paneId)!.owner !== owner) return false; rows.set(paneId, { owner, fill }); return true; },
    unprotectPane: async (owner, paneId) => rows.get(paneId)?.owner === owner && rows.delete(paneId),
    protectedPane: async (paneId) => rows.get(paneId) ?? null
  };
  return { rows, protection: createVaultProtection(store, async () => live(), pages ? async () => pages() : undefined) };
}

async function fencedApp(user: { id: string; automationScope?: string } | null, live: { current: VaultHostTarget } = { current: page() },
  pages?: { current: VaultOpenPage[] }) {
  const app = Fastify();
  const { protection, rows } = memoryProtection(() => live.current, pages ? () => pages.current : undefined);
  app.addHook("onRequest", async (request) => { (request as { user?: unknown }).user = user ?? undefined; });
  registerVaultFences(app, { protection, config });
  for (const path of ["/api/panes/:id/browser/session", "/api/panes/:id/browser/diagnostics", "/api/panes/:id/browser/captures"]) app.get(path, async () => ({ ok: true }));
  app.post("/api/cli/browser/actions", async () => ({ ok: true }));
  // Like LIST_PAGES and CLOSE_PAGE: the pane's tabs with their addresses and titles.
  app.post("/api/cli/browser/commands", async () => ({ sessionId: "browser-session-1", activePageId: "target-2",
    pages: [{ pageId: "target-2", kind: "page", url: "https://app.example/inbox?token=synthetic", title: "Inbox", isActive: true, account: null }] }));
  app.get("/api/cli/browser/cdp/status", async () => ({ ok: true }));
  await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: "doc-1" });
  return { app, protection, rows, live };
}
const agentToken = (paneId: string) => issueCliBrowserBridgeToken(config, { roomId: "room:vaultroom1", paneId, cliSessionId: "cli_session:vault01" })!;

describe("Vault protected browser", () => {
  it("is private to its owner while it holds a fill, with no recordings or diagnostics", async () => {
    for (const [user, expected] of [[{ id: "user:bob" }, 403], [{ id: "user:alice", automationScope: "MEDIA_CAPTURE" }, 403], [null, 403]] as const) {
      const { app } = await fencedApp(user as never);
      expect((await app.inject({ url: `/api/panes/${PROTECTED}/browser/session` })).statusCode).toBe(expected);
      await app.close();
    }
    const { app, live } = await fencedApp({ id: "user:alice" });
    expect((await app.inject({ url: `/api/panes/${PROTECTED}/browser/session` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/panes/${PROTECTED}/browser/diagnostics` })).json().error.code).toBe("VAULT_PROTECTED_PANE_PRIVATE");
    expect((await app.inject({ url: `/api/panes/${PROTECTED}/browser/captures` })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/panes/${OTHER}/browser/diagnostics` })).statusCode).toBe(200);
    // A new document: the filled page is gone and everything comes back (viewer checks run at most every 2 s).
    live.current = page({ document: "doc-2" });
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    expect((await app.inject({ url: `/api/panes/${PROTECTED}/browser/diagnostics` })).statusCode).toBe(200);
    await app.close();
  });

  it("leaves agents navigation, clicks, typing and scrolling, refuses every read, and frees the browser once the page is gone", async () => {
    const { app, rows, live } = await fencedApp(null);
    const headers = { [cliBrowserBridgeTokenHeader]: agentToken(OTHER), "content-type": "application/json" };
    const action = (type: string, targetPaneId = PROTECTED) => app.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId, action: { type, url: "https://login.example" } }] } });
    for (const type of ["navigate", "click", "type", "scroll", "set_viewport"]) expect((await action(type)).statusCode, type).toBe(200);
    for (const type of ["extract_text", "screenshot", "diagnostics", "record"]) expect((await action(type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    expect((await action("extract_text", OTHER)).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers, payload: { targetPaneId: PROTECTED, command: "LIST_PAGES" } })).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/cli/browser/cdp/status?paneId=${PROTECTED}`, headers })).statusCode).toBe(409);
    // A CLI whose own pane is the filled browser gets no CDP either.
    expect((await app.inject({ url: "/api/cli/browser/cdp/status", headers: { [cliBrowserBridgeTokenHeader]: agentToken(PROTECTED) } })).statusCode).toBe(409);
    // Same document after a same-page navigation (a fragment, pushState): still fenced.
    live.current = page();
    expect((await action("extract_text")).statusCode).toBe(409);
    live.current = page({ document: "doc-2" });
    expect((await action("extract_text")).statusCode).toBe(200);
    expect(rows.has(PROTECTED)).toBe(false);
    expect((await app.inject({ url: `/api/cli/browser/cdp/status?paneId=${PROTECTED}`, headers })).statusCode).toBe(200);
    await app.close();
  });

  it("fences in-process callers the same way: the Dot gateway and the internal agent route read nothing from a filled browser (1.1.7 review)", async () => {
    const live = { current: page() };
    const { protection } = memoryProtection(() => live.current);
    await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: "doc-1" });
    for (const type of ["navigate", "click", "type", "scroll", "set_viewport", "press"]) await expect(assertVaultBrowserActionAllowed(protection, PROTECTED, type), type).resolves.toBeUndefined();
    for (const type of ["extract_text", "screenshot", "record", "diagnostics"]) await expect(assertVaultBrowserActionAllowed(protection, PROTECTED, type), type).rejects.toThrow(/locked after a Vault fill or a browser handoff/);
    await expect(assertVaultBrowserActionAllowed(protection, OTHER, "record")).resolves.toBeUndefined();
    // Once the filled page is gone, reads are allowed again.
    live.current = page({ document: "doc-2" });
    await expect(assertVaultBrowserActionAllowed(protection, PROTECTED, "record")).resolves.toBeUndefined();
  });

  it("lets the pane that holds the fence finish the page: keys and masked screenshots, nothing else (2026-10-19)", async () => {
    const { app } = await fencedApp(null);
    const own = { [cliBrowserBridgeTokenHeader]: agentToken(PROTECTED), "content-type": "application/json" };
    const other = { [cliBrowserBridgeTokenHeader]: agentToken(OTHER), "content-type": "application/json" };
    const action = (headers: Record<string, string>, type: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type, ...extra } }] } });
    // Type the mail code, press Enter or Tab to Verify: open to every pane that may act, like click and type.
    expect((await action(own, "type", { text: "123456" })).statusCode).toBe(200);
    for (const key of ["Enter", "Tab", "Shift+Tab"]) expect((await action(own, "press", { key })).statusCode, key).toBe(200);
    expect((await action(other, "press", { key: "Enter" })).statusCode).toBe(200);
    // The masked screenshot: only the fenced pane's own CLI.
    expect((await action(own, "masked_screenshot")).statusCode).toBe(200);
    expect((await action(other, "masked_screenshot")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    // Plain screenshots, page text, recordings, capture jobs and CDP stay refused, also for the own pane.
    for (const type of ["screenshot", "extract_text", "record", "diagnostics"]) expect((await action(own, type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    expect((await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers: own, payload: { targetPaneId: PROTECTED, command: { type: "START_CAPTURE", kind: "SCREENSHOT" } } })).statusCode).toBe(409);
    expect((await app.inject({ url: "/api/cli/browser/cdp/status", headers: own })).statusCode).toBe(409);
    await app.close();
  });

  it("lets the pane holding the fence upload its own file into the page, nobody else, and reads nothing back (31/10: a CV after the Vault password)", async () => {
    const { app, rows } = await fencedApp(null);
    const command = (paneId: string, type: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/cli/browser/commands",
      headers: { [cliBrowserBridgeTokenHeader]: agentToken(paneId), "content-type": "application/json" }, payload: { targetPaneId: PROTECTED, command: { type, ...extra } } });
    const upload = { paths: ["/var/lib/spaceapp-user/agent-workspace/cv.pdf"] };
    expect((await command(PROTECTED, "UPLOAD_FILE", upload)).statusCode).toBe(200);
    expect((await command(OTHER, "UPLOAD_FILE", upload)).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    // The masked readout (7/11 Oracle: no blind Sign In after a fill): the pane holding the fence only.
    expect((await command(PROTECTED, "PAGE_READOUT")).statusCode).toBe(200);
    expect((await command(OTHER, "PAGE_READOUT")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    // The Alibaba slider answers a status only, like a click (13/11): open to every pane that may act.
    for (const pane of [PROTECTED, OTHER]) expect((await command(pane, "SLIDER_CAPTCHA")).statusCode, pane).toBe(200);
    // Every read stays refused for the pane holding the fence too, and the fence is still there.
    for (const type of ["LIST_PAGES", "DEVTOOLS", "START_CAPTURE"]) expect((await command(PROTECTED, type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    expect((await app.inject({ url: "/api/cli/browser/cdp/status", headers: { [cliBrowserBridgeTokenHeader]: agentToken(PROTECTED) } })).statusCode).toBe(409);
    expect(rows.get(PROTECTED)?.fill).toEqual({ targetId: "target-1", origin: LOGIN, document: "doc-1" });
    await app.close();
  });

  it("gives the agent that asked for a handoff masked screenshots of the page the operator left, nothing else (2026-10-25)", async () => {
    const { app, protection } = await fencedApp(null);
    // A completed handoff fences the page with its requester (fence-hooks.ts); other agents keep no view of it.
    await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: "doc-1" }, "cli:cli_session:asker01");
    const headers = (cliSessionId: string) => ({ [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: "room:vaultroom1", paneId: OTHER, cliSessionId })!,
      "content-type": "application/json" });
    const action = (cliSessionId: string, type: string) => app.inject({ method: "POST", url: "/api/cli/browser/actions", headers: headers(cliSessionId),
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type } }] } });
    expect(await protection.viewerOf(PROTECTED)).toBe("cli:cli_session:asker01");
    expect((await action("cli_session:asker01", "masked_screenshot")).statusCode).toBe(200);
    expect((await action("cli_session:other002", "masked_screenshot")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    const captcha = (cliSessionId: string) => app.inject({ method: "POST", url: "/api/cli/browser/commands", headers: headers(cliSessionId),
      payload: { targetPaneId: PROTECTED, command: { type: "TEXT_CAPTCHA", action: "inspect" } } });
    expect((await captcha("cli_session:asker01")).statusCode).toBe(200);
    expect((await captcha("cli_session:other002")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    for (const type of ["screenshot", "extract_text", "record"]) expect((await action("cli_session:asker01", type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    await app.close();
  });

  it("lets an agent hand a filled page to the operator (a CAPTCHA before Submit) and keeps the fence through it (2026-10-22)", async () => {
    const { app, rows } = await fencedApp(null);
    const headers = { [cliBrowserBridgeTokenHeader]: agentToken(OTHER), "content-type": "application/json" };
    const command = (type: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/cli/browser/commands", headers,
      payload: { targetPaneId: PROTECTED, command: { type, ...extra } } });
    expect((await command("REQUEST_HANDOFF", { kind: "CAPTCHA", reason: "Human check before Sign up" })).statusCode).toBe(200);
    for (const type of ["HANDOFF_STATUS", "CANCEL_HANDOFF", "RECLAIM_CONTROL"]) expect((await command(type)).statusCode, type).toBe(200);
    // Everything that reads the page stays refused, and the fence is still there.
    for (const type of ["LIST_PAGES", "START_CAPTURE", "DEVTOOLS"]) expect((await command(type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    expect((await app.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type: "extract_text" } }] } })).statusCode).toBe(409);
    expect(rows.get(PROTECTED)).toEqual({ owner: "user:alice", fill: { targetId: "target-1", origin: LOGIN, document: "doc-1" } });
    await app.close();
  });

  it("knows when the filled page is gone, also from a Browser Host started before document ids", () => {
    const fill = { targetId: "target-1", origin: LOGIN, document: "doc-1" };
    expect(vaultFillPageGone(fill, page())).toBe(false);
    expect(vaultFillPageGone(fill, page({ document: "doc-2" }))).toBe(true);
    expect(vaultFillPageGone(fill, page({ origin: "https://app.example" }))).toBe(true);
    // Another tab in view: the filled tab still holds the value, closed is gone (2026-10-19). Without the tab list, any doubt keeps it.
    expect(vaultFillPageGone(fill, page({ targetId: "target-2" }))).toBe(false);
    expect(vaultFillPageGone(fill, page({ targetId: "target-2" }), tabs("target-2", "target-1"))).toBe(false);
    expect(vaultFillPageGone(fill, page({ targetId: "target-2", document: "doc-9" }), tabs("target-2"))).toBe(true);
    expect(vaultFillPageGone(fill, page({ document: "doc-2" }), tabs("target-1", "target-2"))).toBe(true);
    const blank = page({ eligible: false, reason: "NO_WEB_ORIGIN", targetId: null, frameId: null, origin: null });
    expect(vaultFillPageGone(fill, blank, tabs("target-1"))).toBe(true);
    expect(vaultFillPageGone(fill, blank, tabs("target-2", "target-1"))).toBe(false);
    expect(vaultFillPageGone(fill, blank)).toBe(false);
    // An older host: no document id, and refusals about the Chrome say nothing about the page.
    expect(vaultFillPageGone(fill, page({ document: undefined }))).toBe(false);
    expect(vaultFillPageGone(fill, page({ eligible: false, reason: "PROFILE_SHARED", targetId: null, frameId: null, origin: null }))).toBe(false);
  });

  it("keeps the fence while the filled tab is only out of view, lets agents close it, and lifts once it is closed", async () => {
    const live = { current: page() };
    const pages = { current: tabs("target-1") };
    const { app, rows } = await fencedApp(null, live, pages);
    const headers = { [cliBrowserBridgeTokenHeader]: agentToken(OTHER), "content-type": "application/json" };
    const read = () => app.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type: "extract_text" } }] } });
    // The agent opens a second tab and shows it: the filled tab is still open, so reads stay fenced.
    live.current = page({ targetId: "target-2", origin: "https://app.example", document: "doc-9" });
    pages.current = tabs("target-2", "target-1");
    expect((await read()).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers, payload: { targetPaneId: PROTECTED, command: { type: "LIST_PAGES" } } })).statusCode).toBe(409);
    // Closing a tab stays open, and its answer carries tab ids only, never addresses or titles.
    const closed = await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers, payload: { targetPaneId: PROTECTED, command: { type: "CLOSE_PAGE", pageId: "target-1" } } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ sessionId: "browser-session-1", activePageId: "target-2", pages: [{ pageId: "target-2", kind: "page", isActive: true }] });
    expect(closed.body).not.toContain("app.example");
    expect(rows.has(PROTECTED)).toBe(true);
    pages.current = tabs("target-2");
    expect((await read()).statusCode).toBe(200);
    expect(rows.has(PROTECTED)).toBe(false);
    // Unfenced panes keep the full answer.
    expect((await app.inject({ method: "POST", url: "/api/cli/browser/commands", headers, payload: { targetPaneId: PROTECTED, command: { type: "CLOSE_PAGE", pageId: "target-2" } } })).json().pages[0].url)
      .toBe("https://app.example/inbox?token=synthetic");
    await app.close();
  });

  it("covers every filled or handed-off tab of a pane and lets each go once it is gone", async () => {
    const live = { current: page() };
    const pages = { current: tabs("target-1") };
    const { protection, rows } = memoryProtection(() => live.current, () => pages.current);
    expect(await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: "doc-1" })).toBe(true);
    expect(await protection.protect("user:alice", PROTECTED, { targetId: "target-2", origin: "https://app.example", document: "doc-5" })).toBe(true);
    // A new fill of the same tab replaces its entry instead of adding one.
    expect(await protection.protect("user:alice", PROTECTED, { targetId: "target-2", origin: "https://app.example", document: "doc-6" })).toBe(true);
    expect(await protection.fencedTargets(PROTECTED)).toEqual(["target-2", "target-1"]);
    expect(await protection.fencedTargets(OTHER)).toEqual([]);
    // target-2 moved on to another document, target-1 is still open in the background.
    live.current = page({ targetId: "target-2", origin: "https://app.example", document: "doc-7" });
    pages.current = tabs("target-2", "target-1");
    expect(await protection.release(PROTECTED)).toBe(false);
    expect(rows.get(PROTECTED)!.fill).toEqual({ targetId: "target-1", origin: LOGIN, document: "doc-1" });
    expect(await protection.fencedTargets(PROTECTED)).toEqual(["target-1"]);
    pages.current = tabs("target-2");
    expect(await protection.release(PROTECTED)).toBe(true);
    expect(rows.has(PROTECTED)).toBe(false);
  });

  it("fences a completed handoff's page for the room owner and reports fenced tabs to the CDP proxy", async () => {
    const app = Fastify();
    const live = { current: page({ targetId: "handoff-tab", origin: "https://signup.example", document: "doc-h" }) };
    const store = {
      upsertUser: async (user: never) => user,
      getPane: async (paneId: string) => ({ id: paneId, roomId: "room:vaultroom1" }) as Pane,
      getRoom: async () => ({ ownerUserId: "user:alice" }),
      listPanes: async () => []
    };
    const vault = registerVault(app, { config: { databaseUrl: null, instance: "dev", internalApiToken: config.internalApiToken }, auth: { sessionSecret: "vault-protection-session-secret" },
      store, routeOptions: {}, overrides: { repository: fakeRepository() as never },
      browser: { vaultTarget: async () => live.current, listPages: async () => ({ pages: tabs("handoff-tab") }) } });
    await fenceCompletedHandoff(store, PROTECTED);
    expect(await vault.protection.ownerOf(PROTECTED)).toBe("user:alice");
    expect(await vaultFencedTargets(store, PROTECTED)).toEqual(["handoff-tab"]);
    expect(await vaultFencedTargets(store, OTHER)).toEqual([]);
    // A handoff on a page a fill already fenced (a CAPTCHA before Submit) keeps that fence when it completes.
    await vault.protection.protect("user:alice", OTHER, { targetId: "handoff-tab", origin: "https://signup.example", document: "doc-h" });
    await fenceCompletedHandoff(store, OTHER);
    expect(await vaultFencedTargets(store, OTHER)).toEqual(["handoff-tab"]);
    await vault.protection.unprotect("user:alice", OTHER);
    // No web page in view: nothing to fence, and the handoff still completes.
    live.current = page({ eligible: false, reason: "NO_WEB_ORIGIN", targetId: null, frameId: null, origin: null, document: null });
    await fenceCompletedHandoff(store, OTHER);
    expect(await vault.protection.ownerOf(OTHER)).toBeNull();
    // A store the Vault never saw (another app, a test) has no hooks.
    expect(await vaultFencedTargets({}, PROTECTED)).toEqual([]);
    await expect(fenceCompletedHandoff({}, PROTECTED)).resolves.toBeUndefined();
    await app.close();
  });

  it("frees a browser protected by hand before the change, and tells listeners when a fill protects one", async () => {
    const { protection, rows } = memoryProtection();
    rows.set(OTHER, { owner: "user:alice", fill: null });
    expect(await protection.release(OTHER)).toBe(true);
    expect(rows.has(OTHER)).toBe(false);
    const closed = vi.fn();
    protection.onProtected(closed);
    expect(await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: null })).toBe(true);
    expect(closed).toHaveBeenCalledWith(PROTECTED);
    expect(await protection.protect("user:bob", PROTECTED, { targetId: "target-1", origin: LOGIN, document: null })).toBe(false);
    expect(await protection.ownerOf(PROTECTED)).toBe("user:alice");
  });

  it("gives the CLI that drives the fenced browser pane the masked view, never the filled value, and a CLI that does not drive it nothing (13/11 Nous, plan clipboard:R4ypY6u56pAb)", async () => {
    // A fence that names no viewer (a Nous fill, a handoff Nous asked for, this pane's earlier CLI session): only its driver is known.
    const { protection } = memoryProtection();
    await protection.protect("user:alice", PROTECTED, { targetId: "target-1", origin: LOGIN, document: "doc-1" });
    const activity = createBrowserControlActivity();
    activity.noteAgent(PROTECTED, "pane:cliterminal1");
    // The fenced page, a real DOM: the secret in a password box, the same box shown as text, a text area and an editable area.
    const dom = new JSDOM(`<!doctype html><title>Sign In</title><h1>Sign in</h1><form><input type="email" value="alice@example.com">
      <input type="password" value="${SENTINEL}"><input type="text" value="${SENTINEL}"><textarea>${SENTINEL}</textarea><div contenteditable="true">${SENTINEL}</div></form>
      <div role="alert">Invalid username or password.</div>`, { runScripts: "outside-only", url: `${LOGIN}/signin` });
    const window = dom.window;
    window.Element.prototype.getBoundingClientRect = () => ({ width: 120, height: 24 }) as DOMRect;
    Object.defineProperty(window.HTMLElement.prototype, "innerText", { get(this: HTMLElement) { return this.textContent; } });
    // What a shot draws: the page's text, with each field's text as dots where the page's style hides it (-webkit-text-security).
    const draw = () => [window.document.title, ...[...window.document.querySelectorAll<HTMLElement>("h1,[role=alert],input,textarea,[contenteditable]")].map((el) => {
      const text = "value" in el ? String((el as HTMLInputElement).value) : el.textContent ?? "";
      return window.getComputedStyle(el).getPropertyValue("-webkit-text-security") === "disc" ? "•".repeat(text.length) : text;
    })].join("\n");
    expect(draw()).toContain(SENTINEL);
    const cdp = { close: () => undefined, async send(method: string, params: Record<string, unknown> = {}) {
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return { result: { value: window.eval(String(params.expression)) } };
      if (method === "Page.captureScreenshot") return { data: Buffer.from(draw()).toString("base64") };
      return {};
    } };
    const profile = await mkdtemp(join(tmpdir(), "space-fence-driver-"));
    await writeFile(join(profile, "DevToolsActivePort"), "9222\n/devtools/browser/fake\n");
    // The real hook in front of the real masked screenshot and masked readout.
    const fences = Fastify();
    registerVaultFences(fences, { protection, config, controlActivity: activity });
    fences.post("/api/cli/browser/actions", async () => ({ shot: Buffer.from(await captureMaskedScreenshot(cdp.send as never), "base64").toString() }));
    fences.post("/api/cli/browser/commands", async () => pageReadout({ config: { browserSessionsProfileRoot: profile },
      pane: { id: PROTECTED, roomId: "room:vaultroom1" } as never, session: { activePageId: "target-1", pages: [{ pageId: "target-1" }], profilePath: profile } as never }, async () => cdp as never));
    const as = (paneId: string, cliSessionId: string) => ({ [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: "room:vaultroom1", paneId, cliSessionId })!,
      "content-type": "application/json" });
    const action = (headers: Record<string, string>, type: string) => fences.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type } }] } });
    const readout = (headers: Record<string, string>) => fences.inject({ method: "POST", url: "/api/cli/browser/commands", headers,
      payload: { targetPaneId: PROTECTED, command: { type: "PAGE_READOUT" } } });
    try {
      // (1) The driving CLI (a later session of the pane that drives it) sees the page and the site's error, never the filled value.
      const driver = as("pane:cliterminal1", "cli_session:resumed05");
      const shot = await action(driver, "masked_screenshot");
      expect(shot.statusCode).toBe(200);
      expect(shot.body).toContain("Invalid username or password.");
      const read = await readout(driver);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({ host: "login.example", path: "/signin", title: "Sign In", messages: expect.arrayContaining(["Invalid username or password."]) });
      expect(shot.body + read.body).not.toContain(SENTINEL);
      expect(window.document.getElementById("__space_vault_mask")).toBeNull();
      // Only masked: every read that could carry the value stays refused to the driver too.
      for (const type of ["screenshot", "extract_text", "record", "diagnostics"]) expect((await action(driver, type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
      // (2) A CLI that does not drive the fenced pane gets nothing; nor does any CLI once another pane drives it.
      for (const other of [as("pane:cliterminal2", "cli_session:other003"), as(OTHER, "cli_session:other002")]) {
        expect((await action(other, "masked_screenshot")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
        expect((await readout(other)).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
      }
      activity.noteAgent(PROTECTED, "pane:cliterminal2");
      expect((await action(driver, "masked_screenshot")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
      expect((await readout(driver)).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    } finally {
      await fences.close();
      await rm(profile, { recursive: true });
    }
  });
});

describe("Vault fill path for agents and Nous", () => {
  async function bridgeApp(options: { access?: boolean; origin?: string; approvalMode?: "ASSIST" | "FULL"; agentUse?: boolean; grants?: string[][];
    hostStatus?: "FILLED" | "SUBMITTED" | "BLOCKED"; signup?: (request: { certificate: unknown }) => { status: "FILLED" | "BLOCKED"; reason: string | null }; delegation?: false; autoGrantRefusal?: string;
    /** What the Browser Host reports with the status (hosts since 2026-10-22): a value entered the page; the document the fill ran in. */
    hostTyped?: boolean; hostDocument?: string;
    /** The CDP proxy's document marks: whether an agent session scripted the document (absent: the host reloads every time). */
    documentDirty?: (paneId: string, targetId: string, document: string | null) => boolean;
    documentDirtiedBy?: (paneId: string, targetId: string, document: string | null) => string | null;
    /** Whether the host says it takes freshDocument (default: when the marks are given); an older host never gets the field. */
    hostAcceptsFresh?: boolean;
    /** Whether the host says it takes a generate policy (queue item 37: after its guarded restart). */
    hostTakesPolicy?: boolean;
    /** The item is a payment card (plan clipboard:qf0P640vyLp2); hostCards: the host fills cards. */
    card?: boolean; hostCards?: boolean } = {}) {
    const repository = fakeRepository() as ReturnType<typeof fakeRepository> & Record<string, any>;
    const { body } = await enrollment((await generateVaultTransportKey()).publicKey, "user:alice");
    const { sealedServerShare: _sealed, ...rest } = body;
    await repository.enroll("user:alice", { ...rest, serverShareEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1, purpose: "SERVER_SHARE" }) });
    if (options.access !== false) await repository.enableAgentAccess("user:alice");
    const inbox = await generateVaultTransportKey();
    await repository.setInbox("user:alice", { publicKey: vaultBase64url.encode(inbox.publicKey), privateKeyEnvelope: {} });
    const record = await itemRecord("user:alice", body.vaultId);
    const kind = options.card ? { origins: [], fieldRoles: [...VAULT_CARD_ROLES], card: { brand: "VISA", last4: "4242" } } : { origins: [LOGIN] };
    await repository.saveItem("user:alice", { ...record, metadata: { ...record.metadata, ...kind, policy: { ...record.metadata.policy, agentUse: options.agentUse ?? true } } });
    const handle = record.metadata.id;
    const delegated = options.card ? { origins: [], fields: [...VAULT_CARD_ROLES], submit: false } : { origins: [LOGIN], fields: ["USERNAME", "PASSWORD"], submit: true };
    if (options.delegation !== false) await repository.createDelegation("user:alice", { keyEnvelope: { sealed: "key" },
      fillEnvelopes: { [handle]: Object.fromEntries(delegated.fields.filter((field) => field !== "USERNAME").map((field) => [field, { sealed: "field" }])) },
      certificate: { claims: { generation: 1, vaultId: body.vaultId, items: [{ handle, ...delegated, approvalMode: options.approvalMode ?? "FULL" }] } } });
    for (const sites of options.grants ?? []) {
      await repository.addSignupGrant("user:alice", { claims: { grantId: newVaultHandle("vault_grant"), ownerUserId: "user:alice", sites, dailyCap: 3, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } });
    }
    const { protection, rows } = memoryProtection();
    const issueUse = vi.fn(async () => ({ capability: { claims: "signed by the broker" } }));
    const signupAutoGrant = vi.fn(async () => {
      if (options.autoGrantRefusal) throw new VaultBrokerRefusedError(options.autoGrantRefusal);
      return { certificate: { claims: "minted by the broker" } };
    });
    const sealed = { v: 1, alg: "X25519-HKDF-A256GCM", purpose: "TRANSPORT", keyVersion: 1, epk: "E".repeat(43), nonce: "N".repeat(16), ct: "C".repeat(40) };
    const vaultFill = vi.fn(async (_pane: unknown, request: { mode: string; certificate?: unknown }) => {
      // Like the real Browser Host: a SIGNUP request with any key its strict schema does not know is refused (the certificate is the broker's to check).
      const { certificate: _certificate, ...signup } = request;
      if (request.mode === "SIGNUP" && !vaultHostSignupRequestSchema.omit({ certificate: true }).safeParse(signup).success) {
        return { status: "BLOCKED" as const, reason: "BAD_REQUEST", sealedGenerated: null };
      }
      const reported = { ...(options.hostTyped !== undefined ? { typed: options.hostTyped } : {}), ...(options.hostDocument ? { document: options.hostDocument } : {}) };
      if (request.mode === "SIGNUP" && options.signup) { const answer = options.signup(request as { certificate: unknown }); return { ...answer, sealedGenerated: answer.status === "FILLED" ? sealed : null, ...reported }; }
      const status = options.hostStatus ?? "FILLED";
      return { status, reason: status === "FILLED" ? null : "FIELD_NOT_FOUND", sealedGenerated: status === "FILLED" && (request.mode === "GENERATE" || request.mode === "SIGNUP") ? sealed : null, ...reported };
    });
    const vaultTarget = vi.fn(async () => page({ origin: options.origin ?? LOGIN, ...((options.hostAcceptsFresh ?? Boolean(options.documentDirty)) ? { freshDocument: true } : {}),
      ...(options.hostTakesPolicy ? { generatePolicy: true } : {}), ...(options.hostCards ? { cards: true } : {}) }));
    const panes = [{ id: "pane:cliterminal1", roomId: "room:vaultroom1", mode: "TERMINAL", isClosed: false }, { id: PROTECTED, roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false },
      { id: OTHER, roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false }, { id: "pane:bobsbrowser", roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false }] as Pane[];
    const siteSignins = new InMemorySiteSigninsRepository();
    const agent = createVaultAgent({ siteSignins, paneAccount: async () => "google:synthetic", repository, broker: { issueUse, signupAutoGrant } as never, protection, browser: { vaultTarget, vaultFill }, listPanes: async () => panes,
      paneOwner: async (paneId) => paneId === "pane:bobsbrowser" ? "user:bob" : "user:alice", documentDirty: options.documentDirty, documentDirtiedBy: options.documentDirtiedBy });
    const vault = { repository, protection, broker: { issueUse }, agent } as unknown as VaultModule;
    const app = Fastify();
    registerVaultAgentBridge(app, vault, { store: { getRoom: () => ({ ownerUserId: "user:alice" }) }, requireBridge: async () => ({ claims: { roomId: "room:vaultroom1", paneId: "pane:cliterminal1", cliSessionId: "cli_session:vault01" } }) });
    const post = (path: string, payload: unknown) => app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, payload: payload as never });
    const fill = (patch: Record<string, unknown> = {}) => post("fill", { handle, fields: ["PASSWORD"], ...patch });
    const generate = (purpose: "NEW_ACCOUNT" | "CHANGE_PASSWORD") => post("generate-fill",
      purpose === "CHANGE_PASSWORD" ? { purpose, handle, roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"] } : { purpose, label: "Synthetic new", username: "synthetic@example.com" });
    const audits = async () => (await repository.listAudit("user:alice", { limit: 50 })).map((entry) => entry.event);
    return { app, post, fill, generate, siteSignins, issueUse, signupAutoGrant, vaultFill, vaultTarget, audits, repository, rows, sealed, handle, inbox, vault, vaultId: body.vaultId };
  }

  it("refuses a password reset while the stored sign-in works, unless the operator's order is passed (nous_msg:fe72e061)", async () => {
    const changed = await bridgeApp({ grants: [[LOGIN]], hostTakesPolicy: true });
    try {
      const reset = (patch: Record<string, unknown> = {}) => changed.post("generate-fill", { purpose: "CHANGE_PASSWORD", handle: changed.handle, ...patch });
      // A SUCCESS in the last 30 days: refused with Space's sentence, and the host never asked.
      await changed.siteSignins.record("user:alice", { site: LOGIN, accountLabel: "main", outcome: "SUCCESS", method: "VAULT_LOGIN" }, "cli:test");
      const refused = (await reset()).json();
      expect(refused).toMatchObject({ status: "BLOCKED", reason: "SIGNIN_WORKS" });
      expect(refused.message).toMatch(/^Stored sign-in works \(SUCCESS \d{4}-\d{2}-\d{2}, method VAULT_LOGIN\)\. Sign in with it; a reset needs the operator's explicit order\.$/);
      expect(changed.vaultFill).not.toHaveBeenCalled();
      // The operator's order goes ahead and is audited, in the Vault audit and in the site's record.
      expect((await reset({ operatorOrder: "nous_msg:fe72e061203043b6af2039e9" })).json()).toMatchObject({ status: "FILLED", reason: "OPERATOR_ORDER" });
      expect(await changed.audits()).toContainEqual(expect.objectContaining({ action: "GENERATE", result: "FILLED", reason: "OPERATOR_ORDER" }));
      expect((await changed.siteSignins.get("user:alice", LOGIN))!.history.map((event) => event.reason))
        .toContain("Password reset on the operator's order nous_msg:fe72e061203043b6af2039e9");
    } finally { await changed.app.close(); }
  });

  it("records a submitted Vault login as pending, without claiming sign-in success", async () => {
    const {app, fill, siteSignins, handle} = await bridgeApp({hostStatus: "SUBMITTED"});
    try {
      expect((await fill({submit:true})).json()).toMatchObject({status:"SUBMITTED"});
      const signin = await siteSignins.get("user:alice", LOGIN);
      expect(signin).toMatchObject({method:"VAULT_LOGIN",successCount:0,lastSuccessAt:null,pendingAttempt:{vaultHandle:handle,browserProfileId:"google:synthetic"}});
    } finally {await app.close();}
  });

  it("fills with no approval and no hourly limit, protecting the room's browser for the filled page", async () => {
    const { app, fill, issueUse, vaultFill, rows, audits } = await bridgeApp({ approvalMode: "ASSIST" });
    for (let index = 0; index < 8; index += 1) expect((await fill({ submit: true })).json()).toMatchObject({ status: "FILLED" });
    expect(issueUse).toHaveBeenCalledWith(expect.objectContaining({ paneId: PROTECTED, targetId: "target-1", frameId: "frame-1", origin: LOGIN, fields: ["PASSWORD"], submit: true, epoch: 1 }));
    expect(vaultFill).toHaveBeenCalledWith(expect.objectContaining({ id: PROTECTED }), expect.objectContaining({ mode: "FILL", keyEnvelope: { sealed: "key" } }), expect.any(String));
    expect(rows.get(PROTECTED)).toEqual({ owner: "user:alice", fill: { targetId: "target-1", origin: LOGIN, document: "doc-1", viewer: "cli:cli_session:vault01" } });
    expect((await audits())[0]).toMatchObject({ actor: "AGENT", action: "FILL", result: "FILLED", paneId: "pane:cliterminal1" });
    await app.close();
  });

  it("gives the CLI that filled the browser pane it drives the masked view of that page, nothing unmasked, and no other pane anything (13/11 Felix/Hugo)", async () => {
    const { fill, vault, app, rows, audits } = await bridgeApp();
    const answer = await fill({ submit: false });
    expect(answer.json()).toMatchObject({ status: "FILLED" });
    // The same fence the bridge just set, behind the real hook: the terminal pane filled PROTECTED, the room browser it drives.
    const fences = Fastify();
    registerVaultFences(fences, { protection: vault.protection, config });
    fences.post("/api/cli/browser/actions", async () => ({ ok: true }));
    fences.post("/api/cli/browser/commands", async () => ({ ok: true }));
    const as = (paneId: string, cliSessionId: string) => ({ [cliBrowserBridgeTokenHeader]: issueCliBrowserBridgeToken(config, { roomId: "room:vaultroom1", paneId, cliSessionId })!,
      "content-type": "application/json" });
    const filler = as("pane:cliterminal1", "cli_session:vault01");
    const action = (headers: Record<string, string>, type: string) => fences.inject({ method: "POST", url: "/api/cli/browser/actions", headers,
      payload: { actions: [{ targetPaneId: PROTECTED, action: { type } }] } });
    const readout = (headers: Record<string, string>) => fences.inject({ method: "POST", url: "/api/cli/browser/commands", headers,
      payload: { targetPaneId: PROTECTED, command: { type: "PAGE_READOUT" } } });
    // (a) The filling CLI gets the masked screenshot and the masked readout of the page it filled.
    expect((await action(filler, "masked_screenshot")).statusCode).toBe(200);
    expect((await readout(filler)).statusCode).toBe(200);
    // (b) Only masked: every read that could carry the filled value stays refused for it too, and no answer carries the value.
    for (const type of ["screenshot", "extract_text", "record", "diagnostics"]) expect((await action(filler, type)).json().error.code, type).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    expect(answer.body + JSON.stringify(rows.get(PROTECTED)) + JSON.stringify(await audits())).not.toContain(SENTINEL);
    // (c) By the viewer alone, any other pane or another CLI session in the same pane gets nothing (clicks stay open to it); the CLI pane
    // that drives the browser gets the masked view by the driver rule (the "drives the fenced browser pane" case).
    for (const other of [as(OTHER, "cli_session:other002"), as("pane:cliterminal2", "cli_session:other003"), as("pane:cliterminal1", "cli_session:later04")]) {
      expect((await action(other, "click")).statusCode).toBe(200);
      expect((await action(other, "masked_screenshot")).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
      expect((await readout(other)).json().error.code).toBe("VAULT_PROTECTED_SESSION_REQUIRED");
    }
    await fences.close();
    await app.close();
  });

  it("fills a card at any clean https checkout, never submitting, fenced and audited with where (plan clipboard:qf0P640vyLp2)", async () => {
    const checkout = "https://checkout.shop.example";
    const shop = await bridgeApp({ card: true, hostCards: true, origin: checkout });
    try {
      const answer = await shop.post("card-fill", { handle: shop.handle });
      expect(answer.json()).toEqual({ status: "FILLED", auditId: expect.stringMatching(/^vault_audit:/), reason: null });
      expect(shop.issueUse).toHaveBeenCalledWith(expect.objectContaining({ handle: shop.handle, origin: checkout, fields: [...VAULT_CARD_ROLES], submit: false, paneId: PROTECTED }));
      expect(shop.issueUse.mock.calls[0]![0]).not.toHaveProperty("generate");
      expect(shop.vaultFill).toHaveBeenCalledWith(expect.objectContaining({ id: PROTECTED }), expect.objectContaining({ mode: "CARD", fieldEnvelopes: expect.objectContaining({ CARD_NUMBER: { sealed: "field" } }) }), expect.any(String));
      expect((await shop.audits())[0]).toMatchObject({ actor: "AGENT", action: "FILL", result: "FILLED", itemId: shop.handle, origin: checkout, paneId: "pane:cliterminal1" });
      expect(shop.rows.get(PROTECTED)).toMatchObject({ owner: "user:alice", fill: { origin: checkout } });
      // The list names the card by brand and last four only; a site filter still lists it.
      expect((await shop.post("list", { site: "checkout.shop.example" })).json().items).toEqual([{ handle: shop.handle, label: "Synthetic", origins: [], fields: [...VAULT_CARD_ROLES], card: "VISA ••4242" }]);
      // A login fill with the card's handle asks for fields the card does not hold.
      expect((await shop.fill()).json()).toMatchObject({ status: "BLOCKED", reason: "NOT_DELEGATED" });
      expect(answer.body + JSON.stringify(await shop.audits())).not.toContain(SENTINEL);
    } finally { await shop.app.close(); }
    // An older host, a page that is not clean https, a login's handle: refused before the broker is asked, nothing fenced.
    for (const [options, status, reason] of [[{ card: true, origin: checkout }, "BLOCKED", "CARD_NEEDS_HOST_RESTART"],
      [{ card: true, hostCards: true, origin: "http://shop.example" }, "ORIGIN_MISMATCH", "CARD_NEEDS_HTTPS"], [{ card: true, hostCards: true, origin: "https://10.0.0.1" }, "ORIGIN_MISMATCH", "CARD_NEEDS_HTTPS"],
      [{ hostCards: true }, "BLOCKED", "NOT_A_CARD"], [{ card: true, hostCards: true, agentUse: false, origin: checkout }, "BLOCKED", "NOT_DELEGATED"]] as const) {
      const refused = await bridgeApp(options);
      try {
        expect((await refused.post("card-fill", { handle: refused.handle })).json(), reason).toMatchObject({ status, reason });
        expect(refused.issueUse).not.toHaveBeenCalled();
        expect(refused.vaultFill).not.toHaveBeenCalled();
        expect(refused.rows.size).toBe(0);
      } finally { await refused.app.close(); }
    }
  });

  it("refuses while agent access is off, at another origin, for a hidden item or another owner's browser, before the broker is asked", async () => {
    for (const [options, patch, status, reason] of [[{ access: false }, {}, "BLOCKED", "AGENT_ACCESS_OFF"], [{ origin: "https://evil.example" }, {}, "ORIGIN_MISMATCH", "ORIGIN_NOT_DELEGATED"],
      [{ agentUse: false }, {}, "BLOCKED", "NOT_DELEGATED"], [{}, { targetPaneId: "pane:bobsbrowser" }, "BLOCKED", "NO_BROWSER"],
      [{}, { targetPaneId: "pane:cliterminal1" }, "BLOCKED", "NO_BROWSER"]] as const) {
      const { app, fill, issueUse, audits, rows } = await bridgeApp(options);
      expect((await fill(patch)).json().status).toBe(status);
      expect((await audits())[0]).toMatchObject({ reason });
      expect(issueUse).not.toHaveBeenCalled();
      expect(rows.size).toBe(0);
      await app.close();
    }
  });

  it("fills the named browser pane, and leaves a browser unprotected when the fill typed nothing", async () => {
    const named = await bridgeApp();
    expect((await named.fill({ targetPaneId: OTHER })).json().status).toBe("FILLED");
    expect(named.vaultFill).toHaveBeenCalledWith(expect.objectContaining({ id: OTHER }), expect.anything(), expect.any(String));
    await named.app.close();
    const failed = await bridgeApp({ hostStatus: "BLOCKED" });
    expect((await failed.fill()).json().status).toBe("BLOCKED");
    expect(failed.rows.size).toBe(0);
    await failed.app.close();
  });

  it("keeps the fence when the host typed before it failed, and follows the document the host reloaded into (Vault review 2026-10-22)", async () => {
    // A failed fill whose scrub may not have reached the value: the browser stays fenced; the agent's answer stays the fixed shape.
    const typed = await bridgeApp({ hostStatus: "BLOCKED", hostTyped: true });
    expect((await typed.fill()).json()).toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "FIELD_NOT_FOUND" });
    expect(typed.rows.get(PROTECTED)).toMatchObject({ owner: "user:alice", fill: { targetId: "target-1", origin: LOGIN } });
    await typed.app.close();
    // The host reloads the page before typing: the fence moves to that document instead of lifting on the next release check.
    const reloaded = await bridgeApp({ hostDocument: "doc-2" });
    expect((await reloaded.fill()).json().status).toBe("FILLED");
    expect(reloaded.rows.get(PROTECTED)).toEqual({ owner: "user:alice", fill: { targetId: "target-1", origin: LOGIN, document: "doc-2", viewer: "cli:cli_session:vault01" } });
    await reloaded.app.close();
    // NEW_ACCOUNT through the sign-up path reports the same way.
    const signup = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "BLOCKED", reason: "FOCUS_LOST" }), hostTyped: true });
    expect((await signup.generate("NEW_ACCOUNT")).json().status).toBe("BLOCKED");
    expect(signup.rows.get(PROTECTED)).toBeDefined();
    await signup.app.close();
  });

  it("tells the host whether the document needs a reload from the CDP proxy's marks, and passes the host's reason to the agent (Vault review 2026-10-22)", async () => {
    // No marks known (no proxy): the request carries no freshDocument, so the host reloads (its safe default).
    const unknown = await bridgeApp();
    await unknown.fill();
    expect(unknown.vaultFill.mock.calls[0]![1]).not.toHaveProperty("freshDocument");
    await unknown.app.close();
    // A host from before the field (its target does not say it takes it) never gets it: its strict schema would refuse the fill.
    const older = await bridgeApp({ documentDirty: () => false, hostAcceptsFresh: false });
    await older.fill();
    expect(older.vaultFill.mock.calls[0]![1]).not.toHaveProperty("freshDocument");
    await older.app.close();
    // The proxy knows the document: clean means no reload, dirty means a fresh document first; sign-ups say it the same way.
    const asked: Array<[string, string, string | null]> = [];
    const clean = await bridgeApp({ documentDirty: (...args) => { asked.push(args); return false; } });
    await clean.fill();
    expect(asked).toEqual([[PROTECTED, "target-1", "doc-1"]]);
    expect(clean.vaultFill.mock.calls[0]![1]).toMatchObject({ mode: "FILL", freshDocument: false });
    expect((await clean.fill()).json()).not.toHaveProperty("reloaded");
    await clean.app.close();
    // R20-7 (30/10 13:15 BKK, Allianz: FILLED, nothing said, the reload had emptied every other field): a fill after a reload says so and why.
    const reloadedFill = await bridgeApp({ documentDirty: () => true, documentDirtiedBy: () => "Page.captureScreenshot" });
    expect((await reloadedFill.fill()).json()).toMatchObject({ reloaded: true, dirtiedBy: "Page.captureScreenshot" });
    await reloadedFill.app.close();
    const dirty = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "BLOCKED", reason: "FIELD_NOT_FOUND_AFTER_RELOAD" }), documentDirty: () => true });
    expect((await dirty.generate("NEW_ACCOUNT")).json()).toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "FIELD_NOT_FOUND_AFTER_RELOAD" });
    expect(dirty.vaultFill.mock.calls[0]![1]).toMatchObject({ mode: "SIGNUP", freshDocument: true });
    await dirty.app.close();
    // 28/10 (Workday and amazon.jobs sign-ups lost their step to the reload): the answer names the command that dirtied the page.
    const named = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "BLOCKED", reason: "FIELD_NOT_FOUND_AFTER_RELOAD" }), documentDirty: () => true,
      documentDirtiedBy: () => "Runtime.callFunctionOn" });
    expect((await named.generate("NEW_ACCOUNT")).json()).toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "FIELD_NOT_FOUND_AFTER_RELOAD",
      dirtiedBy: "Runtime.callFunctionOn" });
    await named.app.close();
  });

  it("passes a site's stated password rules only to a host that takes them; an older host stops the call with the reason (queue item 37)", async () => {
    const policy = { minLength: 8, maxLength: 18, symbols: "NONE" };
    const older = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "FILLED", reason: null }) });
    expect((await older.post("generate-fill", { purpose: "NEW_ACCOUNT", label: "Synthetic SuccessFactors", policy })).json())
      .toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "POLICY_NEEDS_HOST_RESTART" });
    expect(older.vaultFill).not.toHaveBeenCalled();
    // Without a policy the older host works as before.
    expect((await older.generate("NEW_ACCOUNT")).json().status).toBe("FILLED");
    expect(older.vaultFill.mock.calls[0]![1]).not.toHaveProperty("policy");
    await older.app.close();
    const restarted = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "FILLED", reason: null }), hostTakesPolicy: true });
    expect((await restarted.post("generate-fill", { purpose: "NEW_ACCOUNT", label: "Synthetic SuccessFactors", policy })).json().status).toBe("FILLED");
    expect(restarted.vaultFill.mock.calls[0]![1]).toMatchObject({ mode: "SIGNUP", policy });
    // 7/11 Oracle: a second password set at the same site waits until the first was filled and read back, and RESET_WAIT_MS.
    expect((await restarted.post("generate-fill", { purpose: "CHANGE_PASSWORD", handle: restarted.handle, policy: { maxLength: 16 } })).json())
      .toEqual({ status: "BLOCKED", auditId: expect.stringMatching(/^vault_audit:/), reason: "RESET_PENDING" });
    // A policy that names an impossible length never reaches the host.
    await restarted.post("generate-fill", { purpose: "NEW_ACCOUNT", label: "x", policy: { minLength: 20, maxLength: 10 } });
    expect(restarted.vaultFill).toHaveBeenCalledTimes(1);
    await restarted.app.close();
    const changed = await bridgeApp({ grants: [[LOGIN]], hostTakesPolicy: true });
    expect((await changed.post("generate-fill", { purpose: "CHANGE_PASSWORD", handle: changed.handle, policy: { maxLength: 16 } })).json().status).toBe("FILLED");
    expect(changed.vaultFill.mock.calls[0]![1]).toMatchObject({ mode: "GENERATE", policy: { maxLength: 16 } });
    await changed.app.close();
  });

  it("NEW_ACCOUNT runs under the site's signed grant, else one the broker mints from the delegation, through the Browser Host, into the inbox", async () => {
    const none = await bridgeApp({ grants: [["https://other.example"]], delegation: false });
    expect((await none.generate("NEW_ACCOUNT")).json().status).toBe("BLOCKED");
    expect((await none.audits())[0]).toMatchObject({ action: "GENERATE", result: "BLOCKED", reason: "NO_SIGNUP_GRANT" });
    expect(none.vaultFill).not.toHaveBeenCalled();
    await none.app.close();
    const capped = await bridgeApp({ autoGrantRefusal: "DAILY_CAP" });
    expect((await capped.generate("NEW_ACCOUNT")).json().status).toBe("RATE_LIMITED");
    expect((await capped.audits())[0]).toMatchObject({ action: "GENERATE", result: "RATE_LIMITED", reason: "DAILY_CAP" });
    expect(capped.vaultFill).not.toHaveBeenCalled();
    expect(capped.rows.size).toBe(0);
    await capped.app.close();
    const minted = await bridgeApp({ grants: [["https://other.example"]], signup: () => ({ status: "FILLED", reason: null }) });
    expect((await minted.generate("NEW_ACCOUNT")).json().status).toBe("FILLED");
    expect(minted.signupAutoGrant).toHaveBeenCalledWith({ ownerUserId: "user:alice", vaultId: minted.vaultId, certificate: expect.objectContaining({ claims: expect.objectContaining({ generation: 1 }) }), origin: LOGIN });
    expect(minted.vaultFill).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ mode: "SIGNUP", certificate: { claims: "minted by the broker" }, origin: LOGIN }), expect.any(String));
    const [created] = await minted.repository.listPending("user:alice");
    expect(created).toEqual(expect.objectContaining({ kind: "NEW_ACCOUNT", label: "Synthetic new", origin: LOGIN, sealedPassword: minted.sealed }));
    // The audit names the item the generated password becomes, so the dock's Activity can show which login it was.
    expect((await minted.audits())[0]).toMatchObject({ action: "GENERATE", result: "FILLED", itemId: created.handle });
    await minted.app.close();
    const granted = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "FILLED", reason: null }) });
    expect((await granted.generate("NEW_ACCOUNT")).json().status).toBe("FILLED");
    expect(granted.signupAutoGrant).not.toHaveBeenCalled();
    expect(granted.vaultFill).toHaveBeenLastCalledWith(expect.objectContaining({ id: PROTECTED }), expect.objectContaining({ mode: "SIGNUP", origin: LOGIN, targetId: "target-1", frameId: "frame-1", paneId: PROTECTED }), expect.any(String));
    expect(await granted.repository.listPending("user:alice")).toEqual([expect.objectContaining({ kind: "NEW_ACCOUNT", label: "Synthetic new", origin: LOGIN, sealedPassword: granted.sealed, paneId: PROTECTED })]);
    expect(granted.rows.has(PROTECTED)).toBe(true);
    await granted.app.close();
  });

  it("13/11 DCM: a retried sign-up waits for no reset and changes its own login instead of making a second item", async () => {
    const retry = await bridgeApp({ grants: [[LOGIN]], signup: () => ({ status: "FILLED", reason: null }) });
    expect((await retry.generate("NEW_ACCOUNT")).json().status).toBe("FILLED");
    expect((await retry.generate("NEW_ACCOUNT")).json().status).toBe("FILLED");
    const [first, second] = await retry.repository.listPending("user:alice");
    expect(first).toMatchObject({ kind: "NEW_ACCOUNT", origin: LOGIN });
    expect(second).toMatchObject({ kind: "CHANGE_PASSWORD", handle: first!.handle, origin: LOGIN });
    // A real reset at the site still waits (7/11 Oracle); another label is another account.
    expect((await retry.generate("CHANGE_PASSWORD")).json().reason).toBe("RESET_PENDING");
    expect((await retry.post("generate-fill", { purpose: "NEW_ACCOUNT", label: "Other account" })).json().reason).toBe("RESET_PENDING");
    await retry.app.close();
  });

  it("generates a changed password into the operator's inbox", async () => {
    const { app, generate, issueUse, vaultFill, repository, sealed, handle } = await bridgeApp();
    expect((await generate("CHANGE_PASSWORD")).json().status).toBe("FILLED");
    expect(issueUse).toHaveBeenCalledWith(expect.objectContaining({ fields: ["PASSWORD"], generate: { roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"], inboxPublicKey: expect.any(String) } }));
    expect(vaultFill).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "GENERATE" }), expect.any(String));
    expect(await repository.listPending("user:alice")).toEqual([expect.objectContaining({ kind: "CHANGE_PASSWORD", handle, origin: LOGIN, sealedPassword: sealed, paneId: PROTECTED })]);
    await app.close();
  });

  it("saves a login an agent created sealed to the operator's inbox, and lists, reports and audits handles only", async () => {
    const { app, post, repository, inbox, handle, vaultId } = await bridgeApp();
    const saved = await post("save", { site: "https://shop.example/register?step=2", username: "synthetic@example.com", password: SENTINEL, label: "Synthetic shop" });
    expect(saved.json()).toEqual({ status: "SAVED", auditId: expect.stringMatching(/^vault_audit:/), reason: null });
    const [pending] = await repository.listPending("user:alice");
    expect(pending).toMatchObject({ kind: "NEW_ACCOUNT", label: "Synthetic shop", origin: "https://shop.example", paneId: "pane:cliterminal1" });
    expect((await repository.listAudit("user:alice", { limit: 1 }))[0]!.event).toMatchObject({ action: "ITEM_SAVE", result: "SAVED", itemId: pending!.handle });
    expect(JSON.stringify(pending)).not.toContain(SENTINEL);
    const open = async (envelope: unknown) => new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, envelope, { ownerUserId: "user:alice", vaultId, keyVersion: 1 }));
    expect(await open(pending!.sealedPassword)).toBe(SENTINEL);
    expect(await open(pending!.sealedUsername)).toBe("synthetic@example.com");
    expect((await post("save", { site: "https://shop.example", username: "only-a-name", label: "No password" })).json().status).toBe("SAVED");
    expect((await repository.listPending("user:alice"))[1]).toMatchObject({ sealedPassword: null });
    // This delegation carries no inbox key (signed before 2026-10-20), so the saved logins join only the next one; no answer
    // counts them as waiting for the operator (31/10).
    expect((await post("list", {})).json()).toEqual({ status: "LISTED", auditId: expect.any(String), items: [{ handle, label: "Synthetic", origins: [LOGIN], fields: ["USERNAME", "PASSWORD"] }] });
    expect((await post("status", {})).json()).toEqual({ status: "LISTED", auditId: expect.any(String), agentAccess: true, delegatedItems: 1 });
    const audit = (await post("audit", { limit: 5 })).json();
    expect(audit.entries.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(["AGENT_LIST:LISTED", "AGENT_LIST:LISTED", "ITEM_SAVE:SAVED", "ITEM_SAVE:SAVED"]);
    expect(JSON.stringify(audit)).not.toContain(SENTINEL);
    await app.close();
  });

  it("sets a saved login's login page by handle on its own site only, with no unlock, and lists it (nous_msg:cc5aba71)", async () => {
    const { app, post, repository, handle } = await bridgeApp();
    const before = await repository.getItem("user:alice", handle);
    expect((await post("save", { handle, loginPage: `${LOGIN}/portal-gui/login` })).json()).toMatchObject({ status: "SAVED", reason: null });
    const after = await repository.getItem("user:alice", handle);
    expect(after!.metadata.loginPage).toBe(`${LOGIN}/portal-gui/login`);
    expect({ dek: after!.dekEnvelope, fields: after!.fields }).toEqual({ dek: before!.dekEnvelope, fields: before!.fields });
    expect((await post("list", {})).json().items).toEqual([expect.objectContaining({ handle, loginPage: `${LOGIN}/portal-gui/login` })]);
    expect((await post("save", { handle, loginPage: "https://evil.example/login" })).json()).toMatchObject({ status: "BLOCKED", reason: "LOGIN_PAGE_OFF_SITE" });
    expect((await post("save", { handle: newVaultHandle("vault_item"), loginPage: `${LOGIN}/login` })).json()).toMatchObject({ status: "BLOCKED", reason: "ITEM_NOT_FOUND" });
    expect((await post("save", { handle, loginPage: null })).json().status).toBe("SAVED");
    expect((await post("list", {})).json().items[0]).not.toHaveProperty("loginPage");
    // A new login carries its login page to the pending record the dock files.
    expect((await post("save", { site: "https://shop.example", username: "synthetic@example.com", label: "Shop", loginPage: "https://shop.example/login" })).json().status).toBe("SAVED");
    expect((await repository.listPending("user:alice"))[0]).toMatchObject({ origin: "https://shop.example", loginPage: "https://shop.example/login" });
    await app.close();
  });

  it("gives Nous the same fill, list and save as the agents, by pane and handle only", async () => {
    const { createNousTools } = await import("../src/nous/tools.js");
    const { vault, vaultFill, rows, handle, app } = await bridgeApp();
    const room = { id: "room:vaultroom1", name: "Work" };
    const browser = { id: PROTECTED, roomId: room.id, paneName: "Login browser", title: "Login browser", mode: "BROWSER", isClosed: false };
    const tools = createNousTools({ rooms: async (owner: string) => owner === "user:alice" ? [room] : [], listPanes: async () => [browser], vault } as never);
    const ctx = { owner: "user:alice", turnId: "t", callId: "c", traceId: "trace" };
    const filled = await tools.execute("space_vault_fill", { room: "Work", pane: "Login browser", handle, fields: ["PASSWORD"], submit: true }, ctx);
    expect(filled).toMatchObject({ ok: true });
    expect(JSON.parse(filled.result)).toEqual({ status: "FILLED", auditId: expect.any(String), reason: null });
    expect(vaultFill).toHaveBeenCalledWith(expect.objectContaining({ id: PROTECTED }), expect.objectContaining({ mode: "FILL" }), "trace");
    expect(rows.has(PROTECTED)).toBe(true);
    expect(JSON.parse((await tools.execute("space_vault_list", {}, ctx)).result).items).toEqual([expect.objectContaining({ handle })]);
    const saved = await tools.execute("space_vault_save", { site: "https://shop.example", username: "nous@example.com", password: SENTINEL, label: "Shop" }, ctx);
    expect(JSON.parse(saved.result).status).toBe("SAVED");
    expect(saved.display).not.toContain(SENTINEL);
    // Another owner reaches neither the room nor the Vault; a value, URL or selector is not an argument.
    expect((await tools.execute("space_vault_fill", { room: "Work", pane: "Login browser", handle, fields: ["PASSWORD"] }, { ...ctx, owner: "user:bob" })).ok).toBe(false);
    expect((await tools.execute("space_vault_fill", { room: "Work", pane: "Login browser", handle, fields: ["PASSWORD"], url: "https://example.com" }, ctx)).result).toContain("Invalid arguments");
    await app.close();
  });
});
