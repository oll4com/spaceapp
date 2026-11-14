import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  generateVaultTransportKey, newVaultHandle, openWithVaultPrivateKey, sealToVaultPublicKey, vaultBase64url, vaultRandomBytes, vaultTotp,
  decodeVaultBase32, type VaultUseClaims
} from "@space/contracts";
import { readVaultTarget, runSealedFill, signupField, type SealedFillBroker, type SealedFillPage } from "../src/vault/sealed-fill.js";
import { VaultBrokerRefusedError } from "../src/vault/broker-client.js";

// Synthetic values only. The page is a real DOM (jsdom) behind a fake CDP: the engine's own fixed scripts run against it,
// Input.insertText types into the focused element, and Page.getFrameTree reports the URL the test chooses.
const SECRET = "SYNTHETIC-sealed-fill-password";
const ORIGIN = "https://login.example";
const BASE32_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890" (RFC 6238 test key)

function fakePage(html: string, options: { url?: string } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `${ORIGIN}/signin` });
  const window = dom.window;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 120, height: 24 }) as DOMRect;
  const submitted = vi.fn();
  // Like the browser's: a scripted requestSubmit fires the form's submit event; `submits` counts the ones no page handler stopped.
  window.HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) { submitted(); this.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); };
  window.addEventListener("submit", (event) => { state.submits++; event.preventDefault(); });
  const state = { url: options.url ?? `${ORIGIN}/signin`, frameId: "frame-1", loaderId: "loader-1", sent: [] as string[], onInsert: null as null | (() => void), focusEmulated: false,
    keys: [] as string[], submits: 0, transition: "typed",
    // A reload gives the top frame a new loader (document); `stuck` is a page that never settles after Page.reload.
    stuck: false, onReload: null as null | (() => void) };
  // Like a pane's Chrome on Xvfb: the window never has focus unless the fill emulates it.
  window.document.hasFocus = () => state.focusEmulated;
  // Chrome types and presses keys in the focused element, also one inside a shadow root.
  const deepActive = () => { let active = window.document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return active as HTMLInputElement | null; };
  const page: SealedFillPage = {
    targetId: "target-1", sessionId: "session-1", paneId: "pane:vault",
    cdp: {
      async send(method: string, params: Record<string, unknown> = {}) {
        state.sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: state.frameId, url: state.url, loaderId: state.loaderId } } } as never;
        if (method === "Page.reload") { if (!state.stuck) { state.loaderId = `loader-${state.sent.filter((sent) => sent === "Page.reload").length + 1}`; state.onReload?.(); } return {} as never; }
        if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 1, url: state.url, transitionType: state.transition }] } as never;
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 } as never;
        if (method === "Input.dispatchKeyEvent") {
          state.keys.push(`${params.type} ${params.key}`);
          const active = deepActive();
          // Chrome's implicit submission: an Enter the page did not cancel clicks the form's default button, else submits the form.
          if (params.type === "keyDown" && params.key === "Enter" && active && active.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })) && active.form) {
            const button = active.form.querySelector<HTMLElement>('button:not([type]),button[type="submit"],input[type="submit"]');
            if (button) button.click(); else active.form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
          }
          return {} as never;
        }
        if (method === "Emulation.setFocusEmulationEnabled") { state.focusEmulated = params.enabled === true; return {} as never; }
        if (method === "Runtime.evaluate") return { result: { value: window.eval(String(params.expression)) } } as never;
        if (method === "Input.insertText") {
          const active = deepActive()!;
          active.value = String(params.text);
          state.onInsert?.();
          return {} as never;
        }
        throw new Error(`unexpected ${method}`);
      }
    }
  };
  return { page, window, state, submitted };
}

async function harness(fields: VaultUseClaims["fields"], overrides: Partial<VaultUseClaims> = {}) {
  const claims: VaultUseClaims = {
    v: 1, kind: "USE", certId: newVaultHandle("vault_delegation"), ownerUserId: "user:alice", vaultId: newVaultHandle("vault"), generation: 1, epoch: 1,
    handle: newVaultHandle("vault_item"), origin: ORIGIN, fields, submit: false, paneId: "pane:vault", targetId: "target-1", pageId: "target-1", frameId: "frame-1",
    nonce: vaultBase64url.encode(vaultRandomBytes(32)), issuedAt: "2026-10-17T11:00:00.000Z", expiresAt: "2026-10-17T13:00:00.000Z", ...overrides
  };
  const opened = vi.fn();
  const broker: SealedFillBroker = {
    verifyUse: async (capability) => { if ((capability as { sig: string }).sig.startsWith("f")) throw new Error("BAD_SIGNATURE"); return claims; },
    openFill: async ({ replyPublicKey }) => {
      opened();
      const secrets = JSON.stringify({ USERNAME: "synthetic@example.com", PASSWORD: SECRET, OTP: BASE32_SEED, ...CARD });
      return sealToVaultPublicKey(vaultBase64url.decode(replyPublicKey), new TextEncoder().encode(secrets), { ownerUserId: claims.ownerUserId, vaultId: claims.vaultId, keyVersion: 1 });
    }
  };
  const envelope = { v: 1, alg: "A256GCM", purpose: "FILL_FIELD", keyVersion: 1, nonce: "A".repeat(16), ct: "B".repeat(40) } as const;
  const request = (mode: "FILL" | "TOTP" | "GENERATE" | "CARD", capability: Record<string, unknown> = {}) => ({
    mode, capability: { claims, sig: "s".repeat(86), keyVersion: 1, ...capability }, keyEnvelope: { ...envelope, purpose: "FILL_KEY" }, fieldEnvelopes: { PASSWORD: envelope }
  });
  return { claims, broker, opened, request };
}

// Stripe's public test number; the rest synthetic.
const CARD = { CARD_NUMBER: "4242424242424242", CARD_EXPIRY: "07/28", CARD_CVC: "123", CARDHOLDER_NAME: "Synthetic Holder" };
const CARD_ROLES = ["CARD_NUMBER", "CARD_EXPIRY", "CARD_CVC", "CARDHOLDER_NAME"] as const;
const STRIPE = '<input name="cardnumber" autocomplete="cc-number"><input name="exp-date" autocomplete="cc-exp" placeholder="MM / YY"><input name="cvc" autocomplete="cc-csc">';

/**
 * A checkout whose card boxes live in a cross-site payment frame (Stripe's js.stripe.com, an OOPIF): Chrome lists it as an
 * iframe target of the page's frame and the fill reaches it through its own session, with its own DOM.
 */
function fakeCheckout(frameHtml: string, options: { topHtml?: string; frameUrl?: string } = {}) {
  const top = fakePage(options.topHtml ?? '<h1>Checkout</h1><form><input id="holder" autocomplete="cc-name"><button>Pay</button></form>');
  const frame = fakePage(frameHtml, { url: options.frameUrl ?? "https://js.stripe.com/v3/elements-inner-card.html" });
  const sent: Array<{ method: string; sessionId?: string }> = [];
  const own = top.page.cdp;
  top.page.cdp = {
    async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
      sent.push({ method, sessionId });
      // Another tab's payment frame is listed too; only this page's frame children are attached.
      if (method === "Target.getTargets") return { targetInfos: [{ targetId: "stripe-frame", type: "iframe", parentFrameId: "frame-1" }, { targetId: "elsewhere", type: "iframe", parentFrameId: "other-tab" }] } as T;
      if (method === "Target.attachToTarget") return { sessionId: `session-${String(params.targetId)}` } as T;
      if (method === "Target.detachFromTarget") return {} as T;
      if (sessionId !== "session-stripe-frame") return own.send<T>(method, params, sessionId);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "stripe-frame", url: frame.state.url } } } as T;
      return frame.page.cdp.send<T>(method, params, sessionId);
    }
  };
  const box = (name: string) => (frame.window.document.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
  return { ...top, frame, sent, box };
}

const LOGIN = '<form><input id="user" autocomplete="username"><input id="pass" type="password" autocomplete="current-password"><button>Sign in</button></form>';
const value = (window: Window, id: string) => (window.document.getElementById(id) as HTMLInputElement).value;
const now = new Date("2026-10-17T12:00:00Z");

describe("Vault sealed fill (Browser Host)", () => {
  it("accepts a broker capability bound to the affiliated GSIS login and still refuses sibling origins", async () => {
    const origin = "https://login.gsis.gr";
    const { broker, request, opened } = await harness(["USERNAME", "PASSWORD"], { origin });
    const allowed = fakePage(LOGIN, { url: `${origin}/mylogin/login.jsp` });
    expect(await runSealedFill(allowed.page, broker, request("FILL"), now)).toMatchObject({ status: "FILLED", typed: true });
    expect(value(allowed.window, "pass")).toBe(SECRET);
    opened.mockClear();
    for (const url of ["https://other.gsis.gr/login", "https://login.gsis.gr.evil.test/login"]) {
      expect(await runSealedFill(fakePage(LOGIN, { url }).page, broker, request("FILL"), now)).toMatchObject({ status: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED", typed: false });
    }
    expect(opened).not.toHaveBeenCalled();
  });

  it("fills username and password at the exact origin and answers only a status", async () => {
    const { page, window, state } = fakePage(LOGIN);
    const { broker, request } = await harness(["USERNAME", "PASSWORD"]);
    const answer = await runSealedFill(page, broker, request("FILL"), now);
    expect(answer).toEqual({ status: "FILLED", reason: null, sealedGenerated: null, typed: true, document: "loader-2", fields: { filled: ["USERNAME", "PASSWORD"], disabled: [] } });
    expect(value(window, "user")).toBe("synthetic@example.com");
    expect(value(window, "pass")).toBe(SECRET);
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    // Every page script ran in the isolated world, and no script ever carried the value.
    expect(state.sent).toContain("Page.createIsolatedWorld");
    // The window had no focus (Xvfb): the fill emulated it only while typing.
    expect(state.sent.filter((method) => method === "Emulation.setFocusEmulationEnabled")).toHaveLength(2);
    expect(state.focusEmulated).toBe(false);
  });

  it("refuses a forged capability, another origin or a page that is no web page before any secret is opened", async () => {
    const { broker, opened, request } = await harness(["PASSWORD"]);
    expect((await runSealedFill(fakePage(LOGIN).page, broker, request("FILL", { sig: "f".repeat(86) }), now)).reason).toBe("CAPABILITY_INVALID");
    expect(await runSealedFill(fakePage(LOGIN, { url: "https://login.example.evil.test/signin" }).page, broker, request("FILL"), now)).toMatchObject({ status: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED" });
    expect(await runSealedFill(fakePage(LOGIN, { url: "about:blank" }).page, broker, request("FILL"), now)).toMatchObject({ status: "BLOCKED", reason: "NO_WEB_ORIGIN" });
    expect(await runSealedFill(fakePage("<form><input id=x></form>").page, broker, request("FILL"), now)).toMatchObject({ reason: "FIELD_NOT_FOUND_AFTER_RELOAD" });
    expect(await runSealedFill(fakePage(LOGIN).page, broker, { ...request("FILL"), selector: "#pass" }, now)).toMatchObject({ reason: "BAD_REQUEST" });
    expect(opened).not.toHaveBeenCalled();
    // A shared Chrome or a second tab no longer refuses (operator decision 2026-10-18): the API fences the filled browser instead.
    expect(await readVaultTarget(fakePage(LOGIN).page)).toEqual({ eligible: true, reason: null, targetId: "target-1", frameId: "frame-1", origin: ORIGIN, document: "loader-1", freshDocument: true, generatePolicy: true, cards: true });
  });

  it("stops and clears what it typed when the page navigates away in the middle", async () => {
    const { page, window, state } = fakePage(LOGIN);
    const { broker, request } = await harness(["USERNAME", "PASSWORD"]);
    state.onInsert = () => { state.url = "https://attacker.test/collect"; };
    const answer = await runSealedFill(page, broker, request("FILL"), now);
    // A value entered the page before the stop: the API keeps the fence (the scrub is best effort).
    expect(answer).toMatchObject({ status: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED", typed: true });
    expect(value(window, "user")).toBe("");
    expect(value(window, "pass")).toBe("");
  });

  it("reloads the page before it looks for fields, so a script left in the document before the fill never sees the value, and reports the new document (Vault review 2026-10-22)", async () => {
    const { page, window, state } = fakePage(LOGIN);
    const { broker, request, opened } = await harness(["USERNAME", "PASSWORD"]);
    // What an agent could have left in the page world before calling the fill: it dies with the document.
    const captured: string[] = [];
    window.document.getElementById("pass")!.addEventListener("input", (event) => captured.push((event.target as HTMLInputElement).value));
    state.onReload = () => { window.document.body.innerHTML = LOGIN; };
    const answer = await runSealedFill(page, broker, request("FILL"), now);
    expect(answer).toMatchObject({ status: "FILLED", typed: true, document: "loader-2" });
    const order = (method: string) => state.sent.indexOf(method);
    expect(order("Page.reload")).toBeGreaterThan(-1);
    expect(order("Page.reload")).toBeLessThan(order("Page.createIsolatedWorld"));
    expect(order("Page.reload")).toBeLessThan(order("Input.insertText"));
    expect(value(window, "pass")).toBe(SECRET);
    expect(captured).toEqual([]);
    // A page that never settles after the reload stops the fill before any secret is opened.
    const stuck = fakePage(LOGIN);
    stuck.state.stuck = true;
    const again = await harness(["PASSWORD"]);
    expect(await runSealedFill(stuck.page, again.broker, again.request("FILL"), now, { reloadTimeoutMs: 300 })).toEqual({ status: "BLOCKED", reason: "NO_FRESH_DOCUMENT", sealedGenerated: null, typed: false, document: null });
    expect(again.opened).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
    // A reload that lands on another origin (a redirect) stops too.
    const moved = fakePage(LOGIN);
    moved.state.onReload = () => { moved.state.url = "https://login.example.evil.test/signin"; };
    expect(await runSealedFill(moved.page, again.broker, again.request("FILL"), now)).toMatchObject({ status: "ORIGIN_MISMATCH", reason: "ORIGIN_CHANGED", typed: false });
  });

  it("fills a document the API knows no agent scripted as it is (freshDocument false), and names a field the reload lost (Vault review 2026-10-22)", async () => {
    // A login that lives in one document (username, Continue, password) keeps its step: no reload, the same document.
    const kept = fakePage(LOGIN);
    const { broker, request } = await harness(["PASSWORD"]);
    const answer = await runSealedFill(kept.page, broker, { ...request("FILL"), freshDocument: false }, now);
    expect(answer).toEqual({ status: "FILLED", reason: null, sealedGenerated: null, typed: true, document: "loader-1", fields: { filled: ["PASSWORD"], disabled: [] } });
    expect(kept.state.sent).not.toContain("Page.reload");
    expect(value(kept.window, "pass")).toBe(SECRET);
    // Without the field the reason says whether a reload came first: the agent then redoes the steps without scripting the page.
    expect((await runSealedFill(fakePage("<form><input id=x></form>").page, broker, { ...request("FILL"), freshDocument: false }, now)).reason).toBe("FIELD_NOT_FOUND");
    expect((await runSealedFill(fakePage("<form><input id=x></form>").page, broker, { ...request("FILL"), freshDocument: true }, now)).reason).toBe("FIELD_NOT_FOUND_AFTER_RELOAD");
    expect((await runSealedFill(fakePage("<form><input id=x></form>").page, broker, request("FILL"), now)).reason).toBe("FIELD_NOT_FOUND_AFTER_RELOAD");
  });

  it("says when a value was typed before a failure, so the fence stays (Vault review 2026-10-22)", async () => {
    const { page, window, state } = fakePage(LOGIN);
    const { broker, request } = await harness(["USERNAME", "PASSWORD"]);
    // After the username went in, a page script makes the password field unusable: the fill stops, and says it typed.
    state.onInsert = () => { (window.document.getElementById("pass") as HTMLInputElement).disabled = true; };
    const answer = await runSealedFill(page, broker, request("FILL"), now);
    expect(answer).toMatchObject({ status: "BLOCKED", reason: "FOCUS_LOST", typed: true, document: "loader-2" });
    expect(value(window, "user")).toBe("");
    // Nothing typed yet: a missing field stops with typed false.
    expect(await runSealedFill(fakePage("<form><input id=x></form>").page, broker, request("FILL"), now)).toMatchObject({ reason: "FIELD_NOT_FOUND_AFTER_RELOAD", typed: false });
  });

  it("fills a login secret kept in a text field named for it when the page has no password field (timologio SubscriptionKey), and only one", async () => {
    const timologio = '<form><input id="UserName" name="UserName" type="text"><input id="VatNumber" name="VatNumber" type="text"><input id="SubscriptionKey" name="SubscriptionKey" type="text"><button>Login</button></form>';
    const { broker, request } = await harness(["USERNAME", "PASSWORD"]);
    const filled = fakePage(timologio);
    expect(await runSealedFill(filled.page, broker, request("FILL"), now)).toMatchObject({ status: "FILLED", typed: true });
    expect(value(filled.window, "UserName")).toBe("synthetic@example.com");
    expect(value(filled.window, "SubscriptionKey")).toBe(SECRET);
    expect(value(filled.window, "VatNumber")).toBe("");
    const password = await harness(["PASSWORD"]);
    const twoSecrets = '<form><input id="SubscriptionKey" type="text"><input name="api_key" type="text"></form>';
    const plain = '<form><input id="UserName" type="text"><input id="VatNumber" type="text"></form>';
    for (const html of [twoSecrets, plain]) {
      expect(await runSealedFill(fakePage(html).page, password.broker, password.request("FILL"), now)).toMatchObject({ reason: "FIELD_NOT_FOUND_AFTER_RELOAD", typed: false });
    }
    expect(password.opened).not.toHaveBeenCalled();
  });

  it("fills a login's only password field even when the site marks it new-password, never a new/confirm pair (Skimlinks Hub, 14/11)", async () => {
    const { broker, request, opened } = await harness(["USERNAME", "PASSWORD"]);
    const skimlinks = fakePage('<form><input id="user" type="email"><input id="pass" type="password" autocomplete="new-password"><button>Log in</button></form>');
    expect(await runSealedFill(skimlinks.page, broker, request("FILL"), now)).toMatchObject({ status: "FILLED", typed: true });
    expect(value(skimlinks.window, "pass")).toBe(SECRET);
    const password = await harness(["PASSWORD"]);
    const pair = fakePage('<form><input id="n1" type="password" autocomplete="new-password"><input id="n2" type="password" autocomplete="new-password"></form>');
    expect(await runSealedFill(pair.page, password.broker, password.request("FILL"), now)).toMatchObject({ reason: "FIELD_NOT_FOUND_AFTER_RELOAD", typed: false });
    expect(value(pair.window, "n1") + value(pair.window, "n2")).toBe("");
    expect(password.opened).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("fills and submits a login whose inputs live in open shadow roots (Reddit's faceplate-text-input, FIELD_NOT_FOUND 13/11)", async () => {
    const { page, window, state } = fakePage('<form id="login"><faceplate-text-input id="login-username"></faceplate-text-input><faceplate-text-input id="login-password"></faceplate-text-input><button>Log In</button></form>');
    const inner = (host: string, html: string) => { const root = window.document.getElementById(host)!.attachShadow({ mode: "open" }); root.innerHTML = html; return root.querySelector("input")!; };
    const user = inner("login-username", '<input type="text" name="username" autocomplete="username webauthn">');
    const pass = inner("login-password", '<input type="password" name="password" autocomplete="current-password">');
    // Like faceplate: the shadow input belongs to no form, so its own Enter handler submits the form around its host.
    pass.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Enter") window.document.getElementById("login")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    const { broker, request } = await harness(["USERNAME", "PASSWORD"], { submit: true });
    expect(await runSealedFill(page, broker, request("FILL"), now)).toMatchObject({ status: "SUBMITTED", reason: null, typed: true, fields: { filled: ["USERNAME", "PASSWORD"] } });
    expect(user.value).toBe("synthetic@example.com");
    expect(pass.value).toBe(SECRET);
    expect(state.keys).toEqual(["keyDown Enter", "keyUp Enter"]);
    expect(state.submits).toBe(1);
  });

  it("submits only when the capability allows it", async () => {
    const plain = fakePage(LOGIN);
    const { broker, request } = await harness(["PASSWORD"]);
    expect((await runSealedFill(plain.page, broker, request("FILL"), now)).status).toBe("FILLED");
    expect(plain.submitted).not.toHaveBeenCalled();
    const allowed = fakePage(LOGIN);
    const submitting = await harness(["PASSWORD"], { submit: true });
    expect((await runSealedFill(allowed.page, submitting.broker, submitting.request("FILL"), now)).status).toBe("SUBMITTED");
    expect(plain.state.keys).toEqual([]);
    expect(allowed.state.keys).toEqual(["keyDown Enter", "keyUp Enter"]);
    expect(allowed.state.submits).toBe(1);
    expect(allowed.submitted).not.toHaveBeenCalled();
  });

  it("submits with a person's Enter, never a scripted requestSubmit the page's own JS does not handle (AWS sign-in 400, 13/11)", async () => {
    // Like AWS sign-in: Next runs the page's own step in its click handler; a submit that reaches the form is the browser's own
    // post, which AWS answered 400 Bad Request.
    const aws = '<form action="/signin" method="post"><input id="user" type="email" autocomplete="username"><button id="next">Next</button></form><p id="step"></p>';
    const { page, window, state, submitted } = fakePage(aws);
    const step = window.document.getElementById("step")!;
    window.document.getElementById("next")!.addEventListener("click", (event) => { event.preventDefault(); step.textContent = "PASSWORD_STEP"; });
    window.document.querySelector("form")!.addEventListener("submit", () => { step.textContent = "400 Bad Request"; });
    const { broker, request } = await harness(["USERNAME"], { submit: true });
    expect(await runSealedFill(page, broker, { ...request("FILL"), freshDocument: false }, now)).toMatchObject({ status: "SUBMITTED", reason: null, typed: true });
    expect(step.textContent).toBe("PASSWORD_STEP");
    expect(state.submits).toBe(0);
    expect(submitted).not.toHaveBeenCalled();
    expect(value(window, "user")).toBe("synthetic@example.com");
    // A field outside any form is typed and left for the agent to press: no key is sent.
    const loose = fakePage('<input id="user" type="email" autocomplete="username">');
    expect(await runSealedFill(loose.page, broker, { ...request("FILL"), freshDocument: false }, now)).toMatchObject({ status: "FILLED", reason: "NO_FORM", typed: true });
    expect(loose.state.keys).toEqual([]);
  });

  it("clicks the one sign-in button of a form Enter cannot submit (DCMnetwork's input type=button, 13/11)", async () => {
    const dcm = '<form id="form" action="send-log-in-link"><input id="user" type="email" autocomplete="username"><input type="button" value="Send login link">'
      + '<input id="login" type="button" value="Log In"></form><p id="step"></p>';
    const { page, window, state } = fakePage(dcm);
    window.document.getElementById("login")!.addEventListener("click", () => { window.document.getElementById("step")!.textContent = "SIGNED_IN"; });
    const { broker, request } = await harness(["USERNAME"], { submit: true });
    expect(await runSealedFill(page, broker, { ...request("FILL"), freshDocument: false }, now)).toMatchObject({ status: "SUBMITTED", reason: null, typed: true });
    expect(window.document.getElementById("step")!.textContent).toBe("SIGNED_IN");
    expect(state.keys).toEqual([]);
    // No button named for signing in (or two of them): typed, nothing pressed, and the agent is told why.
    const vague = fakePage('<form><input id="user" type="email" autocomplete="username"><input type="button" value="Go"></form>');
    expect(await runSealedFill(vague.page, broker, { ...request("FILL"), freshDocument: false }, now)).toMatchObject({ status: "FILLED", reason: "NO_SUBMIT_BUTTON", typed: true });
    expect(vague.state.keys).toEqual([]);
  });

  it("never reloads a dirty page a form submission made, so a sign-in step is not posted again, and fills a clean one as it is (13/11)", async () => {
    const posted = fakePage(LOGIN);
    posted.state.transition = "form_submit";
    const { broker, request, opened } = await harness(["PASSWORD"], { submit: true });
    expect(await runSealedFill(posted.page, broker, request("FILL"), now)).toMatchObject({ status: "BLOCKED", reason: "RELOAD_WOULD_RESUBMIT", typed: false });
    expect(posted.state.sent).not.toContain("Page.reload");
    expect(posted.state.keys).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
    // The same step with no agent script in it (freshDocument false, as on AWS 13/11): no history read, no reload, one Enter.
    posted.state.sent.length = 0;
    expect(await runSealedFill(posted.page, broker, { ...request("FILL"), freshDocument: false }, now)).toMatchObject({ status: "SUBMITTED", typed: true });
    expect(posted.state.sent).not.toContain("Page.reload");
    expect(posted.state.sent).not.toContain("Page.getNavigationHistory");
    expect(posted.state.keys).toEqual(["keyDown Enter", "keyUp Enter"]);
  });

  it("computes the one-time code where it is filled", async () => {
    expect(await vaultTotp(decodeVaultBase32(BASE32_SEED)!, new Date(59_000), { digits: 8 })).toBe("94287082");
    expect(await vaultTotp(decodeVaultBase32(BASE32_SEED)!, new Date(1_111_111_109_000), { digits: 8 })).toBe("07081804");
    const { page, window } = fakePage('<form><input id="otp" autocomplete="one-time-code"></form>');
    const { broker, request } = await harness(["OTP"]);
    expect((await runSealedFill(page, broker, request("TOTP"), now)).status).toBe("FILLED");
    expect(value(window, "otp")).toBe(await vaultTotp(decodeVaultBase32(BASE32_SEED)!, now));
  });

  it("generates a password for the field's rules, fills new and confirm, and seals it only to the inbox key", async () => {
    const inbox = await generateVaultTransportKey();
    const { page, window } = fakePage('<form><input id="n1" type="password" autocomplete="new-password" maxlength="16"><input id="n2" type="password" autocomplete="new-password"></form>');
    const { broker, request, claims } = await harness(["PASSWORD"], { generate: { roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"], inboxPublicKey: vaultBase64url.encode(inbox.publicKey) } });
    const answer = await runSealedFill(page, broker, request("GENERATE"), now);
    expect(answer.status).toBe("FILLED");
    const generated = value(window, "n1");
    expect(generated).toHaveLength(16);
    expect(value(window, "n2")).toBe(generated);
    expect(JSON.stringify(answer)).not.toContain(generated);
    const opened = await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, answer.sealedGenerated, { ownerUserId: claims.ownerUserId, vaultId: claims.vaultId, keyVersion: 1 });
    expect(new TextDecoder().decode(opened)).toBe(generated);
  });

  it("follows the site's stated rules for a generated password and for the sign-up field it gives the broker (queue item 37)", async () => {
    const inbox = await generateVaultTransportKey();
    const { page, window } = fakePage('<form><input id="n1" type="password" autocomplete="new-password" maxlength="64"></form>');
    const { broker, request } = await harness(["PASSWORD"], { generate: { roles: ["NEW_PASSWORD"], inboxPublicKey: vaultBase64url.encode(inbox.publicKey) } });
    expect((await runSealedFill(page, broker, { ...request("GENERATE"), policy: { minLength: 8, maxLength: 18, symbols: "NONE" } }, now)).status).toBe("FILLED");
    expect(value(window, "n1")).toMatch(/^[A-Za-z0-9]{18}$/);
    // Lengths alone keep the broker's old field shape (a broker before its reinstall refuses other keys); symbols add the rest.
    expect(signupField({ minLength: null, maxLength: 64 }, { maxLength: 18 })).toEqual({ minLength: null, maxLength: 18 });
    expect(signupField({ minLength: null, maxLength: 12 }, { maxLength: 18, symbols: "NONE" })).toEqual({ minLength: null, maxLength: 12, symbols: "", requireEachClass: true });
    expect(signupField({ minLength: 6, maxLength: null })).toEqual({ minLength: 6, maxLength: null });
  });

  it("fills a sign-up's Retype Password with the same password, also when the call names only NEW_PASSWORD (SuccessFactors, 30/10)", async () => {
    const inbox = await generateVaultTransportKey();
    const owner = "user:alice", vaultId = newVaultHandle("vault");
    const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
    const password = "SYNTHETIC-signup-Pw-1"; // synthetic test value; gitleaks:allow
    const asked: string[][] = [];
    const broker = { verifyUse: async () => { throw new Error("not used"); }, openFill: async () => { throw new Error("not used"); },
      signup: async (input: Record<string, unknown>) => {
        const roles = input.roles as string[];
        asked.push(roles);
        return { sealedPassword: await sealToVaultPublicKey(inbox.publicKey, new TextEncoder().encode(password), scope),
          sealedFields: await sealToVaultPublicKey(vaultBase64url.decode(String(input.replyPublicKey)), new TextEncoder().encode(JSON.stringify(Object.fromEntries(roles.map((role) => [role, password])))), scope) };
      } } as unknown as SealedFillBroker;
    const certificate = { claims: { v: 1, kind: "SIGNUP_GRANT", grantId: newVaultHandle("vault_grant" as never), ownerUserId: owner, vaultId, sites: [ORIGIN], dailyCap: 3, unlockEpoch: 1,
      issuedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z" }, sig: "s".repeat(86), keyVersion: 1 };
    const request = (roles: string[]) => ({ mode: "SIGNUP", certificate, ownerUserId: owner, vaultId, paneId: "pane:vault", targetId: "target-1", frameId: "frame-1",
      origin: ORIGIN, roles, inboxPublicKey: vaultBase64url.encode(inbox.publicKey), submit: false });
    // Allianz career5's shape: no autocomplete hints, labels only.
    const successFactors = '<form><input id="fbclc_userName" name="username" type="text"><label for="fbclc_pwd">Choose Password</label>' +
      '<input id="fbclc_pwd" name="pwd" type="password" autocomplete="off"><label for="fbclc_pwdConf">Retype Password</label>' +
      '<input id="fbclc_pwdConf" name="pwdConf" type="password" autocomplete="off"><button>Create Account</button></form>';
    for (const roles of [["NEW_PASSWORD"], ["NEW_PASSWORD", "CONFIRM_PASSWORD"]]) {
      const { page, window } = fakePage(successFactors);
      expect(await runSealedFill(page, broker, request(roles))).toMatchObject({ status: "FILLED", typed: true });
      expect(value(window, "fbclc_pwd")).toBe(password);
      expect(value(window, "fbclc_pwdConf")).toBe(password);
      expect(value(window, "fbclc_userName")).toBe("");
    }
    expect(asked).toEqual([["NEW_PASSWORD"], ["NEW_PASSWORD", "CONFIRM_PASSWORD"]]);
    // A single new-password field stays a single fill, and the confirm role never lands in the new field itself.
    const single = fakePage('<form><input id="n1" type="password" autocomplete="new-password"></form>');
    expect((await runSealedFill(single.page, broker, request(["NEW_PASSWORD"]))).status).toBe("FILLED");
    expect(value(single.window, "n1")).toBe(password);
    const change = '<form><input id="old" type="password" autocomplete="current-password"><input id="n1" type="password" autocomplete="new-password"></form>';
    expect((await runSealedFill(fakePage(change).page, broker, request(["NEW_PASSWORD", "CONFIRM_PASSWORD"]))).reason).toBe("FIELD_NOT_FOUND_AFTER_RELOAD");
  });

  it("fills a confirm box the site enables only after the new password passes its rules, and names one still disabled instead of submitting (Oracle, 7/11)", async () => {
    const inbox = await generateVaultTransportKey();
    const generate = (roles: Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD">) => ({ roles, inboxPublicKey: vaultBase64url.encode(inbox.publicKey) });
    const oracle = '<form><input id="n1" type="password" autocomplete="new-password"><input id="n2" type="password" autocomplete="new-password" disabled><button>Change</button></form>';
    const late = fakePage(oracle);
    // The site opens the confirm box a moment after the new password meets its rules.
    late.state.onInsert = () => { if (value(late.window, "n1").length >= 8) setTimeout(() => late.window.document.getElementById("n2")!.removeAttribute("disabled"), 50); };
    const { broker, request } = await harness(["PASSWORD"], { generate: generate(["NEW_PASSWORD"]) });
    expect(await runSealedFill(late.page, broker, request("GENERATE"), now)).toMatchObject({ status: "FILLED", reason: null, typed: true,
      fields: { filled: ["NEW_PASSWORD", "CONFIRM_PASSWORD"], disabled: [] } });
    expect(value(late.window, "n1")).not.toBe("");
    expect(value(late.window, "n2")).toBe(value(late.window, "n1"));
    // A box the site never opens: the new password stays typed, the answer names the empty box and the form is not submitted.
    const shut = fakePage(oracle);
    const submitting = await harness(["PASSWORD"], { submit: true, generate: generate(["NEW_PASSWORD", "CONFIRM_PASSWORD"]) });
    expect(await runSealedFill(shut.page, submitting.broker, submitting.request("GENERATE"), now, { lateFieldWaitMs: 200 })).toMatchObject({ status: "FILLED",
      reason: "FIELD_DISABLED", typed: true, fields: { filled: ["NEW_PASSWORD"], disabled: ["CONFIRM_PASSWORD"] } });
    expect(value(shut.window, "n1")).not.toBe("");
    expect(value(shut.window, "n2")).toBe("");
    expect(shut.submitted).not.toHaveBeenCalled();
  });

  it("NEW_ACCOUNT: fills the broker's generated password at the bound origin and returns it only sealed to the inbox", async () => {
    const inbox = await generateVaultTransportKey();
    const owner = "user:alice", vaultId = newVaultHandle("vault");
    const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
    const asked: Array<Record<string, unknown>> = [];
    let refuse: string | null = null;
    let password = "";
    const broker = { verifyUse: async () => { throw new Error("not used"); }, openFill: async () => { throw new Error("not used"); },
      signup: async (input: Record<string, unknown>) => {
        asked.push(input);
        if (refuse) throw new VaultBrokerRefusedError(refuse);
        password = "G".repeat(Number((input.field as { maxLength: number | null }).maxLength ?? 24));
        const roles = input.roles as string[];
        return { sealedPassword: await sealToVaultPublicKey(inbox.publicKey, new TextEncoder().encode(password), scope),
          sealedFields: await sealToVaultPublicKey(vaultBase64url.decode(String(input.replyPublicKey)), new TextEncoder().encode(JSON.stringify(Object.fromEntries(roles.map((role) => [role, password])))), scope) };
      } } as unknown as SealedFillBroker;
    const form = '<form><input id="n1" type="password" autocomplete="new-password" maxlength="14"><input id="n2" type="password" autocomplete="new-password"></form>';
    const request = (overrides: Record<string, unknown> = {}) => ({ mode: "SIGNUP", certificate: { claims: { v: 1 }, sig: "s".repeat(86), keyVersion: 1 }, ownerUserId: owner, vaultId,
      paneId: "pane:vault", targetId: "target-1", frameId: "frame-1", origin: ORIGIN, roles: ["NEW_PASSWORD", "CONFIRM_PASSWORD"], inboxPublicKey: vaultBase64url.encode(inbox.publicKey), submit: false, ...overrides });
    const certificate = { claims: { v: 1, kind: "SIGNUP_GRANT", grantId: newVaultHandle("vault_grant" as never), ownerUserId: owner, vaultId, sites: [ORIGIN], dailyCap: 3, unlockEpoch: 1,
      issuedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z" }, sig: "s".repeat(86), keyVersion: 1 };

    const { page, window } = fakePage(form);
    const answer = await runSealedFill(page, broker, request({ certificate }));
    expect(answer.status).toBe("FILLED");
    expect(value(window, "n1")).toBe(password);
    expect(value(window, "n2")).toBe(password);
    expect(password).toHaveLength(14);
    expect(asked[0]).toMatchObject({ origin: ORIGIN, paneId: "pane:vault", field: { minLength: null, maxLength: 14 } });
    expect(JSON.stringify(answer)).not.toContain(password);
    expect(new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, answer.sealedGenerated, scope))).toBe(password);

    // Another page, pane or a missing field stops before the broker is asked; a broker refusal comes back as its code.
    const moved = fakePage(form, { url: "https://evil.example/signup" });
    expect((await runSealedFill(moved.page, broker, request({ certificate }))).status).toBe("ORIGIN_MISMATCH");
    expect((await runSealedFill(fakePage(form).page, broker, request({ certificate, paneId: "pane:other" }))).reason).toBe("PANE_MISMATCH");
    expect((await runSealedFill(fakePage(LOGIN).page, broker, request({ certificate }))).reason).toBe("FIELD_NOT_FOUND_AFTER_RELOAD");
    expect((await runSealedFill(fakePage(LOGIN).page, broker, request({ certificate, freshDocument: false }))).reason).toBe("FIELD_NOT_FOUND");
    expect(asked).toHaveLength(1);
    refuse = "DAILY_CAP";
    const capped = fakePage(form);
    expect(await runSealedFill(capped.page, broker, request({ certificate }))).toEqual({ status: "BLOCKED", reason: "DAILY_CAP", sealedGenerated: null, typed: false, document: "loader-2" });
    expect(value(capped.window, "n1")).toBe("");
  });

  it("fills a card in the checkout's cross-site payment frame, never submits it and answers no digit (plan clipboard:qf0P640vyLp2)", async () => {
    const checkout = fakeCheckout(STRIPE);
    // Like Stripe, the frame groups the number as it is typed: the check counts digits.
    checkout.frame.state.onInsert = () => { const el = checkout.frame.window.document.activeElement as HTMLInputElement;
      if (el.name === "cardnumber") el.value = el.value.replace(/(\d{4})(?=\d)/g, "$1 "); };
    const { broker, request } = await harness([...CARD_ROLES], { submit: true });
    const answer = await runSealedFill(checkout.page, broker, request("CARD"), now);
    expect(answer).toEqual({ status: "FILLED", reason: null, sealedGenerated: null, typed: true, document: "loader-2", fields: { filled: [...CARD_ROLES], disabled: [] } });
    expect(checkout.box("cardnumber")).toBe("4242 4242 4242 4242");
    expect(checkout.box("exp-date")).toBe("07/28");
    expect(checkout.box("cvc")).toBe("123");
    expect(value(checkout.window, "holder")).toBe("Synthetic Holder");
    expect(checkout.submitted).not.toHaveBeenCalled();
    for (const secret of Object.values(CARD)) expect(JSON.stringify(answer)).not.toContain(secret);
    // Typed through the frame's own session, focus emulated there too; only this page's frame attached, and detached after.
    expect(checkout.sent).toContainEqual({ method: "Input.insertText", sessionId: "session-stripe-frame" });
    expect(checkout.sent).toContainEqual({ method: "Emulation.setFocusEmulationEnabled", sessionId: "session-stripe-frame" });
    expect(checkout.sent.filter((call) => call.method === "Target.attachToTarget")).toHaveLength(1);
    expect(checkout.sent.at(-1)).toEqual({ method: "Target.detachFromTarget" });
    expect(checkout.frame.state.focusEmulated).toBe(false);
  });

  it("types a card expiry kept in two boxes as month and year, as the boxes ask", async () => {
    const checkout = fakeCheckout('<input id="number" name="cardNumber"><input id="month" name="expMonth" maxlength="2"><input id="year" name="expYear" placeholder="YYYY"><input id="cvv" name="cvv">');
    const { broker, request } = await harness(["CARD_NUMBER", "CARD_EXPIRY", "CARD_CVC"]);
    expect(await runSealedFill(checkout.page, broker, request("CARD"), now)).toMatchObject({ status: "FILLED", fields: { filled: ["CARD_NUMBER", "CARD_EXPIRY", "CARD_CVC"], disabled: [] } });
    expect([value(checkout.frame.window, "month"), value(checkout.frame.window, "year"), value(checkout.frame.window, "cvv")]).toEqual(["07", "2028", "123"]);
  });

  it("keeps cards and logins apart and finds no card outside an https frame, before the broker opens anything", async () => {
    const { broker, request, opened } = await harness([...CARD_ROLES]);
    expect(await runSealedFill(fakeCheckout(STRIPE).page, broker, request("FILL"), now)).toMatchObject({ status: "BLOCKED", reason: "MODE_MISMATCH" });
    const login = await harness(["USERNAME", "PASSWORD"]);
    expect(await runSealedFill(fakePage(LOGIN).page, login.broker, login.request("CARD"), now)).toMatchObject({ status: "BLOCKED", reason: "MODE_MISMATCH" });
    const plain = fakeCheckout(STRIPE, { frameUrl: "http://pay.example/card" });
    expect(await runSealedFill(plain.page, broker, request("CARD"), now)).toMatchObject({ status: "BLOCKED", reason: "FIELD_NOT_FOUND_AFTER_RELOAD", typed: false });
    expect(plain.box("cardnumber")).toBe("");
    expect(opened).not.toHaveBeenCalled();
    expect(login.opened).not.toHaveBeenCalled();
  });
});
