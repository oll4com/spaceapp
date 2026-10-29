import { describe, expect, it } from "vitest";
import type { NousDecision, NousTurnFacts, RoomAgentEvent } from "@space/contracts";
import { NOUS_BASELINE, NOUS_CATALOG_V1, nousCatalogCoverage, nousProgressText, nousScorecard } from "../src/nous/progress.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";

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

  it("answers space_nous_progress from the owner's scorecard", async () => {
    const card = nousScorecard({ now, facts: sampleFacts(), decisions: sampleDecisions(), events: sampleEvents(), tools: baselineTools });
    const tools = createNousTools({ progress: async (owner: string) => { expect(owner).toBe("user:operator"); return card; } } as unknown as NousToolDeps);
    const outcome = await tools.execute("space_nous_progress", {}, { owner: "user:operator", turnId: "nous_turn:p1", callId: "toolu_p", traceId: "trace:p" });
    expect(outcome).toMatchObject({ ok: true, display: "Read my progress" });
    expect(outcome.result).toContain("Not enough data yet");
    expect(outcome.result).toContain("Missing tools you reported: close a pane; create a room; create a plan");
  });
});
