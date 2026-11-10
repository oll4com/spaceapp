import { describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousService, type NousServiceDeps } from "../src/nous/service.js";
import { NOUS_TURN_FAILED_NO_ERROR, type NousDecision, type NousTurnFacts, type RoomAgentEvent } from "@space/contracts";
import { NOUS_BASELINE, NOUS_CATALOG_V1, addToolErrorSample, failureCauses, nousCatalogCoverage, nousProgressText, nousScorecard } from "../src/nous/progress.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";
import { coordinationLine, renderDailyReview, waitLines } from "../src/nous/daily-review.js";

// The 2026-10-17 sample (08:48-09:13 UTC) the baseline was measured on: plan clipboard:L7RgHsveHbcR.
const now = Date.parse("2026-10-17T09:13:10.000Z");
const at = (time: string) => `2026-10-17T${time}.000Z`;
const BASELINE_TOOLS = ["space_world", "space_read_pane", "space_send_to_pane", "space_answer_pane", "space_open_panes", "space_stop_pane", "space_restart_pane",
  "space_set_pane_model", "space_plans", "space_plan_read", "space_plan_update", "space_tasks", "space_task_add", "space_task_update", "space_notifications",
  "space_resolve_notification", "space_release", "space_note", "space_copilot_items", "space_copilot_answer", "space_ask_operator"];
const baselineTools = BASELINE_TOOLS.map((name) => ({ name, inputSchema: { properties: name === "space_ask_operator" ? { action: {} } : {} } }));

const turn = (index: number, extra: Partial<NousTurnFacts> = {}): NousTurnFacts => ({
  turnId: `nous_turn:t${index}`, ownerUserId: "user:operator", reason: "OPERATOR", status: "DONE", tools: {}, planPoints: 0, outcomes: [],
  startedAt: new Date(Date.parse(at("08:49:00")) + index * 120_000).toISOString(), endedAt: new Date(Date.parse(at("08:50:00")) + index * 120_000).toISOString(), ...extra
});
const sampleFacts = (): NousTurnFacts[] => [
  turn(0, {
    tools: { space_send_to_pane: { calls: 21, failed: 1, refused: 0 }, space_answer_pane: { calls: 3, failed: 2, refused: 2 },
      space_set_pane_model: { calls: 5, failed: 3, refused: 0 }, space_open_panes: { calls: 2, failed: 1, refused: 0 } },
    outcomes: [
      { summary: "License answer", outcome: "SELF", correction: true }, { summary: "Remove nothing from example.invalid", outcome: "SELF" },
      { summary: "Ask me such decisions", outcome: "SELF" }, { summary: "Hand the plan to an agent", outcome: "SELF" },
      { summary: "Close finished panes", outcome: "HELPER", missing: "close a pane" }, { summary: "Recreate the Freelance room", outcome: "HELPER", missing: "create a room" },
      { summary: "Plans, notes, Space Control", outcome: "HELPER", missing: "create a plan" },
      { summary: "example.invalid product change", outcome: "OPERATOR", correction: true }
    ]
  }),
  ...Array.from({ length: 10 }, (_, index) => turn(index + 1))
];
const decision = (title: string, createdAt: string, extra: Partial<NousDecision>): NousDecision => ({
  id: `nous_decision:${title.replace(/\W/g, "").slice(0, 12)}`, ownerUserId: "user:operator", category: "DIRECTION", title, body: "", options: [],
  recommendation: null, refs: {}, action: null, status: "OPEN", answer: null, outcome: null, createdAt, answeredAt: null, ...extra
});
const sampleDecisions = (): NousDecision[] => [
  decision("Warm room list", at("09:10:42"), { category: "DESTRUCTIVE", refs: { paneId: "pane:cody" } }),
  decision("AGPL license", at("08:52:52"), { refs: { paneId: "pane:nik" }, status: "CANCELLED", answer: "Withdrawn by Nous: answered to Nik", answeredAt: at("09:20:00") }),
  decision("Reopen the copilots", at("08:50:25"), { status: "CANCELLED", answer: "Withdrawn by Nous: answered in the chat", answeredAt: at("09:20:00") })
];
const event = (kind: RoomAgentEvent["kind"], status: RoomAgentEvent["status"], createdAt: string, updatedAt: string, paneId: string | null = null) =>
  ({ eventId: `room_agent_event:${kind}${createdAt}`, roomId: "room:dino", paneId, paneName: null, kind, severity: "ATTENTION", title: kind, detail: null,
    status, decision: null, createdAt: at(createdAt), updatedAt: at(updatedAt) }) as unknown as RoomAgentEvent;
const sampleEvents = (): RoomAgentEvent[] => [
  event("WAITING", "HANDLED", "08:48:12", "08:50:06", "pane:jack"), event("OVERLAP", "RESOLVED", "08:48:48", "08:50:55"),
  event("WAITING", "RESOLVED", "08:49:50", "08:52:29", "pane:nik"), event("OVERLAP", "RESOLVED", "08:50:55", "09:07:18"),
  event("OVERLAP", "RESOLVED", "08:51:55", "09:07:18"), event("OVERLAP", "RESOLVED", "08:51:55", "09:07:18"), event("OVERLAP", "OPEN", "09:01:51", "09:01:51"),
  event("WAITING", "RESOLVED", "09:01:55", "09:02:23", "pane:nik"), event("WAITING", "OPEN", "09:06:39", "09:06:39", "pane:cody"),
  event("FINISHED", "OPEN", "09:00:00", "09:00:00", "pane:max")
];

describe("Nous's scorecard v1 (plan clipboard:L7RgHsveHbcR)", () => {
  it("keeps 40 catalog actions, 22 of them reachable on 2026-10-17", () => {
    expect(NOUS_CATALOG_V1).toHaveLength(40);
    expect(NOUS_CATALOG_V1.filter((entry) => entry.baseline)).toHaveLength(22);
    expect(nousCatalogCoverage(baselineTools)).toEqual({ reachable: 22, total: 40 });
    // Every tool a catalog entry names exists today, so a renamed tool cannot silently drop coverage.
    const names = new Set(nousToolDefinitions({ copilots: true }).map((tool) => tool.name));
    for (const ref of NOUS_CATALOG_V1.flatMap((entry) => entry.reach)) expect(names.has(ref.split(".")[0]!), ref).toBe(true);
  });

  it("reproduces the 2026-10-17 baseline from that day's facts, decisions and monitor events", () => {
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: sampleDecisions(), events: sampleEvents(), tools: baselineTools });
    for (const [key, value] of Object.entries(card.dimensions)) expect(Math.abs(value.score - value.baseline), key).toBeLessThanOrEqual(0.5);
    expect(card.dimensions.unblocking.note).toBe("median 13.4 min, 1 of 1 answered by Nous");
    expect(card.dimensions.escalation.note).toBe("3 asked, 2 stale, 0 it could have decided, 1 missed");
    expect(card.dimensions.reliability.note).toBe("6 mistakes in 11 turns (5 tool, 0 turn, 1 corrections)");
    expect(card.baselineOverall).toBe(44.7);
    expect(card).toMatchObject({ enoughData: false, window: { turns: 11 } });
    expect(card.failures).toMatchObject({ missing: ["close a pane", "create a room", "create a plan"], staleDecisions: ["AGPL license", "Reopen the copilots"] });
    expect(card.failures.tools[0]).toEqual({ name: "space_set_pane_model", failed: 3 });
    // R30-2: a gate's holds are named as GATE, outside the failed tools and the mistakes.
    expect(card.failures.gates).toEqual([{ name: "space_answer_pane", held: 2 }]);
    expect(nousProgressText(card)).toContain("GATE (held by a gate, not mistakes): space_answer_pane 2");
    expect(card.failures.tools.some((tool) => tool.name === "space_answer_pane")).toBe(false);
  });

  it("says how much Nous improved, and keeps the baseline where the window has no data", () => {
    const facts = Array.from({ length: 24 }, (_, index) => turn(0, {
      turnId: `nous_turn:w${index}`, startedAt: new Date(now - index * 3_600_000).toISOString(), planPoints: index < 5 ? 10 : 0,
      outcomes: index < 9 ? [{ summary: `request ${index}`, outcome: index < 8 ? "SELF" : "HELPER" }] : []
    }));
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: nousToolDefinitions({ copilots: true }) });
    expect(card.enoughData).toBe(true);
    expect(card.dimensions.autonomy).toMatchObject({ score: 88.9, change: 31.9, sample: 9 });
    expect(card.dimensions.coverage.score).toBe(92.5);
    expect(card.dimensions.planMovement.score).toBe(50);
    expect(card.dimensions.reliability.score).toBe(100);
    expect(card.dimensions.unblocking).toMatchObject({ score: NOUS_BASELINE.dimensions.unblocking, note: "no data in the window: baseline kept" });
    expect(card.dimensions.escalation.sample).toBe(0);
    expect(card.changePercent).toBe(Math.round(1000 * (card.overall - card.baselineOverall) / card.baselineOverall) / 10);
    expect(nousProgressText(card)).toContain(`Score ${card.overall} against 44.7 on 2026-10-17: +${card.changePercent}%`);

    const asked = [decision("Which font?", at("09:00:00"), { status: "ANSWERED", couldHaveDecided: true }), decision("Promote", at("09:01:00"), { status: "APPROVED" })];
    expect(nousScorecard({ now, facts, decisions: asked, events: [], tools: baselineTools }).dimensions.escalation)
      .toMatchObject({ score: 50, note: "2 asked, 0 stale, 1 it could have decided, 0 missed" });

    const old = nousScorecard({ now, facts: facts.map((fact) => ({ ...fact, startedAt: "2026-10-01T00:00:00.000Z" })), decisions: [], events: [], tools: baselineTools });
    expect(old).toMatchObject({ enoughData: false, window: { turns: 0 }, changePercent: 0 });
  });

  it("leaves waits the pane left by itself within 30 s (detector flickers) out of unblocking, never one Nous answered (item 29a)", () => {
    const events = [event("WAITING", "HANDLED", "08:50:00", "08:50:20", "pane:a"), event("WAITING", "RESOLVED", "08:51:00", "08:51:12", "pane:b"),
      event("WAITING", "RESOLVED", "08:52:00", "08:54:30", "pane:c"), event("STUCK", "RESOLVED", "08:55:00", "08:55:29", "pane:d")];
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: [], events, tools: baselineTools });
    expect(card.dimensions.unblocking).toMatchObject({ sample: 2, note: "median 1.4 min, 1 of 2 answered by Nous" });
  });

  it("lists every wait of the unblocking sample with its question, minutes and who closed it, never counting the pane or the operator as an agent (round 9 item 3)", () => {
    const named = (status: RoomAgentEvent["status"], decision: string | null, createdAt: string, updatedAt: string, pane: string, detail: string | null = null) =>
      ({ ...event("WAITING", status, createdAt, updatedAt, `pane:${pane}`), paneName: pane, title: `${pane} is waiting: Permission prompt`, detail, decision }) as RoomAgentEvent;
    const events = [named("HANDLED", 'Nous answered "1" for you.', "08:40:00", "08:41:00", "Jack", "Do you want to proceed?\n1. Yes"),
      named("HANDLED", "The pane continued on its own.", "08:42:00", "08:45:00", "Kate"),
      named("HANDLED", 'You answered "2" in the Room Agent.', "08:46:00", "08:50:00", "Leo"),
      named("RESOLVED", "The pane moved on.", "08:51:00", "08:53:00", "Mia"),
      named("HANDLED", 'Answered "y": the safe default', "08:54:00", "08:54:40", "Ned"), named("OPEN", null, "08:56:00", "08:56:00", "Ola")];
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: [], events, tools: baselineTools });
    expect(card.waits!.map((wait) => [wait.pane, wait.question, wait.closer, wait.byAgent, wait.scored])).toEqual([
      ["Ola", "Permission prompt", "nobody yet (open: minutes counted to now)", false, "OPEN"],
      ["Ned", "Permission prompt", "the Room Agent autopilot", true, "ANSWERED"],
      ["Mia", "Permission prompt", "the pane itself (it moved on)", false, "NOT_ANSWERED"],
      ["Leo", "Permission prompt", "the operator (in the Room Agent)", false, "ANSWERED"],
      ["Kate", "Permission prompt", "the pane itself (it continued on its own)", false, "ANSWERED"],
      ["Jack", "Do you want to proceed?", "Nous (a send or an answer)", true, "ANSWERED"]]);
    const text = nousProgressText(card);
    expect(text).toContain("Waits in the unblocking sample (6, newest first;");
    expect(text).toContain('Kate WAITING "Permission prompt": 3 min, closed by the pane itself (it continued on its own) (UNANSWERED by an agent) (the score counts it as answered)');
    expect(text).toContain('Jack WAITING "Do you want to proceed?": 1 min, closed by Nous (a send or an answer)\n');
    expect(waitLines(events, at("08:00:00"))).toContain('- 08:51 UTC Mia WAITING "Permission prompt": UNANSWERED (2 min): closed by the pane itself (it moved on) (closed by its CLI within 3 min: out of the adjusted score)');
  });

  it("shows raw and adjusted unblocking: a wait the pane's CLI closed itself within 3 minutes stays listed and leaves only the adjusted score (R10-4)", () => {
    const named = (status: RoomAgentEvent["status"], decision: string | null, createdAt: string, updatedAt: string, pane: string) =>
      ({ ...event("WAITING", status, createdAt, updatedAt, `pane:${pane}`), paneName: pane, title: `${pane} is waiting: Permission prompt`, decision }) as RoomAgentEvent;
    // 24/10 Dana: Claude's removal prompt denied itself after 2 min (158 s); 21:25 the Room Agent answered in 104 s; Mia moved on after 5 min.
    const events = [named("RESOLVED", "The pane moved on.", "08:40:00", "08:42:38", "Dana"), named("HANDLED", 'The Room Agent sent "Nous: refused" to Dana.', "08:45:00", "08:46:44", "Ola"),
      named("RESOLVED", "The pane moved on.", "08:50:00", "08:55:00", "Mia")];
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: [], events, tools: baselineTools });
    expect(card.dimensions.unblocking).toMatchObject({ sample: 3, note: "median 2.6 min, 1 of 3 answered by Nous" });
    expect(card.unblockingAdjusted).toMatchObject({ sample: 2, left: 1, note: "median 3.4 min, 1 of 2 answered by Nous; 1 closed by the CLI within 3 min left out" });
    expect(card.unblockingAdjusted!.score).toBeGreaterThan(card.dimensions.unblocking.score);
    expect(card.waits!.map((wait) => [wait.pane, wait.closedByCli ?? false])).toEqual([["Mia", false], ["Ola", false], ["Dana", true]]);
    const text = nousProgressText(card);
    expect(text).toContain(`- unblocking adjusted ${card.unblockingAdjusted!.score} (raw ${card.dimensions.unblocking.score}; not in the v1 score): median 3.4 min`);
    expect(text).toContain('Dana WAITING "Permission prompt": 2.6 min, closed by the pane itself (it moved on) (UNANSWERED by an agent) (closed by its CLI within 3 min: out of the adjusted score)');
    expect(waitLines(events, at("08:00:00"))[0]).toBe('- 08:40 UTC Dana WAITING "Permission prompt": UNANSWERED (2.6 min): closed by the pane itself (it moved on) (closed by its CLI within 3 min: out of the adjusted score)');
    // Only CLI-closed waits: the adjusted figure says so instead of inventing a score.
    expect(nousScorecard({ now, facts: sampleFacts(), decisions: [], events: events.slice(0, 1), tools: baselineTools }).unblockingAdjusted)
      .toMatchObject({ sample: 0, left: 1, note: "no wait left (1 closed by the CLI within 3 min)" });
  });

  it("lists OVERLAP notices as coordination, not waits, and leaves them out of the adjusted score (R10-6)", () => {
    const overlap = (createdAt: string, updatedAt: string, title: string, decision = "The overlap is gone.") =>
      ({ ...event("OVERLAP", decision === "The overlap is gone." ? "RESOLVED" : "HANDLED", createdAt, updatedAt), title, decision }) as RoomAgentEvent;
    const events = [overlap("08:40:00", "08:41:00", "Dana and Emma change the same files"), overlap("08:44:00", "08:49:00", "Dana and Emma change the same files"),
      overlap("08:50:00", "08:56:00", "Emma and Cody change the same files", "The Room Agent is coordinating Emma and Cody."),
      ({ ...event("WAITING", "HANDLED", "08:58:00", "08:59:00", "pane:jack"), paneName: "Jack", title: "Jack is waiting: Needs input", decision: 'Nous answered "1" for you.' }) as RoomAgentEvent];
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: [], events, tools: baselineTools });
    expect(card.waits!.map((wait) => wait.kind)).toEqual(["WAITING"]);
    expect(card.coordination).toEqual({ notices: 3, pairs: 2, byAgent: 1, minutes: 5 });
    expect(card.dimensions.unblocking.sample).toBe(4);
    expect(card.unblockingAdjusted).toMatchObject({ sample: 1, left: 3, note: "median 1 min, 1 of 1 answered by Nous; 3 coordination notices left out" });
    expect(nousProgressText(card)).toContain("- coordination (OVERLAP notices: coordination, not waits; outside the waits list and the adjusted score): 3 notices on 2 pairs, 1 answered by an agent, median 5 min");
    expect(coordinationLine(events, at("08:00:00"))).toBe("- Coordination (OVERLAP notices, not waits): 3 notices on 2 pairs, 1 answered by an agent, median 5 min.");
    expect(coordinationLine(events.slice(3), at("08:00:00"))).toBe("- Coordination: no OVERLAP notice.");
  });

  it("counts turn failures by cause, gateway, timeout or other, in space_nous_progress and the REVIEW; the v1 reliability figure stays (R11-1)", () => {
    const facts = [...sampleFacts(), turn(20, { status: "FAILED", error: "API Error: Connection refused (ECONNREFUSED)" }), turn(21, { status: "FAILED", error: "API Error: Connection refused (ECONNREFUSED)" }),
      turn(22, { status: "TIMEOUT", error: "Timed out after 20 minutes." }), turn(23, { status: "FAILED", error: "Claude Code stopped." }), turn(24, { status: "STOPPED" })];
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: baselineTools });
    expect(card.failures.byCause).toEqual({ gateway: 2, quota: 0, system_prompt: 0, timeout: 1, other: 1 });
    expect(card.dimensions.reliability.note).toBe("10 mistakes in 16 turns (5 tool, 4 turn, 1 corrections)");
    expect(nousProgressText(card)).toContain("Turn failures by cause (the v1 reliability figure counts every one): gateway 2, timeout 1, other 1");
    // R12-9: reliability adjusted leaves the OUTAGE turns out (outside the v1 weights); the raw figure stays 37.5.
    expect(card.dimensions.reliability.score).toBe(37.5);
    expect(card.reliabilityAdjusted).toEqual({ score: 42.9, sample: 14, note: "2 OUTAGE turns (Space Gateway refused or unreachable) left out" });
    expect(nousProgressText(card)).toContain("- reliability adjusted 42.9 (raw 37.5; not in the v1 score): 2 OUTAGE turns (Space Gateway refused or unreachable) left out");
    const review = renderDailyReview({ facts, decisions: [], since: at("08:00:00"), day: "2026-10-17", hour: 3 });
    expect(review).toContain("turns that failed, timed out or were stopped: 5 (failures by cause: gateway 2, timeout 1, other 1)");
  });

  it("counts quota turns as QUOTA and leaves them out of reliability adjusted like OUTAGE turns (R17-2)", () => {
    const facts = [...sampleFacts(), turn(20, { status: "FAILED", error: "API Error: Connection refused (ECONNREFUSED)" }),
      turn(21, { status: "FAILED", error: "Claude Code has no available tokens/quota right now: the account quota is exhausted." }),
      turn(22, { status: "FAILED", error: "You've hit your session limit · resets 11:10am (Europe/Athens)" })];
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: baselineTools });
    expect(card.failures.byCause).toEqual({ gateway: 1, quota: 2, system_prompt: 0, timeout: 0, other: 0 });
    expect(nousProgressText(card)).toContain("Turn failures by cause (the v1 reliability figure counts every one): gateway 1, quota 2, timeout 0, other 0");
    expect(card.reliabilityAdjusted?.note).toBe("1 OUTAGE turn (Space Gateway refused or unreachable), 2 QUOTA turns (no account had quota) left out");
    expect(card.reliabilityAdjusted?.sample).toBe(facts.length - 3);
  });

  it("R24-1 (7 days to 1/11: 28 turns \"No active Claude subscription account\", 2 \"model catalog is unavailable\", 35 \"Invalid system prompt.\" read as other): QUOTA, OUTAGE and SYSTEM_PROMPT", () => {
    const facts = [...sampleFacts(), turn(20, { status: "FAILED", error: "No active Claude subscription account. Claude API credits do not serve Nous." }),
      turn(21, { status: "FAILED", error: "The provider model catalog is unavailable." }), turn(22, { status: "FAILED", error: "Invalid system prompt." }),
      turn(23, { status: "FAILED", error: "Invalid system prompt." }), turn(24, { status: "FAILED", error: "Claude Code stopped." })];
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: baselineTools });
    // R66: when it last happened, so a cause fixed days ago is not read as a live one.
    const last = turn(23).endedAt!;
    expect(card.failures.byCause).toEqual({ gateway: 1, quota: 1, system_prompt: 2, timeout: 0, other: 1, systemPromptLast: last });
    expect(nousProgressText(card)).toContain("Turn failures by cause (the v1 reliability figure counts every one): gateway 1, quota 1, SYSTEM_PROMPT 2 (the worker "
      + `refused the turn's prompt or system prompt; the last at ${last.slice(0, 16).replace("T", " ")} UTC), timeout 0, other 1`);
    // The quota and the outage turn leave reliability adjusted; a refused system prompt is Nous's own failure and stays.
    expect(card.reliabilityAdjusted?.note).toBe("1 OUTAGE turn (Space Gateway refused or unreachable), 1 QUOTA turn (no account had quota) left out");
    expect(card.reliabilityAdjusted?.sample).toBe(facts.length - 2);
  });

  it("R38-1 (1/11 05:00-08:59 UTC: 42 operator turns \"Invalid prompt.\" read as other): the worker's prompt check is SYSTEM_PROMPT, and it stays in reliability adjusted", () => {
    const facts = [...sampleFacts(), turn(20, { status: "FAILED", error: "Invalid prompt." }), turn(21, { status: "FAILED", error: "Invalid system prompt." }),
      turn(22, { status: "FAILED", error: "Claude Code stopped." })];
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: baselineTools });
    expect(card.failures.byCause).toEqual({ gateway: 0, quota: 0, system_prompt: 2, timeout: 0, other: 1, systemPromptLast: turn(21).endedAt });
    expect(nousProgressText(card)).toContain(`SYSTEM_PROMPT 2 (the worker refused the turn's prompt or system prompt; the last at ${turn(21).endedAt!.slice(0, 16).replace("T", " ")} UTC), timeout 0, other 1`);
    expect(card.reliabilityAdjusted?.sample).toBe(facts.length);
  });

  it("counts a run of silent 150-200 s FAILED turns with no tool call and no error as an outage (R16-4: 70 turns of 28/10 23:02-01:13 UTC)", () => {
    const silent = (index: number, minute: number, seconds = 180, extra: Partial<NousTurnFacts> = {}) => turn(index, { status: "FAILED", error: null,
      startedAt: at(`09:${String(minute).padStart(2, "0")}:00`), endedAt: new Date(Date.parse(at(`09:${String(minute).padStart(2, "0")}:00`)) + seconds * 1000).toISOString(), ...extra });
    // A run of 3 within 10 minutes of each other; a lone one 30 minutes later, one with a tool call and one of 44 s (24/10's Fable switch) stay "other".
    const facts = [silent(30, 0), silent(31, 3), silent(32, 9), silent(33, 40), silent(34, 42, 180, { tools: { space_world: { calls: 1, failed: 0, refused: 0 } } }), silent(35, 50, 44)];
    expect(failureCauses(facts)).toEqual({ gateway: 3, quota: 0, system_prompt: 0, timeout: 0, other: 3 });
    // R38-1: since the store writes a fixed reason for a FAILED turn with no message, that reason reads as no error here.
    expect(failureCauses(facts.map((fact) => ({ ...fact, error: NOUS_TURN_FAILED_NO_ERROR })))).toEqual({ gateway: 3, quota: 0, system_prompt: 0, timeout: 0, other: 3 });
    const card = nousScorecard({ now, facts: [...sampleFacts(), ...facts], decisions: [], events: [], tools: baselineTools });
    expect(card.reliabilityAdjusted?.note).toBe("3 OUTAGE turns (Space Gateway refused or unreachable) left out");
  });

  it("answers space_nous_progress from the owner's scorecard", async () => {
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: sampleDecisions(), events: sampleEvents(), tools: baselineTools });
    const tools = createNousTools({ progress: async (owner: string) => { expect(owner).toBe("user:operator"); return card; } } as unknown as NousToolDeps);
    const outcome = await tools.execute("space_nous_progress", {}, { owner: "user:operator", turnId: "nous_turn:p1", callId: "toolu_p", traceId: "trace:p" });
    expect(outcome).toMatchObject({ ok: true, display: "Read my progress" });
    expect(outcome.result).toContain("Not enough data yet");
    expect(outcome.result).toContain("Missing tools you reported: close a pane; create a room; create a plan");
  });
});

describe("R19-3: a decision the operator answered in the chat is no stale ask", () => {
  it("records a withdrawal as answered in the chat only after an operator message, and the scorecard leaves it out of stale", async () => {
    // 7 days to 30/10: 9 of the 18 stale decisions were answered in the chat or a pane instead of on the card.
    const repository = new InMemoryNousRepository();
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const ask = (title: string) => service.ask({ ownerUserId: "user:operator", category: "DIRECTION", title, body: "Which?", options: ["A", "B"],
      recommendation: "A. Πρόβλεψη: ναι (80%)", refs: {}, action: null }, { checked: ["The plan map: no answer there"] });
    const before = await ask("Which hosting for the demo?");
    // No operator message since it was asked: an ordinary withdrawal, whatever Nous says.
    expect((await service.withdraw("user:operator", before.id, "answered elsewhere", true))?.answer).toBe("Withdrawn by Nous: answered elsewhere");
    const asked = await ask("Which region for the lab?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.send("user:operator", "Use Frankfurt for the lab.");
    await service.idle("user:operator");
    const answered = await service.withdraw("user:operator", asked.id, "the operator chose Frankfurt in the chat", true);
    expect(answered?.answer).toMatch(/^Answered in the chat \(\d\d:\d\d UTC\), withdrawn by Nous: the operator chose Frankfurt in the chat$/);
    const card = nousScorecard({ now: Date.now(), facts: [], decisions: await repository.listDecisions("user:operator", {}), events: [], tools: [] });
    expect(card.dimensions.escalation.note).toBe("2 asked, 1 stale, 0 it could have decided, 0 missed");
  });

  it("closes a decision replaced by its corrected ask as replaced, and the scorecard counts it apart from stale (R37)", async () => {
    const repository = new InMemoryNousRepository();
    const service = createNousService({ repository, runner: async () => ({ text: "ok", isError: false }), world: async () => ({ text: "world", overview: {} }),
      settings: async () => ({ enabled: false, maxTurnsPerHour: 20 }), notifications: { raise: vi.fn(async () => null), resolve: vi.fn(async () => 0) }, executeAction: vi.fn() } as unknown as NousServiceDeps);
    const ask = (title: string) => service.ask({ ownerUserId: "user:operator", category: "DIRECTION", title, body: "Which?", options: ["A", "B"],
      recommendation: "A. Πρόβλεψη: ναι (80%)", refs: {}, action: null }, { checked: ["The plan map: no answer there"] });
    const first = await ask("Restart the Browser Host at 9204238ed");
    const second = await ask("Restart the Browser Host at a8e30faf56");
    expect((await service.withdraw("user:operator", first.id, "stable HEAD moved", false, second.id))?.answer).toBe(`Replaced by ${second.id} (Nous): stable HEAD moved`);
    const card = nousScorecard({ now: Date.now(), facts: [], decisions: await repository.listDecisions("user:operator", {}), events: [], tools: [] });
    expect(card.dimensions.escalation.note).toBe("2 asked, 0 stale, 1 replaced, 0 it could have decided, 0 missed");
  });
});

describe("Brief tool-error-samples (8/11): error texts per tool in the turn facts and space_nous_progress", () => {
  it("keeps up to 3 failed calls' texts per tool, each at most 200 characters and redacted", () => {
    const tool = { calls: 5, failed: 5, refused: 0 } as NousTurnFacts["tools"][string];
    addToolErrorSample(tool, "  curl failed: token=abc123secret  ");
    addToolErrorSample(tool, "x".repeat(300));
    addToolErrorSample(tool, "third");
    addToolErrorSample(tool, "fourth");
    expect(tool.errors).toHaveLength(3);
    expect(tool.errors![0]).toBe("curl failed: token:[REDACTED]");
    expect(tool.errors![1]).toHaveLength(200);
    expect(tool.errors![1]!.endsWith("…")).toBe(true);
    expect(tool.errors![2]).toBe("third");
  });

  it("groups each failing tool's texts with ids and numbers normalised, the top 3 kinds of the top 5 tools, old `error` rows included", () => {
    const tools = (name: string, failed: number, errors: string[]) => ({ [name]: { calls: failed, failed, refused: 0, errors } });
    const facts = [
      turn(1, { tools: { ...tools("space_db_query", 3, ['column "is_active" does not exist', 'relation "tasks" does not exist', 'column "is_active" does not exist']),
        ...tools("space_files_read", 2, ["active/a/1.md is private", "active/a/22.md is private"]) } }),
      turn(2, { tools: { ...tools("space_db_query", 2, ['column "key" does not exist', 'column "x" does not exist']),
        space_execute: { calls: 1, failed: 1, refused: 0, error: "configure: Pane has no active session pane:abc123" } } }),
      turn(3, { tools: { ...tools("space_execute", 1, ["configure: Pane has no active session pane:def456"]), ...tools("t4", 1, ["a"]), ...tools("t5", 1, ["b"]), ...tools("t6", 1, ["c"]) } })
    ];
    const card = nousScorecard({ now, facts, decisions: [], events: [], tools: baselineTools });
    const byName = Object.fromEntries(card.failures.tools.map((tool) => [tool.name, tool]));
    expect(byName.space_db_query).toEqual({ name: "space_db_query", failed: 5, errors: [
      { text: 'column "is_active" does not exist', count: 2 }, { text: 'relation "tasks" does not exist', count: 1 }, { text: 'column "key" does not exist', count: 1 }] });
    expect(byName.space_files_read!.errors).toEqual([{ text: "active/a/1.md is private", count: 2 }]);
    expect(byName.space_execute!.errors).toEqual([{ text: "configure: Pane has no active session pane:abc123", count: 2 }]);
    expect(card.failures.tools.filter((tool) => tool.errors)).toHaveLength(5);
    const text = nousProgressText(card);
    expect(text).toContain("Failed tools: space_db_query 5, space_files_read 2, space_execute 2");
    expect(text).toContain('- space_db_query errors (sampled up to 3 per turn; same text with other ids or numbers counted together): "column "is_active" does not exist" ×2;');
  });
});
