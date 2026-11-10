import { describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository, type NousNote } from "@space/db";
import { createNousAppParityWatch } from "../src/nous/app-parity.js";
import { renderNousWorld } from "../src/nous/digest.js";
import { claimsDone, createNousLessons, keywordLessons, renderLessons } from "../src/nous/lessons.js";
import { createNousService, type NousRunner } from "../src/nous/service.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

// Operator 31/10 16:25 BKK «Από εκατοντάδες σημειώσεις βλέπω μόνο τις 5 πιο πρόσφατες… φτιάξε μια νέα λογική τύπου space μνήμη»: lessons
// are recalled by relevance, every one of them, whatever their age.
const owner = "user:operator";
const OLD_LESSON = "27/10 20:46 BKK (operator «βρες τα μόνος σου πριν με ρωτήσεις»): I asked him for the Upwork postal code while the Job Copilot memory "
  + "jobmem:postal held it. Do instead: before any card about a postal code, address or residence, search space_memory_recall and the copilot memories.";
const filler = (index: number) => ({ key: `lessons-1031-other-${index}`, updatedAt: `2026-10-31T0${index % 10}:${String(index).padStart(2, "0")}:00.000Z`,
  text: `31/10 incident ${index}: a turn about the merge queue ticket number ${index} and the promote batch timing; do instead: read the queue status first.` });
async function seeded(extra: Array<Pick<NousNote, "key" | "text">> = []) {
  const repository = new InMemoryNousRepository();
  await repository.setNote(owner, "lessons-1027-postal-code", OLD_LESSON);
  for (let index = 0; index < 40; index++) await repository.setNote(owner, filler(index).key, filler(index).text);
  for (const note of extra) await repository.setNote(owner, note.key, note.text);
  await repository.setNote(owner, "plan-map", "A blocks B");
  return repository;
}
// A stand-in for bge-m3: texts on one topic point the same way (cosine 1), others are orthogonal.
const TOPICS = ["postal", "vault", "requests", "queue"];
const topicVector = (text: string) => {
  const vector = new Array(1536).fill(0);
  TOPICS.forEach((topic, index) => { if (text.toLowerCase().includes(topic)) vector[index] = 1; });
  if (vector.every((value) => value === 0)) vector[1535] = 1;
  return vector;
};
const fakeEmbed = vi.fn(async (texts: string[]) => texts.map(topicVector));

describe("Nous's lesson memory (repeat-mistake upgrade 31/10)", () => {
  it("recalls a 27/10 lesson behind 40 newer ones for a matching new message, whole, by keywords alone", async () => {
    const repository = await seeded();
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who) });
    const found = await lessons.recall(owner, "Ποιος είναι ο ταχυδρομικός κώδικας για το Upwork; postal code για τη διεύθυνση");
    expect(found.map((match) => match.key)).toEqual(["lessons-1027-postal-code"]);
    expect(renderLessons(found, "the operator's messages")).toContain(OLD_LESSON);
    // Accents folded: the operator often types without them.
    expect(keywordLessons(await repository.listNotes(owner), "βρες τα μονος σου πριν με ρωτησεις για το upwork").map((match) => match.note.key)).toEqual(["lessons-1027-postal-code"]);
    expect(await lessons.recall(owner, "Ποιος είναι ο καιρός αύριο;")).toEqual([]);
  });

  it("warns when the notes cannot be read instead of rejecting (API audit 5/11: callers fire and forget sync)", async () => {
    const warn = vi.fn();
    const lessons = createNousLessons({ notes: async () => { throw new Error("the database system is in recovery mode"); }, warn });
    await expect(lessons.sync(owner)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("could not be read"));
  });

  it("recalls by meaning with Space Memory's vectors, every relevant lesson and no fixed count", async () => {
    const extra = Array.from({ length: 9 }, (_, index) => ({ key: `lessons-1030-vault-${index}`, text: `Incident ${index}: the Vault unlock was put on the operator again.` }));
    const repository = await seeded(extra);
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), embed: fakeEmbed });
    await lessons.sync(owner);
    const found = await lessons.recall(owner, "Pendings: please open the Vault so the saved logins arrive");
    expect(found.map((match) => match.key).sort()).toEqual(extra.map((note) => note.key).sort());
    expect(found.every((match) => match.similarity === 1)).toBe(true);
    // The old lesson by meaning too, among 40 newer ones.
    expect((await lessons.recall(owner, "postal question for the operator")).map((match) => match.key)).toContain("lessons-1027-postal-code");
  });

  it("lets meaning decide once lessons have vectors, recalls nothing while the first index builds, and keeps only strong keyword matches (stable 31/10: holds of 67 lessons)", async () => {
    const extra = [{ key: "lessons-1030-vault-unlock", text: "Never make his list depend on a Vault unlock." },
      { key: "lessons-1031-queue-words", text: "The merge queue ticket promote batch timing words again: read the queue status first, ticket number and promote batch." }];
    const repository = await seeded(extra);
    // Shares many words with the queue lessons, but its meaning (topic) is the Vault.
    const text = "Vault unlock pendings: the merge queue ticket promote batch timing";
    const vaultOnly = vi.fn(async (texts: string[], purpose: "document" | "query") => texts.map((entry) => purpose === "query" ? topicVector("vault") : topicVector(entry)));
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), embed: vaultOnly });
    await lessons.sync(owner);
    expect((await lessons.recall(owner, text)).map((match) => match.key)).toEqual(["lessons-1030-vault-unlock"]);
    // The first index of this API start is still being built: no keyword noise in the meantime.
    const building = createNousLessons({ notes: (who) => repository.listNotes(who),
      embed: (texts, purpose) => purpose === "query" ? Promise.resolve(texts.map(() => topicVector("vault"))) : new Promise(() => {}) });
    expect(await building.recall(owner, text)).toEqual([]);
    // Keywords alone (no embedder): only matches scoring at least half the best one.
    const notes = [{ key: "lessons-a", text: "alpha bravo charlie delta echo foxtrot golf", updatedAt: "2026-10-31T00:00:00.000Z" },
      { key: "lessons-b", text: "alpha bravo charlie", updatedAt: "2026-10-31T00:00:00.000Z" },
      ...Array.from({ length: 8 }, (_, index) => ({ key: `lessons-z${index}`, text: `zulu yankee x-ray ${index}`, updatedAt: "2026-10-31T00:00:00.000Z" }))];
    expect(keywordLessons(notes, "alpha bravo charlie delta echo foxtrot golf").map((match) => match.note.key)).toEqual(["lessons-a"]);
  });

  it("also recalls a lesson sharing the ask's words when its meaning is near, short of the floor (stable 31/10: approval asks vs lessons-1031-allowances-ask)", async () => {
    const repository = await seeded([
      { key: "lessons-1031-allowances-ask", text: "Why do you still ask me for approvals? Every allowance is on: never ask approval for a guarded restart." }, // a note name, not a credential; gitleaks:allow
      { key: "lessons-1031-restart-words", text: "Guarded restart approval words again, about the restart approval of the pane host." }]);
    // The query points along axis 0; allowances-ask at cosine 0.5 (under the 0.55 floor), every other lesson orthogonal.
    const embed = vi.fn(async (texts: string[], purpose: "document" | "query") => texts.map((entry) => {
      const vector = new Array(1536).fill(0);
      if (purpose === "query") vector[0] = 1;
      else if (entry.startsWith("lessons-1031-allowances-ask")) { vector[0] = 0.5; vector[1] = Math.sqrt(0.75); }
      else vector[2] = 1;
      return vector;
    }));
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), embed });
    await lessons.sync(owner);
    const found = await lessons.recall(owner, "May I run the guarded restart now? Waiting for your approval.");
    expect(found.map((match) => match.key)).toEqual(["lessons-1031-allowances-ask"]);
    expect(found[0]!.similarity).toBeCloseTo(0.5);
  });

  it("fills the turn by rank up to its context budget and names the rest instead of cutting a lesson", () => {
    const matches = Array.from({ length: 3 }, (_, index) => ({ key: `lessons-${index}`, text: `${index}`.repeat(700), updatedAt: "", similarity: 0.9 - index / 10, shared: [] }));
    const text = renderLessons(matches, "this call", 1_500);
    expect(text).toContain("0".repeat(700));
    expect(text).toContain("1".repeat(700));
    expect(text).toContain("- 1 more match (space_lessons {\"query\": …} reads them): lessons-2");
  });

  it("puts the matched lessons in the operator's turn, checks a done claim against the others, and leaves them out of the world's notes", async () => {
    const repository = await seeded([{ key: "lessons-1031-requests-count", text: "31/10 16:12: the Requests tab still showed In progress after I said fixed. "
      + "Do instead: read GET /api/nous/requests counts on stable before saying the In progress count fell." }]);
    const requests: Array<Parameters<NousRunner>[0]> = [];
    const answers = ["Θα το βρω μόνος μου.", "Διορθώθηκε: στο Requests tab τα In progress έπεσαν, ο count είναι τώρα 11."];
    const service = createNousService({ repository, runner: async (input) => { requests.push(input); return { text: answers.shift() ?? "NOTHING_NEW", isError: false }; },
      tools: { execute: vi.fn() } as never, world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never, saveSettings: async (_owner, value) => value, notifications: { raise: vi.fn(), resolve: vi.fn() } as never,
      executeAction: vi.fn(), limits: { inboxDebounceMs: 10 }, lessons: createNousLessons({ notes: (who) => repository.listNotes(who) }) });
    await service.send(owner, "Βάλε τον ταχυδρομικό κώδικα στο Upwork (postal code)");
    await service.idle(owner);
    expect(requests[0]!.prompt).toContain("## Your lessons about this (your memory of the operator's corrections, matched to the operator's messages");
    expect(requests[0]!.prompt).toContain(`[lessons-1027-postal-code] ${OLD_LESSON}`);
    expect(requests[0]!.prompt).not.toContain("lessons-1031-requests-count");
    await service.send(owner, "Τι έγινε με τα In progress;");
    await service.idle(owner);
    // The answer claimed a fix: the lesson about that claim comes back as an inbox line at once.
    await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    expect(requests[2]!.prompt).toContain("Your answer to the operator says it is done or ready. Your lessons about this claim, which that turn did not have: [lessons-1031-requests-count]");
    const world = renderNousWorld({ rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: await repository.listNotes(owner), now: "2026-10-31T10:00:00.000Z" });
    expect(world).toContain("Your memory holds 42 lessons from the operator's corrections, every one kept.");
    expect(world).not.toContain("older notes not shown");
    expect(world).not.toContain("jobmem:postal");
  });

  it("holds an ask once with its lessons, then lets the same call through in that turn", async () => {
    const repository = await seeded();
    const tools = createNousTools({ lessons: createNousLessons({ notes: (who) => repository.listNotes(who) }), setNote: (who, key, text) => repository.setNote(who, key, text) } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "turn:lessons01", callId: "call:1", traceId: "trace:1", turn: { reason: "OPERATOR", operatorMessage: null } } as never;
    const ask = { category: "DIRECTION", title: "Upwork: which postal code for the address?", body: "The Upwork profile asks for the postal code of the residence address.",
      recommendation: "Use the stored one.", options: ["10558", "Other"], checked: ["space_memory_recall postal: nothing"], prediction: { answer: "10558", confidence: 70 } };
    const first = await tools.execute("space_ask_operator", ask, ctx);
    expect(first).toMatchObject({ ok: false, refused: true, display: "Held once: a lesson is about this" });
    expect(first.result).toContain(OLD_LESSON);
    // In the same turn the call passes the lesson check (it then meets the ask's own gates, here an unconfigured decision store).
    expect((await tools.execute("space_ask_operator", ask, ctx)).display).not.toMatch(/^Held once/);
  });

  it("holds a call once per turn and subject, even when its rewrite matches other lessons (R42)", async () => {
    // 2/11 02:10:14 then 02:10:35: one ask held with lessons-1028-bounty-money, rewritten, then held again with lessons-1031-country-per-case.
    const match = (key: string) => ({ key, text: `${key} says what to do.`, updatedAt: "", similarity: 0.8, shared: [] });
    const recall = vi.fn(async (_owner: string, text: string) => [match(text.includes("Thailand") ? "lessons-1031-country-per-case" : "lessons-1028-bounty-money")]);
    const tools = createNousTools({ lessons: { recall } } as unknown as NousToolDeps);
    const ctx = (turnId: string) => ({ owner, turnId, callId: "call:r42", traceId: "trace:r42", turn: { reason: "OPERATOR", operatorMessage: null } }) as never;
    const ask = (body: string, planId?: string) => ({ category: "DIRECTION", title: "GitHub Sponsors payout", body, recommendation: "Personal account.", options: ["Personal", "Company"],
      checked: ["The Sponsors page: payout unset"], prediction: { answer: "Personal", confidence: 70 }, ...(planId ? { refs: { planId } } : {}) });
    expect((await tools.execute("space_ask_operator", ask("Bounty money goes to you."), ctx("turn:r42a"))).display).toBe("Held once: a lesson is about this");
    // The rewrite matches another lesson: the same call subject in the same turn passes the lesson check.
    expect((await tools.execute("space_ask_operator", ask("Payout in Thailand."), ctx("turn:r42a"))).display).not.toMatch(/^Held once/);
    // Another subject in that turn, or the same call in a new turn, meets its lessons.
    expect((await tools.execute("space_ask_operator", ask("Payout in Thailand.", "clipboard:plan0001"), ctx("turn:r42a"))).display).toBe("Held once: a lesson is about this");
    expect((await tools.execute("space_ask_operator", ask("Bounty money goes to you."), ctx("turn:r42b"))).display).toBe("Held once: a lesson is about this");
  });

  it("shows an inbox batch closing a request the lessons about it, so its space_request_done passes the first time (R30-2)", async () => {
    const repository = await seeded();
    const run = vi.fn(async () => ({ ok: true, display: "Recorded the completed request in Done", result: "ok" }));
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who) });
    const tools = createNousTools({ lessons, requestDone: { run } } as unknown as NousToolDeps);
    // R41: the request's id names the batch's item, so the turn's NOTHING_NEW stands (the item was held again once the 5 s floor went).
    const done = { id: "nous_msg:r30", request: "Βάλε τον ταχυδρομικό κώδικα στο Upwork", summary: "The Upwork profile now has the postal code of the residence address from the memory.", where: "no code" };
    const prompts: string[] = [];
    const outcomes: Array<{ ok: boolean; display: string }> = [];
    const service = createNousService({ repository, tools, world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      runner: async (input) => {
        prompts.push(input.prompt);
        outcomes.push(await service.callTool(owner, input.turnId, "space_request_done", done, "call:r30"));
        return { text: "NOTHING_NEW", isError: false };
      },
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never, saveSettings: async (_owner, value) => value, notifications: { raise: vi.fn(), resolve: vi.fn() } as never,
      executeAction: vi.fn(), limits: { inboxDebounceMs: 10 }, lessons });
    const line = "Request nous_msg:r30 looks finished: Upwork profile postal code of the residence address (Cleo/Finn reported done). Record it with space_request_done.";
    await service.notice(owner, "request-done:finished:r30", line, undefined, { soonMs: 10, items: [{ key: "request:r30", kind: "REQUEST", line, messageId: "nous_msg:r30" }] });
    await vi.waitFor(() => expect(outcomes).toHaveLength(1), { timeout: 10_000 });
    expect(prompts[0]).toContain("## Your lessons about this (your memory of the operator's corrections, matched to the requests this batch may close");
    expect(prompts[0]).toContain(`[lessons-1027-postal-code] ${OLD_LESSON}`);
    expect(outcomes[0]).toMatchObject({ ok: true, display: "Recorded the completed request in Done" });
    expect(run).toHaveBeenCalledTimes(1);
    // The hold stays the backstop: a turn whose prompt did not show the lesson is still held once.
    const unseen = { owner, turnId: "turn:r30-other", callId: "call:r30b", traceId: "trace:r30b", turn: { reason: "INBOX", operatorMessage: null } } as never;
    expect(await tools.execute("space_request_done", done, unseen)).toMatchObject({ ok: false, refused: true, display: "Held once: a lesson is about this" });
  });

  it("adds a lesson of a known cause to that lesson as an incident, keeps a distinct one apart, and merges a group", async () => {
    const repository = await seeded([{ key: "lessons-1030-vault-unlock", text: "Never make his list depend on a Vault unlock." }]);
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), embed: fakeEmbed, setNote: (who, key, text) => repository.setNote(who, key, text) });
    await lessons.sync(owner);
    const tools = createNousTools({ lessons, setNote: (who, key, text) => repository.setNote(who, key, text) } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "turn:lessons02", callId: "call:2", traceId: "trace:2", turn: { reason: "OPERATOR", operatorMessage: null } } as never;
    const merged = await tools.execute("space_note", { key: "lessons-1031-vault-again", text: "31/10 10:03: the pendings list asked for a Vault unlock again." }, ctx); // a note name, not a credential; gitleaks:allow
    expect(merged).toMatchObject({ ok: true, display: "Added the lesson to lessons-1030-vault-unlock (same cause)" });
    const notes = await repository.listNotes(owner);
    expect(notes.find((note) => note.key === "lessons-1031-vault-again")).toBeUndefined(); // a note name, not a credential; gitleaks:allow
    expect(notes.find((note) => note.key === "lessons-1030-vault-unlock")?.text).toMatch(/^Never make his list depend on a Vault unlock\.\n\n--- Incident \(\d{4}-\d{2}-\d{2}T[\d:.]+Z, saved as lessons-1031-vault-again\):\nNous observation \(no authority to change user choices\):\n31\/10 10:03/);
    expect(await tools.execute("space_note", { key: "lessons-1031-vault-other", text: "A Vault fill typed the wrong field.", distinct: true }, ctx)).toMatchObject({ display: "Saved the note lessons-1031-vault-other" }); // a note name, not a credential; gitleaks:allow
    await lessons.sync(owner);
    const vaultGroup = (await lessons.duplicates(owner)).find((group) => group.keys.includes("lessons-1030-vault-unlock"));
    expect(vaultGroup).toEqual({ keys: expect.arrayContaining(["lessons-1031-vault-other", "lessons-1030-vault-unlock"]), similarity: 1 });
    expect(vaultGroup!.keys).toHaveLength(2);
    expect((await tools.execute("space_lessons", { merge: { into: "lessons-1030-vault-unlock", from: ["lessons-1031-vault-other"] } }, ctx)).result)
      .toBe("Merged lessons-1031-vault-other into lessons-1030-vault-unlock.");
    const after = await repository.listNotes(owner);
    expect(after.find((note) => note.key === "lessons-1031-vault-other")).toBeUndefined(); // a note name, not a credential; gitleaks:allow
    expect(after.find((note) => note.key === "lessons-1030-vault-unlock")?.text).toContain("--- Incident (merged from lessons-1031-vault-other");
  });

  it("keeps operator instructions intact: the one in a group becomes the merge target (9/11 REVIEW), two of them are refused", async () => {
    const choice = "Operator message nous_msg:source0001: Keep my choice.";
    for (const [into, from] of [["lessons-choice", "lessons-incident"], ["lessons-incident", "lessons-choice"]]) {
      const repository = await seeded([{ key: "lessons-choice", text: choice }, { key: "lessons-incident", text: "A factual incident." }]);
      const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), setNote: (who, key, text) => repository.setNote(who, key, text) });
      expect(await lessons.merge(owner, into!, [from!])).toMatch(/^Merged lessons-incident into lessons-choice/);
      const notes = (await repository.listNotes(owner)).filter((note) => ["lessons-choice", "lessons-incident"].includes(note.key));
      expect(notes.map((note) => note.key)).toEqual(["lessons-choice"]);
      expect(notes[0]!.text).toMatch(new RegExp(`^${choice}\n\n--- Incident \\(merged from lessons-incident`));
    }
    const repository = await seeded([{ key: "lessons-choice", text: choice }, { key: "lessons-other", text: "Operator message nous_msg:source0002: Keep this too." }]);
    const before = await repository.listNotes(owner);
    const lessons = createNousLessons({ notes: (who) => repository.listNotes(who), setNote: (who, key, text) => repository.setNote(who, key, text) });
    expect(await lessons.merge(owner, "lessons-choice", ["lessons-other"])).toContain("Nothing merged: operator instructions");
    // Plan ro5ukMcJnIk4 step 2: through space_lessons the protected-note gate is a refusal, not a tool failure.
    const tools = createNousTools({ lessons, setNote: (who, key, text) => repository.setNote(who, key, text) } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "turn:lessons03", callId: "call:3", traceId: "trace:3", turn: { reason: "OPERATOR", operatorMessage: null } } as never;
    expect(await tools.execute("space_lessons", { merge: { into: "lessons-choice", from: ["lessons-other"] } }, ctx)).toMatchObject({ ok: false, refused: true });
    expect(await repository.listNotes(owner)).toEqual(before);
  });

  it("asks a done claim for what was checked where the operator looks", async () => {
    expect(claimsDone("Διορθώθηκε, τώρα δείχνει 11")).toBe(true);
    expect(claimsDone("Το έλεγξα: είναι έτοιμο στο app")).toBe(true);
    expect(claimsDone("It is fixed on stable")).toBe(true);
    expect(claimsDone("Το κοιτάζω τώρα")).toBe(false);
    const tools = createNousTools({ requestDone: { run: vi.fn(async () => ({ ok: true, display: "Recorded", result: "ok" })) } } as unknown as NousToolDeps);
    const ctx = { owner, turnId: "turn:done01", callId: "call:3", traceId: "trace:3", turn: { reason: "OPERATOR", operatorMessage: { id: "nous_msg:x", content: "", person: true } } } as never;
    const done = { request: "Διόρθωσε τα In progress", summary: "Τα In progress έπεσαν στα 11.", where: "stable" };
    expect(await tools.execute("space_request_done", done, ctx)).toMatchObject({ ok: false, refused: true, display: "Done needs what you checked" });
    expect(await tools.execute("space_request_done", { ...done, verified: "GET /api/nous/requests?status=IN_PROGRESS on stable: counts.IN_PROGRESS 11" }, ctx)).toMatchObject({ ok: true });
    expect(await tools.execute("space_request_done", { ...done, where: "no code" }, ctx)).toMatchObject({ ok: true });
  });
});

describe("Nous app parity line (RCA 31/10, «σε όλα τα nous παντού»)", () => {
  it("names the Nous dock commits on dev once, after the first look", async () => {
    let head = "aaa";
    let at = 0;
    const git = vi.fn(async (args: string[]) => args[0] === "rev-parse" ? `${head}\n`
      : "\x1eabc1234 feat(nous): Requests status filter\napps/web/src/features/nous/NousRequests.tsx\napps/web/src/features/nous/nous.css\n\x1edef5678 fix(quota): red icon\napps/web/src/features/desktop-widgets/AiQuotaWidget.tsx\n");
    const watch = createNousAppParityWatch({ git, now: () => at });
    at = 10 * 60_000;
    expect(await watch.check()).toBeNull();
    head = "bbb";
    at += 60_000;
    expect(await watch.check()).toBeNull();
    at += 10 * 60_000;
    const line = await watch.check();
    expect(line).toContain("The Nous dock changed on dev (2 commits): abc1234 feat(nous): Requests status filter (nous/NousRequests.tsx, nous/nous.css); def5678 fix(quota): red icon (desktop-widgets/AiQuotaWidget.tsx).");
    expect(git).toHaveBeenCalledWith(expect.arrayContaining(["log", "aaa..bbb", "--", "apps/web/src/features/nous"]));
    at += 10 * 60_000;
    expect(await watch.check()).toBeNull();
  });
});
