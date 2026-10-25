import { describe, expect, it } from "vitest";
import type { CouncilAnswer, CouncilModel, CouncilPlan, CouncilPosition, CouncilReview } from "@space/contracts";
import { InMemoryCouncilRepository } from "@space/db";
import { COUNCIL_PROMPT_LIMIT, buildClipboardPlanPrompt, buildFinalPrompt, buildMergePrompt, buildPlanPrompt, buildReviewPrompt } from "../src/council/prompts.js";
import { anonymizeModelText, consensusLine, councilAgreementReached, councilTopEntries, rankCouncilPositions, scrubContactDetails } from "../src/council/ranking.js";
import { createCouncilService, jsonReply, normalizeCouncilPlan, parseCouncilAnswer, parseCouncilReview } from "../src/council/service.js";
import { finalMessageFromResponsesStream, finalTextFromResponsesStream, parseSearchFindings } from "../src/council/web-search.js";
import { notifyCouncilStatus } from "../src/council/wiring.js";

const position = (id: string, support = 1): CouncilPosition => ({ id, title: `Option ${id}`, summary: `Summary ${id}`, support });
const review = (modelId: string, scores: Record<string, number>): CouncilReview => ({
  modelId, status: "DONE", corrections: [], missing: [], error: null,
  scores: Object.entries(scores).map(([positionId, score]) => ({ positionId, score, verdict: score >= 7 ? "agree" : "partly", issue: "" }))
});
const plan: CouncilPlan = {
  understanding: "Earn 100 euros today.", personalContext: "Developer in Athens.", reviewRounds: 1, agreementTarget: 0.67,
  members: [{ modelId: "codex/gpt-6-astra", reason: "" }, { modelId: "opencode/free", reason: "" }],
  criteria: [{ id: "feasibility", label: "Feasible today" }], searchQueries: []
};

describe("council ranking", () => {
  it("puts positions most reviewers agree with first, then by mean and spread", () => {
    const positions = [position("P1", 3), position("P2", 1), position("P3", 2)];
    const ranking = rankCouncilPositions(positions, [
      review("a", { P1: 9, P2: 10, P3: 8 }), review("b", { P1: 8, P2: 3, P3: 8 }), review("c", { P1: 7, P2: 10, P3: 8 })
    ]);
    expect(ranking.map((entry) => entry.positionId)).toEqual(["P3", "P1", "P2"]);
    expect(ranking[0]).toMatchObject({ positionId: "P3", mean: 8, agreeShare: 1, spread: 0, reviewers: 3, qualified: true });
    expect(ranking[2]).toMatchObject({ positionId: "P2", qualified: true });
    expect(consensusLine(ranking[0]!)).toBe("8.0/10 · 3 of 3 agree");
  });

  it("ranks an unqualified high mean below every qualified position and checks the agreement target", () => {
    const ranking = rankCouncilPositions([position("P1"), position("P2")], [review("a", { P1: 10, P2: 7 }), review("b", { P1: 6, P2: 7 }), review("c", { P1: 6, P2: 7 })]);
    expect(ranking.map((entry) => entry.positionId)).toEqual(["P2", "P1"]);
    expect(councilAgreementReached(ranking, 0.67)).toBe(false);
    expect(councilAgreementReached(ranking.slice(0, 1), 0.67)).toBe(true);
    expect(councilTopEntries(ranking).map((entry) => entry.positionId)).toEqual(["P2"]);
    expect(councilTopEntries(rankCouncilPositions([position("P1")], [review("a", { P1: 3 })])).map((entry) => entry.positionId)).toEqual(["P1"]);
  });

  it("removes who-wrote-it hints and contact details but keeps dates and amounts", () => {
    expect(anonymizeModelText("As Claude, and unlike GPT-6 Astra or Gemini, I think…")).toBe("As a model, and unlike a model a model or a model, I think…");
    expect(scrubContactDetails("Mail nikos@example.com or call +30 691 234 5678 by 2026-10-14 for 100 euros"))
      .toBe("Mail [email removed] or call [phone removed] by 2026-10-14 for 100 euros");
  });

  it("drops unknown or repeated positions from a review and bounds the scores", () => {
    expect(parseCouncilReview('{"scores":[{"positionId":"P1","score":12,"verdict":"AGREE"},{"positionId":"P1","score":2},{"positionId":"P9","score":5}]}', [position("P1")]))
      .toEqual({ scores: [{ positionId: "P1", score: 10, verdict: "agree", issue: "" }], corrections: [], missing: [] });
  });

  it("keeps only available models in a plan and fills it up to three voices", () => {
    const models: CouncilModel[] = [
      { id: "codex/gpt-6-astra", displayName: "Astra", providerId: "codex", available: true, note: null },
      { id: "claude/claude-opus-5-5", displayName: "Opus", providerId: "claude", available: false, note: "stable only" },
      { id: "opencode/free", displayName: "Free", providerId: "opencode", available: true, note: null }
    ];
    const normalized = normalizeCouncilPlan({ understanding: "x", personalContext: "Call 6912345678", members: [{ modelId: "claude/claude-opus-5-5" }, { modelId: "codex/gpt-6-astra" }],
      reviewRounds: 9, criteria: [{ id: "1 Bad Id", label: "Cost" }], searchQueries: ["a b c"] }, models, false);
    expect(normalized.members.map((member) => member.modelId)).toEqual(["codex/gpt-6-astra", "opencode/free"]);
    expect(normalized).toMatchObject({ personalContext: "Call [phone removed]", reviewRounds: 3, searchQueries: [], criteria: [{ id: "badid", label: "Cost" }] });
  });
});

describe("council prompts", () => {
  const long = "x".repeat(5_000);
  const answers: CouncilAnswer[] = Array.from({ length: 8 }, (_, index) => ({
    modelId: "codex/gpt-6-astra", status: "DONE", text: `As Claude I say ${long}`, claims: Array.from({ length: 6 }, () => "c".repeat(160)), error: null, ms: 1 + index
  }));
  const positions = Array.from({ length: 10 }, (_, index) => ({ ...position(`P${index + 1}`), summary: "s".repeat(600), title: "t".repeat(160) }));
  const reviews = Array.from({ length: 8 }, (_, index) => ({ ...review(`codex/m${index}`, Object.fromEntries(positions.map((item) => [item.id, 8]))), corrections: ["r".repeat(300)], missing: ["m".repeat(300)] }));
  const ranking = rankCouncilPositions(positions, reviews);
  const evidence = Array.from({ length: 8 }, (_, index) => ({ title: "e".repeat(200), url: `https://example.com/${index}`, finding: "f".repeat(400) }));

  it("keeps every prompt under the one-shot CLI limit and the answers anonymous", () => {
    const merge = buildMergePrompt({ question: "q".repeat(2_000), plan: { ...plan, personalContext: "p".repeat(2_500) }, answers, previous: null });
    expect(merge.length).toBeLessThanOrEqual(COUNCIL_PROMPT_LIMIT);
    expect(merge).toContain("ANSWER H:");
    expect(merge).not.toMatch(/claude|gpt-6/i);
    const prompts = [
      buildPlanPrompt({ question: "q".repeat(2_000), qa: [], questionsAllowed: true, models: [], webSearch: true, personalData: long.repeat(3), previousPlan: plan,
        changeRequests: ["c".repeat(2_000)], memoryQueriesAllowed: true }),
      buildMergePrompt({ question: "q".repeat(2_000), plan, answers, previous: { merged: long, positions, ranking, reviews } }),
      buildReviewPrompt({ question: "q".repeat(2_000), plan: { ...plan, personalContext: "p".repeat(2_500) }, evidence, merged: long, positions }),
      buildFinalPrompt({ question: "q".repeat(2_000), plan, evidence, merged: long, positions, ranking, reviews, top: 3 }),
      buildClipboardPlanPrompt({ question: "q".repeat(2_000), personalContext: "p".repeat(2_500), final: "f".repeat(12_000) })
    ];
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(COUNCIL_PROMPT_LIMIT);
  });
});

describe("council reply parsing", () => {
  it("reads JSON with raw line breaks in strings and answers whose quotes were not escaped", () => {
    expect(jsonReply('{"answer":"Line one\nLine two","claims":["a"]}')).toEqual({ answer: "Line one\nLine two", claims: ["a"] });
    const broken = parseCouncilAnswer('{"answer":"Sell your "old" monitor today\\nfor cash in Athens.","claims":["Sell the "old" monitor","Cash on delivery"]}');
    expect(broken?.text).toBe('Sell your "old" monitor today\nfor cash in Athens.');
    expect(broken?.claims.length).toBeGreaterThan(0);
  });
});

describe("council web search parsing", () => {
  it("falls back to the reply's url citations when the search model answers in prose", () => {
    const text = "Couriers earn per delivery in Athens. Wolt pays weekly (wolt.com).";
    const stream = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text,
      annotations: [{ type: "url_citation", url: "https://wolt.com/couriers", title: "Wolt couriers", start_index: text.indexOf("(wolt"), end_index: text.length - 1 }] }] } })}`;
    const message = finalMessageFromResponsesStream(stream);
    expect(parseSearchFindings(message.text, message.citations)).toEqual([{ title: "Wolt couriers", url: "https://wolt.com/couriers", finding: "Wolt pays weekly" }]);
  });

  it("reads the final message of a streamed reply and keeps only http(s) findings", () => {
    const stream = [
      'data: {"type":"response.output_item.done","item":{"type":"web_search_call"}}',
      `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: '{"findings":[{"title":"Wolt","url":"https://wolt.com/x","finding":"Couriers are paid per order."},{"title":"bad","url":"javascript:alert(1)","finding":"x"}]}' }] } })}`,
      "data: [DONE]"
    ].join("\n");
    expect(parseSearchFindings(finalTextFromResponsesStream(stream))).toEqual([{ title: "Wolt", url: "https://wolt.com/x", finding: "Couriers are paid per order." }]);
  });
});

function fakeCouncil(options: { failOnce?: string; holdModel?: string; hold?: Promise<void>; onStatus?: Parameters<typeof createCouncilService>[0]["onStatus"]; planReply?: string } = {}) {
  const repository = new InMemoryCouncilRepository();
  const calls: Array<{ modelId: string; prompt: string }> = [];
  const savedPlans: Array<Parameters<Parameters<typeof createCouncilService>[0]["savePlan"]>[1]> = [];
  const models: CouncilModel[] = [
    { id: "codex/gpt-6-astra", displayName: "GPT-6 Astra", providerId: "codex", available: true, note: null },
    { id: "codex/gpt-5.6-sol", displayName: "GPT-5.6 Sol", providerId: "codex", available: true, note: null },
    { id: "opencode/free", displayName: "Free", providerId: "opencode", available: true, note: null },
    { id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5", providerId: "claude", available: false, note: "stable only" }
  ];
  let failed = false;
  let held = false;
  const service = createCouncilService({
    repository,
    coordinatorDefault: "claude/claude-opus-5-5",
    webSearchAvailable: true,
    random: () => 0.5,
    onStatus: options.onStatus,
    catalog: async () => models,
    savePlan: async (_owner, plan) => { savedPlans.push(plan); return { id: "clipboard_plan1" }; },
    personalData: async (_owner, _question, memoryQueries) => `PROFILE:\nName: Nikos\nSkills: TypeScript${memoryQueries.length ? "\nSPACE MEMORY: found" : ""}`,
    searchWeb: async (query) => [{ title: `About ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, finding: "A fact." }],
    async callModel({ modelId, prompt, signal }) {
      calls.push({ modelId, prompt });
      if (prompt.includes("Prepare the plan now")) {
        if (!prompt.includes("THE OPERATOR'S ANSWERS")) return '{"questions":["Which city do you live in?"]}';
        if (!prompt.includes("memory was already searched")) return '{"plan":{},"memoryQueries":["skills"]}';
        return JSON.stringify({ plan: { understanding: "Earn 100 euros today in Athens.", personalContext: "Nikos, developer in Athens, nikos@example.com",
          members: [{ modelId: "codex/gpt-6-astra", reason: "web" }, { modelId: "claude/claude-opus-5-5", reason: "unavailable here" }, { modelId: "codex/gpt-5.6-sol", reason: "fast" },
            { modelId: "opencode/free", reason: "free" }],
          reviewRounds: 1, agreementTarget: 0.67, criteria: [{ id: "feasibility", label: "Feasible today" }], searchQueries: ["gig work Athens"] } });
      }
      if (prompt.startsWith("You are one member")) {
        if (modelId === options.holdModel && !held) {
          held = true;
          await Promise.race([options.hold, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
        }
        if (modelId === options.failOnce && !failed) { failed = true; throw new Error("quota reached"); }
        return JSON.stringify({ answer: `As ${modelId}: deliver food with Wolt for a shift.`, claims: ["Courier shift pays about 80-100 euros."] });
      }
      if (prompt.includes("Merge them") || prompt.includes("Revise it")) {
        return JSON.stringify({ merged: "Deliver food, sell items, or freelance.", positions: [
          { id: "P1", title: "Courier shift", summary: "Wolt or efood.", support: 3 },
          { id: "P2", title: "Sell unused items", summary: "Vendora.", support: 2 },
          { id: "P3", title: "Freelance gig", summary: "Upwork.", support: 1 },
          { id: "P4", title: "Lottery", summary: "Buy tickets.", support: 1 }] });
      }
      if (prompt.startsWith("You are a reviewer")) {
        return JSON.stringify({ scores: [{ positionId: "P1", score: 9, verdict: "agree" }, { positionId: "P2", score: 8, verdict: "agree" },
          { positionId: "P3", score: modelId === "opencode/free" ? 5 : 8, verdict: "partly" }, { positionId: "P4", score: 1, verdict: "disagree", issue: "Not a plan." }],
        corrections: ["Wolt needs a few days to onboard."], missing: [] });
      }
      if (prompt.includes("Turn its agreed answer into a plan")) {
        return options.planReply ?? JSON.stringify({ title: "Courier shift today", summary: "Work one Wolt shift.", minimumModel: "", minimumReasoning: "LOW",
          steps: [{ title: "Sign up with Wolt", instructions: "Register.\nUpload documents.", completionCriteria: ["Account approved"] }, { title: "" }, { title: "Do the shift" }] });
      }
      if (prompt.includes("Write the final answer")) return "## Answer\nDo a courier shift.\n## Top 3\n1. Courier shift — 9.0/10 · 3 of 3 agree";
      throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
    }
  });
  return { service, repository, calls, savedPlans };
}

describe("council run", () => {
  const owner = "user:operator";

  it("asks, plans with the operator's memory, waits for approval, then answers, merges anonymously, reviews and finishes", async () => {
    const { service, calls } = fakeCouncil({ failOnce: "opencode/free" });
    const created = await service.create(owner, { question: "Πώς μπορώ να βγάλω 100 ευρώ σε μία μέρα;" });
    expect(created.coordinatorModelId).toBe("codex/gpt-6-astra");
    await service.settled(created.id);
    const asked = await service.get(owner, created.id);
    expect(asked.status).toBe("NEEDS_INPUT");
    expect(asked.qa[0]?.questions).toEqual([{ id: "q1", text: "Which city do you live in?" }]);
    expect(calls[0]?.prompt).toContain("Name: Nikos");

    await service.answer(owner, created.id, { q1: "Athens" });
    await service.settled(created.id);
    const planned = await service.get(owner, created.id);
    expect(planned.status).toBe("AWAITING_APPROVAL");
    expect(planned.plan?.members.map((member) => member.modelId)).toEqual(["codex/gpt-6-astra", "codex/gpt-5.6-sol", "opencode/free"]);
    expect(planned.plan?.personalContext).toBe("Nikos, developer in Athens, [email removed]");
    expect(planned.estimate).toEqual({ calls: 1 + 3 + 4 + 0 + 1, minutes: 6 });
    expect(calls.filter((call) => call.prompt.includes("Prepare the plan now")).at(-1)?.prompt).toContain("SPACE MEMORY: found");

    await expect(service.create(owner, { question: "Another question?" })).rejects.toThrow(/still open/);

    await service.approve(owner, created.id, { personalContext: "Nikos, developer in Athens." });
    await service.settled(created.id);
    const done = await service.get(owner, created.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.evidence).toHaveLength(1);
    expect(done.answers.map((answer) => answer.status)).toEqual(["DONE", "DONE", "FAILED"]);
    expect(done.rounds).toHaveLength(1);
    expect(done.rounds[0]?.ranking.slice(0, 3).map((entry) => entry.positionId)).toEqual(["P1", "P2", "P3"]);
    expect(done.final?.top).toEqual([
      { positionId: "P1", title: "Courier shift", mean: 9, agree: 2, reviewers: 2 },
      { positionId: "P2", title: "Sell unused items", mean: 8, agree: 2, reviewers: 2 },
      { positionId: "P3", title: "Freelance gig", mean: 8, agree: 2, reviewers: 2 }
    ]);
    const merge = calls.find((call) => call.prompt.includes("Merge them"))!.prompt;
    expect(merge).not.toMatch(/gpt|astra|codex|opencode/i);
    const member = calls.find((call) => call.prompt.startsWith("You are one member"))!.prompt;
    expect(member).toContain("Nikos, developer in Athens.");
    expect(member).not.toContain("TypeScript");
    expect(member).toContain("https://example.com/gig%20work%20Athens");

    await service.anotherRound(owner, done.id);
    await service.settled(done.id);
    const again = await service.get(owner, done.id);
    expect(again.status).toBe("COMPLETED");
    expect(again.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(calls.some((call) => call.prompt.includes("Revise it"))).toBe(true);
    await expect(service.get("user:someone-else", done.id)).rejects.toThrow(/not found/);
  });

  it("stops while models answer and resumes without asking the models that already answered", async () => {
    const { service, calls } = fakeCouncil({ holdModel: "opencode/free", hold: new Promise(() => undefined) });
    const run = await service.create(owner, { question: "How can I earn 100 euros today?" });
    await service.settled(run.id);
    await service.answer(owner, run.id, { q1: "Athens" });
    await service.settled(run.id);
    await service.approve(owner, run.id, {});
    for (let wait = 0; wait < 50 && (await service.get(owner, run.id)).answers.filter((answer) => answer.status === "DONE").length < 2; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stopped = await service.stop(owner, run.id);
    expect(stopped.status).toBe("INTERRUPTED");
    expect(stopped.error).toMatch(/Stopped by you/);
    const answeredBefore = stopped.answers.filter((answer) => answer.status === "DONE").map((answer) => answer.modelId);
    expect(answeredBefore).toEqual(["codex/gpt-6-astra", "codex/gpt-5.6-sol"]);
    expect(stopped.answers.find((answer) => answer.modelId === "opencode/free")?.status).toBe("PENDING");

    await service.resume(owner, run.id);
    await service.settled(run.id);
    const finished = await service.get(owner, run.id);
    expect(finished.status).toBe("COMPLETED");
    for (const modelId of answeredBefore) {
      expect(calls.filter((call) => call.modelId === modelId && call.prompt.startsWith("You are one member"))).toHaveLength(1);
    }
    expect(calls.filter((call) => call.modelId === "opencode/free" && call.prompt.startsWith("You are one member"))).toHaveLength(2);
  });

  it("has the coordinator write a plan into the clipboard, and reports a plan it could not write", async () => {
    const finished = async (council: ReturnType<typeof fakeCouncil>) => {
      const run = await council.service.create(owner, { question: "How can I earn 100 euros today?" });
      await council.service.settled(run.id);
      await council.service.answer(owner, run.id, { q1: "Athens" });
      await council.service.settled(run.id);
      await council.service.approve(owner, run.id, {});
      await council.service.settled(run.id);
      return run.id;
    };
    const council = fakeCouncil();
    const id = await finished(council);
    expect((await council.service.createClipboardPlan(owner, id)).clipboardPlan?.status).toBe("WRITING");
    await expect(council.service.anotherRound(owner, id)).rejects.toThrow(/already working/);
    await council.service.settled(id);
    const done = await council.service.get(owner, id);
    expect(done).toMatchObject({ status: "COMPLETED", clipboardPlan: { status: "DONE", itemId: "clipboard_plan1", title: "Courier shift today", error: null } });
    const prompt = council.calls.at(-1)!;
    expect(prompt.modelId).toBe("codex/gpt-6-astra");
    expect(prompt.prompt).toContain("Do a courier shift.");
    const saved = council.savedPlans[0]!;
    expect(saved).toMatchObject({ minimumModel: "GPT-6 Astra", minimumReasoning: "low", steps: [{ title: "Sign up with Wolt", completionCriteria: ["Account approved"] }, { title: "Do the shift", instructions: "" }] });
    expect(saved.text).toBe(["# Courier shift today", "Work one Wolt shift.", `Source: Research Council run ${id}, coordinated by GPT-6 Astra.\nQuestion: How can I earn 100 euros today?`,
      "## Steps\n1. **Sign up with Wolt**\n   Register.\n   Upload documents.\n   Done when: Account approved\n2. **Do the shift**"].join("\n\n"));

    const failing = fakeCouncil({ planReply: "I cannot help with that." });
    const failedId = await finished(failing);
    await failing.service.createClipboardPlan(owner, failedId);
    await failing.service.settled(failedId);
    expect(await failing.service.get(owner, failedId)).toMatchObject({ status: "COMPLETED", clipboardPlan: { status: "FAILED", error: "The coordinator did not return a usable plan." } });
    expect(failing.savedPlans).toEqual([]);

    // A restart dropped the job: the plan shows as failed and can be asked again.
    const stored = await failing.repository.get(owner, failedId);
    await failing.repository.save({ ...stored!, clipboardPlan: { status: "WRITING", itemId: null, title: null, error: null } });
    expect((await failing.service.get(owner, failedId)).clipboardPlan).toMatchObject({ status: "FAILED", error: expect.stringMatching(/server restarted/) });
  });

  it("closes runs a restart left working", async () => {
    const { service, repository } = fakeCouncil();
    const at = "2026-10-14T12:00:00.000Z";
    await repository.create({ id: "council_run:stale123456", ownerUserId: owner, question: "Old question?", coordinatorModelId: "codex/gpt-6-astra", status: "RUNNING",
      stage: "ANSWERS", plan, estimate: null, qa: [], changeRequests: [], evidence: [], answers: [], rounds: [], final: null, events: [], error: null, createdAt: at, updatedAt: at });
    expect(await service.interruptStale()).toBe(1);
    expect(await service.get(owner, "council_run:stale123456")).toMatchObject({ status: "INTERRUPTED", error: expect.stringMatching(/server restarted/) });
  });

  it("notifies when the council needs you and when it finishes, and resolves what you answered", async () => {
    const log: string[] = [];
    const notifications = {
      async raise(input: { kind: string; severity: string; title: string; body: string; dedupeKey: string | null }) {
        log.push(`raise ${input.kind} ${input.severity} ${input.dedupeKey ?? "-"} ${input.title} | ${input.body.split("\n").slice(1).join(" ")}`);
        return {} as never;
      },
      async resolve(_owner: string, key: string) { log.push(`resolve ${key}`); return 0; }
    };
    const { service } = fakeCouncil({ onStatus: (owner, id, run) => notifyCouncilStatus(notifications, owner, id, run) });
    const run = await service.create(owner, { question: "How can I earn 100 euros today?" });
    const key = `council:${run.id}`;
    await service.settled(run.id);
    await service.answer(owner, run.id, { q1: "Athens" });
    await service.settled(run.id);
    await service.approve(owner, run.id, {});
    await service.settled(run.id);
    await service.remove(owner, run.id);
    await service.settled(run.id);
    expect(log).toEqual([
      `resolve ${key}`, `raise NEEDS_INPUT ATTENTION ${key} The council needs your answers | `,
      `resolve ${key}`,
      `resolve ${key}`, `raise AWAITING_APPROVAL ATTENTION ${key} The council's plan waits for your approval | `,
      `resolve ${key}`,
      `resolve ${key}`, "raise COMPLETED INFO - The council finished | 1. Courier shift 2. Sell unused items 3. Freelance gig",
      `resolve ${key}`
    ]);
  });
});
