import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemoryPaneReportsRepository } from "@space/db";
import { accountHold, botCheckHold, vaultReadBackHold, workingSigninHold, type AccountEvidence } from "../src/nous/tools.js";
import { markSignin } from "../src/signin-readback.js";
import { createNousMailContext } from "../src/nous/mail-context.js";
import { createPaneReports } from "../src/pane-reports.js";

// Plan clipboard:1NF6u6gcCwtj step 23 (goal ee5a573e): lablab 6/11, the operator ticked a bot check five times while lablab rejected the
// address and no account existed. A sign-in, bot-check or handoff card waits until mail, a sign-in record or a Vault login shows the account.
const owner = "user:operator";
const lablab = { text: "NEEDS_HANDS\nlablab needs you\nTick the Cloudflare check on the sign-in page", target: "url:https://lablab.build/login" };
const none: AccountEvidence = { mail: async () => false, signins: { list: async () => [] }, vaultLogins: async () => 0 };

describe("accountHold", () => {
  it("refuses the lablab card when nothing shows an account, and tells the agent to check or create it first", async () => {
    const refused = await accountHold(none, owner, lablab);
    expect(refused).toMatch(/^Not raised: nothing shows an account at lablab\.build: no mail with that domain/);
    expect(refused).toMatch(/Check that the account exists, or create it first/);
    expect(refused).toMatch(/Nothing raised\.$/);
    // The site from the card's text when its target is no page.
    expect(await accountHold(none, owner, { text: "Sign in to lablab.build: solve the CAPTCHA", target: "tab:page:1" })).toMatch(/at lablab\.build:/);
  });

  it("passes when mail, a sign-in that worked, a Vault login or `checked` shows the account, or it cannot be told", async () => {
    const record = (successCount: number) => ({ list: async () => [{ site: "lablab.build", successCount }] as never });
    expect(await accountHold({ ...none, mail: async () => true }, owner, lablab)).toBeNull();
    expect(await accountHold({ ...none, signins: record(1) }, owner, lablab)).toBeNull();
    expect(await accountHold({ ...none, signins: record(0) }, owner, lablab)).toMatch(/^Not raised/);
    expect(await accountHold({ ...none, vaultLogins: async () => 1 }, owner, lablab)).toBeNull();
    expect(await accountHold({ ...none, mail: async () => null }, owner, lablab)).toBeNull();
    expect(await accountHold({ ...none, mail: async () => { throw new Error("down"); } }, owner, lablab)).toBeNull();
    expect(await accountHold({ ...none, vaultLogins: undefined }, owner, lablab)).toBeNull();
    expect(await accountHold(none, owner, { ...lablab, checked: ["account exists: created 6/11 with the task's address"] })).toBeNull();
  });

  it("passes a bot check on an applicant tracking system's guest apply page, which needs no account, and a `checked` guest form (7/11 Lever)", async () => {
    const lever = { text: "NEEDS_HANDS\nEva needs you\nTick the hCaptcha on the Portcast application: every field is filled", target: "url:https://jobs.lever.co/portcast/4f1c2a9e-1111-2222-3333-444455556666/apply" };
    expect(await accountHold(none, owner, lever)).toBeNull();
    // The page as a link in the card's text when the target is a tab.
    expect(await accountHold(none, owner, { ...lever, target: "tab:page:3", text: `${lever.text}\nPage: ${lever.target.slice(4)}` })).toBeNull();
    for (const url of ["https://boards.greenhouse.io/acme/jobs/123", "https://job-boards.greenhouse.io/acme/jobs/123", "https://jobs.ashbyhq.com/acme/9f/application",
      "https://apply.workable.com/acme/j/ABC123/apply/", "https://acme.bamboohr.com/careers/42", "https://careers-acme.icims.com/jobs/77/engineer/job",
      "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Engineer_R1/apply"]) {
      expect(await accountHold(none, owner, { ...lever, target: `url:${url}` })).toBeNull();
    }
    // Not an apply page, or no bot check: the account check stays.
    expect(await accountHold(none, owner, { ...lever, target: "url:https://jobs.lever.co/portcast" })).toMatch(/^Not raised: nothing shows an account at lever\.co/);
    expect(await accountHold(none, owner, { ...lever, text: "Sign in to Lever to see your applications" })).toMatch(/^Not raised/);
    expect(await accountHold(none, owner, { ...lever, target: "url:https://jobs.lever.co.evil-ats.com/x/apply" })).toMatch(/^Not raised/);
    // The escape: `checked` names the guest form.
    expect(await accountHold(none, owner, { ...lablab, checked: ["guest form: https://lablab.build/apply"] })).toBeNull();
  });

  it("leaves code cards (mailCodeHold reads those), cards about no sign-in and cards naming no site alone", async () => {
    expect(await accountHold(none, owner, { ...lablab, text: "Sign in to lablab.build: the 6-digit code went to your phone" })).toBeNull();
    expect(await accountHold(none, owner, { ...lablab, text: "Review the design in the open page" })).toBeNull();
    expect(await accountHold(none, owner, { text: "Sign in to the bank app on your phone", target: null })).toBeNull();
  });
});

// 7/11 REVIEW item 1: the operator answered «fill everything, give focus only for the CAPTCHA» on UpCloud, YZi, lablab, Oracle and Vonage cards.
describe("botCheckHold", () => {
  it("refuses a bot-check card until its text or `checked` says every field is filled", () => {
    const oracle = "Oracle Free Tier: πάτα «I am human» στο hCaptcha (και λύσε την εικόνα αν βγει). Τίποτε άλλο· η Kate συνεχίζει μόνη της.";
    expect(botCheckHold({ text: oracle })).toMatch(/^Not raised: a bot check comes last\. Fill every field of the page yourself first/);
    expect(botCheckHold({ text: "Fill in the form and solve the CAPTCHA" })).toMatch(/^Not raised/);
    expect(botCheckHold({ text: "Συμπληρώστε τη φόρμα και λύστε το CAPTCHA" })).toMatch(/^Not raised/);
    expect(botCheckHold({ text: oracle, checked: ["Kate's report 00:58: all 14 fields filled from the Vault, only the CAPTCHA left"] })).toBeNull();
    expect(botCheckHold({ text: "Tick Turnstile: the sign-up form is filled" })).toBeNull();
    expect(botCheckHold({ text: "Λύσε το παζλ· όλα τα πεδία συμπληρώθηκαν" })).toBeNull();
    expect(botCheckHold({ text: "Approve the reply to Acme" })).toBeNull();
  });
});

// nous_msg:fcea1c9e1c704703949edd86 (7/11 Oracle): a sign-in card for a login the Vault holds waits until it was filled and read back.
describe("vaultReadBackHold", () => {
  const oracle = { text: "Oracle sign-in: Invalid username or password, please sign in for Kate", target: "url:https://signon.oracle.com/signin" };
  const evidence = (logins: number | null) => ({ signins: { list: async () => [] }, vaultLogins: async () => logins });
  it("refuses until the stored login was tried and read back, then passes", async () => {
    const who = "user:readback-card";
    expect(await vaultReadBackHold(evidence(1), who, oracle)).toMatch(/^Not raised: The Vault holds the login for oracle\.com .*space_vault_request_fill/);
    markSignin(who, "https://signon.oracle.com/", "tried");
    expect(await vaultReadBackHold(evidence(1), who, oracle)).toMatch(/was filled, but the page after it was never read: call space_browser_page_readout/);
    markSignin(who, "https://signon.oracle.com/", "read", Date.now() + 1);
    expect(await vaultReadBackHold(evidence(1), who, oracle)).toBeNull();
  });
  it("passes with no Vault login or no Vault access, and for what stays the operator's: CAPTCHA, phone push, card", async () => {
    expect(await vaultReadBackHold(evidence(0), owner, oracle)).toBeNull();
    expect(await vaultReadBackHold(evidence(null), owner, oracle)).toBeNull();
    for (const text of ["Oracle sign-in: solve the hCaptcha", "Oracle sign-in: approve the push on your phone", "Oracle login: enter the card details"])
      expect(await vaultReadBackHold(evidence(1), owner, { ...oracle, text }), text).toBeNull();
    expect(await vaultReadBackHold(evidence(1), owner, { ...oracle, text: "Review the Oracle invoice" })).toBeNull();
  });
});

describe("mail context site()", () => {
  it("says whether the connected mailboxes hold mail with a site's domain, null when that cannot be told", async () => {
    const page = (threads: number, errors = 0) => ({ threads: Array.from({ length: threads }, () => ({ account: "a@gmail.com", subject: "Welcome", receivedAt: "2026-11-06" })), errors: Array(errors).fill("x"), nextPageToken: null });
    const threads = vi.fn(async (_owner: string, query: { q: string }) => page(query.q.includes("lablab.build") ? 1 : 0, query.q.includes("broken.example") ? 1 : 0) as never);
    const mail = createNousMailContext({ threads, accounts: async () => ["a@gmail.com", "me@example.invalid"] });
    expect(await mail.site(owner, "lablab.build")).toBe(true);
    expect(await mail.site(owner, "vultr.com")).toBe(false);
    expect(await mail.site(owner, "broken.example")).toBeNull();
    expect(await mail.site(owner, "gmail.com")).toBeNull();
    expect(await mail.site(owner, "oll4.com")).toBeNull();
  });
});

describe("pane reports", () => {
  const room = { id: "room:bruno", ownerUserId: owner } as Room;
  const pane = { id: "pane:andy", roomId: room.id, title: "Andy" } as Pane;
  it("hands an agent's `checked` to the sign-in check, keeps it on the card, and skips the check for a needs-you that clears the ask", async () => {
    const signinCard = vi.fn(async () => null);
    const raise = vi.fn(async (input: unknown) => input as never);
    const reports = createPaneReports({ repository: new InMemoryPaneReportsRepository(), now: () => Date.parse("2026-11-07T00:00:00Z"), lastAnswer: async () => null,
      screen: async () => null, notifications: { raise, resolve: vi.fn(async () => 1) }, signinCard,
      store: { getRoom: async () => room, getPane: async () => pane } as never });
    await reports.report(room, pane, { status: "needs-you", summary: "Sign in to lablab.build", checked: ["account exists: signed up 6/11"] });
    expect(signinCard).toHaveBeenCalledWith(expect.objectContaining({ payload: { checked: ["account exists: signed up 6/11"] } }));
    // The card keeps the list structured too, like Nous's cards.
    expect(raise.mock.calls[0]![0]).toMatchObject({ kind: "NEEDS_YOU", payload: { checked: ["account exists: signed up 6/11"] } });
    await reports.report(room, pane, { status: "needs-you", summary: "Signed in to lablab.build myself", needs: "none" });
    expect(signinCard).toHaveBeenCalledTimes(1);
  });
});

// nous_msg:fe72e061203043b6af2039e9 (Upwork 7/11: Google sign-in fine, a reset asked for an optional address change).
describe("workingSigninHold", () => {
  const upwork = { text: "NEEDS_HANDS\nUpwork needs you\nApprove the password reset link for upwork.com", target: "url:https://www.upwork.com/ab/account-security/reset-password" };
  const records = (method: string, lastSuccessAt: string | null) => ({ list: async () => [{ site: "upwork.com", accountLabel: "main", method, lastSuccessAt }] }) as never;
  it("refuses a reset card while the stored sign-in works, passes with no record or the operator's order", async () => {
    expect(await workingSigninHold(records("GOOGLE", null), owner, upwork)).toMatch(/^Not raised: upwork\.com: Stored sign-in works \(SUCCESS not recorded, method GOOGLE\)\. Sign in with it; a reset needs the operator's explicit order\. Nothing raised\.$/);
    expect(await workingSigninHold(records("VAULT_LOGIN", new Date(Date.now() - 86_400_000).toISOString()), owner, upwork)).toMatch(/method VAULT_LOGIN/);
    expect(await workingSigninHold({ list: async () => [] }, owner, upwork)).toBeNull();
    expect(await workingSigninHold(records("GOOGLE", null), owner, { ...upwork, checked: ["operator order nous_msg:fe72e061203043b6af2039e9"] })).toBeNull();
    // A support message about the password is refused the same way; a sign-in card without a reset is not this guard's.
    expect(await workingSigninHold(records("GOOGLE", null), owner, { text: "Send a support message about my password to upwork.com" })).toMatch(/^Not raised: upwork\.com/);
    expect(await workingSigninHold(records("GOOGLE", null), owner, { text: "Sign in to upwork.com", target: "url:https://www.upwork.com/login" })).toBeNull();
  });
});
