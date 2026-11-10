import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SiteSignin } from "@space/contracts";
import { maskReadoutPath, maskReadoutText, pageReadout } from "../src/browser-page-readout.js";
import { markSignin, readBackMissing, RESET_ASK, RESET_URL, RESET_WAIT_MS, resetHold, resetRefusal, VAULT_RESET_REASON, WORKING_SIGNIN_MS } from "../src/signin-readback.js";

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
  it("knows reset asks and reset pages", () => {
    for (const text of ["Forgot password link", "reset the password", "account recovery", "Επαναφορά κωδικού"]) expect(RESET_ASK.test(text)).toBe(true);
    expect(RESET_ASK.test("Sign in with Google")).toBe(false);
    expect(RESET_URL.test("https://www.upwork.com/ab/account-security/reset-password")).toBe(true);
    expect(RESET_URL.test("https://www.reddit.com/password")).toBe(false);
    expect(RESET_URL.test("https://www.upwork.com/ab/account-security/login")).toBe(false);
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
