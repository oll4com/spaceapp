import { describe, expect, it, vi } from "vitest";
import type { SpaceNotification } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { createNousService, toolSubjects, type NousRunner, type NousServiceDeps } from "../src/nous/service.js";
import { heldCardLine, heldQuestionItem, heldQuestionRecall, renderHeldQuestions } from "../src/nous/copilot-questions.js";
import { itemActed, type NousTurnAct } from "../src/nous/turn-items.js";
import { askLines } from "../src/nous/daily-review.js";

// Plan clipboard:7L5KyWp3kQsP step 1 (goal ee5a573e): no copilot question held for Nous is lost by a Nous turn.
const owner = "user:operator";
type Step = (input: Parameters<NousRunner>[0], service: ReturnType<typeof createNousService>) => Promise<{ text: string; isError: boolean }>;
const at = Date.parse("2026-11-01T17:10:06.000Z");
// The real case: held for Nous, it reached one INBOX turn that ended NOTHING_NEW, then sat 9.5 h in Needs you (Job memory held the answer).
const card = {
  id: "notification:76e1658d40044ce4aa31e737", ownerUserId: owner, roomId: "room:alex0001", paneId: "pane:jack0001", source: "JOB_COPILOT", kind: "QUESTION",
  severity: "ATTENTION", title: "Job Copilot needs you", body: "Heritage Holdings asks for your GPA. What should I enter?", link: {}, status: "OPEN",
  dedupeKey: "job-apply:question:jobq:Tcoa0D_0Vp3t", payload: { heldForNous: { until: new Date(at + 60 * 60_000).toISOString() } },
  createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString()
} as unknown as SpaceNotification;
const answer = { copilot: "JOB", question: "jobq:Tcoa0D_0Vp3t", answer: "Skip it: the operator never gives grades (jobmem:S60Ur8lh8uZK)." };

function fixture(steps: Step[], overrides: Partial<NousServiceDeps> = {}) {
  let held = true;
  const requests: Array<Parameters<NousRunner>[0]> = [];
  const execute = vi.fn(async (name: string) => { if (name === "space_copilot_answer" || name === "space_notify_operator") held = false; return { ok: true, display: `did ${name}`, result: `result of ${name}` }; });
  const late: { service?: ReturnType<typeof createNousService> } = {};
  const service = late.service = createNousService({
    repository: new InMemoryNousRepository(),
    runner: async (input) => { requests.push(input); const step = steps.shift(); return step ? step(input, late.service!) : { text: "NOTHING_NEW", isError: false }; },
    tools: { execute },
    world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
    settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never,
    saveSettings: async (_owner, value) => value,
    notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => 0) } as never,
    executeAction: vi.fn(async () => "ok"),
    heldQuestions: async () => held ? [{ card }] : [],
    now: () => at + 12 * 60_000,
    limits: { inboxDebounceMs: 10 },
    ...overrides
  });
  const arrive = () => service.notice(owner, `notification:${card.dedupeKey}`, heldCardLine(card), undefined, { soonMs: 10, items: [heldQuestionItem(card)] });
  return { service, requests, execute, arrive };
}

describe("held copilot questions are never lost by a Nous turn (plan clipboard:7L5KyWp3kQsP step 1)", () => {
  it("pins the question in the turn, holds an INBOX turn's NOTHING_NEW on it and wakes Nous again at once", async () => {
    const f = fixture([async () => ({ text: "NOTHING_NEW", isError: false }), async (input, service) => {
      await service.callTool(owner, input.turnId, "space_copilot_answer", answer, "toolu_answer");
      return { text: "NOTHING_NEW", isError: false };
    }]);
    await f.arrive();
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 15_000 });
    await f.service.idle(owner);
    expect(f.requests[0]!.prompt).toContain("## Copilot questions held for you (answer now)");
    expect(f.requests[0]!.prompt).toContain("asked 17:10 UTC, 12 min ago; 48 min of its hold left, then it goes to the operator");
    expect(f.requests[1]!.prompt).toContain("Held: your INBOX turn answered NOTHING_NEW while an item below had no act");
    expect(f.requests[1]!.prompt).toContain("A copilot question held for you (1) holds any turn");
    expect(f.service.questionShown(owner, card.id)).toBe(2);
    expect(f.requests).toHaveLength(2);
  }, 30_000);

  it("holds a turn that answered in words too, until the question is answered or forwarded", async () => {
    const f = fixture([async () => ({ text: "Plans moved; nothing else.", isError: false }), async (input, service) => {
      await service.callTool(owner, input.turnId, "space_notify_operator", { room: "Alex", pane: "Jack", title: "Job Copilot asks", items: [{ text: "GPA?", ref: card.id }],
        checked: ["Job memory: no GPA entry"] }, "toolu_card");
      return { text: "NOTHING_NEW", isError: false };
    }]);
    await f.arrive();
    await vi.waitFor(() => expect(f.requests).toHaveLength(2), { timeout: 15_000 });
    await f.service.idle(owner);
    expect(f.requests[1]!.prompt).toContain("Held: your INBOX turn ended while a copilot question held for you below had no act");
    expect(f.requests).toHaveLength(2);
  }, 30_000);

  it("holds an operator turn's outcome report once while a pinned question has no act, and wakes an INBOX turn for the question it left", async () => {
    const f = fixture([async (input, service) => {
      const first = await service.callTool(owner, input.turnId, "space_nous_outcome", { requests: [{ summary: "Answered the operator", outcome: "SELF", answerOnly: true }] }, "toolu_o1");
      expect(first).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Not recorded yet") });
      expect(first.result).toContain("jobq:Tcoa0D_0Vp3t");
      const second = await service.callTool(owner, input.turnId, "space_nous_outcome", { requests: [{ summary: "Answered the operator", outcome: "SELF", answerOnly: true }] }, "toolu_o2");
      expect(second.ok).toBe(true);
      return { text: "Here is your answer.", isError: false };
    }, async (input, service) => {
      await service.callTool(owner, input.turnId, "space_copilot_answer", answer, "toolu_answer");
      return { text: "NOTHING_NEW", isError: false };
    }]);
    await f.service.send(owner, "πώς πάμε;");
    await vi.waitFor(() => expect(f.requests.map((request) => request.reason)).toEqual(["OPERATOR", "INBOX"]), { timeout: 15_000 });
    await f.service.idle(owner);
    expect(f.execute.mock.calls.filter(([name]) => name === "space_nous_outcome")).toHaveLength(1);
    expect(f.requests[0]!.prompt).toContain("## Copilot questions held for you (answer now)");
    expect(f.requests[1]!.prompt).toContain("Woken again: your OPERATOR turn showed this copilot question held for you and ended without an act on it");
    expect(f.requests).toHaveLength(2);
  }, 30_000);

  it("counts only an answer, a forward, a close or a held reason that names the question", () => {
    const item = heldQuestionItem(card);
    expect(item).toMatchObject({ key: `question:${card.id}`, kind: "QUESTION", refs: [card.id, "jobq:Tcoa0D_0Vp3t"] });
    const act = (name: string, args: Record<string, unknown>, ok = true): NousTurnAct => ({ name, args, ok, subjects: toolSubjects(name, args) });
    expect(itemActed(item, [act("space_copilot_answer", answer)])).toBe(true);
    expect(itemActed(item, [act("space_focus_pane", { room: "Alex", pane: "Jack", items: [{ text: "GPA?", ref: card.id }], checked: ["x"] })])).toBe(true);
    expect(itemActed(item, [act("space_resolve_notification", { notification: card.id })])).toBe(true);
    expect(itemActed(item, [act("space_nous_outcome", { requests: [{ summary: `jobq:Tcoa0D_0Vp3t stays held: waiting for the operator's transcript`, outcome: "PENDING" }] })])).toBe(true);
    // Not acts on it: another question's answer, a failed answer, a read, an unrelated send to the same pane, an outcome naming nothing.
    expect(itemActed(item, [act("space_copilot_answer", { ...answer, question: "jobq:other0001" }), act("space_copilot_answer", answer, false),
      act("space_read_pane", { room: "Alex", pane: "Jack" }), act("space_send_to_pane", { room: "Alex", pane: "Jack", text: "continue" }),
      act("space_nous_outcome", { requests: [{ summary: "Plans moved", outcome: "SELF" }] })])).toBe(false);
  });

  it("renders a hold that ran out as waiting for a second wake", () => {
    const text = renderHeldQuestions([{ card }], at + 70 * 60_000);
    expect(text).toContain("asked 17:10 UTC, 70 min ago; its hold ran out: it goes to the operator once you were woken for it twice");
    expect(renderHeldQuestions([], at)).toBe("");
  });

  it("recalls the copilot's own memory and Space Memory for a held question and keeps them on the card (step 2)", async () => {
    const space = ["<!-- space-memory:id=space_memory:grades0001 -->", "## 2026-10-13 - Space canonical memory: Job applications never give grades",
      "- created_at=2026-10-13T08:00:00.000Z", "- Tags: operator-rule", "Never give a GPA or any grade on an application: skip the field or write N/A.", "",
      "<!-- space-memory:id=space_memory:postal0001 -->", "## 2026-10-13 - Space canonical memory: Postal code", "- created_at=2026-10-13T09:00:00.000Z",
      "Residence postal code 10558.", ""].join("\n");
    const copilot = vi.fn(async () => [
      { source: "Job Copilot memory", id: "jobmem:S60Ur8lh8uZK", key: "grades", text: "Never ask for GPA or grades: skip the field.", updatedAt: "2026-10-20T00:00:00.000Z" },
      { source: "Freelance Copilot memory", id: "flmem:other0001", key: "gpa", text: "Another copilot's memory.", updatedAt: "2026-10-20T00:00:00.000Z" }
    ]);
    const memory = await heldQuestionRecall(card, { copilot, space: async () => space });
    expect(copilot).toHaveBeenCalledWith(expect.stringContaining("gpa"));
    expect(memory).toEqual(['jobmem:S60Ur8lh8uZK "grades" → Never ask for GPA or grades: skip the field.',
      'space_memory:grades0001 "Job applications never give grades" → Never give a GPA or any grade on an application: skip the field or write N/A.']);
    // Kept on the card (payload.recall), every later line and the pinned section carry it.
    const kept = { ...card, payload: { ...card.payload, recall: memory } } as SpaceNotification;
    expect(heldCardLine(kept)).toContain("; memory holds: jobmem:S60Ur8lh8uZK");
    expect(renderHeldQuestions([{ card: kept }], at)).toContain("space_memory:grades0001");
    expect(await heldQuestionRecall(card, {})).toEqual([]);
  });

  it("counts in the daily REVIEW the held questions answered within their hour against those escalated, and agents' cards without checked (step 5)", () => {
    const since = new Date(at - 3_600_000).toISOString();
    const iso = (minutes: number) => new Date(at + minutes * 60_000).toISOString();
    const held = (id: string, extra: Partial<SpaceNotification>) => ({ ...card, id, ...extra }) as SpaceNotification;
    const agent = (id: string, body: string, alertAt: string) => ({ ...card, id, source: "AGENT", kind: "NEEDS_YOU", title: `${id} needs you`, body, payload: { alertAt } }) as unknown as SpaceNotification;
    const lines = askLines([
      held("notification:inhour", { status: "RESOLVED", resolvedAt: iso(40) }),
      // The real case: its hour ran out and the operator got it (releasedFromNous, written by the release).
      held("notification:released", { status: "ACKED", ackedAt: iso(600), payload: { releasedFromNous: iso(70), alertAt: iso(70) } }),
      held("notification:forwarded", { status: "RESOLVED", resolvedAt: iso(30), payload: { heldForNous: { until: iso(43_200), card: "notification:nouscard" } } }),
      held("notification:waiting", {}),
      held("notification:old", { createdAt: new Date(at - 7_200_000).toISOString() }),
      held("notification:notheld", { payload: {} }),
      agent("Dana", "Birth date and GPA", iso(5)),
      agent("Andy", "Pick the colour\n\nChecked first:\n• Space Memory: no colour rule", iso(6)),
      agent("Finn", "Old card", new Date(at - 7_200_000).toISOString()),
      // Copilot NEEDS_USER cards go straight to the operator, so they count too (goal ee5a573e); their questions do not.
      { ...agent("Mail Copilot", "Hireflix interview", iso(7)), source: "MAIL_COPILOT", kind: "NEEDS_USER" } as SpaceNotification,
      { ...agent("Freelance Copilot", "Contra sign-in\n\nChecked first:\n• Account page: Contra", iso(8)), source: "FREELANCE_COPILOT", kind: "NEEDS_USER" } as SpaceNotification,
      { ...agent("Job Copilot", "GPA?", iso(9)), source: "JOB_COPILOT", kind: "QUESTION" } as SpaceNotification
    ], since);
    expect(lines).toEqual([
      "- Copilot questions held for you: 4; answered within their hour: 1; escalated to the operator: 2 (after the hold 1, on your cards 1); later or still waiting: 1",
      "- Agents' and copilots' needs-you cards: 4; without \"Checked first\": 2 (Dana needs you; Mail Copilot needs you)"
    ]);
  });
});
