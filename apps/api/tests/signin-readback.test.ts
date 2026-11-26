import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SiteSignin } from "@space/contracts";
import { JSDOM } from "jsdom";
import { authenticatorCodeAsk, FORMS_SCRIPT, mailCodeAsk, maskReadoutPath, maskReadoutText, pageReadout } from "../src/browser-page-readout.js";
import { DEVICE_APPROVAL, markSignin, namedAccounts, otpSwapDoneHold, VAULT_OTP_SWAP_REASON, readBackMissing, RESET_ASK, RESET_URL, RESET_WAIT_MS, resetHold, resetRefusal, VAULT_RESET_REASON, vaultSigninHold, WORKING_SIGNIN_MS } from "../src/signin-readback.js";

// nous_msg:fcea1c9e1c704703949edd86 (7/11 Oracle): reset after reset, Sign In pressed blind. Synthetic values only.
const site = "https://signon.oracle.com/";
const reset = (at: number) => ({ site: "oracle.com", accountLabel: "main", history: [{ at: new Date(at).toISOString(), by: "cli:x", outcome: "CHANGED", changes: {}, reason: VAULT_RESET_REASON }] }) as unknown as SiteSignin;

describe("resetHold", () => {
  it("refuses a new reset while the last one is fresh or was not tried and read back, and allows it after both", () => {
    const owner = "user:reset-hold";
    const t0 = Date.now() - RESET_WAIT_MS - 1_000;
    expect(resetHold(owner, site, null)).toBeNull();
    expect(resetHold(owner, site, reset(Date.now()))).toBe("RESET_PENDING");
    expect(resetHold(owner, site, reset(t0))).toBe("RESET_PENDING");
    markSignin(owner, site, "tried", t0 + 1);
    expect(readBackMissing(owner, site, reset(t0))).toBe("READ");
    expect(resetHold(owner, site, reset(t0))).toBe("RESET_PENDING");
    markSignin(owner, site, "read", t0 + 2);
    expect(resetHold(owner, site, reset(t0))).toBeNull();
    // A fill before the reset does not count for it.
    expect(readBackMissing(owner, site, reset(t0 + 5))).toBe("FILL");
  });
});

// 20/11 (Cody, Marketing Copilot): a LOGIN handoff for info@example.invalid at google.com was held because the Vault held four OTHER
// google.com accounts; filling one signs in the wrong account. Synthetic accounts only.
describe("vaultSigninHold and the account the ask names", () => {
  const others = [{ label: "Gmail SpaceApp", account: "space.synthetic@gmail.com" }, { label: "operator-synthetic" }, { label: "seed S1" }];
  it("holds only for a stored login of the named account, and as before when no account is named", async () => {
    const owner = "user:readback-named";
    const ask = (reason: string, page?: string | null) => namedAccounts(reason, page);
    expect(ask("Sign in to Google as Info@Olla.example for Reddit", null)).toEqual(["info@olla.example"]);
    // Only other accounts' logins: no read-back step, the handoff goes to the operator.
    expect(await vaultSigninHold(owner, "google.com", null, async () => others, ask("Sign in to Google as info@olla.example"))).toBeNull();
    // The sign-in page's own hint names the account too.
    expect(await vaultSigninHold(owner, "google.com", null, async () => others, ask("Google sign-in", "info@olla.example"))).toBeNull();
    // A matching login (label, Google account or user name) not tried yet: fill and read back first.
    for (const login of [{ label: "INFO@olla.example" }, { label: "Google", account: "info@olla.example" }, { label: "info (olla)" }]) {
      expect(await vaultSigninHold(owner, "google.com", null, async () => [...others, login], ask("Sign in as info@olla.example"))).toContain("space_vault_request_fill");
    }
    // The site record's Vault login counts only when it is the named account's.
    const record = (email: string) => ({ site: "google.com", accountLabel: "main", method: "VAULT_LOGIN", vaultHandle: "vault_item:synthetic01", siteAccountEmail: email, history: [] }) as unknown as SiteSignin;
    expect(await vaultSigninHold(owner, "google.com", record("other@olla.example"), async () => [], ask("as info@olla.example"))).toBeNull();
    expect(await vaultSigninHold(owner, "google.com", record("info@olla.example"), async () => [], ask("as info@olla.example"))).toContain("space_vault_request_fill");
    // No account named: any stored login holds, as before.
    expect(await vaultSigninHold(owner, "google.com", null, async () => others, ask("Invalid username or password"))).toContain("space_vault_request_fill");
    expect(await vaultSigninHold(owner, "google.com", null, async () => 2, [])).toContain("space_vault_request_fill");
    // Agent access off (not known): passes, as before.
    expect(await vaultSigninHold(owner, "google.com", null, async () => null, ask("as info@olla.example"))).toBeNull();
  });
});

// nous_msg:fe72e061203043b6af2039e9 (Reddit 2/11, Oracle 7/11, Upwork 7/11): no reset while the stored sign-in works.
describe("resetRefusal", () => {
  const now = Date.parse("2026-11-07T08:00:00.000Z");
  const record = (method: string, lastSuccessAt: string | null) => ({ site: "upwork.com", accountLabel: "main", method, lastSuccessAt, history: [] }) as unknown as SiteSignin;
  it("refuses with a SUCCESS in the last 30 days or a Google/SSO method, allows with no record, an old success or the operator's order", () => {
    expect(resetRefusal(record("VAULT_LOGIN", "2026-11-01T10:00:00.000Z"), null, now).refusal)
      .toBe("Stored sign-in works (SUCCESS 2026-11-01, method VAULT_LOGIN). Sign in with it; a reset needs the operator's explicit order.");
    expect(resetRefusal(record("GOOGLE", null), null, now).refusal).toBe("Stored sign-in works (SUCCESS not recorded, method GOOGLE). Sign in with it; a reset needs the operator's explicit order.");
    expect(resetRefusal(null, null, now)).toEqual({ refusal: null, override: null });
    expect(resetRefusal(record("VAULT_LOGIN", new Date(now - WORKING_SIGNIN_MS - 1).toISOString()), null, now).refusal).toBeNull();
    expect(resetRefusal(record("GOOGLE", null), "nous_msg:fe72e061203043b6af2039e9", now)).toEqual({ refusal: null, override: "nous_msg:fe72e061203043b6af2039e9" });
    // A malformed order is no order.
    expect(resetRefusal(record("GOOGLE", null), "please", now).refusal).not.toBeNull();
  });
  it("allows the ask when a failure is newer than the last success (civo.com 26/11), keeps password-less methods working", () => {
    const failed = (method: string) => ({ ...record(method, "2026-11-01T10:49:00.000Z"), lastFailureAt: "2026-11-06T12:44:00.000Z" }) as SiteSignin;
    expect(resetRefusal(failed("VAULT_LOGIN"), null, now).refusal).toBeNull();
    expect(resetRefusal(failed("GOOGLE"), null, now).refusal).not.toBeNull();
    expect(resetRefusal({ ...failed("VAULT_LOGIN"), lastFailureAt: "2026-10-30T00:00:00.000Z" }, null, now).refusal).not.toBeNull();
  });
  it("knows reset asks and reset pages", () => {
    for (const text of ["Forgot password link", "reset the password", "account recovery", "Επαναφορά κωδικού"]) expect(RESET_ASK.test(text)).toBe(true);
    expect(RESET_ASK.test("Sign in with Google")).toBe(false);
    expect(RESET_URL.test("https://www.upwork.com/ab/account-security/reset-password")).toBe(true);
    expect(RESET_URL.test("https://www.reddit.com/password")).toBe(false);
    expect(RESET_URL.test("https://www.upwork.com/ab/account-security/login")).toBe(false);
  });
});

describe("mail code or authenticator code", () => {
  it("reads an app code under a sign-in form's Email label as the app's, a code sent to the mailbox as mail (19/11 Braintrust)", () => {
    const braintrust = "Sign in\nEmail\nPassword\n2-step authentication\nEnter the 6-digit code generated by your authenticator app.\nUse backup code instead";
    expect(mailCodeAsk(braintrust)).toBe(false);
    expect(authenticatorCodeAsk(braintrust)).toBe(true);
    const upcloud = "Verify your email\nWe have sent a verification code to a•••@example.invalid. Enter the code below to continue.";
    expect(mailCodeAsk(upcloud)).toBe(true);
    expect(authenticatorCodeAsk(upcloud)).toBe(false);
    // Both routes offered: the mailbox one is the agent's.
    const both = "Enter the code from your authenticator app, or we can send a code to your email.";
    expect(mailCodeAsk(both)).toBe(true);
    expect(authenticatorCodeAsk(both)).toBe(false);
    expect(mailCodeAsk("Enter the code we sent by SMS to your phone. Email: a@b.c")).toBe(false);
  });
});

describe("masked readout", () => {
  it("keeps the message and masks words that could be a secret, token or code", () => {
    expect(maskReadoutText("Invalid username or password.")).toBe("Invalid username or password.");
    expect(maskReadoutText("Your code is 482913.")).toBe("Your code is •••");
    expect(maskReadoutText("Temporary password: Xk#9pLm2q!")).toBe("Temporary password: •••");
    expect(maskReadoutPath("/reset/a8F3kLq9Zt0p/confirm")).toBe("/reset/•••/confirm");
    expect(maskReadoutPath("/signin")).toBe("/signin");
  });

  it("reads the active tab through a fixed script in an isolated world and masks what it returns", async () => {
    const sent: string[] = [];
    const client = { close: () => undefined, send: async (method: string) => {
      sent.push(method);
      if (method === "Target.attachToTarget") return { sessionId: "s1" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.evaluate") return { result: { value: { host: "signon.oracle.com", path: "/signin/t0k3nAbc99", title: "Sign In", messages: ["Invalid username or password.", "Invalid username or password."] } } };
      return {};
    } };
    const pane = { id: "pane:x", roomId: "room:x" } as never;
    const profile = await mkdtemp(join(tmpdir(), "space-readout-"));
    await writeFile(join(profile, "DevToolsActivePort"), "9222\n/devtools/browser/fake\n");
    const session = { activePageId: "p1", pages: [{ pageId: "p1" }], profilePath: profile } as never;
    const readout = await pageReadout({ config: { browserSessionsProfileRoot: profile }, pane, session }, async () => client as never).finally(() => rm(profile, { recursive: true }));
    expect(readout).toMatchObject({ host: "signon.oracle.com", path: "/signin/•••", title: "Sign In", messages: ["Invalid username or password."] });
    expect(sent).toContain("Target.detachFromTarget");
  });
});

// Plan clipboard:nsWKwUFhUFWA slice 5: the form controls instead of the whole page; secret-like fields say only whether they are filled.
describe("page forms", () => {
  it("lists visible controls with labels, values and click points, never a secret field's value", () => {
    const dom = new JSDOM(`<form>
      <label for="n">Full name</label><input id="n" name="name" required value="Ada Lovelace">
      <input type="hidden" name="csrf" value="tok123456">
      <label>Password <input type="password" name="pw" value="Xk#9pLm2q!"></label>
      <input name="code" autocomplete="one-time-code" value="">
      <select name="country" aria-label="Country"><option>Greece</option><option selected>Thailand</option></select>
      <label><input type="checkbox" name="consent" checked> I agree</label>
      <select name="cc-exp-month" autocomplete="cc-exp-month" aria-label="Expiry month"><option value="">MM</option><option value="07" selected>07</option></select>
      <input type="text" name="gone" style="display:none" value="x">
      <button type="submit">Submit application</button>
    </form>`, { runScripts: "outside-only" });
    const { window } = dom;
    Object.defineProperty(window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
    window.Element.prototype.getBoundingClientRect = function () { return { left: 10, top: 20, width: this.style.display === "none" ? 0 : 100, height: 30 } as DOMRect; };
    const result = window.eval(FORMS_SCRIPT) as { controls: Array<Record<string, unknown>> };
    expect(result.controls).toEqual([
      { type: "text", label: "Full name", name: "name", x: 60, y: 35, required: true, value: "Ada Lovelace" },
      { type: "password", label: "Password", name: "pw", x: 60, y: 35, filled: true },
      { type: "text", label: "", name: "code", x: 60, y: 35, filled: false },
      { type: "select", label: "Country", name: "country", x: 60, y: 35, options: ["Greece", "Thailand"], selected: ["Thailand"] },
      { type: "checkbox", label: "I agree", name: "consent", x: 60, y: 35, checked: true },
      { type: "select", label: "Expiry month", name: "cc-exp-month", x: 60, y: 35, filled: true },
      { type: "button", label: "", name: "", x: 60, y: 35, text: "Submit application" }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Xk#9|tok123/);
  });
});

// nous_msg:e3d9b230 (20/11 Braintrust): an authenticator swap reported done with the key saved and the site's 2FA change never proven.
describe("otpSwapDoneHold", () => {
  const event = (by: string, outcome: string, reason: string | null = null) => ({ at: new Date().toISOString(), by, outcome, changes: {}, reason });
  const record = (...history: ReturnType<typeof event>[]) => ({ site: "braintrust.example", accountLabel: "main", history }) as unknown as SiteSignin;
  const swap = event("TERMINAL:pane:a", "CHANGED", VAULT_OTP_SWAP_REASON);
  it("refuses the swapping pane's done until a Vault login submitted after the swap is followed by a non-operator SUCCESS", () => {
    expect(otpSwapDoneHold([record(swap)], "pane:a")).toContain("braintrust.example");
    expect(otpSwapDoneHold([record(swap)], "pane:b")).toBeNull();
    // The operator's handoff signed in with their own code: no proof of the Vault key.
    expect(otpSwapDoneHold([record(swap, event("BROWSER:pane:x", "PENDING"), event("OPERATOR:browser_handoff:1", "SUCCESS"))], "pane:a")).not.toBeNull();
    // A SUCCESS without a Vault login after the swap (still signed in) proves nothing either.
    expect(otpSwapDoneHold([record(swap, event("TERMINAL:pane:a", "SUCCESS"))], "pane:a")).not.toBeNull();
    expect(otpSwapDoneHold([record(swap, event("BROWSER:pane:x", "PENDING"), event("TERMINAL:pane:a", "SUCCESS"))], "pane:a")).toBeNull();
    expect(otpSwapDoneHold([record(event("BROWSER:pane:x", "PENDING"), event("TERMINAL:pane:a", "SUCCESS"))], "pane:a")).toBeNull();
  });
});

describe("DEVICE_APPROVAL", () => {
  it("is a CLI web-auth approval, not any card naming a CLI and a sign-in (DEV3D-037)", () => {
    for (const text of ["Approve the npm CLI web login with your YubiKey", "the CLI web-auth link /login/cli/abc", "Approve the CLI webauth request"]) expect(DEVICE_APPROVAL.test(text)).toBe(true);
    for (const text of ["The CLI pane needs you to sign in to x.com", "The CLI could not sign in with the stored password", "Open the Space CLI pane and authorize the deploy"]) expect(DEVICE_APPROVAL.test(text)).toBe(false);
  });
});
