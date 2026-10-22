import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { generateVaultTransportKey, newVaultHandle, openWithVaultPrivateKey, sealVaultEnvelope, vaultBase64url, vaultHostSignupRequestSchema, vaultRandomBytes, type Pane, type VaultHostTarget } from "@space/contracts";
import { issueCliBrowserBridgeToken, cliBrowserBridgeTokenHeader } from "../src/cli-browser-bridge.js";
import { getApiConfig } from "../src/config.js";
import { createVaultAgent } from "../src/vault/agent.js";
import { VaultBrokerRefusedError } from "../src/vault/broker-client.js";
import { createVaultProtection, registerVaultFences, vaultFillPageGone, type VaultOpenPage, type VaultProtectionStore } from "../src/vault/protection.js";
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
});

describe("Vault fill path for agents and Nous", () => {
  async function bridgeApp(options: { access?: boolean; origin?: string; approvalMode?: "ASSIST" | "FULL"; agentUse?: boolean; grants?: string[][];
    hostStatus?: "FILLED" | "BLOCKED"; signup?: (request: { certificate: unknown }) => { status: "FILLED" | "BLOCKED"; reason: string | null }; delegation?: false; autoGrantRefusal?: string } = {}) {
    const repository = fakeRepository() as ReturnType<typeof fakeRepository> & Record<string, any>;
    const { body } = await enrollment((await generateVaultTransportKey()).publicKey, "user:alice");
    const { sealedServerShare: _sealed, ...rest } = body;
    await repository.enroll("user:alice", { ...rest, serverShareEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: "user:alice", vaultId: body.vaultId, keyVersion: 1, purpose: "SERVER_SHARE" }) });
    if (options.access !== false) await repository.enableAgentAccess("user:alice");
    const inbox = await generateVaultTransportKey();
    await repository.setInbox("user:alice", { publicKey: vaultBase64url.encode(inbox.publicKey), privateKeyEnvelope: {} });
    const record = await itemRecord("user:alice", body.vaultId);
    await repository.saveItem("user:alice", { ...record, metadata: { ...record.metadata, origins: [LOGIN], policy: { ...record.metadata.policy, agentUse: options.agentUse ?? true } } });
    const handle = record.metadata.id;
    if (options.delegation !== false) await repository.createDelegation("user:alice", { keyEnvelope: { sealed: "key" }, fillEnvelopes: { [handle]: { PASSWORD: { sealed: "field" } } },
      certificate: { claims: { generation: 1, vaultId: body.vaultId, items: [{ handle, origins: [LOGIN], fields: ["USERNAME", "PASSWORD"], approvalMode: options.approvalMode ?? "FULL", submit: true }] } } });
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
      if (request.mode === "SIGNUP" && options.signup) { const answer = options.signup(request as { certificate: unknown }); return { ...answer, sealedGenerated: answer.status === "FILLED" ? sealed : null }; }
      const status = options.hostStatus ?? "FILLED";
      return { status, reason: status === "FILLED" ? null : "FIELD_NOT_FOUND", sealedGenerated: status === "FILLED" && (request.mode === "GENERATE" || request.mode === "SIGNUP") ? sealed : null };
    });
    const vaultTarget = vi.fn(async () => page({ origin: options.origin ?? LOGIN }));
    const panes = [{ id: "pane:cliterminal1", roomId: "room:vaultroom1", mode: "TERMINAL", isClosed: false }, { id: PROTECTED, roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false },
      { id: OTHER, roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false }, { id: "pane:bobsbrowser", roomId: "room:vaultroom1", mode: "BROWSER", isClosed: false }] as Pane[];
    const agent = createVaultAgent({ repository, broker: { issueUse, signupAutoGrant } as never, protection, browser: { vaultTarget, vaultFill }, listPanes: async () => panes,
      paneOwner: async (paneId) => paneId === "pane:bobsbrowser" ? "user:bob" : "user:alice" });
    const vault = { repository, protection, broker: { issueUse }, agent } as unknown as VaultModule;
    const app = Fastify();
    registerVaultAgentBridge(app, vault, { store: { getRoom: () => ({ ownerUserId: "user:alice" }) }, requireBridge: async () => ({ claims: { roomId: "room:vaultroom1", paneId: "pane:cliterminal1" } }) });
    const post = (path: string, payload: unknown) => app.inject({ method: "POST", url: `/api/cli/space-vault/${path}`, payload: payload as never });
    const fill = (patch: Record<string, unknown> = {}) => post("fill", { handle, fields: ["PASSWORD"], ...patch });
    const generate = (purpose: "NEW_ACCOUNT" | "CHANGE_PASSWORD") => post("generate-fill",
      purpose === "CHANGE_PASSWORD" ? { purpose, handle, roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"] } : { purpose, label: "Synthetic new", username: "synthetic@example.com" });
    const audits = async () => (await repository.listAudit("user:alice", { limit: 50 })).map((entry) => entry.event);
    return { app, post, fill, generate, issueUse, signupAutoGrant, vaultFill, vaultTarget, audits, repository, rows, sealed, handle, inbox, vault, vaultId: body.vaultId };
  }

  it("fills with no approval and no hourly limit, protecting the room's browser for the filled page", async () => {
    const { app, fill, issueUse, vaultFill, rows, audits } = await bridgeApp({ approvalMode: "ASSIST" });
    for (let index = 0; index < 8; index += 1) expect((await fill({ submit: true })).json()).toMatchObject({ status: "FILLED" });
    expect(issueUse).toHaveBeenCalledWith(expect.objectContaining({ paneId: PROTECTED, targetId: "target-1", frameId: "frame-1", origin: LOGIN, fields: ["PASSWORD"], submit: true, epoch: 1 }));
    expect(vaultFill).toHaveBeenCalledWith(expect.objectContaining({ id: PROTECTED }), expect.objectContaining({ mode: "FILL", keyEnvelope: { sealed: "key" } }), expect.any(String));
    expect(rows.get(PROTECTED)).toEqual({ owner: "user:alice", fill: { targetId: "target-1", origin: LOGIN, document: "doc-1" } });
    expect((await audits())[0]).toMatchObject({ actor: "AGENT", action: "FILL", result: "FILLED", paneId: "pane:cliterminal1" });
    await app.close();
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
    expect(saved.json()).toEqual({ status: "SAVED", auditId: expect.stringMatching(/^vault_audit:/) });
    const [pending] = await repository.listPending("user:alice");
    expect(pending).toMatchObject({ kind: "NEW_ACCOUNT", label: "Synthetic shop", origin: "https://shop.example", paneId: "pane:cliterminal1" });
    expect((await repository.listAudit("user:alice", { limit: 1 }))[0]!.event).toMatchObject({ action: "ITEM_SAVE", result: "SAVED", itemId: pending!.handle });
    expect(JSON.stringify(pending)).not.toContain(SENTINEL);
    const open = async (envelope: unknown) => new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, envelope, { ownerUserId: "user:alice", vaultId, keyVersion: 1 }));
    expect(await open(pending!.sealedPassword)).toBe(SENTINEL);
    expect(await open(pending!.sealedUsername)).toBe("synthetic@example.com");
    expect((await post("save", { site: "https://shop.example", username: "only-a-name", label: "No password" })).json().status).toBe("SAVED");
    expect((await repository.listPending("user:alice"))[1]).toMatchObject({ sealedPassword: null });
    // The two saved logins wait for an unlocked dock: agents and Nous see how many (2026-10-19).
    expect((await post("list", {})).json()).toEqual({ status: "LISTED", auditId: expect.any(String), items: [{ handle, label: "Synthetic", origins: [LOGIN], fields: ["USERNAME", "PASSWORD"] }], pendingItems: 2 });
    expect((await post("status", {})).json()).toMatchObject({ status: "LISTED", agentAccess: true, delegatedItems: 1, pendingItems: 2 });
    const audit = (await post("audit", { limit: 5 })).json();
    expect(audit.entries.map((entry: { action: string; result: string }) => `${entry.action}:${entry.result}`)).toEqual(["AGENT_LIST:LISTED", "AGENT_LIST:LISTED", "ITEM_SAVE:SAVED", "ITEM_SAVE:SAVED"]);
    expect(JSON.stringify(audit)).not.toContain(SENTINEL);
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
    expect(JSON.parse(filled.result)).toEqual({ status: "FILLED", auditId: expect.any(String) });
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
