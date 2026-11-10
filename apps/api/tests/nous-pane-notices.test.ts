import { describe, expect, it, vi } from "vitest";
import { eventSchema, type Pane, type Room } from "@space/contracts";
import { InMemorySiteSigninsRepository, InMemorySpaceNotificationsRepository } from "@space/db";
import { makeSpaceId, SpaceEventBus } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { baseRateRecommendation, createNousPaneNotices, ledgerRecommendation, ruleRecommendation } from "../src/nous/pane-notices.js";
import { heldForNousNote, NOUS_QUESTION_REWAKE_MS, sweepCopilotQuestions } from "../src/nous/copilot-questions.js";
import { cardTextMatched } from "../src/nous/predictions.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// One card per pane for what only the operator's hands can do (plan clipboard:8FfXWclYUfOH).
const owner = "user:operator";
const room = { id: "room:freelance01", name: "Freelance", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = (id: string, paneName: string) => ({ id, roomId: room.id, paneName, title: paneName, mode: "TERMINAL", isClosed: false }) as unknown as Pane;
const andy = pane("pane:andy0001", "Andy");
const bob = pane("pane:bob00001", "Bob");

function fixture(held = false) {
  const repository = new InMemorySpaceNotificationsRepository(undefined, true);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => held, raised: () => {} } });
  return { repository, service, notices: createNousPaneNotices({ notifications: service }) };
}

describe("Nous's cards to the operator", () => {
  it("keeps one card per pane: a new list replaces the items, unread again and alerted once; the same list changes nothing", async () => {
    const f = fixture();
    const first = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(first).toMatchObject({ ok: true, display: "Sent the operator's card for Andy in Freelance (1 item)" });
    const [card] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(card).toMatchObject({ source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", paneId: andy.id, roomId: room.id, dedupeKey: "nous:pane:pane:andy0001",
      link: { roomId: room.id, paneId: andy.id }, body: "• Pass the Cloudflare check", status: "OPEN" });
    await f.service.setStatus(owner, card!.id, "READ");

    const same = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the Cloudflare check" }] });
    expect(same.display).toBe("The card for Andy in Freelance already lists this");
    expect(f.repository.telegram).toHaveLength(1);

    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you",
      items: [{ text: "Pass the Cloudflare check" }, { text: "Enter the 2FA code", ref: "notification:abc123", steps: ["Open https://www.upwork.com/ab/account-security/login in Andy's browser", "Enter the 6-digit code from Google Authenticator (ntheogr@gmail.com)"] }] });
    const cards = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: card!.id, status: "OPEN", body: "• Pass the Cloudflare check\n• Enter the 2FA code\n  1. Open https://www.upwork.com/ab/account-security/login in Andy's browser"
      + "\n  2. Enter the 6-digit code from Google Authenticator (ntheogr@gmail.com)" });
    expect(f.repository.telegram).toHaveLength(2);

    await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Sign in to LinkedIn", items: [{ text: "Sign in", steps: ["Open https://www.linkedin.com/login in Bob's browser", "Sign in with Google (ntheogr@gmail.com)"] }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "Send the invoice PDF", items: [{ text: "Download it from the bank" }] });
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey).sort())
      .toEqual(["nous:general", "nous:pane:pane:andy0001", "nous:pane:pane:bob00001"]);
    expect(await f.notices.summary(owner, { room: () => "Freelance", pane: (id) => id === andy.id ? "Andy" : id === bob.id ? "Bob" : null }))
      .toContain(`- [${card!.id}] Upwork needs you · Andy in Freelance · 2 items`);
  });

  it("links the card to the item Go to pane opens: an item's target, else the target of the card an item answers (operator 1/11 11:58 BKK)", async () => {
    const f = fixture();
    const mail = await f.service.raise({ ownerUserId: owner, roomId: room.id, paneId: andy.id, source: "MAIL_COPILOT", kind: "NEEDS_USER", severity: "ATTENTION", title: "Mail Copilot needs you",
      body: "Complete the Zinc check", link: { roomId: room.id, paneId: andy.id, target: "thread:ntheogr@gmail.com:1a1925b124bb7cb8" }, dedupeKey: "mail:zinc", payload: {}, telegram: null });
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Mercor mail", items: [{ text: "Complete the Zinc check(s) link", ref: mail.id }] });
    const card = () => f.service.list(owner, { status: "ALL", source: "NOUS", limit: 5 }).then((items) => items[0]!);
    expect((await card()).link).toEqual({ roomId: room.id, paneId: andy.id, target: "thread:ntheogr@gmail.com:1a1925b124bb7cb8" });
    // An item's own target wins, and a target alone is a new card (the old link would open the wrong page).
    expect((await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Mercor mail",
      items: [{ text: "Complete the Zinc check(s) link", ref: mail.id, target: "url:https://app.zinc.work/checks" }] })).display).toContain("Updated");
    expect((await card()).link.target).toBe("url:https://app.zinc.work/checks");
    // A card another pane raised is not this pane's item.
    await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Mercor mail", items: [{ text: "Check it", ref: mail.id }] });
    expect((await f.service.list(owner, { status: "ALL", source: "NOUS", limit: 5 })).find((item) => item.paneId === bob.id)!.link).toEqual({ roomId: room.id, paneId: bob.id });
  });

  it("asks its first item's question with the options and Nous's recommendation; a changed question alerts again (plan clipboard:5AQvaoSR-IZa)", async () => {
    const f = fixture();
    const items = [{ text: "Pick the Upwork profile" }, { text: "Which profile should Andy use?", question: "Which profile should Andy use?", options: ["Agency", "Freelancer"], recommended: "Freelancer" }];
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items });
    const [card] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(card!.payload.ask).toEqual({ question: "Which profile should Andy use?", options: ["Agency", "Freelancer"], recommended: "Freelancer", answer: { kind: "NOUS" } });
    const changed = await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you",
      items: [items[0]!, { ...items[1]!, recommended: "Agency" }] });
    expect(changed.display).toContain("Updated");
    expect((await f.service.list(owner, { status: "ALL", limit: 50 }))[0]!.payload.ask).toMatchObject({ recommended: "Agency" });
    // R12-11: options with no recommended one among them raise nothing.
    expect(await f.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Plan", items: [{ text: "Choose the plan", question: "Plan chosen?", options: ["Yes"], recommended: "No" }] }))
      .toMatchObject({ ok: false, display: "Asked without a recommended option", result: expect.stringContaining("Every decision carries a prediction") });
    expect((await f.service.list(owner, { status: "ALL", limit: 50 })).find((item) => item.paneId === bob.id)).toBeUndefined();
  });

  it("takes an item's recommended option from the operator rule that answers its question, and says which rule (R11-2 (6))", async () => {
    // REVIEW 29/10: card predictions 12 of 25; 4 cards (video watch ×2, physicians, ID.me) were answered against the recommendation.
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }), nous: { held: async () => false, raised: () => {} } });
    const rules = [{ id: "space_memory:rule0001", title: "Job applications: optional videos", body: "When an application offers an optional video, Skip it." },
      { id: "space_memory:rule0002", title: "Freelance pricing", body: "Quote hourly, never fixed price, for new clients." }];
    const notices = createNousPaneNotices({ notifications: service, operatorRules: async () => rules });
    const checked = ["Space Memory: the operator's video rule"];
    await notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy asks", checked,
      items: [{ text: "The Acme application offers an optional intro video.", question: "Record the optional video for the application?", options: ["Record", "Skip"], recommended: "Record" }] });
    const card = (await service.list(owner, { status: "OPEN", limit: 5 }))[0]!;
    expect(card.payload.ask).toMatchObject({ recommended: "Skip" });
    expect(card.body).toContain('(Recommended "Skip" by your rule [space_memory:rule0001] "Job applications: optional videos".)');
    // No rule answers this one: the item stays as Nous wrote it.
    await notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Bob asks", checked,
      items: [{ text: "Two sign-in methods.", question: "Which sign-in should Bob use?", options: ["Google", "Email"], recommended: "Google", steps: ["Open https://www.upwork.com/ab/account-security/login in Andy's browser", "Enter the 6-digit code from Google Authenticator (ntheogr@gmail.com)"] }] });
    const other = (await service.list(owner, { status: "OPEN", limit: 5 })).find((item) => item.paneId === bob.id)!;
    expect(other.payload.ask).toMatchObject({ recommended: "Google" });
    expect(other.body).not.toContain("by your rule");
    expect(ruleRecommendation({ question: "Quote a fixed price or hourly for the new client?", options: ["Fixed price", "Hourly"] }, rules)).toEqual({ option: "Hourly", rule: { id: "space_memory:rule0002", title: "Freelance pricing" } });
    // 30/10 12:10 BKK: Dana's Braintrust card got "Done" from a Mail archive rule, a Contra card from "never ask again about 1.1.9": status options
    // and generic words never make a rule's answer.
    const misfires = [{ id: "space_memory:2526eb53", title: "Mail Copilot daily archive", body: "Every day the Mail Copilot archives what is done and asks the operator nothing." },
      { id: "space_memory:772378fb", title: "Releases", body: "Never ask again about the 1.1.9 publication: it is done." }];
    expect(ruleRecommendation({ question: "Did you finish the Braintrust ID check? Answer when it is done.", options: ["Done", "Not yet"] }, misfires)).toBeNull();
    expect(ruleRecommendation({ question: "Never asked before: is the Contra profile done?", options: ["Done", "Need help"] }, misfires)).toBeNull();
    // A rule that agrees with Nous's own recommendation adds nothing to the card.
    await notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Bob asks again", checked,
      items: [{ text: "Another optional video.", question: "Record the optional video for the application?", options: ["Record", "Skip"], recommended: "Skip" }] });
    const agreed = (await service.list(owner, { status: "OPEN", limit: 5 })).find((item) => item.paneId === bob.id)!;
    expect(agreed.payload.ask).toMatchObject({ recommended: "Skip" });
    expect(agreed.body).not.toContain("by your rule");
  });

  it("takes an item's recommended option from the operator's last 2 agreeing answers to the same question; a rule still wins (R13-7)", async () => {
    // 29/10: cards predicted 13 of 26.
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }), nous: { held: async () => false, raised: () => {} } });
    const row = (title: string, answer: string, at: string) => ({ source: "NEEDS_YOU:NOUS", title, answer, at });
    const rows = [row("Watch the 3 videos for the application?", "Skip", "2026-10-28T10:00:00.000Z"), row("Watch the 5 videos for the application?", "Skip: not worth it", "2026-10-29T08:00:00.000Z"),
      row("Which sign-in should Bob use?", "Email", "2026-10-28T10:00:00.000Z"), row("Which sign-in should Bob use?", "Email", "2026-10-29T08:00:00.000Z")];
    const notices = createNousPaneNotices({ notifications: service, ledger: async () => rows });
    const checked = ["The ledger: the operator skipped the last two"];
    await notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy asks", checked,
      items: [{ text: "Videos again.", question: "Watch the 4 videos for the application?", options: ["Watch", "Skip"], recommended: "Watch" }] });
    const card = (await service.list(owner, { status: "OPEN", limit: 5 }))[0]!;
    expect(card.payload.ask).toMatchObject({ recommended: "Skip" });
    expect(card.body).toContain('(Recommended "Skip" by your last 2 answers.)');
    // Never on a hands item; two answers that disagree, or one, set nothing.
    expect(ledgerRecommendation({ text: "Two sign-in methods.", question: "Which sign-in should Bob use?", options: ["Google", "Email"] }, rows)).toBeNull();
    expect(ledgerRecommendation({ text: "x", question: "Watch the 4 videos for the application?", options: ["Watch", "Skip"] }, [rows[0]!, { ...rows[1]!, answer: "Watch" }])).toBeNull();
    expect(ledgerRecommendation({ text: "x", question: "Watch the 4 videos for the application?", options: ["Watch", "Skip"] }, [rows[0]!])).toBeNull();
    // 2026-10-30 REVIEW (cards 54 %): when the last two disagree, R16-9's base rate of that question decides (5 answers, 80 %).
    const many = [...["Skip", "Skip", "Skip", "Skip"].map((answer, index) => row(`Watch the ${index + 1} videos for the application?`, answer, `2026-10-2${index}T10:00:00.000Z`)),
      row("Watch the 9 videos for the application?", "Watch", "2026-10-29T09:00:00.000Z")];
    expect(ledgerRecommendation({ text: "x", question: "Watch the 4 videos for the application?", options: ["Watch", "Skip"] }, many)).toEqual({ option: "Skip", answers: 5 });
    expect(ledgerRecommendation({ text: "x", question: "Watch the 4 videos for the application?", options: ["Watch", "Skip"] }, many.slice(1))).toBeNull();
    // An operator rule still wins over the ledger.
    const ruled = createNousPaneNotices({ notifications: service, ledger: async () => rows,
      operatorRules: async () => [{ id: "space_memory:rule0003", title: "Videos", body: "Optional videos for applications: Watch them." }] });
    await ruled.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Bob asks", checked,
      items: [{ text: "Videos.", question: "Watch the optional videos for the application?", options: ["Watch", "Skip"], recommended: "Skip" }] });
    expect((await service.list(owner, { status: "OPEN", limit: 5 })).find((item) => item.paneId === bob.id)!.payload.ask).toMatchObject({ recommended: "Watch" });
  });

  it("never asks again what the operator answered on a card in the last 2 hours, unless the item says what changed since (R16-2)", async () => {
    // 29/10: 3 cards for the 4 allowance switches in 50 minutes (8a276b5d, b241991f, cbef6b65); the third got «Δεν καταλαβαίνω την ερώτηση σου!!».
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }), nous: { held: async () => false, raised: () => {} } });
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const rows = [{ source: "NEEDS_YOU:NOUS", title: "Turn on the four allowance switches in Settings?", answer: "Yes", at: ago(30), ref: "notification:8a276b5d" },
      { source: "NEEDS_YOU:NOUS", title: "Restart the Browser Host tonight?", answer: "Yes", at: ago(180), ref: "notification:old00001" }];
    const notices = createNousPaneNotices({ notifications: service, ledger: async () => rows });
    const checked = ["Settings: two of the four switches are still off", "Browser Host: idle since 02:00"];
    const ask = (question: string, since?: string) => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Allowances", checked,
      items: [{ text: "The allowance switches.", question, options: ["Yes", "No"], recommended: "Yes", ...(since ? { since } : {}) }] });
    // W45 step 2: a hold (REFUSED), worded as final for this item.
    expect(await ask("Turn on the allowance switches in Settings now?")).toMatchObject({ ok: false, refused: true, display: "The operator already answered this",
      result: expect.stringContaining('"Yes". Nothing raised. Do not call it again with this item; state the server\'s fact instead of asking them to confirm it') });
    expect((await ask("Turn on the allowance switches in Settings now?")).result).toContain("(card notification:8a276b5d)");
    expect(await service.list(owner, { status: "OPEN", limit: 5 })).toHaveLength(0);
    // What changed since his answer, an answer older than 2 hours, or another question: raised.
    expect((await ask("Turn on the allowance switches in Settings now?", "two switches are still off after the reload")).ok).toBe(true);
    expect((await service.list(owner, { status: "OPEN", limit: 5 }))[0]!.body).toContain("(Since your answer: two switches are still off after the reload)");
    expect((await ask("Restart the Browser Host tonight?")).ok).toBe(true);
  });

  it("refuses a hands item without its link and numbered steps, and offers Failed and Need links/steps on one asked with options (R20-asks-2)", async () => {
    // Operator rule cc31fdd2, 30/10: «δώσε μου links και οδηγίες ώστε να προχωρήσω τώρα» four times in a day; 7 of 36 cards answered against «Done».
    const { service, notices } = fixture();
    const card = (item: Record<string, unknown>) => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you",
      checked: ["Andy's space_look: the billing page shows no linked project"], items: [{ text: "Set up Google billing", ...item }] });
    expect(await card({})).toMatchObject({ ok: false, refused: true, display: "A hands card needs its link and steps", result: expect.stringContaining("the exact https link and the full numbered steps") });
    expect(await card({ steps: ["Open the billing page", "Add the card"] })).toMatchObject({ ok: false, refused: true });
    expect(await card({ steps: ["Open https://console.cloud.google.com/billing as ntheogr@gmail.com"] })).toMatchObject({ ok: false, refused: true });
    expect(await card({ steps: ["Open https://console.cloud.google.com/billing as ntheogr@gmail.com", "Link the Space project to the billing account"],
      question: "Billing linked?", options: ["Done", "Not yet"], recommended: "Not yet" })).toMatchObject({ ok: true });
    const raised = (await service.list(owner, { status: "OPEN", limit: 5 }))[0]!;
    expect(raised.payload.ask).toMatchObject({ options: ["Done", "Not yet", "Failed", "Need links/steps"] });
    expect(raised.body).toContain("• Set up Google billing\n  1. Open https://console.cloud.google.com/billing as ntheogr@gmail.com\n  2. Link the Space project");
    // An item that is no hands work needs none.
    expect((await notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Pick", items: [{ text: "Pick the Upwork profile" }] })).ok).toBe(true);
  });

  it("R27-2: a hands item without options asks Go now (recommended) and on a browser pane opens its page; R27-3: a code item asks for the code", async () => {
    // Mercor card 11:52 (1/11) went unscored; the operator answered «open the page and go to the point» 2/2.
    const { service, notices } = fixture();
    const steps = ["Open https://work.mercor.com/login as ntheogr@gmail.com", "Pass the sign-in check"];
    const card = (on: Pane | null, items: Array<Record<string, unknown>>) => notices.notify(owner, room, on, { room: "Freelance", pane: "Andy", title: "Needs you",
      items: items as Parameters<typeof notices.notify>[3]["items"] });
    expect(await card(andy, [{ text: "Sign in to Mercor", steps }])).toMatchObject({ ok: true });
    const cardOf = async (on: Pane) => (await service.list(owner, { status: "WAITING", limit: 20 })).find((item) => item.paneId === on.id)!;
    expect((await cardOf(andy)).payload.ask).toEqual({ question: "Sign in to Mercor", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } });
    // On a browser pane Go now opens the page: a url or tab target, not the bare browser.
    const browser = { ...bob, mode: "BROWSER" } as Pane;
    expect(await card(browser, [{ text: "Sign in to Mercor", steps }])).toMatchObject({ ok: false, refused: true, display: "A hands card on a browser pane needs its page" });
    expect(await card(browser, [{ text: "Sign in to Mercor", steps, target: "browser" }])).toMatchObject({ ok: false, refused: true });
    expect(await card(browser, [{ text: "Sign in to Mercor", steps, target: "url:https://work.mercor.com/login" }])).toMatchObject({ ok: true });
    expect((await cardOf(browser)).link.target).toBe("url:https://work.mercor.com/login");
    // R27-3: the code item is the card's question, answered into the pane: no link, steps or options; one a card, on a pane.
    const code = { text: "Upwork sent a sign-in code to your phone", question: "The 6-digit Upwork code from your SMS", code: true };
    expect(await card(andy, [{ text: "Sign in to Mercor", steps }, code])).toMatchObject({ ok: true });
    expect((await cardOf(andy)).payload.ask).toEqual({ question: code.question, code: true, answer: { kind: "PANE" } });
    expect(await card(browser, [code])).toMatchObject({ ok: true });
    expect(await card(null, [code])).toMatchObject({ ok: false, refused: true, display: "A code item goes to its pane" });
    expect(await card(andy, [code, { ...code, question: "And the mail code" }])).toMatchObject({ ok: false, refused: true });
    expect(await card(andy, [{ ...code, options: ["A", "B"], recommended: "A" }])).toMatchObject({ ok: false, refused: true });
  });

  it("operator nous_msg:4b36b80e: a hands item joining the pane's card with its page leads it, its own Go now on top; every item's steps stay in the body", async () => {
    const { service, notices } = fixture();
    const finn = { ...bob, mode: "BROWSER" } as Pane;
    const older = { text: "Pick the Upwork profile", question: "Which profile should Finn use?", options: ["Agency", "Freelancer"], recommended: "Freelancer",
      target: "url:https://www.upwork.com/freelancers/settings" };
    const login = { text: "LOGIN: Google sign-in for the job site", question: "Sign in to google.com", target: "tab:page-google",
      steps: ["Open https://accounts.google.com in Finn's browser", "Sign in as ntheogr@gmail.com"] };
    expect(await notices.notify(owner, room, finn, { room: "Freelance", pane: "Bob", title: "Finn needs you", items: [older] })).toMatchObject({ ok: true });
    expect(await notices.notify(owner, room, finn, { room: "Freelance", pane: "Bob", title: "Finn needs you", items: [older, login] })).toMatchObject({ ok: true, display: expect.stringContaining("Updated") });
    const [card] = await service.list(owner, { status: "WAITING", limit: 5 });
    expect(card!.link.target).toBe("tab:page-google");
    expect(card!.payload.ask).toEqual({ question: "Sign in to google.com", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } });
    expect(card!.body).toBe("• Pick the Upwork profile\n• LOGIN: Google sign-in for the job site\n  1. Open https://accounts.google.com in Finn's browser\n  2. Sign in as ntheogr@gmail.com");
  });

  it("brief 20261103 (goal 7365014c): every item without options stores Go now (recommended), so its answer is scored; a card raised before is not alerted again", async () => {
    // 2/11-3/11: the Cleo/Iris 0.2.13 card and the Cleo/Dana freelance card stored no recommendation and counted as "no prediction".
    const f = fixture();
    const cardOf = async () => (await f.service.list(owner, { status: "WAITING", limit: 20 })).find((item) => item.paneId === andy.id)!;
    expect(await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", items: [{ text: "Accept the Contra offer for oll4" }] })).toMatchObject({ ok: true });
    const card = await cardOf();
    expect(card.payload.items).toEqual([{ text: "Accept the Contra offer for oll4", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now" }]);
    expect(card.payload.ask).toEqual({ question: "Accept the Contra offer for oll4", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now", answer: { kind: "NOUS" } });
    expect(cardTextMatched(card.payload.ask as never, "Go now")).toBe(true);
    expect(cardTextMatched(card.payload.ask as never, "Failed")).toBe(false);
    // A real question on a later item stays the card's question.
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", items: [{ text: "Accept the Contra offer for oll4" },
      { text: "Rate", question: "Which rate do we bid?", options: ["$60/h", "$80/h"], recommended: "$80/h" }] });
    expect((await cardOf()).payload.ask).toMatchObject({ question: "Which rate do we bid?", recommended: "$80/h" });
    // A card raised before the change (no options stored) sent again with the same list changes nothing and alerts no one.
    const legacy = fixture();
    await legacy.service.raise({ ownerUserId: owner, roomId: room.id, paneId: bob.id, source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Bob needs you",
      body: "• Test the Nous app 0.2.13 on your phone", link: { roomId: room.id, paneId: bob.id }, dedupeKey: `nous:pane:${bob.id}`, telegram: null,
      payload: { items: [{ text: "Test the Nous app 0.2.13 on your phone" }], alertAt: new Date().toISOString() } });
    const before = legacy.repository.telegram.length;
    expect((await legacy.notices.notify(owner, room, bob, { room: "Freelance", pane: "Bob", title: "Bob needs you", items: [{ text: "Test the Nous app 0.2.13 on your phone" }] })).display)
      .toBe("The card for Bob in Freelance already lists this");
    expect(legacy.repository.telegram).toHaveLength(before);
  });

  it("operator 4/11 18:42 BKK: an item asking for a value is typed on the card: answerKind text, and by default a question without options that is no hands work", async () => {
    const f = fixture();
    const cardOf = async () => (await f.service.list(owner, { status: "WAITING", limit: 20 })).find((item) => item.paneId === andy.id)!;
    const notify = (items: Array<Record<string, unknown>>) => f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you",
      items: items as Parameters<typeof f.notices.notify>[3]["items"] });
    const phone = { text: "Form A of the Hetzner claim needs the applicant's phone", question: "Which phone goes on Form A as the applicant's phone?" };
    expect(await notify([phone])).toMatchObject({ ok: true });
    expect((await cardOf()).payload.ask).toEqual({ question: phone.question, answerKind: "text", answer: { kind: "NOUS" } });
    // Asked by the item itself, without a question: its text is the question.
    expect(await notify([{ text: "The applicant's phone for Form A", answerKind: "text" }])).toMatchObject({ ok: true });
    expect((await cardOf()).payload.ask).toEqual({ question: "The applicant's phone for Form A", answerKind: "text", answer: { kind: "NOUS" } });
    // Sign-in work with a question and no options still asks Go now.
    expect(await notify([{ text: "Sign in to Mercor", question: "Sign in to Mercor now?", steps: ["Open https://work.mercor.com/login", "Pass the sign-in check"] }])).toMatchObject({ ok: true });
    expect((await cardOf()).payload.ask).toMatchObject({ options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now" });
    expect((await cardOf()).payload.ask).not.toHaveProperty("answerKind");
  });

  it("R21-3 (REVIEW 1/11: hands cards predicted 30 of 57): an agent does hands work where Space holds the login, and a hands card recommends Done only on the operator's base rate", async () => {
    // 31/10: the NVIDIA sign-in card came back "Need links/steps", Lendable's «Βάλε agent να το κανει».
    const siteSignins = new InMemorySiteSigninsRepository();
    await siteSignins.record(owner, { site: "nvidia.com", method: "GOOGLE", googleAccountEmail: "ntheogr@gmail.com", outcome: "SUCCESS" }, "test");
    const notify = async () => ({ ok: true, display: "Sent the card", result: "ok" });
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], siteSignins, vault: { agent: { call: async () => ({ status: "LISTED", items: [] }) } },
      paneNotices: { notify } } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:r213", callId: "toolu_r213", traceId: "trace:r213" };
    const steps = ["Open https://learn.nvidia.com/login in Andy's browser", "Sign in with Google as ntheogr@gmail.com"];
    const card = (checked: string[], triedStored?: string) => tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "Andy needs you",
      items: [{ text: "Sign in to NVIDIA DLI", steps, ...(triedStored ? { triedStored } : {}) }], checked }, ctx);
    // Since R66 (5/11) a sign-in item meets the stored sign-in first, whatever `checked` says; R21-3's hold covers the other hands work (R60 below).
    expect(await card(["Andy's report: the course page asks to log in"])).toMatchObject({ ok: false, refused: true, display: "Space holds a sign-in for this site",
      result: expect.stringContaining("site sign-in record nvidia.com (GOOGLE, 1 successful). Have a pane sign in with it") });
    expect(await card(["Andy tried the stored Google sign-in: Google asks for the code on his phone"])).toMatchObject({ refused: true, display: "Space holds a sign-in for this site" });
    // The stored method failed, with its reason (triedStored): the card goes.
    expect((await card(["Andy's report: the course page asks to log in"], "Google sign-in as ntheogr@gmail.com: Google asks for the code on his phone")).ok).toBe(true);
    // Done is no recommendation for a hands card unless the operator's answers to that question say so (5 or more, 80 %).
    const rows: Array<{ source: string; title: string; answer: string; at: string }> = [];
    const notices = createNousPaneNotices({ notifications: fixture().service, ledger: async () => rows });
    const ask = () => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", checked: ["Andy's space_look: the billing page shows no linked account"],
      items: [{ text: "Set up Google billing", steps: ["Open https://console.cloud.google.com/billing as ntheogr@gmail.com", "Link the Space project"], question: "Billing linked?", options: ["Done", "Not yet"], recommended: "Done" }] });
    expect(await ask()).toMatchObject({ ok: false, refused: true, display: '"Done" is no recommendation for a hands card', result: expect.stringContaining("Need links/steps") });
    for (let index = 0; index < 5; index += 1) rows.push({ source: "NEEDS_YOU:NOUS", title: "Billing linked?", answer: "Done", at: new Date(Date.now() - index * 60_000 - 3 * 3_600_000).toISOString() });
    expect((await ask()).ok).toBe(true);
  });

  it("R60 (cards 2-3/11): site work an agent can do is an agent's, the operator's own part waits for a signed-in page, and the extras speak the options' language", async () => {
    // Turing ×2, Lendable «Βάλε agent», Reddit «νέος κωδικός»; Backblaze «μην με πηγαινεις σε μια σελιδα που δεν εχεις κανει login», PayPal tax data.
    const siteSignins = new InMemorySiteSigninsRepository();
    for (const site of ["turing.com", "reddit.com", "backblaze.com"]) await siteSignins.record(owner, { site, method: "GOOGLE", googleAccountEmail: "info@example.invalid", outcome: "SUCCESS" }, "test");
    const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], siteSignins, vault: { agent: { call: async () => ({ status: "LISTED", items: [] }) } },
      paneNotices: { notify } } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:r60", callId: "toolu_r60", traceId: "trace:r60" };
    const card = (text: string, checked: string[]) => tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "Andy needs you",
      items: [{ text, steps: ["Open https://www.turing.com/dashboard", "Do it"] }], checked }, ctx);
    expect(await card("Turing: 3 tests by 22:05 on turing.com", ["Andy's report: three tests wait"])).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("an agent can do this (rule 4d47dcab): Space signed in to turing.com before") });
    expect(await card("Reddit: νέος κωδικός στο reddit.com", ["Andy's report: reset mail arrived"])).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("rule 4d47dcab") });
    const backblaze = (checked: string[]) => card("Backblaze: add the card on backblaze.com billing so the backup starts", checked);
    expect(await backblaze(["the Vault has no card"])).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("only the operator does this part, on a page an agent already signed in to") });
    expect((await backblaze(["Cody signed in to backblaze.com, the billing page is open at the card field"])).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    // 1/11 X Premium: "Failed" recommended; 1/11 Twitch 2FA: Greek options got "Failed" and "Need links/steps".
    const f = fixture();
    const twitch = (options: string[], recommended: string) => f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Twitch 2FA",
      items: [{ text: "Turn on Twitch 2FA", steps: ["Open https://www.twitch.tv/settings/security", "Turn on 2FA"], question: "Twitch 2FA;", options, recommended }] });
    expect(await twitch(["Updated the card", "Failed"], "Failed")).toMatchObject({ ok: false, refused: true, display: '"Failed" is no recommendation' });
    expect((await twitch(["Πάω τώρα", "Παράλειψε το hackathon"], "Πάω τώρα")).ok).toBe(true);
    expect((await f.service.list(owner, { status: "ALL", limit: 5 }))[0]!.payload.ask).toMatchObject({ options: ["Πάω τώρα", "Παράλειψε το hackathon", "Απέτυχε", "Χρειάζομαι link/βήματα"] });
    expect((await twitch(["Πάω τώρα", "Απέτυχε", "Θέλω βοήθεια"], "Πάω τώρα")).ok).toBe(true);
    expect((await f.service.list(owner, { status: "ALL", limit: 5 }))[0]!.payload.ask).toMatchObject({ options: ["Πάω τώρα", "Απέτυχε", "Θέλω βοήθεια"] });
  });

  it("2/11 (Twitch 2FA, PayPal SMS cards whose codes also come by mail): a code card for a site whose mail reaches a connected mailbox is an agent's", async () => {
    const notify = vi.fn(async () => ({ ok: true, display: "Sent the card", result: "ok" }));
    const mailContext = vi.fn(async (_owner: string, _refs: unknown, sites: string[]) => sites.includes("twitch.tv") ? ['Mail from twitch.tv in 30 days: spaceappdv@gmail.com: 3 threads'] : []);
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], vault: { agent: { call: async () => ({ status: "LISTED", items: [] }) } },
      paneNotices: { notify }, mailContext } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:mailcode", callId: "toolu_mailcode", traceId: "trace:mailcode" };
    const card = (text: string, checked: string[]) => tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "Andy needs you", items: [{ text, code: true }], checked }, ctx);
    expect(await card("Twitch asks for the 2FA code to sign in at https://www.twitch.tv/login", ["Andy's report: the sign-in asks for a code"])).toMatchObject({ ok: false, refused: true,
      result: expect.stringContaining("read the code with space_mail_search / space_mail_read") });
    expect(notify).not.toHaveBeenCalled();
    // Nous read the mailbox and the code is not there, or the site never mails: the card goes up.
    expect((await card("Twitch asks for the 2FA code to sign in at https://www.twitch.tv/login", ["spaceappdv@gmail.com inbox: no Twitch code mail in 10 minutes, Twitch sends it by SMS only"])).ok).toBe(true);
    expect((await card("Bank asks for the SMS code at https://ebanking.example-bank.gr", ["Andy's report: the bank asks for the code"])).ok).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("4/11 REVIEW: an item recommending Done or Yes needs a checked line about the same thing, and the hold names the hit rate", async () => {
    // 3/11: 3 cards answered against "Done"/"Yes" (0.2.13 was not in Updates, the Authenticator account, a Hetzner payment).
    const rows = [{ source: "NEEDS_YOU:NOUS", title: "Installed?", predicted: "Done", answer: "Not there", match: false, at: new Date().toISOString(), ref: null },
      { source: "NEEDS_YOU:NOUS", title: "Saved?", predicted: "Yes", answer: "Yes", match: true, at: new Date().toISOString(), ref: null },
      { source: "NEEDS_YOU:NOUS", title: "Which?", predicted: "Later", answer: "Now", match: false, at: new Date().toISOString(), ref: null }];
    const notices = createNousPaneNotices({ notifications: fixture().service, ledger: async () => rows as never });
    const ask = (checked: string[]) => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Update", checked,
      items: [{ text: "SpaceApp 0.2.13 waits for the phones", question: "Send 0.2.13 to the phones?", options: ["Yes", "No"], recommended: "Yes" }] });
    expect(await ask(["Andy's report: the release built"])).toMatchObject({ ok: false, refused: true, display: "Show what proves it first",
      result: '"Send 0.2.13 to the phones?" recommends "Yes": add to `checked` the source that shows its prerequisite and what it showed, naming the same thing '
        + '(e.g. "app Updates: lists 0.2.13"), then raise the card. Your cards recommending Done or Yes went as recommended 1 of 2 times in 90 days. Nothing raised.' });
    expect((await ask(["The app's Updates page: lists 0.2.13"])).ok).toBe(true);
    // R74 (4/11 Meridial: «Το έκανα» recommended with nothing checked): the same in Greek.
    const greek = await notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Meridial", checked: ["Andy's report: invite mail arrived"],
      items: [{ text: "Meridial WeCP assessments", question: "Έκανες τα τεστ WeCP του Meridial από τον υπολογιστή σου;", options: ["Το έκανα", "Όχι ακόμα"], recommended: "Το έκανα" }] });
    expect(greek).toMatchObject({ ok: false, refused: true, display: "Show what proves it first" });
  });

  it("R24-2 (cards 31 of 60 in 7 days): a card asking whether a card or billing setting is saved waits until a pane looked at the billing page", async () => {
    // 30-31/10: 6 of 8 such cards missed («I added payment methods, don't know what else you want», «check and tell me the exact problem»).
    let at = Date.parse("2026-11-01T08:00:00.000Z");
    const notices = createNousPaneNotices({ notifications: fixture().service, now: () => at });
    const ask = (checked: string[], question = "Card shows (masked) on Backblaze billing?") => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", checked,
      items: [{ text: "Add the company card on Backblaze", steps: ["Open https://secure.backblaze.com/billing.htm", "Add the card ending 4242"], question, options: ["Card added", "Could not"], recommended: "Card added" }] });
    expect(await ask(["Andy's report: the charge waits"])).toMatchObject({ ok: false, refused: true, display: "Look at the billing page first",
      result: expect.stringContaining("have the pane look at it (space_look, browser content)") });
    // What the page showed raises it at once; the same question again within the hour is Nous's call and goes through.
    expect((await ask(["Andy's space_look: the Backblaze billing page shows no card"], "Card saved in Backblaze?")).ok).toBe(true);
    expect((await ask(["Andy's report: the Backblaze charge waits"])).ok).toBe(true);
    at += 2 * 3_600_000;
    expect((await ask(["Andy's report: still waiting"])).ok).toBe(false);
    // Other cards are untouched, and an operator rule never recommends the options Space adds to a hands card.
    expect((await notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", checked: ["Mercor mail of 27/10: the offer waits"],
      items: [{ text: "Mercor offer", question: "Accepted the Mercor Generalist offer?", options: ["Accepted", "Not for me"], recommended: "Accepted" }] })).ok).toBe(true);
    expect(ruleRecommendation({ question: "X Premium payment failed: what did you do?", options: ["Updated the card", "Let it lapse", "Failed", "Need links/steps"] },
      [{ id: "mem:x", title: "X Premium payment", body: "When an X Premium payment failed, the copilot reports it." }])).toBeNull();
  });

  it("R23-3 (operator «Θέλω να τα δω όλα αυτά»): a card naming an artifact that does not open for the owner is refused; one that opens is raised with it", async () => {
    const f = fixture();
    const notices = createNousPaneNotices({ notifications: f.service, artifactOpens: async (_owner, id) => id === "artifact:icon00001" });
    const card = (option: string) => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", checked: ["Design pane: two icons delivered"],
      items: [{ text: "Pick the app icon", question: "Which icon?", options: [option, "Keep the old one"], recommended: option }] });
    expect(await card("New artifact:nope00001")).toMatchObject({ ok: false, refused: true, display: "A named artifact does not open",
      result: expect.stringContaining("artifact:nope00001 is no artifact of your rooms") });
    expect(await f.service.list(owner, { status: "ALL", limit: 50 })).toHaveLength(0);
    expect((await card("New artifact:icon00001")).ok).toBe(true);
    const [raised] = await f.service.list(owner, { status: "ALL", limit: 50 });
    expect(raised!.payload.ask).toMatchObject({ options: expect.arrayContaining(["New artifact:icon00001"]) });
  });

  it("refuses a Nous card asking now or later by day, and asks it in quiet hours (2026-10-30 REVIEW: R16-3 for Nous's own cards)", async () => {
    const { service } = fixture();
    let quiet = false;
    const notices = createNousPaneNotices({ notifications: service, quiet: async () => quiet });
    const ask = () => notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Andy needs you", checked: ["Andy's report: the sign-in waits"],
      items: [{ text: "Upwork sign-in.", question: "Hand over the Upwork sign-in now or tomorrow?", options: ["Now, one by one", "Tomorrow morning"], recommended: "Now, one by one", steps: ["Open https://www.upwork.com/ab/account-security/login in Andy's browser", "Enter the 6-digit code from Google Authenticator (ntheogr@gmail.com)"] }] });
    expect(await ask()).toMatchObject({ ok: false, refused: true, display: "Asked when, by day", result: expect.stringContaining("Nothing raised. Do not call it again with this question") });
    expect(await service.list(owner, { status: "OPEN", limit: 5 })).toEqual([]);
    quiet = true;
    expect(await ask()).toMatchObject({ ok: true });
  });

  it("gives a card with options and no recommended one the operator's usual answer to its kind, 5 or more answers at 80 % (R16-9)", async () => {
    // 29/10: 15 of 32 card and rail answers carried no prediction (Mail NEEDS_USER «I handled it / Ignore it», unvouched reviews, questions).
    const row = (answer: string) => ({ source: "NEEDS_YOU:MAIL_COPILOT", kind: "MAIL_COPILOT:NEEDS_USER", answer });
    const rows = [row("Ignore it"), row("Ignore it"), row("Ignore it: spam"), row("I handled it"), row("Ignore it")];
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      nous: { held: async () => false, raised: () => {}, recommend: async (card) => baseRateRecommendation(rows, card) } });
    const card = (dedupeKey: string) => service.raise({ ownerUserId: owner, roomId: room.id, paneId: andy.id, source: "MAIL_COPILOT", kind: "NEEDS_USER", severity: "ATTENTION",
      title: "Mail Copilot needs you", body: "A refund mail from MOBILE BUZZ.", link: {}, dedupeKey, telegram: null,
      payload: { ask: { question: "What should Mail Copilot do with this mail?", options: ["I handled it", "Ignore it"], answer: { kind: "MAIL_FIX" } } } });
    const raised = await card("mail-copilot:mailevt:buzz00001");
    expect(raised.payload).toMatchObject({ ask: { recommended: "Ignore it" }, baseRate: { option: "Ignore it", answers: 5 } });
    expect(raised.body).toContain('Recommended "Ignore it" by your last 5 answers.');
    // Fewer than 5 answers, or no option at 80 %: no recommendation.
    expect(baseRateRecommendation(rows.slice(0, 4), { source: "MAIL_COPILOT", kind: "NEEDS_USER", options: ["I handled it", "Ignore it"] })).toBeNull();
    expect(baseRateRecommendation([...rows, row("I handled it")], { source: "MAIL_COPILOT", kind: "NEEDS_USER", options: ["I handled it", "Ignore it"] })).toBeNull();
    expect(baseRateRecommendation(rows, { source: "FREELANCE_COPILOT", kind: "NEEDS_USER", options: ["I handled it", "Ignore it"] })).toBeNull();
  });

  it("reaches the operator at once even while Nous holds other notifications, and resolves the cards of closed panes", async () => {
    const f = fixture(true);
    await f.notices.notify(owner, room, andy, { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] });
    await f.notices.notify(owner, room, null, { room: "Freelance", title: "A document", items: [{ text: "Get it" }] });
    expect(f.repository.telegram).toHaveLength(2);
    expect(await f.notices.reconcile(owner, new Set([bob.id]))).toBe(1);
    expect((await f.service.list(owner, { status: "OPEN", limit: 50 })).map((item) => item.dedupeKey)).toEqual(["nous:general"]);
  });

  it("is a Nous tool that reaches only the owner's rooms and panes", async () => {
    const f = fixture();
    const tools = createNousTools({ paneNotices: f.notices, rooms: async (who: string) => who === owner ? [room] : [], listPanes: async () => [andy, bob] } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "nous_turn:n1", callId: "toolu_n", traceId: "trace:n" };
    const checked = ["Vault: no Upwork login", "pane reports: Andy waits on a CAPTCHA since 10:02"];
    // Ask last (goal ee5a573e): a card without what Nous checked first is refused with the rule.
    const unchecked = await tools.execute("space_notify_operator", { room: "freelance", pane: "andy", title: "Upwork needs you", items: [{ text: "Pass the check" }] }, ctx);
    expect(unchecked).toMatchObject({ ok: false, result: expect.stringContaining("checked: Ask last (operator goal ee5a573e") });
    expect(await tools.execute("space_notify_operator", { room: "freelance", pane: "andy", title: "Upwork needs you", items: [{ text: "Pass the check" }], checked }, ctx))
      .toMatchObject({ ok: true, result: expect.stringMatching(/^Notification notification:/) });
    const card = (await f.service.list(owner, { status: "OPEN", limit: 10 }))[0]!;
    expect(card.body).toBe("• Pass the check\n\nChecked first:\n• Vault: no Upwork login\n• pane reports: Andy waits on a CAPTCHA since 10:02");
    expect(card.payload.checked).toEqual(checked);
    // Other wording of what was checked is no new list: no second alert.
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "Upwork needs you", items: [{ text: "Pass the check" }], checked: ["Vault: nothing"] }, ctx)).result).toContain("Unchanged");
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Zed", title: "x", items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    // Queue item 36: a card without a pane (nous:general) never reached Needs you or a banner; it is refused, with the tool that fits.
    const general = await tools.execute("space_notify_operator", { room: "Freelance", title: "Send the invoice PDF", items: [{ text: "Download it" }], checked }, ctx);
    expect(general).toMatchObject({ ok: false, result: expect.stringContaining("space_ask_operator") });
    expect((await f.service.list(owner, { status: "ALL", limit: 50 })).some((item) => item.dedupeKey === "nous:general")).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x".repeat(81), items: [{ text: "y" }] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", title: "x", items: [] }, ctx)).ok).toBe(false);
    expect((await tools.execute("space_notify_operator", { room: "Freelance", pane: "Andy", title: "x", items: [{ text: "y" }] }, { ...ctx, owner: "user:other" })).ok).toBe(false);
  });
});

describe("Copilot questions go to Nous first (Ask Last step 7, 2026-10-27)", () => {
  function questions(start = Date.parse("2026-10-27T15:00:00.000Z")) {
    let at = start;
    let holds = true;
    const raised: string[] = [];
    const repository = new InMemorySpaceNotificationsRepository(() => new Date(at).toISOString(), true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never, now: () => new Date(at).toISOString(),
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date(at).toISOString() }),
      nous: { held: async () => false, raised: (item) => raised.push(item.id), holdsCopilotQuestions: async () => holds } });
    const ask = (key: string, extra: Partial<Parameters<typeof service.raise>[0]> = {}) => service.raise({ ownerUserId: owner, roomId: room.id, paneId: andy.id,
      source: "JOB_COPILOT", kind: "QUESTION", severity: "ATTENTION", title: "Job Copilot needs you", body: "Your Bangkok postal code?", link: {}, dedupeKey: key, payload: {}, telegram: null, ...extra });
    const needsYou = async () => (await service.list(owner, { status: "NEEDS_YOU", limit: 50 })).map((item) => item.id);
    return { repository, service, notices: createNousPaneNotices({ notifications: service }), ask, needsYou, raised,
      tick: (ms: number) => { at += ms; }, now: () => at, setHolds: (value: boolean) => { holds = value; } };
  }

  it("holds a new copilot question out of Needs you, Telegram and push for Nous; a Nous card naming it is its one surface and ends it (R16-8)", async () => {
    const f = questions();
    const question = await f.ask("job-apply:question:jobq:s0O3NpRylU1i");
    expect(question.payload.heldForNous).toEqual({ until: "2026-10-27T16:00:00.000Z" });
    expect(f.raised).toEqual([question.id]);
    expect(f.repository.telegram).toEqual([]);
    expect(await f.needsYou()).toEqual([]);
    // R16-8 (19:11 BKK: the MOBILE BUZZ refund reached the operator twice): the Nous card whose item names the question is the only surface;
    // the question stays held, past its hour too, and ends when the card is answered.
    await f.notices.notify(owner, room, andy, { room: room.name, pane: "Andy", title: "Job Copilot asks", items: [{ text: "Your Bangkok postal code?", ref: question.id }],
      checked: ["Space Memory and copilot memories: no postal code"] });
    const nousCard = (await f.service.list(owner, { status: "OPEN", source: "NOUS", limit: 5 }))[0]!;
    expect(nousCard.body).toContain("Your Bangkok postal code? (answers the Job Copilot's question)");
    expect((await f.service.get(owner, question.id))!.payload.heldForNous).toMatchObject({ card: nousCard.id });
    expect(await f.needsYou()).toEqual([nousCard.id]);
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => new Set(["jobq:s0O3NpRylU1i"]), paneOpen: async () => true });
    f.tick(2 * 60 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    await f.service.setStatus(owner, nousCard.id, "ACKED");
    expect(await sweep()).toEqual({ resolved: 1, released: 0 });
    expect((await f.service.get(owner, question.id))!.status).toBe("RESOLVED");
    // Off: today's behaviour, nothing held.
    f.setHolds(false);
    expect((await f.ask("job-apply:question:jobq:second0001")).payload.heldForNous).toBeUndefined();
  });

  it("holds a Mail Copilot NEEDS_USER card for Nous too, never resolves it for a missing rail item, and releases it after its hour (queue item 32)", async () => {
    const f = questions();
    const card = await f.ask("mail-copilot:mailevt:sign00001", { source: "MAIL_COPILOT", kind: "NEEDS_USER", title: "Mail Copilot needs you (Mail)", body: "Only you can sign this form." });
    expect(card.payload.heldForNous).toEqual({ until: "2026-10-27T16:00:00.000Z" });
    expect(await f.needsYou()).toEqual([]);
    const missingSince = new Map<string, number>();
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["MAIL_COPILOT"], holds: async () => true, now: f.now, missingSince,
      openItemIds: async () => new Set<string>(), paneOpen: async () => true });
    // No rail item names it (the Mail service resolves it when the thread is settled): minutes pass, it stays held.
    for (let minute = 0; minute < 3; minute += 1) { expect(await sweep()).toEqual({ resolved: 0, released: 0 }); f.tick(60_000); }
    f.tick(60 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 1 });
    expect(await f.needsYou()).toContain(card.id);
    // Sign-in and handoff kinds of other sources are never held.
    expect((await f.ask("job-apply:signin:pane1", { kind: "SIGN_IN_NEEDED" })).payload.heldForNous).toBeUndefined();
  });

  it("lets a held question whose hour ran out reach the operator only after two Nous turns showed it, waking Nous again meanwhile (plan clipboard:7L5KyWp3kQsP step 1)", async () => {
    // 1/11 17:10 UTC: jobq:Tcoa0D_0Vp3t reached one INBOX turn that ended NOTHING_NEW, then sat 9.5 h in Needs you while Job memory held the answer.
    const f = questions();
    const question = await f.ask("job-apply:question:jobq:Tcoa0D_0Vp3t", { body: "What was your GPA?" });
    let shown = 0;
    const rewake = vi.fn(async () => {});
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => new Set(["jobq:Tcoa0D_0Vp3t"]), paneOpen: async () => true, shown: () => shown, rewake });
    // Within its hour nothing moves.
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(61 * 60_000);
    // Its hour ran out after one turn: Nous is woken again, the operator not yet.
    shown = 1;
    expect(await sweep()).toEqual({ resolved: 0, released: 0, rewoken: 1 });
    expect(rewake).toHaveBeenCalledWith(expect.objectContaining({ id: question.id }));
    expect((await f.service.get(owner, question.id))!.payload.heldForNous).toEqual({ hourEnded: "2026-10-27T16:00:00.000Z", until: "2026-10-27T16:11:00.000Z" });
    expect(await f.needsYou()).toEqual([]);
    // Within the longer hold nothing moves; once it ends after a second turn showed the card, it goes to the operator.
    shown = 2;
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(11 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 1 });
    expect(await f.needsYou()).toEqual([question.id]);
    // Step 5: the release marks the card escalated for the daily REVIEW's count.
    expect((await f.service.get(owner, question.id))!.payload).toMatchObject({ releasedFromNous: expect.any(String) });
    // A turn that never comes (low-spend CRITICAL) holds it at most NOUS_QUESTION_REWAKE_MS past its hour.
    const second = await f.ask("job-apply:question:jobq:second0002", { body: "Your date of birth?" });
    shown = 0;
    f.tick(60 * 60_000 + NOUS_QUESTION_REWAKE_MS);
    const late = () => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => new Set(["jobq:second0002"]), paneOpen: async () => true, shown: () => shown, rewake });
    expect(await late()).toEqual({ resolved: 0, released: 1 });
    expect(await f.needsYou()).toContain(second.id);
  });

  it("holds Freelance and Marketing NEEDS_USER cards for Nous, and resolves one a later Nous brief to its pane answered (R10-13)", async () => {
    // 28/10 22:13 BKK: Cleo/Andy's notes "Waiting for Nous: the link from Gmail …" reached the operator although Nous's brief had answered them.
    const f = questions();
    const freelance = await f.ask("freelance-copilot:event:flevt:uJvvhrTAlu5v", { source: "FREELANCE_COPILOT", kind: "NEEDS_USER", title: "Freelance Copilot needs you (Andy)", body: "Waiting for Nous: the link from Gmail." });
    const marketing = await f.ask("marketing-copilot:event:mktevt:note000001", { source: "MARKETING_COPILOT", kind: "NEEDS_USER", title: "Marketing Copilot needs you (Kate)", body: "Which subreddit?" });
    expect([freelance.payload.heldForNous, marketing.payload.heldForNous]).toEqual([{ until: "2026-10-27T16:00:00.000Z" }, { until: "2026-10-27T16:00:00.000Z" }]);
    expect(await f.needsYou()).toEqual([]);
    const taken = new Set<string>();
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["FREELANCE_COPILOT", "MARKETING_COPILOT"], holds: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => new Set<string>(), paneOpen: async () => true, answeredByNousBrief: async (item) => taken.has(item.id) });
    f.tick(60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    taken.add(freelance.id);
    expect(await sweep()).toEqual({ resolved: 1, released: 0 });
    expect((await f.service.get(owner, freelance.id))!.status).toBe("RESOLVED");
    // The other one, never answered, reaches the operator after its hour.
    f.tick(60 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 1 });
    expect(await f.needsYou()).toEqual([marketing.id]);
  });

  it("R24-2 (operator 1/11 11:50 BKK): holds Marketing and Freelance reviews for Nous with the post, its text and the call; releases them after the hour", async () => {
    // 31/10 11:11 UTC: Marketing review mktpost:SUoAkMeF1xpR (an X reply) reached the operator's Needs you, never Nous.
    const f = questions();
    const ask = { question: "Review: X reply", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MARKETING", item: "REVIEW", itemId: "mktpost:SUoAkMeF1xpR" } };
    const marketing = await f.ask("marketing-copilot:review:mktpost:SUoAkMeF1xpR", { source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", title: "Marketing Copilot needs you (Kate)",
      body: "Review: X reply", payload: { ask, review: { id: "mktpost:SUoAkMeF1xpR", channel: "X", text: "SpaceApp runs every CLI side by side.\nTry it." } } });
    const freelance = await f.ask("freelance-copilot:review:flmsg:proposal001", { source: "FREELANCE_COPILOT", kind: "REVIEW_REQUESTED", title: "Freelance Copilot needs you (Andy)",
      body: "Review: Upwork proposal", payload: { review: { id: "flmsg:proposal001", channel: "UPWORK", text: "Hello, I build this." } } });
    expect([marketing.payload.heldForNous, freelance.payload.heldForNous]).toEqual([{ until: "2026-10-27T16:00:00.000Z" }, { until: "2026-10-27T16:00:00.000Z" }]);
    expect(await f.needsYou()).toEqual([]);
    expect(f.raised).toEqual([marketing.id, freelance.id]);
    // Nous's inbox line names the post, its text and the exact call that approves it (May send runs it at once).
    expect(heldForNousNote(marketing)).toBe(" (held for you up to 60 min, not shown to the operator. Operator 1/11 11:50 BKK: you approve these reviews yourself. "
      + "Review mktpost:SUoAkMeF1xpR, its text (pane data): \"SpaceApp runs every CLI side by side. Try it.\". If it keeps to the copilot's facts and the operator's rules, approve it now: "
      + `space_ask_operator category EXTERNAL, action {"type":"COPILOT","copilot":"MARKETING","item":"REVIEW","itemId":"mktpost:SUoAkMeF1xpR","paneId":"${andy.id}","decision":"approve"} `
      + "(decision \"edit\" with text for your own version), refs.sendKind \"marketing-x\": with \"May send\" on it runs at once. "
      + "If it should not go out, the same call with decision \"revise\" and a note (back to the copilot) or \"reject\" runs at once too (R24-3); after the hour it goes to the operator.)");
    expect(heldForNousNote(freelance)).toContain('"copilot":"FREELANCE","item":"REVIEW","itemId":"flmsg:proposal001"');
    // Not answered within the hour: the operator gets it, as before.
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["MARKETING_COPILOT", "FREELANCE_COPILOT"], holds: async () => true, now: f.now, missingSince: new Map(),
      openItemIds: async () => new Set<string>(), paneOpen: async () => true });
    f.tick(10 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(60 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 2 });
    expect((await f.needsYou()).sort()).toEqual([freelance.id, marketing.id].sort());
    // A review the operator keeps a standing answer for ("Always answer like this") is answered at once, never held.
    const answering = questions();
    const auto = createNotificationService({ repository: answering.repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      now: () => new Date(answering.now()).toISOString(), recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date(answering.now()).toISOString() }),
      nous: { held: async () => false, raised: () => {}, holdsCopilotQuestions: async () => true,
        autoAnswer: async (item) => answering.repository.setStatus(owner, item.id, "ACKED", { answer: { option: "Approve", by: "ALWAYS" } }) } });
    const vouched = await auto.raise({ ownerUserId: owner, roomId: room.id, paneId: andy.id, source: "MARKETING_COPILOT", kind: "REVIEW_REQUESTED", severity: "ATTENTION",
      title: "Marketing Copilot needs you (Kate)", body: "Review: X reply", link: {}, dedupeKey: "marketing-copilot:review:mktpost:vouched0001", payload: { ask }, telegram: null });
    expect(vouched).toMatchObject({ status: "ACKED" });
    expect(vouched.payload.heldForNous).toBeUndefined();
  });

  it("each minute resolves questions that no longer wait, keeps a live one, and releases held ones after their hour or when Nous stops holding", async () => {
    const f = questions();
    const live = await f.ask("job-apply:question:jobq:s0O3NpRylU1i", { paneId: null });
    const answered = await f.ask("job-apply:question:jobq:answered01", { paneId: null });
    const byEvent = await f.ask("job-apply:QUESTION:jobevt:old0000001", { paneId: null });
    const marketing = await f.ask("marketing-copilot:question:mktq:open000001", { source: "MARKETING_COPILOT" });
    const design = await f.ask("design:question:dreq:gone000001", { source: "DESIGN", kind: "DESIGN_QUESTION", paneId: "pane:closed001" });
    await f.service.setStatus(owner, answered.id, "READ");
    const missingSince = new Map<string, number>();
    let openIds = ["mktq:open000001", "dreq:gone000001"];
    const sweep = () => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT", "MARKETING_COPILOT", "DESIGN"], holds: async () => holds, now: f.now, missingSince,
      openItemIds: async () => new Set(openIds), paneOpen: async (paneId) => paneId !== "pane:closed001" });
    let holds = true;
    // Item 35 (28/10 02:31): one read came back without a question that still waited; nothing is resolved on one read.
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(60_000);
    openIds = ["jobq:s0O3NpRylU1i", "mktq:open000001", "dreq:gone000001"];
    expect(await sweep()).toEqual({ resolved: 0, released: 0 });
    f.tick(60_000);
    // Two minutes missing: resolved; the question the first read missed came back and stays.
    expect(await sweep()).toEqual({ resolved: 3, released: 0 });
    expect((await f.service.get(owner, live.id))?.status).toBe("OPEN");
    for (const [item, status] of [[live, "OPEN"], [answered, "RESOLVED"], [byEvent, "RESOLVED"], [marketing, "OPEN"], [design, "RESOLVED"]] as const) {
      expect((await f.service.get(owner, item.id))?.status).toBe(status);
    }
    // Its hour ends: the question goes to the operator.
    f.tick(61 * 60_000);
    expect(await sweep()).toEqual({ resolved: 0, released: 2 });
    expect((await f.service.get(owner, marketing.id))!.payload.heldForNous).toBeUndefined();
    // Nous switched off or paused: a question held a minute ago goes at once.
    const fresh = await f.ask("job-apply:question:jobq:fresh00001", { paneId: null });
    holds = false;
    const sweepWith = (open: string[]) => sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => holds, now: f.now, missingSince,
      openItemIds: async () => new Set(open), paneOpen: async () => true });
    expect(await sweepWith(["jobq:s0O3NpRylU1i", "jobq:fresh00001"])).toEqual({ resolved: 0, released: 1 });
    expect((await f.service.get(owner, fresh.id))!.payload.heldForNous).toBeUndefined();
    // The copilot's own answer resolves it as today; an owner whose items cannot be read is left alone.
    expect(await f.service.resolve(owner, "job-apply:question:jobq:fresh00001")).toBe(1);
    expect(await sweepCopilotQuestions({ notifications: f.service, sources: ["JOB_COPILOT"], holds: async () => true, paneOpen: async () => true, missingSince,
      openItemIds: async () => { throw new Error("Job Copilot unavailable"); } })).toEqual({ resolved: 0, released: 0 });
  });
});
