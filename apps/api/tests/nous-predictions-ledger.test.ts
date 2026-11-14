import { describe, expect, it, vi } from "vitest";
import { nousAnswerIntent, type NousDecision } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { cardAnswerMatched, cardTextMatched, cardWordsConfirm, decisionPredictedOption, optionPredictionMatched, predictionAccuracy, writtenPredictionMatched, yesNoPredictionMatched } from "../src/nous/predictions.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NousLedgerRow } from "@space/db";
import { DECISION_RULES_NOTE, mirrorLedger, syncRailLedger } from "../src/nous/rail-ledger.js";
import { createNousService, type NousServiceDeps } from "../src/nous/service.js";

const owner = "user:operator";
const decision = (extra: Partial<NousDecision>): NousDecision => ({ id: "nous_decision:d1", ownerUserId: owner, category: "DIRECTION", title: "Which way?", body: "", options: [],
  recommendation: null, refs: {}, action: null, status: "OPEN", answer: null, outcome: null, createdAt: "2026-10-28T10:00:00.000Z", answeredAt: null, ...extra });

describe("decision ledger: option predictions and the copilot rails (R11-3)", () => {
  it("reads a prediction that names an option and scores it against the recommended option or the operator's words", () => {
    // 28/10: f229736d «Πρόβλεψη: (α)+(β)+(γ) (80%)» and 47f01ad9 «Πρόβλεψη: επιλογή 1 …» were stored with predicted = null.
    expect(decisionPredictedOption({ recommendation: "All three. Πρόβλεψη: (α)+(β)+(γ) (80%)", body: "" })).toBe("(α)+(β)+(γ)");
    expect(decisionPredictedOption({ recommendation: "Πρόβλεψη: επιλογή 1 …", body: "" })).toBe("επιλογή 1");
    expect(decisionPredictedOption({ recommendation: "Πρόβλεψη: ναι (90%)", body: "" })).toBeNull();
    const asked = { recommendation: "(α)+(β)+(γ): all three." };
    expect(optionPredictionMatched("(α)+(β)+(γ)", asked, "APPROVED", null)).toBe(true);
    expect(optionPredictionMatched("(α)+(β)+(γ)", asked, "ANSWERED", "α, β και γ")).toBe(true);
    expect(optionPredictionMatched("(α)+(β)+(γ)", asked, "ANSWERED", "μόνο (α)")).toBe(false);
    expect(optionPredictionMatched("επιλογή 1", asked, "ANSWERED", "1")).toBe(true);
    expect(optionPredictionMatched("επιλογή 1", asked, "DECLINED", null)).toBe(false);
    const scored = predictionAccuracy([
      decision({ recommendation: "Πρόβλεψη: επιλογή 1 (70%)", status: "ANSWERED", answer: "2", answeredAt: "2026-10-28T11:00:00.000Z" }),
      decision({ recommendation: "Πρόβλεψη: (α)+(β)+(γ) (80%)", status: "APPROVED", answer: null, answeredAt: "2026-10-28T11:00:00.000Z" }),
      decision({ recommendation: "Πρόβλεψη: ναι (90%)", status: "APPROVED", answeredAt: "2026-10-28T11:00:00.000Z" })], [], "2026-10-28T00:00:00.000Z");
    expect(scored.decisions).toEqual({ matched: 2, total: 3 });
  });

  it("scores a card by the option the operator chose, a note with it or not, and leaves Space's own answers out (R19-3)", () => {
    // 30/10 scorecard: cards 22 of 40 while the ledger counted "<option>: <note>" answers as matches.
    const card = (text: string, by?: string) => ({ id: `n:${text}`, updatedAt: "2026-10-30T01:00:00.000Z",
      payload: { ask: { question: "When?", options: ["Now, one by one", "Tomorrow"], recommended: "Now, one by one" }, answer: { text, at: "2026-10-30T01:00:00.000Z", ...(by ? { by } : {}) } } });
    const cards = [card("Now, one by one"), card("Now, one by one: start with Upwork"), card("Tomorrow"), card("Tomorrow: after 10"), card("Now, one by one", "TIMING"), card("Now, one by one", "ALWAYS")];
    expect(predictionAccuracy([], cards as never, "2026-10-30T00:00:00.000Z").cards).toEqual({ matched: 2, total: 4 });
  });

  it("R21-pred-1: words that say yes or done confirm an affirmative recommended option, never a fail or later one", () => {
    // Ledger 166 and 168 (31/10): both confirmed the recommended option in words and were scored MISS.
    expect(cardWordsConfirm("Card added", "ειναι ετοιμο εβαλα καρτα -- προχωρησε την χρεωση", nousAnswerIntent("ειναι ετοιμο εβαλα καρτα -- προχωρησε την χρεωση"))).toBe(true);
    expect(cardWordsConfirm("Installed, download works", "ναι δουλεψε μια χαρα", nousAnswerIntent("ναι δουλεψε μια χαρα"))).toBe(true);
    expect(cardWordsConfirm("Still fails", "ναι", "APPROVE")).toBe(false);
    expect(cardWordsConfirm("Need links/steps", "done", null)).toBe(false);
    expect(cardWordsConfirm("Card added", "έβαλες κάρτα;", null)).toBe(false);
    expect(cardWordsConfirm("Card added", "βάλε agent να το κάνει", null)).toBe(false);
  });

  it("R38: one matcher reads typed values and confirming words as the option, and every real miss of 26/10-2/11 stays a miss", () => {
    // space_nous_progress 2/11: cards 31 of 61. Findings ~/agent-workspace/active/20261102-card-prediction/findings.md (rows by R24-2 number).
    const hit: Array<[string[], string, string]> = [
      [["I'll type my Greek address", "Bangkok", "Skip"], "I'll type my Greek address", "Example St 1, Patra, 26000"], // 12
      [["I'll type it", "Fill it myself", "Skip"], "I'll type it", "10260"], // 17
      [["Saved", "Could not"], "Saved", "εβαλα τροποι πληρωμης δεν ξερω τι αλλο θελειες"], // 44: "I put the payment methods" (R21-pred-1's «έβαλα»)
      [["Card added", "Skip"], "Card added", "ειναι ετοιμο εβαλα καρτα -- προχωρησε την χρεωση"] // 51
    ];
    const miss: Array<[string[], string, string]> = [
      [["Yes, I made it", "No: delete it and change the Robot password"], "No: delete it and change the Robot password", "Yes, I made it"], // 3
      [["I try once, then chat", "Drop AWS"], "I try once, then chat", "το δοκιμασα αλλα το ίδιο προβλημα ειχα!!"], // 6 (meaning only)
      [["Now", "Later today", "Drop"], "Later today", "δημιουργησα τον λογαριασμο για το twitch"], // 7
      [["I pay it now", "Wait for Hetzner's answer (by 3/11)"], "I pay it now", "Wait for Hetzner's answer (by 3/11)"], // 11
      [["Silence both", "Fix Thailand router, public-host stays off", "Keep both"], "Silence both", "Fix Thailand router, public-host stays off"], // 13
      [["Yes, submit", "No, skip"], "No, skip", "Yes, submit"], // 15
      [["Yes to both", "Unlisted + Q21", "Changes first"], "Yes to both", "ζητηζ να μπει ηχος και να ολοκληρωθει το βιντεο"], // 19
      [["Today", "Tomorrow", "Skip"], "Today", "σημερα δωσε μου focus στην σελιδα"], // 25 (meaning only)
      [["Yes", "Only this one", "No"], "No", "Δώσε μου focus ώστε να γράφω το όνομα μου"], // 26 (meaning only)
      [["Yes", "Still off"], "Yes", "Δεν καταλαβαίνω την ερώτηση σου!!"], // 33
      [["Yes, order", "No"], "Yes, order", "I am not in greece I can't add more disks"], // 37
      [["Done", "Not now"], "Done", "δωσε μου λινκσ και οδηγιες ωστε να προχωρησω τωρα την διαδικασία!!"], // 45
      [["Installed", "Download failed"], "Installed", "Download failed"], // 46
      [["Done", "Google error"], "Done", "ειναι περασμενη κανονικα η καρτα της εταρειας απλα δεν εχω χρηματα μεσα"], // 50
      [["Done", "Later", "Skip"], "Done", "Βάλε agent να το κανει"], // 54
      [["Done", "Failed", "Need links/steps"], "Done", "Need links/steps"], // 56
      [["Updated the card", "Let lapse", "Need links/steps", "Failed"], "Failed", "Updated the card"], // 57
      [["Done", "Failed", "Need links/steps"], "Done", "ανοιξε το broswer μπες στην σελιδα να κανω τα υπολοιπα!!"], // 58
      [["Yes, enabled", "Not yet"], "Yes, enabled", "123456"] // 1/11 Twitch 2FA: a code typed on a yes/no card (R27-3 asks codes since)
    ];
    for (const [options, recommended, text] of hit) expect(cardTextMatched({ options, recommended }, text), text).toBe(true);
    for (const [options, recommended, text] of miss) expect(cardTextMatched({ options, recommended }, text), text).toBe(false);
    // An "I'll type it" card answered with another option, a refusal or a question is no typed value.
    expect(cardTextMatched({ options: ["I'll type it", "Skip"], recommended: "I'll type it" }, "Skip")).toBe(false);
    expect(cardTextMatched({ options: ["I'll type it", "Skip"], recommended: "I'll type it" }, "όχι")).toBe(false);
    expect(cardTextMatched({ options: ["I'll type it", "Skip"], recommended: "I'll type it" }, "which address?")).toBe(false);
    // R74 (4/11 UNICEF): a yes to the card's only yes option is that option, though the option says "no" later; with two yes options it stays a miss.
    expect(cardTextMatched({ options: ["Ναι, όλα Όχι", "Κάποιο Ναι"], recommended: "Ναι, όλα Όχι" }, "ναι σε ολα απλα να υπαρχουν διαφορετικα needs you για καθε δουλεια!!")).toBe(true);
    expect(cardTextMatched({ options: ["Yes, all No", "Yes, but one Yes"], recommended: "Yes, all No" }, "yes")).toBe(false);
    expect(cardTextMatched({ options: ["Ναι, όλα Όχι", "Κάποιο Ναι"], recommended: "Ναι, όλα Όχι" }, "όχι")).toBe(false);
  });

  it("R60: Greek done words and an «I send it» option read as the option; the other misses of 2/11-3/11 stay misses", () => {
    // Nous's export 4/11 (~/agent-workspace/nous/decisions/cards-answered-20261104.jsonl), rows by id; the IBAN is a placeholder.
    const hit: Array<[string[], string, string]> = [
      [["Go now", "Αργότερα"], "Go now", "στο προσθεσα"], // f2340534
      [["Το ανεβάζω στα Agent Files", "Το ανεβάζω ο ίδιος στο PayPal"], "Το ανεβάζω στα Agent Files", "μολις ανεβασα ενα pdf στο agent files δες αν σου κανει"], // fc21ec2a
      [["Ναι, το αλλάζω τώρα", "Όχι ακόμα"], "Ναι, το αλλάζω τώρα", "τον αλλαξα για δες τωρα"], // a6d96ad1
      [["Στέλνω ελληνικό IBAN + ΑΦΜ", "Revolut (+ ΑΦΜ)"], "Στέλνω ελληνικό IBAN + ΑΦΜ", "ΑΦΜ 000000000 IBAN GR00 0000 0000 0000 0000 0000 000"] // 0c53714e
    ];
    const miss: Array<[string[], string, string]> = [
      [["Πάω τώρα", "Αργότερα σήμερα", "Αφήνουμε το Reddit"], "Πάω τώρα", "το εβαλα στο vault Που υπηρχε ηδη το προηγούμενο δεν ξερω γιατι το αλλαξες!!"], // efdd23bf
      [["Πάω τώρα", "Failed", "Need links/steps"], "Πάω τώρα", "σου κανα συνδεση κανονικα δες το"], // 044f8e64 (meaning only: «σου έκανα» is also "I asked you")
      [["Θα το κάνω", "Δεν χρειάζεται, αρχειοθέτησέ το"], "Θα το κάνω", "ναοιξε μου broswer κανε Login πηγαινε στο σημειο"], // 7ae63dfa
      [["Το πλήρωσα", "Αργότερα σήμερα", "Απέτυχε η πληρωμή"], "Το πλήρωσα", "δεν θα πληρησω τωα εχουμε περιθώριο"], // d19d463b
      [["Ναι, αλλάζω τον κωδικό", "Όχι"], "Ναι, αλλάζω τον κωδικό", "άλλαξα γνώμη, άσ' το"], // "I changed my mind" is no act done
      [["Στέλνω ελληνικό IBAN + ΑΦΜ", "Revolut (+ ΑΦΜ)"], "Στέλνω ελληνικό IBAN + ΑΦΜ", "Revolut (+ ΑΦΜ)"]
    ];
    for (const [options, recommended, text] of hit) expect(cardTextMatched({ options, recommended }, text), text).toBe(true);
    for (const [options, recommended, text] of miss) expect(cardTextMatched({ options, recommended }, text), text).toBe(false);
  });

  it("R38: a Go now visit is scored once its card stops waiting, by the answer it ended with", () => {
    const card = (status: string, text: string) => ({ id: `n:${status}:${text}`, status, updatedAt: "2026-11-02T01:00:00.000Z",
      payload: { ask: { question: "Sign in to NVIDIA", options: ["Go now", "Failed", "Need links/steps"], recommended: "Go now" }, answer: { text, at: "2026-11-02T01:00:00.000Z" } } });
    const since = "2026-11-02T00:00:00.000Z";
    expect(cardAnswerMatched(card("READ", "Go now") as never, since)).toBeNull();
    expect(cardAnswerMatched(card("RESOLVED", "Go now") as never, since)).toBe(true);
    expect(cardAnswerMatched(card("ACKED", "Failed") as never, since)).toBe(false);
    expect(cardAnswerMatched(card("ACKED", "Need links/steps") as never, since)).toBe(false);
  });

  it("writes an option prediction and its match into the ledger when the operator answers", async () => {
    const repository = new InMemoryNousRepository();
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const asked = await service.ask({ ownerUserId: owner, category: "DIRECTION", title: "Which plan?", body: "(α) fast (β) safe (γ) both", options: ["(α)", "(β)", "(γ)"],
      recommendation: "Both. Πρόβλεψη: (γ) (75%)", refs: {}, action: null }, { checked: ["The plan map"] });
    await service.answer(owner, asked.id, { answer: "ANSWER", text: "γ" });
    expect((await repository.listLedger(owner, "2000-01-01T00:00:00.000Z"))[0]).toMatchObject({ source: "NOUS_DECISION", predicted: "(γ)", match: true });
    await service.idle(owner);
  });

  it("goal 7365014c step 2: scores a predicted written answer by its yes or no and its words, and counts it in the accuracy", () => {
    // 6/11 measurement: 26 of 42 misses were written answers ("yes, but sooner").
    const predicted = "ναι, αλλά όλα μέσα σε μία εβδομάδα";
    expect(writtenPredictionMatched(predicted, "ANSWERED", "ναι αλλά όλα σε μία εβδομάδα")).toBe(true);
    expect(writtenPredictionMatched(predicted, "ANSWERED", "όχι, άσ' το")).toBe(false);
    expect(writtenPredictionMatched(predicted, "DECLINED", "μία εβδομάδα")).toBe(false);
    expect(writtenPredictionMatched(predicted, "APPROVED", null)).toBe(false);
    expect(writtenPredictionMatched(predicted, "ANSWERED", "ναι αλλά σε δύο μήνες")).toBe(false);
    expect(writtenPredictionMatched("no, wait until Monday", "ANSWERED", "no, wait for monday")).toBe(true);
    const written = { recommendation: null, refs: { prediction: { answer: predicted, confidence: 70, written: true as const } } };
    expect(optionPredictionMatched(predicted, written, "ANSWERED", "ναι, σε μια εβδομαδα ολα")).toBe(true);
    // Without the flag the option matcher is unchanged.
    expect(optionPredictionMatched(predicted, { recommendation: null }, "ANSWERED", "ναι, σε μια εβδομαδα ολα")).toBe(false);
    const at = "2026-11-06T11:00:00.000Z";
    expect(predictionAccuracy([decision({ ...written, status: "ANSWERED", answer: "ναι αλλά όλα σε μία εβδομάδα", answeredAt: at }),
      decision({ ...written, id: "nous_decision:d2", status: "ANSWERED", answer: "όχι", answeredAt: at })], [], "2026-11-06T00:00:00.000Z").decisions).toEqual({ matched: 1, total: 2 });
  });

  it("14/11: a yes or no prediction matches a written answer that leads with the same yes or no (13-14/11 ledger phrasings)", () => {
    for (const answer of ["Ναι, 12:15 στο PC μου", "Ναι, έχω ταϊλανδέζικο δίπλωμα/ID", "Yes, send as written", "οκ, το βλέπω αύριο", "ok, after lunch"]) {
      expect(yesNoPredictionMatched("APPROVE", "ANSWERED", answer)).toBe(true);
      expect(yesNoPredictionMatched("DECLINE", "ANSWERED", answer)).toBe(false);
    }
    const no = "Όχι τώρα: το GitHub μένει, συνεχίζω με Stripe";
    expect(yesNoPredictionMatched("DECLINE", "ANSWERED", no)).toBe(true);
    expect(yesNoPredictionMatched("APPROVE", "ANSWERED", no)).toBe(false);
    // No leading yes or no: scored as before, a miss either way.
    for (const answer of ["Δεν απέκλεισα τίποτα!!", "θελω με χρονικα σημεια μεσα στο chat"]) {
      expect(yesNoPredictionMatched("APPROVE", "ANSWERED", answer)).toBe(false);
      expect(yesNoPredictionMatched("DECLINE", "ANSWERED", answer)).toBe(false);
    }
    expect(yesNoPredictionMatched("APPROVE", "APPROVED", null)).toBe(true);
    expect(yesNoPredictionMatched("APPROVE", "DECLINED", "ναι αλλά όχι έτσι")).toBe(false);
    const at = "2026-11-14T01:00:00.000Z";
    const yes = { refs: { prediction: { answer: "yes", confidence: 85 } } };
    expect(predictionAccuracy([decision({ ...yes, status: "ANSWERED", answer: "Ναι, ξεκίνα το τώρα", answeredAt: at }),
      decision({ ...yes, id: "nous_decision:d2", status: "ANSWERED", answer: "Δεν απέκλεισα τίποτα!!", answeredAt: at })], [], "2026-11-14T00:00:00.000Z").decisions)
      .toEqual({ matched: 1, total: 2 });
  });

  it("goal 7365014c step 2: the server marks couldHaveDecided on a send May send covers, never on another decision", async () => {
    // 6/11 measurement: couldHaveDecided read 0 because only the operator's feedback button set it.
    const repository = new InMemoryNousRepository();
    let maySend = false;
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20, maySend }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) },
      executeAction: vi.fn(async () => "sent") } as unknown as NousServiceDeps);
    const send = await service.ask({ ownerUserId: owner, category: "EXTERNAL", title: "Send the reply", body: "To Anna", options: [], recommendation: "Prediction: yes (90 %)",
      refs: { sendKind: "mail-reply" }, action: { type: "SPACE_CONTROL", roomId: "room:r1", actions: [{ kind: "pane", operation: "prompt", text: "send it", target: { paneIds: ["pane:p1"] } }] } });
    const other = await service.ask({ ownerUserId: owner, category: "DIRECTION", title: "Which way?", body: "", options: [], recommendation: "Prediction: yes (90 %)", refs: {}, action: null });
    expect([send.status, other.status]).toEqual(["OPEN", "OPEN"]);
    maySend = true;
    expect((await service.answer(owner, send.id, { answer: "APPROVE" })).couldHaveDecided).toBe(true);
    expect((await service.answer(owner, other.id, { answer: "ANSWER", text: "left" })).couldHaveDecided).toBe(false);
    // 13/11 (Kevin's mail, the wrong meeting time): a declined send needed the ask.
    const wrong = await service.ask({ ownerUserId: owner, category: "EXTERNAL", title: "Send the correction to Kevin", body: "Mon 17:00", options: [],
      recommendation: "Prediction: yes (90 %)", refs: { sendKind: "mail-reply" }, action: null });
    expect((await service.answer(owner, wrong.id, { answer: "DECLINE" })).couldHaveDecided).toBe(false);
    await service.idle(owner);
  });

  it("appends the operator's rail answers to the ledger once each", async () => {
    // 28/10: the ledger held 43 rows while the day's answers were 48 (the rails' own answers never reached it).
    const repository = new InMemoryNousRepository();
    const answers = vi.fn(async () => [
      { source: "Mail Copilot", id: "mailevt:review0001", type: "REVIEW_DECIDED", decision: "approve", title: "You approved the reply; it was sent", at: "2026-10-28T10:00:00.000Z" },
      { source: "Job Copilot", id: "jobevt:answer0001", type: "ANSWERED", decision: "answered", title: "You answered: 10260", at: "2026-10-28T10:05:00.000Z" }]);
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    expect(await syncRailLedger(owner, answers, repository, now)).toBe(2);
    expect(await syncRailLedger(owner, answers, repository, now + 600_000)).toBe(0);
    expect((await repository.listLedger(owner, "2000-01-01T00:00:00.000Z")).map(({ source, kind, answer, ref, match }) => [source, kind, answer, ref, match])).toEqual(expect.arrayContaining([
      ["RAIL:Mail Copilot", "REVIEW_DECIDED", "approve", "Mail Copilot:mailevt:review0001", null], ["RAIL:Job Copilot", "ANSWERED", "answered", "Job Copilot:jobevt:answer0001", null]]));
    expect(answers).toHaveBeenLastCalledWith(owner, new Date(now + 600_000 - 24 * 3_600_000).toISOString());
  });
});

describe("plan clipboard:USQ6ktIIN_1D: a prediction on every rail answer, and the ledger file and decision-rules note written by Space", () => {
  it("predicts a rail answer from the rail and kind's earlier answers (5 or more, 80 %), never a question's bare \"answered\"", async () => {
    const repository = new InMemoryNousRepository();
    for (const n of [1, 2, 3, 4, 5]) await repository.appendLedger({ ownerUserId: owner, source: "RAIL:Marketing Copilot", kind: "POST_DECIDED", title: `Post ${n}`, predicted: null, answer: "approve", match: null, ref: `Marketing Copilot:mktevt:p${n}` });
    const answers = vi.fn(async () => [
      { source: "Marketing Copilot", id: "mktevt:p6", type: "POST_DECIDED", decision: "approve", title: "Post 6", at: "2026-11-03T10:00:00.000Z" },
      { source: "Marketing Copilot", id: "mktevt:p7", type: "POST_DECIDED", decision: "reject", title: "Post 7", at: "2026-11-03T10:01:00.000Z" },
      { source: "Mail Copilot", id: "mailevt:r1", type: "REVIEW_DECIDED", decision: "approve", title: "Reply", at: "2026-11-03T10:02:00.000Z" },
      { source: "Job Copilot", id: "jobevt:q1", type: "ANSWERED", decision: "answered", title: "You answered: 10260", at: "2026-11-03T10:03:00.000Z" }]);
    expect(await syncRailLedger(owner, answers, repository)).toBe(4);
    const rows = await repository.listLedger(owner, "2000-01-01T00:00:00.000Z");
    expect(Object.fromEntries(rows.filter((row) => !/Marketing Copilot:mktevt:p[1-5]$/.test(row.ref ?? "")).map((row) => [row.ref, [row.predicted, row.match]]))).toEqual({
      "Marketing Copilot:mktevt:p6": ["approve", true], "Marketing Copilot:mktevt:p7": ["approve", false],
      "Mail Copilot:mailevt:r1": [null, null], "Job Copilot:jobevt:q1": [null, null] });
  });

  it("appends each new ledger row to the file with its rule, and keeps the note's Space part to the kinds whose last answers agree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-ledger-"));
    const file = join(dir, "decisions", "ledger.md");
    const rows: NousLedgerRow[] = [];
    const notes = new Map<string, string>([[DECISION_RULES_NOTE, "Nous's own rule: company facts come from memory."]]);
    const repo = {
      listLedger: async () => [...rows].reverse(),
      listNotes: async () => [...notes].map(([key, text]) => ({ key, text, updatedAt: "2026-11-03T00:00:00.000Z" })),
      setNote: vi.fn(async (_owner: string, key: string, text: string | null) => { if (text === null) notes.delete(key); else notes.set(key, text); })
    };
    const row = (at: string, extra: Partial<NousLedgerRow>): NousLedgerRow => ({ ownerUserId: owner, source: "NOUS_DECISION", kind: "EXTERNAL", title: "Send the offer",
      predicted: "APPROVE", answer: "APPROVED", match: true, ref: `nous_decision:${at}`, at, ...extra });
    const mirror = (now: string) => mirrorLedger(owner, repo, { file, timeZone: "Asia/Bangkok", now: Date.parse(now) });
    rows.push(row("2026-11-03T09:00:00.000Z", {}));
    // The first run only marks where it starts: the rows before it are Nous's own lines.
    expect(await mirror("2026-11-03T09:30:00.000Z")).toBe(0);
    writeFileSync(file, "# Ledger\n3/11: 8 answers, 4 HIT.\n");
    rows.push(row("2026-11-03T10:00:00.000Z", { title: "Pay | renew" }), row("2026-11-03T10:00:00.000Z", { source: "ALLOWANCE", answer: "APPROVED: allowance maySend", predicted: null, match: null, ref: "nous_decision:allow" }),
      row("2026-11-03T10:05:00.000Z", { source: "NEEDS_YOU:NOUS", kind: "NOUS:QUESTION", title: "Ready now?", predicted: "Go now", answer: "Later today", match: false, ref: "notification:c1" }));
    expect(await mirror("2026-11-03T10:10:00.000Z")).toBe(3);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines.slice(2, 5)).toEqual(["", "| When | Source kind | Title | Prediction | Answer | Match | Rule |", "|---|---|---|---|---|---|---|"]);
    expect(lines).toContain("| 2026-11-03 17:00 | NOUS_DECISION EXTERNAL | Pay \\| renew (nous_decision:2026-11-03T10:00:00.000Z) | APPROVE | APPROVED | HIT | rule: APPROVED (2 in a row) |");
    expect(lines).toContain("| 2026-11-03 17:00 | ALLOWANCE EXTERNAL | Send the offer (nous_decision:allow) | — | APPROVED: allowance maySend | — | — |");
    expect(lines).toContain("| 2026-11-03 17:05 | NEEDS_YOU:NOUS NOUS:QUESTION | Ready now? (notification:c1) | Go now | Later today | MISS | — |");
    expect(notes.get(DECISION_RULES_NOTE)).toBe("Nous's own rule: company facts come from memory.\n\nLearned from the operator's answers (Space rewrites this part from the decision ledger; "
      + "a kind leaves it when an answer differs):\n- NOUS_DECISION EXTERNAL: APPROVED (last 2 answers alike, latest 2026-11-03 17:00)\n(end of Space's part)");
    // Nothing new: no line, no note write. A different answer ends the rule; Nous's text after Space's part stays.
    repo.setNote.mockClear();
    expect(await mirror("2026-11-03T10:20:00.000Z")).toBe(0);
    expect(repo.setNote).not.toHaveBeenCalled();
    notes.set(DECISION_RULES_NOTE, `${notes.get(DECISION_RULES_NOTE)}\n\nNous added this later.`);
    rows.push(row("2026-11-03T11:00:00.000Z", { answer: "DECLINED: not this one", match: false }));
    expect(await mirror("2026-11-03T11:10:00.000Z")).toBe(1);
    expect(notes.get(DECISION_RULES_NOTE)).toBe("Nous's own rule: company facts come from memory.\n\nNous added this later.");
    expect(readFileSync(file, "utf8").trimEnd().split("\n").at(-1)).toBe("| 2026-11-03 18:00 | NOUS_DECISION EXTERNAL | Send the offer (nous_decision:2026-11-03T11:00:00.000Z) | APPROVE | DECLINED: not this one | MISS | — |");
  });
});
