import { describe, expect, it } from "vitest";
import type { NotificationRaiseInput, SpaceNotification } from "@space/contracts";
import { focusNeedHold, type ChallengeAttempt } from "../src/nous/focus-need.js";

// Operator rule 13/11 11:21 BKK (nous_msg:83c0acb8): focus only for a CAPTCHA the internal solver cannot pass or data the agent cannot know.
const now = Date.parse("2026-11-13T05:00:00Z");
const agentCard = (body: string, extra: Partial<NotificationRaiseInput> = {}, payload: Record<string, unknown> = {}): NotificationRaiseInput => ({
  ownerUserId: "user:operator", roomId: "room:a", paneId: "pane:cli", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", title: "Jack needs you",
  body, link: { roomId: "room:a", paneId: "pane:cli", target: "url:https://signup.example.com/register" }, dedupeKey: null, telegram: null, payload, ...extra });
const nousCard = (items: Array<Record<string, unknown>>, checked: string[] = []): NotificationRaiseInput => ({
  ...agentCard(""), source: "NOUS", kind: "NEEDS_HANDS", title: "Jack needs you", payload: { items, checked } });
const attempt = (status: string, at = "2026-11-13T04:50:00Z", url = "https://signup.example.com/register"): ChallengeAttempt => ({ solver: "hCaptcha", status, pageId: "page-1", url, at });
const hold = (input: NotificationRaiseInput, latest: ChallengeAttempt | null = null, cards: SpaceNotification[] = []) =>
  focusNeedHold({ latestAttempt: async () => latest, agentCards: async () => cards, now: () => now }, input);

describe("focusNeedHold", () => {
  it("(a) passes a CAPTCHA card only after the solver ran on that page and could not pass it", async () => {
    const captcha = agentCard("All fields filled. The hCaptcha is left.\nSolve the captcha");
    expect(await hold(captcha)).toMatch(/no internal solver ran.*space_browser_hcaptcha/);
    expect(await hold(captcha, attempt("BLOCKED", "2026-11-13T04:00:00Z"))).toMatch(/no internal solver ran/); // stale run
    expect(await hold(captcha, attempt("BLOCKED", undefined, "https://other.example.org/"))).toMatch(/no internal solver ran/); // another page
    expect(await hold(captcha, attempt("CLEARED"))).toMatch(/answered CLEARED/);
    expect(await hold(captcha, attempt("IMAGE_CHALLENGE"))).toMatch(/Finish its loop/);
    expect(await hold(agentCard(captcha.body, {}, { checked: ["solver failed: 3 verifications, still images"] }), attempt("IMAGE_CHALLENGE"))).toBeNull();
    expect(await hold(captcha, attempt("BLOCKED"))).toBeNull();
  });

  it("(b) passes a data card only for data the agent cannot get, and a card number only at the card field", async () => {
    expect(await hold(agentCard("Checkout needs the card number and CVC"))).toMatch(/card is asked at its field/);
    expect(await hold(agentCard("Checkout needs the card number and CVC", {}, { checked: ["at the card form: Stripe card fields open, $20"] }))).toBeNull();
    const phone = agentCard("The form needs your phone number");
    expect(await hold(phone)).toMatch(/Search the Vault, mail, Space Memory/);
    expect(await hold(agentCard(phone.body, {}, { checked: ["Vault: no phone item", "mail: none in 90 days"] }))).toMatch(/Search Space Memory for it/);
    expect(await hold(agentCard(phone.body, {}, { checked: ["Vault: no phone item", "mail: none", "Space Memory: none"] }))).toBeNull();
  });

  it("(b) refuses a card entry while the Vault holds a card the agent can fill; the 3-D Secure approval passes (13/11 nous_msg:40c57252 Cartesia)", async () => {
    const vault = (cards: number | null) => (input: NotificationRaiseInput) =>
      focusNeedHold({ latestAttempt: async () => null, agentCards: async () => [], vaultCards: async () => cards, now: () => now }, input);
    const cartesia = agentCard("Enter a card on Cartesia checkout (due today $0.00; overage above 8M chars/month would be charged to it)?", {}, { checked: ["at the card form: Stripe card fields open"] });
    expect(await vault(1)(cartesia)).toMatch(/Vault holds the operator's card.*space_vault_card_fill/);
    // No card in the Vault, or no list to tell: the card field is the operator's, as before.
    expect(await vault(0)(cartesia)).toBeNull();
    expect(await vault(null)(cartesia)).toBeNull();
    expect(await hold(cartesia)).toBeNull();
    // The fill ran (or was refused): the bank approval or the fallback passes.
    expect(await vault(1)(agentCard("Approve in the Revolut app: Cartesia checkout, $0.00. Nothing to type.", {}, { checked: ["card fields filled from the Vault on the final checkout page, Pay pressed", "total $0.00 verified"] }))).toBeNull();
    expect(await vault(1)(agentCard(cartesia.body, {}, { checked: ["at the card form: Stripe fields open", "space_vault_card_fill: BLOCKED CARD_NEEDS_HOST_RESTART"] }))).toBeNull();
    expect(await vault(1)(agentCard("Approve the 3-D Secure charge at the checkout, $5", {}, { checked: ["at the card form: Pay pressed, $5 verified"] }))).toBeNull();
  });

  it("(c) refuses steps for the operator and focus scheduled for a time of day", async () => {
    expect(await hold(nousCard([{ text: "Sign in to Cartesia", steps: ["Open https://play.cartesia.ai", "Sign in with Google"] }]))).toMatch(/no steps for the operator/);
    expect(await hold(agentCard("Please: 1. Open the dashboard 2. Click Billing 3. Copy the key"))).toMatch(/no steps for the operator/);
    expect(await hold(agentCard("Done: 1. Opened the dashboard 2. Clicked Billing. The key needs your approval on the site."))).toBeNull();
    expect(await hold(agentCard("When can I bring you to the pane for the approval?"))).toMatch(/never scheduled for a time of day/);
    expect(await hold(agentCard("The approval waits", {}, { options: ["Now", "Tonight at 20:00"] }))).toMatch(/never scheduled/);
    expect(await hold(nousCard([{ text: "Approve the login", options: ["Now", "Tomorrow morning"] }]))).toMatch(/never scheduled/);
    expect(await hold(nousCard([{ text: "Approve the login", options: ["Now", "Tomorrow morning"] }], ["operator order nous_msg:83c0acb8abc"]))).toBeNull();
  });

  it("(d) raises nothing new for what the operator answered on the pane", async () => {
    const answered = { ...agentCard("Approve the Upwork 2FA request for work@example.invalid on the phone"), id: "notification:1", status: "ACKED", createdAt: "2026-11-13T04:10:00Z",
      payload: { answer: { text: "I approved it", at: "2026-11-13T04:20:00Z", routed: true } } } as unknown as SpaceNotification;
    const again = agentCard("Approve the Upwork 2FA request for work@example.invalid on the phone again");
    expect(await hold(again, null, [answered])).toMatch(/answered this at 04:20 UTC: "I approved it"/);
    expect(await hold(agentCard(again.body, {}, { checked: ["since the answer: the site asked a second time at 04:55"] }), null, [answered])).toBeNull();
    expect(await hold(again, null, [{ ...answered, payload: { answer: { text: "I approved it", at: "2026-11-13T01:00:00Z", routed: true } } } as SpaceNotification])).toBeNull();
  });

  it("(c) refuses a card that asks whether the operator is ready (13/11 lessons-hands-cards-ready-now: Link SpaceApp, npm key, pairing QR)", async () => {
    expect(await hold(agentCard("Είσαι έτοιμος τώρα να πατήσεις Link SpaceApp στο stable μέσα σε 2 λεπτά;"))).toMatch(/never asks whether the operator is ready/);
    expect(await hold(agentCard("Είσαι έτοιμος τώρα να σαρώσεις το QR σύζευξης με τη Nous (ισχύει 120 δευτερόλεπτα);"))).toMatch(/never asks whether/);
    expect(await hold(agentCard("Ready now to approve the npm sign-in with your security key? Cody makes a fresh link the moment you answer."))).toMatch(/never asks whether/);
    expect(await hold(nousCard([{ text: "public-host Space Link: ready now to press Link SpaceApp on stable within 2 minutes?" }]))).toMatch(/never asks whether/);
    // The act itself with its link passes, and so do a plain decision and a status line.
    expect(await hold(agentCard("Press Link SpaceApp on stable: Iris writes a fresh 2-minute code the moment you press Go now."))).toBeNull();
    expect(await hold(agentCard("Να ξεκινήσει τώρα η δωρεάν αίτηση D-U-N-S για την INTRATRADE;"))).toBeNull();
    expect(await hold(agentCard("The build is ready to ship. Approve the npm sign-in with your security key at the link."))).toBeNull();
    expect(await hold(nousCard([{ text: "Ready now to scan the pairing QR?" }], ["operator order nous_msg:83c0acb8abc"]))).toBeNull();
    // 14/11 REVIEW: the readiness asked through an option, on the act's own card, from Nous or an agent.
    expect(await hold(nousCard([{ text: "Press Link SpaceApp on stable", options: ["Έτοιμος τώρα", "Αργότερα"], recommended: "Έτοιμος τώρα" }]))).toMatch(/never asks whether/);
    expect(await hold(agentCard("Approve the npm sign-in with your security key.", {}, { options: ["Ready now", "Not now"] }))).toMatch(/never asks whether/);
    expect(await hold(agentCard("Approve the npm sign-in with your security key.", {}, { options: ["I'm ready to approve it"] }))).toMatch(/never asks whether/);
    // A status the operator reports after the act is no readiness.
    expect(await hold(nousCard([{ text: "Press Link SpaceApp on stable", options: ["Έτοιμο", "Done", "Failed"], recommended: "Failed" }]))).toBeNull();
  });

  it("(c) refuses a card that asks whether or when the operator will do the act (13/11 ledger: 9 MISSes, answered \"do it yourself\" or \"give me the link\")", async () => {
    for (const ask of ["Θα βάλεις την κάρτα στο checkout της Cartesia (σήμερα $0,00) όταν τελειώσεις τις συνεντεύξεις;", "Βάζεις ξανά την κάρτα στο νέο checkout της Cartesia ($0.00 σήμερα);",
      "Μπαίνεις τώρα στο Stripe όταν ο Bob ανοίξει τη σύνδεση;", "Υποβάλλεις τώρα την αίτηση YC W27;", "Θα γράψεις το βίντεο 1 λεπτού για το Y Combinator;",
      "Θα στείλεις τώρα από το κινητό την απάντηση στον Fares;", "Can you type the Braintrust authenticator code in Dino/Emma now?", "Mercor interview: when will you do it?",
      "When do you do the Mercor Domain Expert interview?", "Πότε κάνεις τη συνέντευξη Mercor;"]) {
      expect(await hold(nousCard([{ text: ask }])), ask).toMatch(/whether or when the operator will do the act/);
    }
    // The act itself, a decision and a data question pass.
    expect(await hold(agentCard("Enter the card at the Cartesia checkout: everything else is filled.", {}, { checked: ["at the card form: Stripe card fields open, $0"] }))).toBeNull();
    expect(await hold(nousCard([{ text: "Hoot.ae: δέχεσαι την πρόταση (Auth0 Organizations + PostgreSQL RLS) για το κείμενο προς Fares;" }]))).toBeNull();
    expect(await hold(nousCard([{ text: "Ποιο λογότυπο κρατάμε για το unboxexpert.com;" }]))).toBeNull();
    expect(await hold(nousCard([{ text: "When should the launch mail go out?" }]))).toBeNull();
    expect(await hold(nousCard([{ text: "Πότε να σταλεί το mail της κυκλοφορίας;" }]))).toBeNull();
    expect(await hold(nousCard([{ text: "Will you submit the YC application now?" }], ["operator order nous_msg:83c0acb8abc"]))).toBeNull();
  });
});
