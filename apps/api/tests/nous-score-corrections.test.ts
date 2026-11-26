import { describe, expect, it, vi } from "vitest";
import { nousTurnFactsSchema } from "@space/contracts";
import { nousScoreErrors } from "../src/nous/score.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { errorCause } from "../src/room-agent-tools.js";

// 13/11 Score lever "Daily Nous errors": a card answer ("[Room · Pane] My answer to …") is never an operator correction.
const card = { id: "nous_msg:card0001", kind: "OPERATOR", ownerUserId: "user:operator", meta: { person: true },
  content: "[Dino · Emma] My answer to \"Outlier: να συνεχίσω;\": ναι" };
const real = { id: "nous_msg:real0001", kind: "OPERATOR", ownerUserId: "user:operator", meta: { person: true },
  content: "Λάθος, το B2 είναι κλειστό μόνο στο pve-az" };
describe("space_nous_outcome corrections", () => {
  const tools = createNousTools({ listConversation: async () => [card, real] } as unknown as NousToolDeps);
  const ctx = (replyTo: string[]) => ({ owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1",
    turn: { reason: "STANDING", operatorMessage: null, replyTo } }) as never;
  const report = async (replyTo: string[], id?: string) => {
    const result = await tools.execute("space_nous_outcome", { requests: [{ summary: "x", outcome: "PENDING", correction: true, ...(id ? { id } : {}) }] }, ctx(replyTo));
    return (result as { outcomes?: Array<{ correction?: boolean }> }).outcomes?.[0];
  };

  it("drops correction when the bound message is a card answer", async () => {
    expect((await report([card.id]))?.correction).toBeUndefined();
    expect((await report([], card.id))?.correction).toBeUndefined();
  });

  it("keeps a real correction and one named by id outside an operator turn", async () => {
    expect((await report([real.id]))?.correction).toBe(true);
    expect((await report([], real.id))?.correction).toBe(true);
  });

  // 15/11 corrections ×61: "(no message)" corrections were charged unconditionally; two re-charged a4dc1df9 and e2a445ef.
  it("holds a correction bound to no operator message until id names it", async () => {
    const held = await tools.execute("space_nous_outcome", { requests: [{ summary: "Links in the appointments' location field", outcome: "SELF", correction: true }] }, ctx([])) as { ok: boolean; refused?: boolean; result: string };
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("set id");
    expect(await tools.execute("space_nous_outcome", { requests: [{ summary: "Links sent", outcome: "SELF" }] }, ctx([]))).toMatchObject({ ok: true });
  });

  // 14/11 slice 21: "Duplicate of …", "Same correction: …", "Repeat of …" were each charged −5 with no repeats set.
  it("holds a correction that calls itself a repeat until repeats names the first complaint", async () => {
    const send = (request: object) => tools.execute("space_nous_outcome", { requests: [{ outcome: "PENDING", correction: true, ...request }] }, ctx([real.id]));
    const held = await send({ summary: "Duplicate of the 11:37 UpCloud correction; same work with Andy" }) as { ok: boolean; refused?: boolean; result: string };
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("set repeats");
    expect(await send({ summary: "Ίδια διόρθωση: ο Andy δεν είχε τελειώσει" })).toMatchObject({ refused: true });
    expect(await send({ summary: "Επανάληψη: ίδιο λάθος", repeats: card.id })).toMatchObject({ ok: true });
    expect(await send({ summary: "Links in the appointments; Dana's duplicate card closed" })).toMatchObject({ ok: true });
  });

  // 20/11 sixth pass (16/11 1a3e96a0 → 66ac312a, 17/11 89efda83 → ccf452a2): a complaint while the first correction's work was still open was charged again.
  it("holds once per turn a correction without repeats while an earlier correction's request is open", async () => {
    const at = "2026-11-16T13:56:00.000Z";
    const open = [{ key: "k1", messageId: "nous_msg:first001", summary: "Only very big free programs", correction: true, turnId: "nous_turn:t0", openedAt: at, reportedAt: at },
      { key: "k2", messageId: "nous_msg:plain001", summary: "Check the backup", turnId: "nous_turn:t0", openedAt: at, reportedAt: at },
      { key: "k3", messageId: real.id, summary: "B2 only on pve-az", correction: true, turnId: "nous_turn:t0", openedAt: at, reportedAt: at }];
    const reported = vi.fn(async () => undefined);
    const withOpen = createNousTools({ listConversation: async () => [card, real],
      requestDone: { named: async (_owner: string, requests: unknown[]) => requests, openList: async () => open, reported } } as unknown as NousToolDeps);
    const send = (turnId: string, request: object) => withOpen.execute("space_nous_outcome", { requests: [{ summary: "Small programs still listed",
      outcome: "PENDING", correction: true, ...request }] }, { owner: "user:operator", turnId, callId: "toolu_1", traceId: "trace:1",
      turn: { reason: "STANDING", operatorMessage: null, replyTo: [real.id] } } as never) as Promise<{ ok: boolean; refused?: boolean; result: string }>;
    const held = await send("nous_turn:t2", {});
    expect(held).toMatchObject({ ok: false, refused: true });
    expect(held.result).toContain("nous_msg:first001");
    expect(held.result).not.toContain("nous_msg:plain001");
    expect(held.result).not.toContain(real.id);
    expect(reported).not.toHaveBeenCalled();
    expect(await send("nous_turn:t2", {})).toMatchObject({ ok: true });
    expect(await send("nous_turn:t3", { repeats: "nous_msg:first001" })).toMatchObject({ ok: true });
    expect(await send("nous_turn:t4", { correction: false })).toMatchObject({ ok: true });
    expect(reported).toHaveBeenCalledTimes(3);
  });
});

// 14/11 slice 7: corrections stored before the tool rule reached stable (3 of 55 in 7 days) cost nothing in the score either.
describe("score: a correction bound only to card answers", () => {
  const fact = (id: string, messageIds: string[]) => nousTurnFactsSchema.parse({ turnId: id, ownerUserId: "user:operator", reason: "OPERATOR", status: "DONE",
    startedAt: "2026-11-13T11:50:00.000Z", endedAt: "2026-11-13T11:52:00.000Z", planPoints: 0, tools: {},
    outcomes: [{ summary: "x", outcome: "SELF", correction: true, messageIds }] });
  const corrections = (facts: ReturnType<typeof fact>[]) => nousScoreErrors({ now: Date.parse("2026-11-14T00:00:00.000Z"), timeZone: "UTC", facts, decisions: [], lessons: [],
    messages: [{ id: card.id, text: card.content }, { id: real.id, text: real.content }] }).reduce((sum, day) => sum + day.corrections, 0);

  it("costs nothing; one that also binds a real correction, or no message, still counts", () => {
    expect(corrections([fact("nous_turn:a", [card.id])])).toBe(0);
    expect(corrections([fact("nous_turn:b", [card.id, real.id])])).toBe(1);
    expect(corrections([fact("nous_turn:c", [])])).toBe(1);
  });
});

// 22/11 corrections ×39: two burst repeats and one order, stored before the 20/11 hold, were charged as corrections.
describe("score: the three stored rows the 22/11 read found were no correction", () => {
  const fact = (id: string, messageIds: string[]) => nousTurnFactsSchema.parse({ turnId: id, ownerUserId: "user:operator", reason: "OPERATOR", status: "DONE",
    startedAt: "2026-11-18T15:30:00.000Z", endedAt: "2026-11-18T15:30:00.000Z", planPoints: 0, tools: {},
    outcomes: [{ summary: "x", outcome: "SELF", correction: true, messageIds }] });
  const corrections = (ids: string[][]) => nousScoreErrors({ now: Date.parse("2026-11-19T00:00:00.000Z"), timeZone: "UTC", decisions: [], lessons: [],
    facts: ids.map((messageIds, index) => fact(`nous_turn:n${index}`, messageIds)) }).reduce((sum, day) => sum + day.corrections, 0);

  it("costs nothing for them; the first complaint, the stale card and a row that also binds a real message still count", () => {
    expect(corrections([["nous_msg:66ac312a9c12453db20081ad"], ["nous_msg:ccf452a2bf474536b8d4e685"], ["nous_msg:74a2b4338ca74e0e92394df9"]])).toBe(0);
    expect(corrections([["nous_msg:1a3e96a0644d49c99710747c"], ["nous_msg:4fa67673648d4e7da30f0eda"]])).toBe(2);
    expect(corrections([["nous_msg:74a2b4338ca74e0e92394df9", "nous_msg:4fa67673648d4e7da30f0eda"]])).toBe(1);
  });
  it("22/11 second read: db5f61ca repeats 89efda83's reset while that work ran; 89efda83 still counts", () => {
    expect(corrections([["nous_msg:89efda83a97d49e6a3ff0282"], ["nous_msg:db5f61cafe3847b1ad5f59f6"]])).toBe(1);
  });
});

// Slice 15: 13/11 14:22 the operator's «δεν δουλεύει ούτε απο εκεί!!!» reached Nous twice in the same second; each got its own correction outcome.
describe("score: a double send is one correction", () => {
  const fact = (id: string, endedAt: string, messageIds: string[]) => nousTurnFactsSchema.parse({ turnId: id, ownerUserId: "user:operator", reason: "OPERATOR", status: "DONE",
    startedAt: endedAt, endedAt, planPoints: 0, tools: {}, outcomes: [{ summary: "x", outcome: "SELF", correction: true, messageIds }] });
  const text = "δεν δουλεύει ούτε απο εκεί!!! φτιάξε μου νέα έκδοση";
  const messages = [{ id: "nous_msg:aaaaaaaa1", text, at: "2026-11-13T14:22:01.000Z" }, { id: "nous_msg:aaaaaaaa2", text: ` ${text.toUpperCase()} `, at: "2026-11-13T14:22:02.000Z" },
    { id: "nous_msg:aaaaaaaa3", text, at: "2026-11-13T15:30:00.000Z" }, { id: "nous_msg:aaaaaaaa4", text: "άλλο πράγμα", at: "2026-11-13T14:22:03.000Z" }];
  const corrections = (ids: string[]) => nousScoreErrors({ now: Date.parse("2026-11-14T00:00:00.000Z"), timeZone: "UTC", decisions: [], lessons: [], messages,
    facts: ids.map((id, index) => fact(`nous_turn:d${index}`, `2026-11-13T16:0${index}:00.000Z`, [id])) }).reduce((sum, day) => sum + day.corrections, 0);

  it("costs once; the same words an hour later or other words seconds later still count", () => {
    expect(corrections(["nous_msg:aaaaaaaa1", "nous_msg:aaaaaaaa2"])).toBe(1);
    expect(corrections(["nous_msg:aaaaaaaa1", "nous_msg:aaaaaaaa3"])).toBe(2);
    expect(corrections(["nous_msg:aaaaaaaa1", "nous_msg:aaaaaaaa4"])).toBe(2);
  });

  // 14/11 Score lever #1 (corrections ×61, lessons ×17): the day row names what it counted, so a code-fix pane can group the causes.
  it("names each counted correction and lesson, not the ones it leaves out", () => {
    const days = nousScoreErrors({ now: Date.parse("2026-11-14T00:00:00.000Z"), timeZone: "UTC", decisions: [], messages,
      facts: ["nous_msg:aaaaaaaa1", "nous_msg:aaaaaaaa2"].map((id, index) => fact(`nous_turn:r${index}`, `2026-11-13T16:0${index}:00.000Z`, [id])),
      lessons: [{ key: "lessons-own-catch", text: "self-found", updatedAt: "2026-11-13T18:00:00.000Z", createdAt: "2026-11-13T18:00:00.000Z" }] });
    expect(days.flatMap((day) => day.records ?? [])).toEqual(["correction nous_msg:aaaaaaaa1: x", "lesson lessons-own-catch 2026-11-13T18:00:00.000Z"]);
  });
});

// Operator 14/11 09:34 BKK (nous_msg:adc1046a, Collabify): «μην ξαναδωσεις αρνητικη απαντηση» on a job application.
describe("space_copilot_answer: a No to the Job Copilot", () => {
  it("is held once per turn and question; a Yes, another copilot's No and the second call pass", async () => {
    const answerQuestion = vi.fn(async () => "Answered.");
    const jobs = createNousTools({ copilots: { items: async () => [], answerQuestion } } as unknown as NousToolDeps);
    const turn = { owner: "user:operator", turnId: "nous_turn:j1", callId: "toolu_1", traceId: "trace:1", turn: { reason: "OPERATOR", operatorMessage: null, replyTo: [] } } as never;
    const no = { copilot: "JOB", question: "jobq:collabify", answer: "No. SpaceApp has no paying customers yet." };
    expect(await jobs.execute("space_copilot_answer", no, turn)).toMatchObject({ ok: false, refused: true, display: "Held once: a negative answer to a job application" });
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(await jobs.execute("space_copilot_answer", { ...no, answer: "Όχι, δεν χρειάζομαι visa sponsorship.", question: "jobq:visa" }, turn)).toMatchObject({ refused: true });
    expect(await jobs.execute("space_copilot_answer", { ...no, answer: "Yes: SpaceApp and example.invalid." }, turn)).toMatchObject({ ok: true });
    expect(await jobs.execute("space_copilot_answer", { ...no, copilot: "MAIL", answer: "No, archive it." }, turn)).toMatchObject({ ok: true });
    expect(await jobs.execute("space_copilot_answer", no, turn)).toMatchObject({ ok: true });
    expect(answerQuestion).toHaveBeenCalledTimes(3);
  });
});

describe("space_db_query failures (13/11 Score lever)", () => {
  it("tells a slow query apart from an unavailable database", () => {
    const slow = errorCause("Postgres: canceling statement due to statement timeout (code 57014)");
    expect(slow).toContain("query too slow");
    expect(slow).not.toContain("database unavailable");
    expect(errorCause("Connection terminated unexpectedly")).toContain("database unavailable");
  });
});

describe("Nous persona (13/11 Score lever)", () => {
  it("asks for a re-check or a date before a remembered fact is stated as current", async () => {
    const persona = (await import("../src/nous/service.js")).NOUS_PERSONA;
    expect(persona).toContain("give its date and say you did not re-check it");
    expect(persona).toContain("A cause you name is one you read on its source (log, page, mail, code) this turn; otherwise call it a guess");
    expect(persona).toContain("not a new request, a card answer or a repeat while you were still working");
    expect(persona).toContain("Your reading adds and drops nothing: no stop, hold or \"plan first, code later\" they did not say");
    expect(persona).toContain("goes to that pane in the same turn: your answer says who does it now, not only why it was not done");
  });
});

describe("TURN_CLAIMS asked-unquoted (15/11 REVIEW corrections)", () => {
  it("finds a sentence saying what the operator asked without their words, not one that quotes them or says nothing they asked", async () => {
    const { askedUnquotedSentence } = await import("../src/nous/service.js");
    expect(askedUnquotedSentence("Έγινε. Ζήτησες να μεταφραστούν τα tabs του μενού.")).toBe("Ζήτησες να μεταφραστούν τα tabs του μενού.");
    expect(askedUnquotedSentence("You asked me to rename the menu tabs.")).toBe("You asked me to rename the menu tabs.");
    // DEV3D-044: a past ask after "when" is a claim, not an offer.
    expect(askedUnquotedSentence("When you asked me to restart the panes, I restarted them all.")).toBe("When you asked me to restart the panes, I restarted them all.");
    expect(askedUnquotedSentence("Όταν ζήτησες να κλείσουν, τα έκλεισα.")).toBe("Όταν ζήτησες να κλείσουν, τα έκλεισα.");
    for (const text of ["Ζήτησες «να φτιάξεις τα ελληνικά ονόματα αρχείων», το κάνει ο Bob.", "You asked for \"Greek file names\": Bob does it now.",
      "Δεν ζήτησες να κλείσει.", "As you asked, Bob runs it now.", "Ο Bob ξεκίνησε το build.", "Do you want me to proceed?", "Θέλεις να το κλείσω;",
      // DEV3D-036: an offer is no claim about what they asked.
      "If you want me to restart it, say so.", "Αν θέλεις να το κλείσω, πες το.", "Whenever you want me to promote, I will."]) expect(askedUnquotedSentence(text)).toBeNull();
  });
});
