// Nous's Score (operator 3/11 23:11 BKK, plan clipboard:1NF6u6gcCwtj): points that can go negative; open plans and operator requests cost
// points while they stay open, finished work and the scorecard give them.
import { nousDecisionSchema, nousTurnFactsSchema, type NousScore } from "@space/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { SpaceEventBus } from "@space/runtime";
import { NEVER_BUY_ANSWER } from "../src/nous/allowances.js";
import { NOUS_PERSONA, NOUS_SCORE_FIRST_RULE } from "../src/nous/service.js";
import { addToolErrorSample, toolFailureCause } from "../src/nous/progress.js";
import { CLOSE_PARKED } from "../src/nous/score-push.js";
import { createNousScore, goalProgressDays, nousScore, nousScoreErrors, nousScoreLeversText, paneDaysOf, NOUS_SCORE_EVENT_DELAY_MS, NOUS_SCORE_STARTUP_MS, NOUS_SCORE_SNAPSHOT_MS, nousScoreLine, NOUS_SCORE_WEIGHTS, registerNousScoreRoutes, parseScoreReset,
  type NousScoreInput, type NousScoreLever, type NousScoreReset } from "../src/nous/score.js";

const owner = "user:operator";
const NOW = Date.parse("2026-11-03T16:00:00.000Z");
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const dimension = (score: number, baseline: number) => ({ score, baseline, change: score - baseline, sample: 10, note: "n" });
const input = (extra: Partial<NousScoreInput> = {}): NousScoreInput => ({ now: NOW, plans: [], completedPlans: [], requests: [], done: [], utilization: null, scorecard: null, panes: [], goals: [], dailyErrors: [], timeZone: "UTC",
  dailyTasks: [], taskRuns: [], messages: [], programs: [], projects: [], paneDays: [], ...extra });

describe("NOUS_SCORE_WEIGHTS", () => {
  it("is the one table of weights: open work costs, finished work gives", () => {
    // A changed weight is a decision of the operator: this table and the docs change together.
    expect(NOUS_SCORE_WEIGHTS).toEqual({ openPlan: -2, openPlanPerDay: -2, planAgeExponent: 2, parkedPlanPerDay: -2, openPane: -1, paneDay: -0.2, idlePanePerHour: -2, goalPerDay: -2, goalNoProgressDay: -3, goalOverdueDay: -20, toolFailure: -2, lesson: -5, decisionDeclined: -5, predictionMiss: -3, chatError: -1, decisionFailed: -3, planNoWorkingPane: -3, planStalled: -5, openRequest: -2, requestPast1h: -2,
      requestPast6h: -4, requestPast24h: -8, requestStuckDay: -4, planCompleted: 5, requestDone: 3, utilizationPerPoint: 0.5, lostAtResetPerPoint: -95, correction: -5, couldHaveDecided: -3, scorecardPerPoint: 0.5,
      dailyTaskMissed: -5, slowReply: -2, slowReplyPast10x: -2, slowDone: -2, slowDonePast24h: -4, projectShortfallPerPoint: -0.2, projectDay: -1, programOpen: -1, programNotApplied: -0.2,
      marketingPerPoint: -0.2, marketingDayBelowTarget: -1, marketingFailed: -2, marketingZeroReach: -0.5, marketingDayWithoutResult: -1, idleBrowserPerHour: -2, browserReaped: -2,
      approvedNotDone: -5, approvedNotDonePerHour: -0.25, approvedNotDoneAgeExponent: 2, approvedNotDoneGraceHours: 2 });
    for (const key of ["openPlan", "openPlanPerDay", "planNoWorkingPane", "planStalled", "openRequest", "requestPast1h", "requestPast6h", "requestPast24h", "requestStuckDay", "correction", "couldHaveDecided"] as const) {
      expect(NOUS_SCORE_WEIGHTS[key]).toBeLessThan(0);
    }
    for (const key of ["planCompleted", "requestDone", "utilizationPerPoint", "scorecardPerPoint"] as const) expect(NOUS_SCORE_WEIGHTS[key]).toBeGreaterThan(0);
  });
});

describe("nousScore", () => {
  it("charges marketing below its target, more each day in a row, its failed and no-reach posts of the window and days without a result", () => {
    const row = (number: number, status: string, hoursAgo: number, score: number | null) => ({ id: `mktpost:p${number}`, number, channel: "X", status, at: at(hoursAgo * HOUR), score, title: `Post ${number}` });
    const marketing = { score: 30, target: 50, daysBelowTarget: 4, daysWithoutResult: 2,
      posts: [row(4, "PUBLISHED", 2, 0), { ...row(5, "PUBLISHED", 3, 0), kind: "REPLY" }, row(3, "FAILED", 5, 0), row(2, "PUBLISHED", 6, 40), row(1, "PUBLISHED", 24 * 9, 0)] };
    const tile = nousScore(input({ marketing })).tiles.find((entry) => entry.key === "marketing")!;
    expect(tile.detail).toBe("30/100 · target 50 · 4 d below it");
    expect(tile.items.map((item) => [item.label, item.points])).toEqual([
      ["Marketing score 30/100, target 50", 20 * -0.2 + 4 * -1 * (20 / 50)], ["#3 X: Post 3", -2],
      ["2 of the last 7 days without a post that brought anything", -2], ["#4 X: Post 4", -0.5]]);
    expect(tile.points).toBe(-10.1);
    // A day longer below the target costs more; at the target only the posts and days cost; no Marketing Copilot, no tile.
    expect(nousScore(input({ marketing: { ...marketing, daysBelowTarget: 5 } })).score).toBeLessThan(nousScore(input({ marketing })).score);
    expect(nousScore(input({ marketing: { ...marketing, score: 50 } })).tiles.find((entry) => entry.key === "marketing")!.points).toBe(-4.5);
    expect(nousScore(input()).tiles.some((entry) => entry.key === "marketing")).toBe(false);
  });
  // Operator 5/11 (nous_msg:b489788c «μεγάλη μείωση στο Score»): Lost tokens is a variable of its own, out of Utilization.
  it("charges a week left unused at its reset as Lost tokens: ~30% of one Max week costs more than any variable but Daily Nous errors", () => {
    const lost = (label: string, lostPercent: number, daysAgo: number) => ({ label, quotaKey: "", resetAt: at(daysAgo * 24 * HOUR), lostPercent,
      lostTokens: lostPercent * 100_000_000, lostCostUsd: lostPercent * 50 });
    const { tiles, breakdown } = nousScore(input({ utilization: { value: 90, target: 90, what: "Today's average" },
      lostAtResets: [lost("crew", 30, 1), lost("ops", 0.5, 2), lost("old", 40, 9)] }));
    const tile = tiles.find((entry) => entry.key === "lostTokens")!;
    // ops under 1% and old outside the 7 days cost nothing; Utilization at its target costs nothing either (nothing counted twice).
    expect(tile.items.map((item) => [item.label, item.points])).toEqual([[`crew left 30% of its week at its reset ${at(24 * HOUR).slice(0, 10)}`, -2850]]);
    expect(tile.points).toBe(-2850);
    expect(tile.detail).toBe("30 points of weeks left unused at their resets in 7 days ≈ 3.0B tokens, $1500");
    expect(tiles.find((entry) => entry.key === "utilization")!.points).toBe(0);
    expect(breakdown).toEqual([expect.objectContaining({ label: "Lost tokens", points: -2850, share: 100 })]);
    // Stable 5/11 05:03 UTC: Open plans −2,680, Daily Nous errors −2,981.
    expect(tile.points).toBeLessThan(-2680);
    expect(tile.points).toBeGreaterThan(-2981);
    expect(nousScore(input()).tiles.find((entry) => entry.key === "lostTokens")).toMatchObject({ points: 0, detail: "no week left room at its reset in 7 days" });
    const line = nousScoreLine({ at: at(0), score: -2850, change24h: null, change7d: null, tiles, breakdown });
    expect(line).toContain(", Lost tokens: 30 points of weeks left unused at their resets in 7 days ≈ 3.0B tokens, $1500 (−2850)");
    expect(line).toContain("Lost tokens (a subscription week left unused at its reset) cost 95 a point.");
  });

  it("charges open plans by age, no working pane and STALLED, and open requests by age past 1, 6 and 24 hours", () => {
    const { score, tiles } = nousScore(input({
      plans: [{ id: "clipboard:a", title: "Worked on", createdAt: at(2 * HOUR), working: true, stalled: null },
        { id: "clipboard:b", title: "Forgotten", createdAt: at(3 * 24 * HOUR + HOUR), working: false, stalled: "unchanged 30 h" }],
      requests: [{ id: "nous_msg:1", summary: "fresh", openedAt: at(10 * 60_000) }, { id: "nous_msg:2", summary: "two hours", openedAt: at(2 * HOUR) },
        { id: "nous_msg:3", summary: "seven hours", openedAt: at(7 * HOUR) }, { id: null, summary: "two days", openedAt: at(48 * HOUR) }]
    }));
    const plans = tiles.find((tile) => tile.key === "plans")!;
    // −2; −2 −2×3² days −3 no pane −5 STALLED: the costliest item first.
    expect(plans.items.map((item) => [item.id, item.points])).toEqual([["clipboard:b", -28], ["clipboard:a", -2]]);
    expect(plans.items[0]!.detail).toBe("open 3 d · no working pane · STALLED: unchanged 30 h");
    const requests = tiles.find((tile) => tile.key === "requests")!;
    // 27/11 (nous_msg:583c7629): the 2-day request is 1 full day past its first 24 h: −16 −4.
    expect(requests.items.map((item) => item.points)).toEqual([-20, -8, -4, -2]);
    expect(requests.points).toBe(-34);
    expect(requests.detail).toBe("4 open · 1 stuck past 24 h, -4 each more day");
    expect(score).toBe(-64);
  });

  it("a stuck request costs 4 more each full day past its first 24 h, no cap (operator 27/11 nous_msg:583c7629)", () => {
    const { tiles, levers } = nousScore(input({ requests: [{ id: "nous_msg:old", summary: "account will lock", openedAt: at(10 * 24 * HOUR + HOUR) }] }));
    const [item] = tiles.find((tile) => tile.key === "requests")!.items;
    expect(item).toMatchObject({ points: -16 - 9 * 4, detail: "open 10 d · stuck 9 d (-4 a day)" });
    expect(levers.find((lever) => lever.id === "nous_msg:old")).toMatchObject({ points: -52, perDay: -4 });
  });

  // Plan clipboard:nLYbDf3TqBPm step 1 (W47 audit, Open plans −105): SzUQxpr8eu8z and NdUqdzgGp_BR waited on dates and were charged "no working pane".
  it("a recorded wait is not 'no working pane'; a plan past 24 h with neither a working pane nor a recorded wait is pushed", () => {
    const plan = (id: string, hoursAgo: number, extra: Partial<NousScoreInput["plans"][number]> = {}) => ({ id, title: id, createdAt: at(hoursAgo * HOUR), working: false, stalled: null, ...extra });
    const { tiles, paneless } = nousScore(input({ plans: [plan("clipboard:date", 4 * 24, { held: "waits on a date: batch 7 sends Mon 14:00", waits: "6. Pilots (BLOCKED)" }),
      plan("clipboard:none", 25, { waits: "7. Rollout (BLOCKED)" }), plan("clipboard:young", 23), plan("clipboard:worked", 48, { working: true })] }));
    const items = tiles.find((tile) => tile.key === "plans")!.items;
    // −2 −2×4² and no −3: its wait is named instead.
    expect(items.find((item) => item.id === "clipboard:date")).toMatchObject({ points: -34, detail: "open 4 d · waits on a date: batch 7 sends Mon 14:00" });
    expect(items.find((item) => item.id === "clipboard:none")).toMatchObject({ points: -7, detail: "open 1 d · no working pane" });
    expect(paneless).toEqual([{ id: "clipboard:none", title: "clipboard:none", points: -7, age: "1 d" }]);
    // 21/11 (Score −2980, Open plans 70%): a wait recorded on the plan itself is pushed to be closed parked, not left open to age.
    const parked = nousScore(input({ plans: [plan("clipboard:park", 10 * 24, { held: "waits on a third party: Braintrust reply", parkable: true }), plan("clipboard:young", 23, { held: "waits on you: go", parkable: true })] }));
    expect(parked.paneless).toEqual([{ id: "clipboard:park", title: "clipboard:park", points: -202, age: "10 d", held: "waits on a third party: Braintrust reply" }]);
    expect(parked.levers.find((lever) => lever.id === "clipboard:park")!.action).toBe(`it waits on a third party: Braintrust reply and no pane works on it: ${CLOSE_PARKED}`);
  });

  it("Score levers now (operator 5/11 12:32 BKK): every open item a move removes or stops growing, costliest by tomorrow first, with its move", () => {
    const day = 24 * HOUR;
    const quiet = { calls: 5, failed: 3, refused: 0, corrections: 0, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0 };
    const { levers, tiles } = nousScore(input({
      plans: [{ id: "clipboard:b", title: "Fresh", createdAt: at(2 * HOUR), working: true, stalled: null, progress: 40, pane: "Alex" },
        { id: "clipboard:a", title: "Release", createdAt: at(9 * day + HOUR), working: false, stalled: null, progress: 97, pane: "Bruno" }],
      requests: [{ id: "nous_msg:3", summary: "seven hours", openedAt: at(7 * HOUR) }, { id: "nous_msg:4", summary: "two days", openedAt: at(48 * HOUR) }],
      goals: [{ id: "nous_goal:g", text: "Score positive", createdAt: at(3 * day), status: "ACTIVE", limit: null, progressDays: [] }],
      panes: [{ id: "pane:1", title: "Done 1", idleSince: at(2 * HOUR) }, { id: "pane:2", title: "Done 2", idleSince: at(2 * HOUR) }, { id: "pane:3", title: "Busy", idleSince: null }],
      utilization: { value: 70, target: 90, what: "Today's average" },
      dailyErrors: [{ day: "2026-11-02", ...quiet }]
    }));
    // A 9-day plan: −2 −2×81 −3 now, −2×(100−81) more tomorrow; a request 7 h old crosses 24 h (−8); the goal −2 and −3 without progress today.
    expect(levers.map((lever) => [lever.id ?? lever.label, lever.points, lever.perDay])).toEqual([
      ["clipboard:a", -167, -38], ["2 panes idle past 60 min (Done 1 [pane:1] idle or finished 2 h, Done 2 [pane:2] idle or finished 2 h)", -6, -96.4],
      ["nous_msg:4", -20, -4], ["nous_goal:g", -15, -5], ["nous_msg:3", -8, -8],
      ["Utilization 70% against 90%", -10, 0], ["Daily Nous errors (2.6% of the negative)", -6, -0.9], ["clipboard:b", -2, -2]]);
    expect(levers[0]!.action).toContain("complete it with its proof");
    expect(levers.at(-1)!.action).toBe("Alex works on it: send the next step the moment it reports");
    // 13/11: a plan whose open steps all wait gets nothing from the 90 % push, so its lever says so instead of "send it its next step now".
    const waits = nousScore(input({ plans: [{ id: "clipboard:w", title: "Waits", createdAt: at(2 * HOUR), working: false, stalled: null, progress: 40, pane: "Bruno", waits: "sign-in" }] }));
    expect(waits.levers.find((lever) => lever.id === "clipboard:w")!.action).toBe("every open step waits (next: sign-in) and no wait is recorded: record it (space_plan_update waitsOn), unblock its step when the wait ends");
    // 13/11: a plan waiting on the operator (its waitsOn «continue») opens no pane.
    const held = nousScore(input({ plans: [{ id: "clipboard:h", title: "Held", createdAt: at(2 * HOUR), working: false, stalled: null, progress: 40, pane: null, held: "waits on you: continue" }] }));
    expect(held.levers.find((lever) => lever.id === "clipboard:h")!.action).toBe("it waits on you: continue: no pane to open or send; clear the wait (you: one ask; a third party: follow up; a date or another plan: nothing until then)");
    const text = nousScoreLeversText(levers);
    // 20/11 (token saving): the two requests' shared move is written once and named on their lines.
    expect(text.split("\n").slice(1, 4)).toEqual(["Moves several lines share (a line ending in [move N] takes that move):",
      "[move 1] deliver it and record it Done (space_request_done); a pane on it now if none works on it; if it waits on a release or ticket, report it PENDING with release or tickets so its shipping brings it back",
      "- Plan [clipboard:a] \"Release\" 97% · −167 now → −205 tomorrow · complete it with its proof (space_plan_update), it removes all of it"]);
    expect(text).toContain("- Request [nous_msg:3] «seven hours» · −8 now → −16 tomorrow · [move 1]");
    expect(text.match(/deliver it and record it Done/g)).toHaveLength(1);
    // A shared tail after ": " is named too; each line keeps its own words before it.
    const wait = (id: string, held: string): NousScoreLever => ({ id, label: id, points: -5, perDay: -1,
      action: `it ${held}: no pane to open or send; clear the wait (you: one ask; a third party: follow up; a date or another plan: nothing until then)` });
    expect(nousScoreLeversText([wait("p1", "waits on a date: 7/12"), wait("p2", "waits on a third party: X (reason: Y)")]).split("\n").slice(2)).toEqual([
      "[move 1] no pane to open or send; clear the wait (you: one ask; a third party: follow up; a date or another plan: nothing until then)",
      "- p1 · −5 now → −6 tomorrow · it waits on a date: 7/12: [move 1]", "- p2 · −5 now → −6 tomorrow · it waits on a third party: X (reason: Y): [move 1]"]);
    // 13/11: no cost is left to the window: the errors name their causes with counts for a code-fix pane.
    expect(text).not.toContain("No move removes");
    expect(text).toContain("- Daily Nous errors (2.6% of the negative) · −6 now → −6.9 tomorrow · open or brief a code-fix pane with these causes and counts: failed tools ×3 (−6)");
    expect(tiles.find((tile) => tile.key === "dailyErrors")!.points).toBe(-6);
    expect(nousScoreLeversText([])).toBe("## Score levers now (your first measure: take the top move first; points now → tomorrow if left · the move that cuts them)\n- none");
  });

  it("Score first (operator 5/11 12:32 BKK): the persona puts the Score right after Nous's identity, above the spend rule", () => {
    const at = (text: string) => NOUS_PERSONA.indexOf(text);
    expect(at(NOUS_SCORE_FIRST_RULE)).toBeGreaterThan(at("You are Nous (Greek νους, mind)"));
    expect(at(NOUS_SCORE_FIRST_RULE)).toBeLessThan(at("Read the world's Tokens, Providers and Low-spend mode"));
    expect(NOUS_SCORE_FIRST_RULE).toContain("## Score levers now");
    // Low-spend defers only where no account of the pool has room.
    expect(NOUS_PERSONA).toContain("Low-spend holds back only a pool where no account has room");
  });

  it("gives points for work finished in the 7-day window only, and for utilization and the scorecard against their marks", () => {
    const { score, tiles } = nousScore(input({
      completedPlans: [{ id: "clipboard:c", title: "Shipped", at: at(24 * HOUR) }, { id: "clipboard:old", title: "Old", at: at(9 * 24 * HOUR) }],
      done: [{ id: "n1", title: "Fixed", at: at(HOUR) }],
      utilization: { value: 70, target: 90, what: "Today's average" },
      scorecard: { overall: 60, baselineOverall: 50, baselineDate: "2026-10-17",
        dimensions: { autonomy: dimension(70, 50), coverage: dimension(55, 55), unblocking: dimension(78, 78), planMovement: dimension(0, 0), escalation: dimension(25, 25), reliability: dimension(45, 45) },
        failures: { tools: [], missing: [], corrections: ["Said done before it was"], staleDecisions: [], couldHaveDecided: ["Ask to merge", "Ask to restart"] } }
    }));
    const points = Object.fromEntries(tiles.map((tile) => [tile.key, tile.points]));
    // autonomy +20 at weight 0.25 → +2.5 at 0.5 a point.
    expect(points).toEqual({ plans: 0, parked: 0, requests: 0, approvedNotDone: 0, completed: 5, done: 3, utilization: -10, lostTokens: 0, panes: 0, idlePanes: 0, browsers: 0, goals: 0, projects: 0, dailyTasks: 0, response: 0, dailyErrors: 0, scorecard: 2.5 });
    expect(score).toBe(0.5);
  });

  it("14/11 (nous_msg:cf45a823): 24 h, 7 days and 30 days each count their own window; what is open now is the same in every range", () => {
    const task = { id: "task:daily", title: "Daily check", createdAt: at(40 * 24 * HOUR), time: "10:00", timeZone: "UTC", nextRunAt: "2026-11-03T10:00:00.000Z" };
    const extra: Partial<NousScoreInput> = {
      plans: [{ id: "clipboard:p", title: "Open", createdAt: at(HOUR), working: true, stalled: null }],
      completedPlans: [{ id: "c1", title: "A", at: at(2 * HOUR) }, { id: "c2", title: "B", at: at(3 * 24 * HOUR) }, { id: "c3", title: "C", at: at(20 * 24 * HOUR) }],
      done: [{ id: "n1", title: "X", at: at(10 * 24 * HOUR) }],
      // Every day's run from 2/11 back 40 days left its text out of the pane.
      dailyTasks: [task], taskRuns: Array.from({ length: 40 }, (_, day) => ({ taskId: task.id, dueAt: new Date(Date.parse("2026-11-02T10:00:00.000Z") - day * 24 * HOUR).toISOString(), typed: false }))
    };
    const view = (windowDays: number) => nousScore(input({ ...extra, windowDays }));
    const tiles = (windowDays: number) => Object.fromEntries(view(windowDays).tiles.map((tile) => [tile.key, [tile.points, tile.detail]]));
    expect([1, 7, 30].map((days) => [tiles(days).completed, tiles(days).done, tiles(days).dailyTasks, tiles(days).plans])).toEqual([
      [[5, "1 in 24 h"], [0, "0 in 24 h"], [-5, "1 daily · 1 missed days in 24 h"], [-2, "1 open"]],
      [[10, "2 in 7 days"], [0, "0 in 7 days"], [-35, "1 daily · 7 missed days in 7 days"], [-2, "1 open"]],
      [[15, "3 in 30 days"], [3, "1 in 30 days"], [-150, "1 daily · 30 missed days in 30 days"], [-2, "1 open"]]]);
    // No window is the 7 days', as before.
    expect(nousScore(input(extra))).toEqual(view(7));
    // Each range's errors start at its own first hour: a failure 30 h ago is in 7 days, not in 24 h.
    const fact = (endedAt: string) => nousTurnFactsSchema.parse({ turnId: endedAt, ownerUserId: owner, reason: "OPERATOR", status: "DONE", startedAt: endedAt, endedAt,
      planPoints: 0, tools: { read: { calls: 1, failed: 1, refused: 0 } }, outcomes: [] });
    const failed = (windowDays: number) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [fact(at(HOUR)), fact(at(30 * HOUR)), fact(at(20 * 24 * HOUR))], decisions: [], lessons: [], windowDays })
      .reduce((sum, day) => sum + day.failed, 0);
    expect([failed(1), failed(7), failed(30)]).toEqual([1, 2, 3]);
  });

  it("Idle open panes (operator 13/11 09:48 BKK): every started hour past 60 min doing nothing, the Mail Copilot and a pane under Idle open browsers excepted", () => {
    const result = nousScore(input({ panes: [
      { id: "pane:working", title: "Working", idleSince: null },
      { id: "pane:59", title: "59 min", idleSince: at(59 * 60_000) },
      { id: "pane:61", title: "61 min", idleSince: at(61 * 60_000) },
      { id: "pane:310", title: "3 h 10 min", idleSince: at(190 * 60_000) },
      { id: "pane:mail", title: "Mail Copilot", idleSince: at(5 * HOUR), mode: "MAIL_COPILOT" },
      { id: "pane:bob", title: "Bob (Browser 2)", idleSince: at(5 * HOUR) }
    ], browsers: { idle: [{ id: "pane:bob", title: "Bob (Browser 2)", idleSince: at(5 * HOUR) }], reaped: [] } }));
    const tile = result.tiles.find((entry) => entry.key === "idlePanes")!;
    // 61 min: one started hour past 60 (−2); 3 h 10 min: three (−6); 59 min, the Mail Copilot and Bob (charged as a browser) nothing.
    expect(tile.items.map((item) => [item.id, item.points])).toEqual([["pane:310", -6], ["pane:61", -2]]);
    expect(tile).toMatchObject({ label: "Idle open panes", points: -8, detail: "2 panes idle past 60 min" });
    expect(result.tiles.find((entry) => entry.key === "panes")).toMatchObject({ points: -6, detail: "6 open" });
    expect(result.levers.find((lever) => lever.label.startsWith("2 panes idle past 60 min"))).toMatchObject({ points: -10, perDay: -96.4,
      label: "2 panes idle past 60 min (3 h 10 min [pane:310] idle or finished 3 h, 61 min [pane:61] idle or finished 1 h)" });
  });

  it("Idle open browsers (operator 5/11 14:47 BKK): each started hour past 30 min unused, each one Space had to close, and a \"close it\" lever", () => {
    const result = nousScore(input({ browsers: {
      idle: [{ id: "pane:bob", title: "Bob (Browser 2)", idleSince: at(45 * 60_000) }, { id: "pane:dino", title: "Dino (Job Copilot 6)", idleSince: at(3 * HOUR) }],
      reaped: [{ id: "pane:finn", title: "Finn (Browser 6)", at: at(2 * HOUR) }, { id: "pane:old", title: "Old", at: at(8 * 24 * HOUR) }] } }));
    const tile = result.tiles.find((entry) => entry.key === "browsers")!;
    // 45 min: the first hour past 30 min (−2); 3 h: 2.5 h past it, three started hours (−6); one reap in the window (−2), the 8-day-old one none.
    expect(tile.items.map((item) => [item.id, item.points])).toEqual([["pane:dino", -6], ["pane:bob", -2], ["pane:finn", -2]]);
    expect(tile).toMatchObject({ label: "Idle open browsers", points: -10, detail: "2 open unused past 30 min · 1 closed by Space in 7 days" });
    const levers = nousScoreLeversText(result.levers, result);
    expect(levers).toContain("[move 1] close it: close its pane if it is done, or its tabs (space_browser_close_tab)");
    expect(levers).toContain("- Browser of Dino (Job Copilot 6) unused 3 h · −6 now → −54 tomorrow · [move 1]");
    expect(levers).toContain("- Browser of Bob (Browser 2) unused 45 min · −2 now → −50 tomorrow · [move 1]");
    expect(nousScoreLine({ at: at(0), score: result.score, change24h: null, change7d: null, tiles: result.tiles, breakdown: result.breakdown }))
      .toContain(", Idle open browsers: 2 open unused past 30 min · 1 closed by Space in 7 days (−10)");
    // Nothing idle: the tile costs nothing.
    expect(nousScore(input()).tiles.find((entry) => entry.key === "browsers")).toMatchObject({ points: 0, items: [] });
  });

  it("Approved but not done (operator 5/11 20:36 BKK): an approved EXTERNAL decision costs past its 2 h grace, more each hour; confirmed or withdrawn clears", () => {
    const decision = (id: string, hoursAgo: number, extra: Record<string, unknown> = {}) => ({ id, title: `Reply ${id}`, category: "EXTERNAL" as const, status: "APPROVED" as const,
      outcome: null, createdAt: at(hoursAgo * HOUR), answeredAt: at(hoursAgo * HOUR), refs: { mailThread: { account: "a@x.com", threadId: `t-${id}` } }, ...extra });
    const tileOf = (decisions: ReturnType<typeof decision>[], sends: Record<string, "SENT" | "BOUNCED"> = {}) =>
      nousScore(input({ approvals: { decisions, sends } })).tiles.find((entry) => entry.key === "approvedNotDone")!;
    // 1 h: in its grace (0); 5 h: 3 full hours past it, −5 − 0.25 × 3² = −7.25, shown −7.2; 26 h: −5 − 0.25 × 24² = −149.
    const tile = tileOf([decision("nous_decision:a", 1), decision("nous_decision:b", 5), decision("nous_decision:c", 26)]);
    expect(tile.items.map((item) => [item.id, item.points])).toEqual([["nous_decision:c", -149], ["nous_decision:b", -7.2], ["nous_decision:a", 0]]);
    expect(tile).toMatchObject({ label: "Approved but not done", points: -156.2, detail: "3 not done · 2 past the 2 h grace" });
    expect(tile.items.find((item) => item.id === "nous_decision:a")!.detail).toContain("in its 2 h grace");
    // Confirmed: our reply in its thread (the mail store), or (no thread) an outcome that ran; a bounce still costs; withdrawn, declined or another category: nothing.
    expect(tileOf([decision("nous_decision:b", 5)], { "nous_decision:b": "SENT" })).toMatchObject({ points: 0, items: [] });
    expect(tileOf([decision("nous_decision:b", 5)], { "nous_decision:b": "BOUNCED" }).items[0]!.detail).toContain("our send a@x.com thread t-nous_decision:b bounced");
    expect(tileOf([decision("nous_decision:d", 5, { refs: {}, outcome: "Sent to Bob in Ops." })]).items).toEqual([]);
    expect(tileOf([decision("nous_decision:d", 5, { refs: {}, outcome: "Failed: pane closed" })]).points).toBe(-7.2);
    for (const extra of [{ status: "CANCELLED" }, { status: "DECLINED" }, { category: "RELEASE" }]) expect(tileOf([decision("nous_decision:e", 5, extra)]).items).toEqual([]);
    // Goal 84ba917a: a COPILOT item that ended (done with evidence or void) and a decision Nous marked (space_settle_decision) drop out.
    expect(nousScore(input({ approvals: { decisions: [decision("nous_decision:s", 5, { refs: {}, outcome: "Failed: This post is no longer waiting for a decision" })], sends: {},
      settled: { "nous_decision:s": { state: "DONE", proof: "https://reddit.com/r/x/1" } } } })).tiles.find((entry) => entry.key === "approvedNotDone")!.items).toEqual([]);
    for (const outcome of ["Done (marked by Nous): <msg-1@mail.gmail.com> — sent from a new thread", "Void (marked by Nous): the operator changed course"])
      expect(tileOf([decision("nous_decision:m", 5, { outcome })]).items).toEqual([]);
    // Audit 6/11 rule 3: an approved post scheduled ahead (1VOZAQFJPDUN, 10/11) is not owed before its date, and late only from it.
    const post = decision("nous_decision:p", 30, { refs: {}, outcome: "Failed: This post is no longer waiting for a decision" });
    expect(nousScore(input({ approvals: { decisions: [post], sends: {}, scheduled: { "nous_decision:p": at(-24 * HOUR) } } })).tiles.find((entry) => entry.key === "approvedNotDone")!.items).toEqual([]);
    expect(nousScore(input({ approvals: { decisions: [post], sends: {}, scheduled: { "nous_decision:p": at(5 * HOUR) } } })).tiles.find((entry) => entry.key === "approvedNotDone")!.items[0])
      .toMatchObject({ points: -7.2, detail: expect.stringContaining("scheduled 5 h ago") });
    // Recipients without a thread make it a mail send: the outcome alone does not confirm it, a logged send to them does.
    const toVodafone = decision("nous_decision:r", 5, { refs: { recipients: ["b2b@vodafone.gr"] }, outcome: "Sent to Dana in Ops." });
    expect(tileOf([toVodafone]).items[0]!.detail).toContain("no send of ours to b2b@vodafone.gr in any thread since the approval");
    expect(tileOf([toVodafone], { "nous_decision:r": "SENT" }).items).toEqual([]);
    // Grows with age: each hour costs more than the last, and the lever names the move.
    const cost = (hours: number) => tileOf([decision("nous_decision:f", hours)]).points;
    expect(cost(5) - cost(4)).toBeLessThan(cost(4) - cost(3));
    // The lever names which send and why, so the cause gets fixed once.
    const result = nousScore(input({ approvals: { decisions: [decision("nous_decision:b", 5), decision("nous_decision:g", 5, { refs: {}, outcome: "Failed: pane closed" })], sends: {} } }));
    const levers = nousScoreLeversText(result.levers, result);
    expect(levers).toContain("- Approved [nous_decision:b] «Reply nous_decision:b»: no send of ours a@x.com thread t-nous_decision:b since the approval · −7.2 now → −187.2 tomorrow · [move 1]");
    expect(levers).toContain("[move 1] run it now and confirm it (space_mail_read SENT)");
    expect(levers).toContain("- Approved [nous_decision:g] «Reply nous_decision:g»: Failed: pane closed · −7.2 now");
    // 13/11 (3fac478d, 2f27149c, 453972c2): with a reset 2 days ago the window still takes the approval itself, as approvalStates' send check
    // does: 8 days ago is out (no send entry, never charged); 3 days ago is in and counts from the reset (48 h: −5 − 0.25 × 46² = −534).
    const reset = { at: at(48 * HOUR), offset: 0, tiles: {} };
    const afterReset = nousScore(input({ reset, approvals: { decisions: [decision("nous_decision:old", 8 * 24), decision("nous_decision:in", 3 * 24)], sends: {} } }));
    expect(afterReset.tiles.find((entry) => entry.key === "approvedNotDone")!.items.map((item) => [item.id, item.points])).toEqual([["nous_decision:in", -534]]);
  });

  it("Parked plans (operator 13/11 nous_msg:4080b166): a closed parked plan costs from its last move, the first day free, then −2×days², with its condition as the lever", () => {
    const day = 24 * HOUR;
    const parked = (id: string, sinceMs: number, own: string[], waits: string[] = []) => ({ id, title: id, progress: 60, since: at(sinceMs), met: 1, total: 2, own, waits });
    const { tiles, levers } = nousScore(input({ parked: [parked("clipboard:fresh", 20 * HOUR, ["c1 NOUS: decide"]), parked("clipboard:old", 3 * day + HOUR, ["c2 AGENT: deploy"]),
      parked("clipboard:held", 2 * day, [], ["c1 OPERATOR: answers"]), parked("clipboard:dated", -5 * day, [], ["c1 DATE: Monday"])] }));
    const tile = tiles.find((entry) => entry.key === "parked")!;
    expect(tile.items.map((item) => [item.id, item.points])).toEqual([["clipboard:old", -18], ["clipboard:held", -8], ["clipboard:fresh", 0], ["clipboard:dated", 0]]);
    expect(tile.items[0]!.detail).toBe("closed and parked, unmoved 3 d · 1/2 conditions met");
    expect(tile.points).toBe(-26);
    const lever = (id: string) => levers.find((entry) => entry.id === id);
    expect([lever("clipboard:old")!.points, lever("clipboard:old")!.perDay, lever("clipboard:fresh")!.perDay]).toEqual([-18, -14, -2]);
    expect(lever("clipboard:old")!.action).toContain("do c2 AGENT: deploy now");
    expect(lever("clipboard:held")!.action).toContain("it waits on c1 OPERATOR: answers: no pane to open");
    // Waiting for a date five days out costs nothing and grows nothing yet.
    expect(lever("clipboard:dated")).toBeUndefined();
  });

  it("grows the plan's daily cost quadratically: ten days is far worse than one and the next day costs more", () => {
    const cost = (days: number) => nousScore(input({ plans: [{ id: "clipboard:old", title: "Old", createdAt: at(days * 24 * HOUR), working: true, stalled: null }] })).score;
    expect(cost(1)).toBe(-4);
    expect(cost(10)).toBe(-202);
    expect(cost(3) - cost(2)).toBeLessThan(cost(2) - cost(1));
  });

  it("charges active unmet goals by age, completed local days without progress, and each overdue day", () => {
    const goal = { id: "nous_goal:test001", text: "Ship", status: "ACTIVE" as const, createdAt: at(3 * 24 * HOUR),
      limit: { kind: "DATE" as const, until: at(24 * HOUR + 1) }, progressDays: ["2026-11-01", "2026-11-01", "2026-11-03"] };
    const result = nousScore(input({ goals: [goal, { ...goal, id: "paused", status: "PAUSED" }, { ...goal, id: "done", status: "ACHIEVED" }] }));
    // Three days unmet, two completed days without a progress/note change (today is not complete), two days late.
    expect(result.tiles.find((tile) => tile.key === "goals")).toMatchObject({ points: -52, items: [{ id: goal.id, points: -52,
      detail: "3 d unmet · 2 d without progress in 7 days · 2 d overdue" }] });
    expect(nousScore(input({ goals: [{ ...goal, createdAt: at(HOUR), limit: null, progressDays: [] }] })).score).toBe(0);
  });

  it("counts a day a pane reported PROGRESS or DONE on one of the goal's plans as goal progress (plan W48 step 3)", () => {
    const goal = { id: "nous_goal:g1", planIds: ["clipboard:planA001"] };
    const days = goalProgressDays(goal, [
      { goalId: "nous_goal:g1", kind: "NOTE", at: "2026-11-20T03:00:00Z" },
      { goalId: "nous_goal:g1", kind: "WAITS", at: "2026-11-19T03:00:00Z" },
      { goalId: "nous_goal:other", kind: "PROGRESS", at: "2026-11-18T03:00:00Z" }
    ], [
      { planId: "clipboard:planA001", status: "DONE", at: "2026-11-21T20:00:00Z" },
      { planId: "clipboard:planA001", status: "PROGRESS", at: "2026-11-20T05:00:00Z" },
      { planId: "clipboard:planA001", status: "HEARTBEAT", at: "2026-11-17T03:00:00Z" },
      { planId: "clipboard:planB001", status: "DONE", at: "2026-11-16T03:00:00Z" },
      { planId: null, status: "DONE", at: "2026-11-15T03:00:00Z" }
    ], "Asia/Bangkok");
    // 21/11 20:00Z is 22/11 in Bangkok; a heartbeat, another plan's or a planless report and a WAITS event are no progress.
    expect(days.sort()).toEqual(["2026-11-20", "2026-11-22"]);
  });

  it("uses the owner's calendar for goal inactivity across a DST day and never charges today before it ends", () => {
    const result = nousScore(input({ now: Date.parse("2026-11-02T05:30:00Z"), timeZone: "America/New_York", goals: [{
      id: "nous_goal:dsttest", text: "DST", status: "ACTIVE", createdAt: "2026-10-31T16:00:00Z", limit: null, progressDays: ["2026-11-01"] }] }));
    expect(result.tiles.find((tile) => tile.key === "goals")).toMatchObject({ points: -5 });
  });

  it("scores daily tools, chat and decision errors, shows today's and the window counts, and excludes refused/old/future facts", () => {
    const fact = (endedAt: string) => nousTurnFactsSchema.parse({ turnId: endedAt, ownerUserId: owner, reason: "OPERATOR", status: "DONE",
      startedAt: endedAt, endedAt, planPoints: 0, tools: { read: { calls: 8, failed: 4, refused: 2 } },
      outcomes: [{ summary: "Operator corrected this", outcome: "SELF", correction: true }] });
    const decision = nousDecisionSchema.parse({ id: "nous_decision:abcdef123456", ownerUserId: owner, category: "DIRECTION", title: "Ask",
      body: "Prediction: yes (90%)", options: [], recommendation: null, refs: {}, action: null, status: "DECLINED", answer: "No", outcome: null,
      createdAt: at(48 * HOUR), answeredAt: at(HOUR), couldHaveDecided: true });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "Asia/Bangkok", facts: [fact(at(HOUR)), fact(at(25 * HOUR)), fact(at(8 * 24 * HOUR)), fact(at(-HOUR))],
      decisions: [decision], lessons: [{ key: "lessons-score", createdAt: at(2 * HOUR), updatedAt: at(2 * HOUR) }, { key: "other", createdAt: at(HOUR), updatedAt: at(HOUR) }] });
    expect(dailyErrors).toEqual([
      { day: "2026-11-02", calls: 8, failed: 2, refused: 2, corrections: 1, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0,
        records: ["correction (no message): Operator corrected this"], last: { read: at(25 * HOUR), corrections: at(25 * HOUR) } },
      // 13/11 (Kevin's mail): the declined ask is charged once, as declined, never also as one it could have decided or a missed prediction (14/11).
      { day: "2026-11-03", calls: 8, failed: 2, refused: 2, corrections: 1, lessons: 1, declined: 1, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0,
        records: ["correction (no message): Operator corrected this", "lesson lessons-score 2026-11-03T14:00:00.000Z"],
        last: { read: at(HOUR), corrections: at(HOUR), declined: at(HOUR), lessons: at(2 * HOUR) } }
    ].map((day) => ({ ...day, tools: { read: 2 } })));
    expect(nousScoreErrors({ now: NOW, timeZone: "Asia/Bangkok", facts: [], lessons: [], decisions: [{ ...decision, status: "APPROVED", answer: "Yes" }] })
      .find((day) => day.day === "2026-11-03")).toMatchObject({ declined: 0, couldHaveDecided: 1 });
    expect(nousScoreErrors({ now: NOW, timeZone: "Asia/Bangkok", facts: [], lessons: [], decisions: [{ ...decision, status: "ANSWERED", answer: "No" }] })
      .find((day) => day.day === "2026-11-03")).toMatchObject({ declined: 0, predictionMisses: 1, records: ["prediction miss nous_decision:abcdef123456: No"] });
    // 22/11 (d43fff0e + d4924b41): free grant auto-declined by Never buy on negated «δεν πληρώνουν» is excused as ruleMisfire.
    const misfire = { ...decision, id: "nous_decision:d43fff0e91f94fdc902069b6", category: "EXTERNAL" as const,
      title: "Codex for Open Source (OpenAI): να υποβληθεί η δωρεάν αίτηση με αυτά ακριβώς τα πεδία;",
      recommendation: "Τα API credits είναι δωρεάν tokens που δεν πληρώνουν τίποτε άλλο.", status: "DECLINED" as const, answer: NEVER_BUY_ANSWER };
    expect(nousScoreErrors({ now: NOW, timeZone: "Asia/Bangkok", facts: [], lessons: [], decisions: [misfire] })
      .find((day) => day.day === "2026-11-03")).toMatchObject({ declined: 0 });
    const result = nousScore(input({ dailyErrors, timeZone: "Asia/Bangkok" }));
    expect(result.tiles.find((tile) => tile.key === "dailyErrors")).toMatchObject({ points: -28, detail: expect.stringContaining("Today: 5 · 7 days: 8") });
    // No second charge through the legacy Corrections / Asked, could decide tiles.
    expect(result.tiles.some((tile) => ["corrections", "couldHaveDecided"].includes(tile.key))).toBe(false);
  });

  it("counts a failed or timed-out turn as a chat error and an answered decision whose action failed; a stopped turn is neither", () => {
    const turn = (status: string) => nousTurnFactsSchema.parse({ turnId: status, ownerUserId: owner, reason: "OPERATOR", status, startedAt: at(HOUR), endedAt: at(HOUR),
      planPoints: 0, tools: {}, outcomes: [] });
    const decision = (id: string, outcome: string | null) => nousDecisionSchema.parse({ id, ownerUserId: owner, category: "DIRECTION", title: "Run", body: "",
      options: [], recommendation: null, refs: {}, action: null, status: "APPROVED", answer: "Yes", outcome, createdAt: at(2 * HOUR), answeredAt: at(HOUR) });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [turn("FAILED"), turn("TIMEOUT"), turn("STOPPED"), turn("DONE")],
      decisions: [decision("nous_decision:failed000001", "Failed: the pane is gone"), decision("nous_decision:approved0001", "Approved the review")], lessons: [] });
    expect(dailyErrors).toMatchObject([{ day: "2026-11-03", chatErrors: 2, decisionsFailed: 1 }]);
    expect(nousScore(input({ dailyErrors })).tiles.find((tile) => tile.key === "dailyErrors")).toMatchObject({ points: -5,
      detail: "Today: 3 · 7 days: 3", items: expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("2 chat errors · 1 decisions failed") })]) });
  });

  it("does not count a turn no account had quota for as a chat error (Daily Nous errors 13/11)", () => {
    const turn = (error: string) => nousTurnFactsSchema.parse({ turnId: error, ownerUserId: owner, reason: "OPERATOR", status: "FAILED", startedAt: at(HOUR), endedAt: at(HOUR),
      planPoints: 0, tools: {}, outcomes: [], error });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [turn("Space Gateway: no available tokens for claude"), turn("The turn failed: 401 invalid_api_key")], decisions: [], lessons: [] });
    expect(dailyErrors).toMatchObject([{ day: "2026-11-03", chatErrors: 1 }]);
  });

  it("does not count a turn Space's own restart or database stopped, recorded FAILED before that rule (Daily Nous errors 13/11)", () => {
    const turn = (error: string) => nousTurnFactsSchema.parse({ turnId: error, ownerUserId: owner, reason: "OPERATOR", status: "FAILED", startedAt: at(HOUR), endedAt: at(HOUR),
      planPoints: 0, tools: {}, outcomes: [], error });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "UTC", decisions: [], lessons: [], facts: [
      turn("Claude Opus 5.5 · Claude: The CLI was stopped by SIGTERM (likely a server restart) before it returned a result."),
      turn("timeout exceeded when trying to connect"),
      turn("Claude: API Error: 500 timeout exceeded when trying to connect. (earlier: Codex: ECONNREFUSED)"),
      turn("Codex: ECONNREFUSED 127.0.0.1:4920"),
      turn("Codex: exceeded retry limit, last status: 429 Too Many Requests (earlier: database system is starting up)")] });
    // The gateway connection refusal and 429 are transient holds too, including facts recorded before that distinction.
    expect(dailyErrors).toMatchObject([{ day: "2026-11-03", chatErrors: 0 }]);
  });

  it("reclassifies historical caller/state holds from their recorded samples, without rewriting facts or forgiving unsampled failures", () => {
    const holds: Record<string, string[]> = {
      space_db_query: ['Postgres: relation "space_memory" does not exist (code 42P01)', 'Postgres: syntax error in jsonpath input (code 42601)',
        'Postgres: column "title" does not exist (code 42703)', 'Postgres: operator does not exist: text ->> unknown (code 42883)',
        'Postgres: column reference "status" is ambiguous (code 42702)', 'Postgres: more than one row returned by a subquery used as an expression (code 21000)',
        'Connection terminated unexpectedly'],
      space_task_update: ['Task item task:gone was not found.', 'No task gone.', 'gone is no task id. Open tasks: task:open'],
      space_ask_operator: ['file.md is inside nous, a folder the agent that made it keeps private (mode 700): Space can read …',
        'mailrev:gone: No file or folder mailrev:gone under the agent workspace.', 'file.png: file.png is a binary…',
        'The action approves no ticket. Have the pane submit the hotfix first.', 'The action\'s room "old" is not one of the operator\'s rooms.',
        'replaces names nous_decision:old, which is not an open decision of yours: nothing to replace.', 'Invalid arguments: prediction: Invalid input: expected object, received string'],
      space_pane_checked: ['No open pane named "Dana" in Cleo.', 'WAITING_DATE needs nextCheckInMinutes: when to look again.'],
      space_look: ['Dana has no live browser session: nothing to look at.', 'The Browser Host is unavailable.',
        'No Xvfb display is available for a headed browser session.', 'BROWSER_ROUTE: another pane uses this browser account on another network route;',
        'app.apk (artifact:app) is application/vnd.android.package-archive, not an image (PNG, JPEG, WebP or GIF): read text with space_files_read.'],
      space_read_pane: ['No open pane named "Andy" in Bruno.', 'No room named "gone". Rooms: Alex.'],
      space_execute: ['FAILED status: Watch ID is required.', 'FAILED status: Watch not found.', 'FAILED configure pane:old: The CLI session changed during the model switch.', 'FAILED configure pane:old: Pane has no active session.'],
      space_files_read: ['No Agent Files or Media artifact artifact:gone in your rooms.', 'file.txt is 46 MB; files up to 8 MB are read.', 'Only files under /var/lib/spaceapp-user/agent-workspace can be read.'],
      space_copilot_answer: ['"old question" is neither the id nor the words of an open MAIL question. Open now: none. An…', 'The question was not found.'],
      space_answer_pane: ['Bob is not waiting for an answer (state IDLE). It is at an empty prompt.', 'Dana is not waiting for an answer (state EXITED). Read the pane again.', 'The pane\'s question changed since it was inspected; inspect it again before answering.'],
      space_send_to_pane: ['Not sent: Andy: The CLI has not opened its input yet; no input was sent.', 'Not sent: Bob: The CLI kept the text as an unsent draft after Enter; it was not submitted.'],
      space_programs: ['No program aws-activate. Ids with its words: other.', 'braintrust-startups: reapply.when: Not a date', 'Only Nous changes the programs registry'],
      space_plan_update: ['Clipboard item clipboard:gone was not found.', 'Give a status, a percentage, a step, new steps, a title or text, a link, the plan map (dependsOn, dueAt, waitsOn) or park.', 'Invalid arguments: dueAt: Invalid ISO datetime']
    };
    for (const [name, samples] of Object.entries(holds)) for (const error of samples) {
      const fact = nousTurnFactsSchema.parse({ turnId: 'historical', ownerUserId: owner, reason: 'OPERATOR', status: 'DONE', startedAt: at(HOUR), endedAt: at(HOUR), planPoints: 0, outcomes: [],
        tools: { [name]: { calls: 4, failed: 3, refused: 1, errors: [error] } } });
      const before = structuredClone(fact);
      const [day] = nousScoreErrors({ now: NOW, timeZone: 'UTC', facts: [fact], decisions: [], lessons: [] });
      expect(day, `${name}: ${error}`).toMatchObject({ calls: 4, failed: 1, refused: 2, tools: { [name]: 1 } });
      expect(fact).toEqual(before);
    }
  });

  it("slice 6 (11-14/11): the cut 200-character samples of answers tools.ts now holds are held; real failures stay charged", () => {
    const receipt = (detail: string) => `{"status":"FAILED","operationId":"${"6b1a270d".repeat(8)}","results":[{"paneId":"pane:XOu-5N6yjLGv","status":"FAILED","detail":"${detail}"}]} The pane keeps its current model.`;
    const tail = `\n{"dotId":"dot:fb378243c320313db0ffaf09c8d77e02","id":"${"ce5920b7".repeat(8)}","actorId":"user:operator","roomId":"room:HrUVNdg"}`;
    const zod = (key: string) => `FAILED panes.open: [\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "${key}"\n    ],\n    "path": [],\n    "message": "Unrecognized key: \\"${key}\\""\n  }\n]${tail}`;
    const sample = (text: string) => { const tool = { calls: 1, failed: 1, refused: 0 }; addToolErrorSample(tool, text); return (tool as { errors: string[] }).errors[0]!; };
    const cases: Array<[string, string, boolean]> = [
      ["space_execute", `FAILED status: Watch ID is required.${tail}`, true],
      ["space_execute", `FAILED status pane:3870_EI5q5rn, pane:GkbF-AeyuY4-: Watch ID is required.${tail}`, true],
      ["space_execute", `FAILED status: Watch not found.${tail}`, true],
      ["space_execute", `FAILED configure pane:Fl2655iXeKLh: Pane has no active session.${tail}`, true],
      ["space_execute", `FAILED configure pane:ehGlvXqoPK_1: The CLI session changed during the model switch.${tail}`, true],
      ["space_execute", zod("mail_copilot"), true],
      ["space_execute", zod("jobcopilot"), true],
      ["space_set_pane_model", receipt("The CLI session changed during the model switch."), true],
      ["space_set_pane_model", receipt("Claude is working; change its model after the current turn."), true],
      ["space_set_pane_model", receipt("Codex rejected the requested pre-thread model settings."), true],
      ["space_set_pane_model", receipt("Live Codex model control is unavailable; the current CLI session was left unchanged."), true],
      ["space_close_pane", receipt("Pane pane:cS8DBIi-HTIU stays open: its Marketing Copilot has 1 approved post scheduled"), true],
      ["space_copilot_control", "The CLI has not opened its input yet (still starting, or waiting for sign-in or a question); no input was sent.", true],
      ["space_programs", "Only Nous changes the programs registry", true],
      ["space_programs", "No program fulcrum", true],
      // 14/11: the entry's own problems (fields, twin, operator lock) and missing arguments save nothing and name the fix.
      ["space_programs", "braintrust-startups: reapply.when: Not a date", true],
      ["space_programs", "acme: a new program needs parent, program and status", true],
      ["space_programs", "sentry2: Sentry › Sentry for Startups is already recorded as sentry-startups; update sentry-startups instead (nothing was saved)", true],
      ["space_programs", "upcloud-for-startups: amount locked by the operator; change or unlock it only with a new source in sources (the operator's message or mail that says so); nothing was saved", true],
      ["space_programs", "mail: date: Invalid input: expected string, received undefined", true],
      ["space_programs", "add_mail needs id and mail", true],
      // 14/11 (7/11 15:45 ×6, 7/11 14:51, 8/11 06:30, 14/11 01:54): a short id, a branch no repository has and a path not at that revision.
      ["space_git", "git: error: short object ID 2e50 is ambiguous", true],
      ["space_git", "git: fatal: ambiguous argument 'fix/snip-held-video-paste^...fix/snip-held-video-paste': unknown revision or path not in the working tree.", true],
      ["space_git", "git: fatal: no such path apps/web/src/features/agent-files/AgentFileLinks.tsx in HEAD", true],
      ["space_git", "git: fatal: path 'apps/api/src/mail-copilot-routes.ts' does not exist in 'HEAD'", true],
      ["space_git", "git: fatal: path 'apps/api/src/cli-routes.ts' does not exist in 'HEAD'\nNearest paths at HEAD: apps/api/src/cli-account-routes.ts, apps/api/src/cli-auth-handoff-routes.ts.", true],
      ["space_appointment_add", "Appointment refused, its notes miss: the account HOW TO JOIN signs in with (or \"no sign-in\"). Add them and retry.", true],
      ["space_plan_update", "clipboard:7S_jA46vDkU9 is not parked with a condition c1; park it first (park).", true],
      ["space_notify_operator", "clipboard:mmeF0-e3x4G is no plan of yours: name it by its clipboard id (space_plans lists them).", true],
      ["space_request_done", "No such plan", true],
      ["space_settle_decision", "nous_decision:c25803f2 is not one of your decisions.", true],
      ["space_tool_result", "No long answer of call toolu_0179HqQAZRGmZSgkW73mjq2f is kept (a turn's answers over 2,000 characters are kept while it runs)", true],
      ["space_tool_result", "No answer of space_world is kept: only answers over 2,000 characters are kept (a shorter one was shown whole)", true],
      ["space_resolve_notification", "No open notification notification:9ba1c247c64a4f7a8e1d3f05.", true],
      ["space_nous_share_file", "No Agent File KzndPmwLS2_k in your rooms: only the operator's Agent Files are shared.", true],
      ["space_subagents", "Give tasks to start helpers, or the runId of a run you started to read it; not both.", true],
      ["space_nous_followup", "Give exactly one trigger: at or inMinutes, ticket, or room and pane.", true],
      ["space_codex_reset_redeem", "ntheogr@gmail.com is back by itself Sat 14 Nov, 02:16 Asia/Bangkok, within 6 hours: a credit now would be wasted. Nothing spent.", true],
      ["space_mail_read", "info@example.invalid: info@example.invalid: Gmail no longer has that message or thread. Connected Gmail accounts: info@example.invalid. Next: find it with space_mail_search.", true],
      ["space_mail_search", "crew@spaceapp.dev is not a mail account of this pane.", true],
      // 14/11 slice 11: answers that name the next call (another pane, a key, a pane kind, a field) or a state Space holds today.
      ["space_set_pane_model", receipt("This Claude Code version cannot change the model for one pane only."), true],
      ["space_set_pane_model", receipt('\\"gemini-4-argon\\" is no Claude model: Claude offers claude:sonnet (low/medium/high/xhigh/max).'), true],
      ["space_set_pane_model", "This CLI cannot list claude-opus-5-5; open a Claude Code pane. Nothing changed or queued.", true],
      ["space_set_pane_model", "space-gateway-claude/claude-opus-5-5 bills the paid Claude API key, and Claude Max still has room (its best account has at least 10% of both windows). Open a Claude Code pane", true],
      ["space_notes", "No note has the key goal-e803-daily-20261109; space_notes {} lists every key.", true],
      ["space_browser_set_route", "Pane pane:eA-QB5jgetcT is TERMINAL; browser sessions require BROWSER, YOUTUBE, JOB_APPLY, MARKETING_COPILOT or FREELANCE_COPILOT panes.", true],
      ["space_browser_close_tab", "No open tab 7F80260BA4121ED0166978B5166978B5148E50A8 in that browser: read space_browser_tabs again.", true],
      ["space_browser_close_tab", "The Browser Host is unavailable.", true],
      ["space_web_search", "Web search HTTP 429: Rate limit exceeded. Try again in 300s. Web search is out of quota until 2026-11-11 05:35 UTC (Space Gateway's Codex accounts): nothing was searched", true],
      ["space_notify_operator", '"Paired?" has options and no recommended one: Every decision carries a prediction (goal 7365014c criterion 3)', true],
      // Real failures: a cut detail that names no hold, a host or network fault, a slow query, a broken write, a rolled-back update.
      ["space_restart_pane", receipt("CLI session cli_session:WoPtbmC2nMfP closed before input could be sent."), false],
      ["space_execute", "FAILED panes.open: [", false],
      ["space_copilot_control", "The request could not be completed.", false],
      ["space_db_query", "Postgres: canceling statement due to statement timeout (code 57014)", false],
      ["space_memory_save", "EACCES: permission denied, open '/opt/spaceapp/docs/space_memory_2026-11.md'", false],
      ["space_net_check", "DNS A spaceapp.example failed: ETIMEOUT.", false],
      ["space_git", "git took longer than 15 s.", false],
      ["space_programs", "The programs registry is unavailable", false],
      ["space_programs", "Postgres: canceling statement due to statement timeout (code 57014)", false]
    ];
    for (const [name, text, held] of cases) {
      const error = sample(text);
      const fact = nousTurnFactsSchema.parse({ turnId: 'slice6', ownerUserId: owner, reason: 'OPERATOR', status: 'DONE', startedAt: at(HOUR), endedAt: at(HOUR), planPoints: 0, outcomes: [],
        tools: { [name]: { calls: 1, failed: 1, refused: 0, errors: [error] } } });
      const [day] = nousScoreErrors({ now: NOW, timeZone: 'UTC', facts: [fact], decisions: [], lessons: [] });
      expect(day?.failed ?? 0, `${name}: ${error}`).toBe(held ? 0 : 1);
    }
  });

  // Queue 1053 (5 samples of 3 turns read only "FAILED panes.open: ["): a first line that opens a JSON list or object goes on with the rest.
  it("slice 11: a failed call's cause keeps the JSON its first line opens, spaces collapsed, within 200 characters", () => {
    const zod = 'FAILED panes.open: [\n  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "mail_copilot"\n    ],\n    "path": []\n  }\n]';
    const cause = toolFailureCause(zod);
    expect(cause).toBe('FAILED panes.open: [ { "code": "unrecognized_keys", "keys": [ "mail_copilot" ], "path": [] } ]');
    const tool = { calls: 1, failed: 1, refused: 0 }; addToolErrorSample(tool, cause);
    const fact = nousTurnFactsSchema.parse({ turnId: 'slice11', ownerUserId: owner, reason: 'OPERATOR', status: 'DONE', startedAt: at(HOUR), endedAt: at(HOUR), planPoints: 0, outcomes: [],
      tools: { space_execute: tool } });
    expect(nousScoreErrors({ now: NOW, timeZone: 'UTC', facts: [fact], decisions: [], lessons: [] })[0]?.failed ?? 0).toBe(0);
    expect(toolFailureCause("\nNo note has the key x; space_notes {} lists every key.\nMore.")).toBe("No note has the key x; space_notes {} lists every key.");
    expect(toolFailureCause(`FAILED panes.open: [\n${"x ".repeat(300)}`)).toHaveLength(200);
    expect(toolFailureCause("")).toBe("");
  });

  // Plan clipboard:1NF6u6gcCwtj step 4: receipts recorded as `{"status":"FAILED","operationId":…` cut at 200 (restart_pane 11/11, close_pane 9/11).
  it("a failed call whose first line is a Space Control receipt records its first unfinished result, not the JSON", () => {
    const restart = '{"status":"FAILED","operationId":"9d8a6339","results":[{"paneId":"pane:hnZS2v9Km4Js","status":"FAILED","detail":"CLI session cli_session:WoPtbmC2nMfP closed before input could be sent."}]}';
    expect(toolFailureCause(restart)).toBe("FAILED pane:hnZS2v9Km4Js: CLI session cli_session:WoPtbmC2nMfP closed before input could be sent.");
    const partial = '{"status":"PARTIAL","operationId":"7aef","results":[{"paneId":"pane:t-kpKsFYscEj","status":"COMPLETED","detail":"Pane control applied."},'
      + '{"paneId":"pane:b","status":"UNKNOWN","detail":"Not confirmed.","error":"Room lock\\ntimed out."}]}';
    expect(toolFailureCause(partial)).toBe("UNKNOWN pane:b: Room lock timed out.");
    const model = '{"status":"FAILED","operationId":"1305","results":[{"paneId":"pane:-RzMl5rto98Z","status":"FAILED","detail":"Claude is working; change its model after the current turn."}]} The pane keeps its current model.\nMore.';
    expect(toolFailureCause(model)).toBe("FAILED pane:-RzMl5rto98Z: Claude is working; change its model after the current turn.");
    const execute = JSON.stringify({ id: "op", status: "FAILED", results: [{ index: 0, status: "COMPLETED", detail: "ok" }, { index: 1, status: "FAILED", detail: "Pane pane:x was not found." }],
      command: { actions: [{ kind: "pane", operation: "start" }, { kind: "browser", operation: "browser.content" }] } });
    expect(toolFailureCause(execute)).toBe("FAILED browser.content: Pane pane:x was not found.");
    // Not a receipt with an unfinished result: the old rule (first line, JSON it opens).
    expect(toolFailureCause('{"status":"FAILED","results":[]}')).toBe('{"status":"FAILED","results":[]}');
    expect(toolFailureCause("{ not json }")).toBe("{ not json }");
  });

  it("keeps genuine, mixed, unknown and cut-off failures charged; legacy error is one sample, errors takes precedence", () => {
    const tools = {
      space_db_query: { calls: 5, failed: 5, refused: 1, errors: ['Connection terminated unexpectedly', 'Postgres: canceling statement due to statement timeout (code 57014)', 'unexpected query execution failure'] },
      space_execute: { calls: 1, failed: 1, refused: 0, errors: ['FAILED panes.open: ['] },
      space_look: { calls: 1, failed: 1, refused: 0, errors: ['The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR).'] },
      space_task_update: { calls: 2, failed: 2, refused: 0, error: 'No task old.' },
      space_plan_update: { calls: 1, failed: 1, refused: 0, error: 'Invalid arguments: dueAt: Invalid ISO datetime', errors: ['Unexpected storage error'] },
      unknown: { calls: 1, failed: 1, refused: 0 }
    };
    const fact = nousTurnFactsSchema.parse({ turnId: 'mixed', ownerUserId: owner, reason: 'OPERATOR', status: 'DONE', startedAt: at(HOUR), endedAt: at(HOUR), planPoints: 0, outcomes: [], tools });
    const [day] = nousScoreErrors({ now: NOW, timeZone: 'UTC', facts: [fact], decisions: [], lessons: [] });
    expect(day).toMatchObject({ calls: 11, failed: 8, refused: 3, tools: { space_db_query: 3, space_execute: 1, space_look: 1, space_task_update: 1, space_plan_update: 1, unknown: 1 } });
    // Slice 8: each counted tool names its latest counted sample; a count whose samples were all held (task_update) names none.
    expect(day!.causes).toEqual({ space_db_query: 'unexpected query execution failure', space_execute: 'FAILED panes.open: [',
      space_look: 'The Browser Host is running but failed this request (BROWSER_HOST_INTERNAL_ERROR).', space_plan_update: 'Unexpected storage error' });
  });

  it("leaves historical provider holds and tool allowlist refusals out of chat errors, but keeps auth, unknown and real timeouts", () => {
    const held = ['Codex: exceeded retry limit, last status: 429 Too Many Requests — not retried on another route: this run had already acted.',
      'Space Gateway answered 503: Service Unavailable', 'Codex: ECONNREFUSED 127.0.0.1:4920', 'Gemini requested a tool outside the Nous allowlist.',
      'Claude: 403 Forbidden: 5-hour limit reached', 'Claude Opus 5.5 · Claude via OpenCode: Waiting for the selected VPN connection...',
      'gemini-4-argon-high · Gemini Argon (Antigravity): Gemini needs a new sign-in.', 'gemini-4-argon-high · Gemini Argon (Antigravity): Gemini returned HTTP 404.',
      // 18/11 and 23/11: route faults the router fails over on, failing only when every route had one.
      'gemini-3.8-flash-high · Gemini 3.8 Flash (Antigravity): Gemini returned HTTP 403.', 'Gemini returned an empty answer.',
      'Claude Sonnet 5.5 · Claude via OpenCode: OpenCode requested a tool outside Nous.', 'Claude sent no reply within 5 minutes of the start: the route was unavailable.',
      'Claude Opus 5.5 · Claude via OpenCode: OpenCode did not start its server. (earlier: Claude Opus 5.5 · Claude: Claude sent no reply within 5 minutes of the start: the route was unavailable.)'];
    const charged = ['401 invalid_api_key (earlier: Codex: 429 Too Many Requests)', 'An unexpected bug (earlier: no available tokens)',
      'Claude Opus 5.5 · Claude: No answer within 20 minutes.'];
    const facts = [...held, ...charged].map((error, i) => nousTurnFactsSchema.parse({ turnId: `turn:${i}`, ownerUserId: owner, reason: 'OPERATOR', status: 'FAILED', startedAt: at(HOUR), endedAt: at(HOUR), planPoints: 0, tools: {}, outcomes: [], error }));
    facts.push({ ...facts[0]!, turnId: 'timeout', status: 'TIMEOUT', error: 'Timed out after 20 minutes. (earlier: quota exhausted)' });
    expect(nousScoreErrors({ now: NOW, timeZone: 'UTC', facts, decisions: [], lessons: [] })).toMatchObject([{ chatErrors: charged.length + 1 }]);
  });

  it("holds a turn the pve-az resize shutdowns of 12/11 cut (05:33:00, 05:42:04 UTC), never a turn that failed outside them or a timeout in them", () => {
    const now = Date.parse("2026-11-14T00:00:00Z");
    const fact = (turnId: string, endedAt: string, status = "FAILED") => nousTurnFactsSchema.parse({ turnId, ownerUserId: owner, reason: "OPERATOR", status, startedAt: endedAt,
      endedAt, planPoints: 0, tools: {}, outcomes: [], error: 'Claude Opus 5.5 · Claude: "input_json_delta","partial_json":", \\"pane"}}' });
    const errors = (facts: Array<ReturnType<typeof nousTurnFactsSchema.parse>>) => nousScoreErrors({ now, timeZone: "UTC", facts, decisions: [], lessons: [] }).reduce((sum, day) => sum + day.chatErrors, 0);
    expect(errors([fact("cut1", "2026-11-12T05:33:00.335Z"), fact("cut2", "2026-11-12T05:42:04.848Z")])).toBe(0);
    expect(errors([fact("before", "2026-11-12T05:29:34.000Z"), fact("between", "2026-11-12T05:38:00.000Z"), fact("other-day", "2026-11-13T05:33:00.000Z"),
      fact("timeout", "2026-11-12T05:42:04.000Z", "TIMEOUT")])).toBe(4);
  });

  it("counts a lesson on its creation and each incident it gained, never on a rewrite or the merge that moved it", () => {
    const errors = (lessons: Parameters<typeof nousScoreErrors>[0]["lessons"]) => nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [], decisions: [], lessons })
      .map((day) => [day.day, day.lessons]);
    // Created 20 days ago, rewritten today: nothing in the window.
    expect(errors([{ key: "lessons-old", text: "rewritten", createdAt: at(20 * 24 * HOUR), updatedAt: at(HOUR) }])).toEqual([]);
    // Created 25/10 (outside), a same-cause incident on 2/11, a lesson of 1/11 merged today: 1/11 and 2/11 count, today's merge does not.
    expect(errors([{ key: "lessons-target", createdAt: at(9 * 24 * HOUR), updatedAt: at(HOUR), text: ["Base.", "--- Incident (2026-11-02T10:00:00.000Z, saved as lessons-x):\nAgain.",
      "--- Incident (merged from lessons-y, 2026-11-01T08:00:00.000Z):\nY."].join("\n\n") }])).toEqual([["2026-11-01", 1], ["2026-11-02", 1]]);
    // A new lesson today counts once; a note with no created_at updated today counts nothing (its update is a rewrite), only its incidents (a date-only one too).
    expect(errors([{ key: "lessons-new", text: "New.", createdAt: at(HOUR), updatedAt: at(HOUR) }, { key: "lessons-legacy", text: "Old.", createdAt: null, updatedAt: at(2 * HOUR) },
      { key: "lessons-legacy2", text: "Old.\n\n--- Incident (2026-11-02, saved as lessons-z):\nZ.", createdAt: null, updatedAt: at(HOUR) }])).toEqual([["2026-11-02", 1], ["2026-11-03", 1]]);
    expect(errors([{ key: "lessons-legacy", text: "Old.", createdAt: null, updatedAt: at(HOUR) }])).toEqual([]);
  });

  it("does not charge a lesson again in a turn that already costs its cause: the daily REVIEW, or a turn with a correction (decision b6effe98 α)", () => {
    const turn = (reason: string, from: number, to: number, correction: boolean) => nousTurnFactsSchema.parse({ turnId: `${reason}${from}`, ownerUserId: owner, reason,
      status: "DONE", startedAt: at(from), endedAt: at(to), planPoints: 0, tools: {}, outcomes: correction ? [{ summary: "Wrong", outcome: "SELF", correction: true }] : [] });
    const facts = [turn("REVIEW", 10 * HOUR, 9 * HOUR, false), turn("OPERATOR", 6 * HOUR, 5 * HOUR, true), turn("OPERATOR", 3 * HOUR, 2 * HOUR, false)];
    const lessons = [{ key: "lessons-review", createdAt: at(9.5 * HOUR), updatedAt: at(9.5 * HOUR) }, { key: "lessons-corrected", createdAt: at(5.5 * HOUR), updatedAt: at(5.5 * HOUR),
      text: "Base.\n\n--- Incident (" + at(2.5 * HOUR) + ", saved as lessons-again):\nSelf-found again." }, { key: "lessons-self", createdAt: at(2.5 * HOUR), updatedAt: at(2.5 * HOUR) }];
    // The REVIEW's and the correction's lessons cost nothing; the self-found lesson and the self-found incident count.
    expect(nousScoreErrors({ now: NOW, timeZone: "UTC", facts, decisions: [], lessons })).toMatchObject([{ day: "2026-11-03", corrections: 1, lessons: 2 }]);
  });

  it("charges one correction per operator message, however many outcomes or turns mark it (13/11: 5 of 37 were repeats)", () => {
    const turn = (id: string, endedHoursAgo: number, outcomes: Array<{ messageIds?: string[] }>) => nousTurnFactsSchema.parse({ turnId: id, ownerUserId: owner, reason: "OPERATOR",
      status: "DONE", startedAt: at(endedHoursAgo + 0.5), endedAt: at(endedHoursAgo), planPoints: 0, tools: {},
      outcomes: outcomes.map((outcome) => ({ summary: "Wrong", outcome: "SELF", correction: true, ...outcome })) });
    const facts = [
      // Listed out of order: the later turn re-marks the message the earlier one charged, and adds a new one.
      turn("later", HOUR, [{ messageIds: ["nous_msg:aaaaaaaa"] }, { messageIds: ["nous_msg:aaaaaaaa", "nous_msg:bbbbbbbb"] }]),
      turn("first", 3 * HOUR, [{ messageIds: ["nous_msg:aaaaaaaa"] }, { messageIds: ["nous_msg:aaaaaaaa"] }]),
      // No bound message: each still counts.
      turn("unbound", 2 * HOUR, [{}, {}])];
    expect(nousScoreErrors({ now: NOW, timeZone: "UTC", facts, decisions: [], lessons: [] })).toMatchObject([{ day: "2026-11-03", corrections: 4 }]);
  });

  it("charges a complaint again about a mistake already charged as that one correction (14/11: intratrade ×2, provider ×3, load ×5)", () => {
    const turn = (id: string, endedHoursAgo: number, messageId: string, repeats?: string) => nousTurnFactsSchema.parse({ turnId: id, ownerUserId: owner, reason: "OPERATOR",
      status: "DONE", startedAt: at(endedHoursAgo + 0.5), endedAt: at(endedHoursAgo), planPoints: 0, tools: {},
      outcomes: [{ summary: "Wrong", outcome: "SELF", correction: true, messageIds: [messageId], ...(repeats ? { repeats } : {}) }] });
    const facts = [turn("first", 5 * HOUR, "nous_msg:aaaaaaaa"), turn("again", 4 * HOUR, "nous_msg:bbbbbbbb", "nous_msg:aaaaaaaa"),
      // A chain: the third names the second, which is charged through the first.
      turn("third", 3 * HOUR, "nous_msg:cccccccc", "nous_msg:bbbbbbbb"),
      // Naming a message no correction charged is a correction of its own.
      turn("other", 2 * HOUR, "nous_msg:dddddddd", "nous_msg:zzzzzzzz"),
      // Naming its own message is no repeat.
      turn("self", HOUR, "nous_msg:eeeeeeee", "nous_msg:eeeeeeee")];
    expect(nousScoreErrors({ now: NOW, timeZone: "UTC", facts, decisions: [], lessons: [] })).toMatchObject([{ day: "2026-11-03", corrections: 3 }]);
  });

  it("charges each judged day a DAILY task's text never reached its pane, and judges a day only once its next run is due (the scheduler runs it late until then)", () => {
    const task = { id: "task:daily01", title: "API check", createdAt: at(3 * 24 * HOUR), time: "01:00", timeZone: "UTC", nextRunAt: "2026-11-03T01:00:00.000Z" };
    const score = (now: number) => nousScore(input({ now,
      dailyTasks: [task, { ...task, id: "task:later", title: "Later today", time: "10:00", createdAt: at(HOUR) }],
      // 1/11 typed; 2/11 skipped (never typed); 3/11 nothing yet, its next run (still owed); another task's run never counts.
      taskRuns: [{ taskId: task.id, dueAt: "2026-11-01T01:00:00.000Z", typed: true }, { taskId: task.id, dueAt: "2026-11-02T01:00:00.000Z", typed: false },
        { taskId: "task:other", dueAt: "2026-11-03T01:00:00.000Z", typed: true }]
    })).tiles.find((tile) => tile.key === "dailyTasks");
    expect(score(Date.parse("2026-11-04T01:00:00.000Z"))).toMatchObject({ points: -10, detail: "2 daily · 2 missed days in 7 days",
      items: [{ id: task.id, points: -10, detail: "01:00 daily · ran 1 of 3 days · missed 2026-11-02, 2026-11-03" }, { id: "task:later", points: 0, detail: "10:00 daily · ran 0 of 0 days" }] });
    // 3/11 01:00 may still run late until 4/11 01:00, so it is not judged a minute before.
    expect(score(Date.parse("2026-11-04T00:59:00.000Z"))?.items[0]).toMatchObject({ detail: "01:00 daily · ran 1 of 2 days · missed 2026-11-02" });
  });

  it("briefs no code-fix pane for a missed task whose text reached its pane on a later day; its miss still counts (13/11: the 12/11 misses, fixed)", () => {
    const task = { id: "task:fixed", title: "Temu watch", createdAt: at(3 * 24 * HOUR), time: "01:00", timeZone: "UTC", nextRunAt: "2026-11-04T01:00:00.000Z" };
    const broken = { ...task, id: "task:broken", title: "Grants" };
    // 2/11 skipped for both (a run row, never typed).
    const runs = [{ taskId: task.id, dueAt: "2026-11-01T01:00:00.000Z", typed: true }, { taskId: task.id, dueAt: "2026-11-03T01:00:00.000Z", typed: true },
      { taskId: broken.id, dueAt: "2026-11-01T01:00:00.000Z", typed: true }, ...[task.id, broken.id].map((taskId) => ({ taskId, dueAt: "2026-11-02T01:00:00.000Z", typed: false }))];
    const result = nousScore(input({ now: Date.parse("2026-11-03T12:00:00.000Z"), dailyTasks: [task, broken], taskRuns: runs }));
    expect(result.tiles.find((tile) => tile.key === "dailyTasks")?.items).toEqual([
      expect.objectContaining({ id: task.id, points: -5, detail: "01:00 daily · ran 1 of 2 days · missed 2026-11-02 · reached its pane again 2026-11-03" }),
      expect.objectContaining({ id: broken.id, points: -5, detail: "01:00 daily · ran 1 of 2 days · missed 2026-11-02" })]);
    expect(result.levers.map((lever) => lever.id)).toContain(broken.id);
    expect(result.levers.map((lever) => lever.id)).not.toContain(task.id);
    const brief = result.levers.find((lever) => lever.label.startsWith("Daily tasks"))?.action ?? "";
    expect(brief).toContain("Grants");
    expect(brief).not.toContain("Temu");
    // Every missed task ran again: no code-fix brief at all.
    const fixed = nousScore(input({ now: Date.parse("2026-11-03T12:00:00.000Z"), dailyTasks: [task], taskRuns: runs }));
    expect(fixed.levers.filter((lever) => lever.id === task.id || lever.label.startsWith("Daily tasks"))).toEqual([]);
  });

  it("judges only days the scheduler handled (a run row) or still owes (from its next run on): never one before the run log, paused, or skipped at a restore", () => {
    const task = { id: "task:old", title: "Old daily", createdAt: at(30 * 24 * HOUR), time: "01:00", timeZone: "UTC" };
    const items = (nextRunAt: string | null, runs: Array<[string, boolean]>) => nousScore(input({ now: NOW + 12 * HOUR, dailyTasks: [{ ...task, nextRunAt }],
      taskRuns: runs.map(([day, typed]) => ({ taskId: task.id, dueAt: `${day}T01:00:00.000Z`, typed })) })).tiles.find((tile) => tile.key === "dailyTasks")?.items;
    // Temporal rustls (12/11): typed 31/10, paused 1/11, restored 2/11 14:00 (R71 owed no 2/11 run), typed 3/11; 29-30/10 predate the log.
    expect(items("2026-11-04T01:00:00.000Z", [["2026-10-31", true], ["2026-11-03", true]])).toEqual([expect.objectContaining({ points: 0, detail: "01:00 daily · ran 2 of 2 days" })]);
    // A skipped run is a miss; a paused task is judged on the days it ran.
    expect(items(null, [["2026-10-31", true], ["2026-11-02", false]])).toEqual([expect.objectContaining({ points: -5, detail: "01:00 daily · ran 1 of 2 days · missed 2026-11-02" })]);
    // A stuck scheduler: no rows since its next run on 1/11, so every judged day from it on is missed.
    expect(items("2026-11-01T01:00:00.000Z", [["2026-10-31", true]])).toEqual([expect.objectContaining({ points: -15, detail: "01:00 daily · ran 1 of 4 days · missed 2026-11-01, 2026-11-02, 2026-11-03" })]);
  });

  it("charges each day's slow first answers (over 2 min, again over 20) and slow Done records (over 6 h, again over 24 h); an unanswered message counts its wait", () => {
    const MIN = 60_000;
    const message = (id: string, ago: number, reply: number | null, done: number | null = null) =>
      ({ id, at: at(ago), answeredAt: reply === null ? null : at(ago - reply), doneAt: done === null ? null : at(ago - done) });
    const result = nousScore(input({ messages: [
      message("m1", HOUR, MIN, 30 * MIN), message("m2", 8 * HOUR, 5 * MIN, 7 * HOUR), message("m3", 3 * HOUR, 25 * MIN),
      message("m4", MIN, null), message("m5", 10 * MIN, null), message("old", 8 * 24 * HOUR, 30 * MIN), message("m6", 40 * HOUR, 30_000, 30 * HOUR)
    ] }));
    const tile = result.tiles.find((entry) => entry.key === "response")!;
    expect(tile.items.map((item) => [item.label, item.points])).toEqual([["Today (2026-11-03)", -10], ["2026-11-02", -6]]);
    expect(tile.items[0]!.detail).toBe("5 messages · first answer median 5 min, slowest 25 min, 3 over 2 min (2 still unanswered) · Done 2, median 7 h, 1 over 6 h");
    // 14/11: the window's −16 beside "Today: …" read as today's; today's own −10 and the earlier days' −6 are named apart.
    expect(tile).toMatchObject({ points: -16, detail: expect.stringMatching(/^Today −10: 5 messages .* · earlier days −6, past: they leave as the window moves$/) });
  });

  it("leaves the time a request waited on the operator alone (their phone test) out of its Done time", () => {
    const message = { id: "m1", at: at(11 * HOUR), answeredAt: at(11 * HOUR - 60_000), doneAt: at(HOUR) };
    const tile = (waitedMs?: number) => nousScore(input({ messages: [{ ...message, waitedMs }] })).tiles.find((entry) => entry.key === "response")!;
    expect(tile().points).toBe(-2);
    // 10 h to Done, 6 h of it on the operator's test: 4 h of Nous's own, under 6 h.
    expect(tile(6 * HOUR)).toMatchObject({ points: 0, detail: expect.stringMatching(/Done 1, median 4 h, 0 over 6 h \(6 h waiting on the operator left out\)$/) });
  });

  it("counts one Done record once, for the earliest message it covers (12/11: one plan's record read six messages Done)", () => {
    const ask = { id: "m1", at: at(11 * HOUR), answeredAt: at(11 * HOUR - 60_000), doneAt: at(HOUR), doneId: "done:plan" };
    const followUp = { ...ask, id: "m2", at: at(8 * HOUR), answeredAt: at(8 * HOUR - 60_000) };
    const tile = (messages: NousScoreInput["messages"]) => nousScore(input({ messages })).tiles.find((entry) => entry.key === "response")!;
    // The ask and its follow-up share the plan's record: one request, 10 h to Done, one slow Done.
    expect(tile([followUp, ask])).toMatchObject({ points: -2, detail: expect.stringMatching(/Done 1, median 10 h, 1 over 6 h$/) });
    // Two records are two requests.
    expect(tile([ask, { ...followUp, doneId: "done:other" }]).points).toBe(-4);
  });

  it("one-time jump of ~+160 from the 14/11 reweighting, not real progress (nous_msg:cbc40ebc): each programs page by its answered applications' success rate; a waiting application costs −0.2 like one not applied, a DRAFT −1; no programs cost nothing", () => {
    // One Startup row since the oll4.com funding page went (operator 7/11, nous_msg:e9c06cd838de45f4bccda467); a row left on its page counts there.
    // The Affiliate page (14/11) is its own row: its approvals no longer lift Startup programs' rate.
    const program = (id: string, page: string, status: string) => ({ id, page: page as "startup", parent: "Parent", program: id, status: status as never, appliedAt: null, createdAt: at(HOUR) });
    const result = nousScore(input({ programs: [program("a", "startup", "APPROVED"), program("b", "startup", "REJECTED"), program("c", "startup", "APPLIED"),
      program("d", "startup", "DRAFT"), program("e", "startup", "CANCELLED"), program("f", "oll4-funding", "NOT_APPLIED"),
      program("g", "affiliate", "APPROVED"), program("h", "affiliate", "APPLIED")] }));
    const tile = result.tiles.find((entry) => entry.key === "projects")!;
    // 1 of 2 answered approved (the APPLIED one waits, the CANCELLED one was withdrawn): 50 points short × 0.2. Affiliate: 1 of 1, nothing.
    expect(tile.items.map((item) => [item.label, item.points])).toEqual([
      ["Startup programs: 1 of 2 answered applications approved (50 %)", -10], ["Parent › d", -1],
      ["Parent › c", -0.2], ["Parent › f", -0.2], ["Parent › h", -0.2], ["Affiliate programs: 1 of 1 answered applications approved (100 %)", 0]]);
    expect(tile.items.some((item) => item.label.includes("oll4.com funding"))).toBe(false);
    // Applying never costs more than not applying. Stable 14/11: 232 waiting at −1 → −0.2 (+185.6) and 78/403 → 78/171 answered (+5.7): ~+190, Nous said ~+160.
    expect(tile).toMatchObject({ points: -11.6, detail: "2 projects · lower success and more days cost more" });
    expect(tile.items.find((item) => item.id === "h")!.detail).toBe("Affiliate programs · applied");
    expect(nousScore(input()).tiles.find((entry) => entry.key === "projects")).toMatchObject({ points: 0, items: [] });
  });

  it("charges jobs, crypto and freelance by their success rate, more each day since the first try; funding counts from its first application", () => {
    const result = nousScore(input({
      programs: [{ id: "a", page: "startup", parent: "P", program: "a", status: "REJECTED", appliedAt: at(10 * 24 * HOUR), createdAt: at(40 * 24 * HOUR) }],
      projects: [{ name: "Job applications", succeeded: 0, tried: 3428, what: "sent got an offer", since: at(89 * 24 * HOUR + HOUR) },
        { name: "Crypto methods", succeeded: 1, tried: 4, what: "tested passed", since: at(20 * 24 * HOUR) },
        { name: "Freelance", succeeded: 2, tried: 2, what: "proposals won a contract", since: at(30 * 24 * HOUR) }] }));
    const items = result.tiles.find((entry) => entry.key === "projects")!.items;
    // 0 %: 100 × 0.2 + 89 days × 1; 25 %: 75 × 0.2 + 0.75 × 20 days; 100 %: nothing; funding: 10 days since the application, not 40 since the entry.
    expect(items.map((item) => [item.label, item.points])).toEqual([["Job applications: 0 of 3428 sent got an offer (0 %)", -109],
      ["Startup programs: 0 of 1 answered applications approved (0 %)", -30], ["Crypto methods: 1 of 4 tested passed (25 %)", -30], ["Freelance: 2 of 2 proposals won a contract (100 %)", 0]]);
    expect(items[0]!.detail).toBe("89 d since the first · -0.2 a point below 100 % success, -1 a day × the share short");
    // The breakdown: every costing tile and each project on its own, biggest first, with its share of the negative and the number behind it.
    expect(result.breakdown).toEqual([
      { label: "Job applications", points: -109, share: 64.5, detail: "0 of 3428 sent got an offer, 0 % · 89 d" },
      { label: "Startup programs", points: -30, share: 17.8, detail: "0 of 1 answered applications approved, 0 % · 10 d" },
      { label: "Crypto methods", points: -30, share: 17.8, detail: "1 of 4 tested passed, 25 % · 20 d" }]);
    const more = nousScore(input({ projects: [{ name: "Job applications", succeeded: 0, tried: 10, what: "sent got an offer", since: at(90 * 24 * HOUR) }],
      plans: [{ id: "clipboard:p", title: "P", createdAt: at(HOUR), working: true, stalled: null }] }));
    expect(more.breakdown.map((entry) => [entry.label, entry.points, entry.share])).toEqual([["Job applications", -110, 98.2], ["Open plans", -2, 1.8]]);
    // 13/11 (stable: Startup programs −185.6 in the breakdown, Big projects −1.6 on the Score screen): after a reset each project row counts from its
    // own baseline, so the rows add up to the tile; a note stored before 13/11 (no project keys) shows one "Big projects" row equal to the tile.
    const jobs = { name: "Job applications", succeeded: 0, tried: 10, what: "sent got an offer", since: at(90 * 24 * HOUR) };
    const reset = { at: at(HOUR), offset: 0, tiles: { projects: -15, "project:Job applications": -15 } };
    const after = nousScore(input({ reset, projects: [jobs] }));
    // 100 % short × 0.2 with no day since the reset yet: −20 against −15 at the reset.
    expect(after.tiles.find((tile) => tile.key === "projects")!.points).toBe(-5);
    expect(after.breakdown).toEqual([expect.objectContaining({ label: "Job applications", points: -5 })]);
    const old = nousScore(input({ reset: { ...reset, tiles: { projects: -15 } }, projects: [jobs] }));
    expect(old.breakdown).toEqual([expect.objectContaining({ label: "Big projects", points: -5 })]);
  });

  it("Bob 14/11: the errors lever names each cause's last occurrence and when it leaves the window; points stay the same", () => {
    const fact = (endedAt: string, correction: boolean) => nousTurnFactsSchema.parse({ turnId: endedAt, ownerUserId: owner, reason: "OPERATOR", status: "DONE", startedAt: endedAt, endedAt, planPoints: 0,
      tools: { space_remote: { calls: 1, failed: 1, refused: 0, errors: ["That SpaceApp closed the link: code 1011."] } }, outcomes: correction ? [{ summary: "x", outcome: "SELF", correction: true }] : [] });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [fact("2026-11-01T02:08:00.000Z", false), fact("2026-10-31T05:00:00.000Z", true)], decisions: [], lessons: [] });
    const result = nousScore(input({ dailyErrors }));
    const action = result.levers.find((lever) => lever.label.startsWith("Daily Nous errors"))!.action;
    expect(action).toContain('space_remote failed ×2 (−4; latest: "That SpaceApp closed the link: code 1011."; last 01/11 02:08Z, leaves the window 08/11 02:08Z)');
    expect(action).toContain("corrections ×1 (−5; last 31/10 05:00Z, leaves the window 07/11 05:00Z)");
    expect(result.tiles.find((tile) => tile.key === "dailyErrors")!.points).toBe(-9);
  });

  it("20/11: a pane's finished report on Daily Nous errors takes the causes last seen before it out of the brief; their points stay, a recurring one briefs again", () => {
    const fact = (endedAt: string, correction: boolean) => nousTurnFactsSchema.parse({ turnId: endedAt, ownerUserId: owner, reason: "OPERATOR", status: "DONE", startedAt: endedAt, endedAt, planPoints: 0,
      tools: { space_remote: { calls: 1, failed: 1, refused: 0, errors: ["Peer answered 502."] } }, outcomes: correction ? [{ summary: "x", outcome: "SELF", correction: true }] : [] });
    const dailyErrors = nousScoreErrors({ now: NOW, timeZone: "UTC", facts: [fact("2026-11-01T02:08:00.000Z", false), fact("2026-10-31T05:00:00.000Z", true)], decisions: [], lessons: [] });
    const run = (finished: NousScoreInput["finished"]) => nousScore(input({ dailyErrors, finished }));
    const lever = (finished: NousScoreInput["finished"]) => run(finished).levers.find((entry) => entry.label.startsWith("Daily Nous errors"));
    // Reviewed between the two: the correction is out, space_remote (newer) still briefs.
    const between = lever([{ at: "2026-11-01T01:00:00.000Z", text: "Daily Nous errors seventh pass: fixed or explained" }])!.action;
    expect(between).toContain("space_remote failed ×2");
    expect(between).not.toContain("corrections");
    // Reviewed after both: no lever, no push; the tile keeps its points.
    const after = run([{ at: "2026-11-01T03:00:00.000Z", text: "Daily Nous errors: every cause fixed or explained" }]);
    expect(after.levers.find((entry) => entry.label.startsWith("Daily Nous errors"))).toBeUndefined();
    expect(after.unworked).toEqual([]);
    expect(after.tiles.find((tile) => tile.key === "dailyErrors")!.points).toBe(-9);
    // A report on other work reviews nothing.
    expect(lever([{ at: "2026-11-01T03:00:00.000Z", text: "Response time done" }])!.action).toContain("corrections ×1");
  });

  it("13/11: while the Score is negative, a variable worth over 5 % of it that no pane works on is the top lever; a working pane covers it", () => {
    const errors = [{ day: "2026-11-03", calls: 40, failed: 20, refused: 0, corrections: 0, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0, tools: { space_plan_update: 12 } }];
    const plans = [{ id: "clipboard:a", title: "A", createdAt: at(2 * HOUR), working: true, stalled: null }];
    const open = nousScore(input({ dailyErrors: errors, plans }));
    // Slice 8: the latest day's counted sample names the cause.
    const named = nousScore(input({ dailyErrors: [{ ...errors[0]!, day: "2026-11-02", failed: 0, tools: {}, causes: { space_plan_update: "old" } }, { ...errors[0]!, causes: { space_plan_update: "Unexpected storage error" } }], plans }));
    expect(named.levers[0]!.action).toContain('space_plan_update failed ×12 (−24; latest: "Unexpected storage error")');
    expect(open.levers[0]).toMatchObject({ label: "Daily Nous errors (95.2% of the negative)", points: -40 });
    expect(open.levers[0]!.action).toMatch(/^no pane works on it: open or brief a code-fix pane with these causes and counts: space_plan_update failed ×12 \(−24\), failed tools ×8 \(−16\)/);
    const worked = nousScore(input({ dailyErrors: errors, plans, working: ["Fix the daily Nous errors"] }));
    expect(worked.levers[0]!.action).toMatch(/^open or brief a code-fix pane/);
    // 1071 (13/11: a follow-up naming the variable was pushed again 15 min later): an open follow-up's wait is no push; the lever still reads unworked.
    expect(open.unworked.map((entry) => entry.label)).toEqual(["Daily Nous errors"]);
    const waiting = nousScore(input({ dailyErrors: errors, plans, waits: ["Daily Nous errors: Andy's slice 7 ships with q-1, check at 12:00"] }));
    expect(waiting.unworked).toEqual([]);
    expect(waiting.levers[0]!.action).toMatch(/^no pane works on it: /);
    expect(nousScore(input({ dailyErrors: errors, plans, waits: ["Big projects: wait for the mails"] })).unworked).toHaveLength(1);
  });

  it("14/11: a pane's finished report on Response time after today's newest slow case ends the brief; its points stay, a newer slow case briefs again", () => {
    const slow = (id: string, ago: number) => ({ id, at: at(ago), answeredAt: at(ago - 10 * 60_000), doneAt: null });
    const lever = (finished: NousScoreInput["finished"]) => nousScore(input({ messages: [slow("t1", 5 * HOUR), slow("t2", 2 * HOUR)], finished })).levers
      .find((entry) => entry.label.startsWith("Response time"));
    expect(lever([])!.action).toMatch(/^no pane works on it: brief a code-fix pane on what made today's first answers or Dones slow \(2 messages/);
    // Reviewed before t2 was answered: t2 is newer, so the brief stays.
    expect(lever([{ at: at(3 * HOUR), text: "Response time: every slow case fixed or explained" }])).toMatchObject({ points: -4 });
    expect(lever([{ at: at(HOUR), text: "Response time done" }, { at: at(0), text: "unrelated work done" }])).toBeUndefined();
  });

  it("14/11: Response time briefs a code-fix pane only on today's slow answers; past days' misses stay on the tile but are no lever and no push", () => {
    const MIN = 60_000;
    const message = (id: string, ago: number, reply: number) => ({ id, at: at(ago), answeredAt: at(ago - reply), doneAt: null });
    const past = nousScore(input({ messages: [message("y1", 30 * HOUR, 25 * MIN)] }));
    expect(past.tiles.find((tile) => tile.key === "response")!.points).toBe(-4);
    expect(past.levers.filter((lever) => lever.label.startsWith("Response time"))).toEqual([]);
    expect(past.unworked).toEqual([]);
    const today = nousScore(input({ messages: [message("y1", 30 * HOUR, 25 * MIN), message("t1", HOUR, 5 * MIN)] }));
    expect(today.unworked.map((entry) => entry.label)).toEqual(["Response time"]);
    expect(today.levers[0]).toMatchObject({ points: -6, perDay: -2,
      action: "no pane works on it: brief a code-fix pane on what made today's first answers or Dones slow (1 message · first answer median 5 min, slowest 5 min, 1 over 2 min · Done 0)" });
    // Today's part under 5 % of the negative (14/11: −2 of −408.6): an ordinary lever, no push.
    const small = nousScore(input({ messages: [...[1, 2, 3, 4, 5].map((n) => message(`y${n}`, 30 * HOUR + n * MIN, 25 * MIN)), message("t1", HOUR, 5 * MIN)],
      plans: [{ id: "clipboard:p", title: "Old", createdAt: at(9 * 24 * HOUR), working: false, stalled: null }] }));
    expect(small.breakdown.find((entry) => entry.label === "Response time")!.share).toBeGreaterThan(5);
    expect(small.unworked).toEqual([]);
    expect(small.levers.find((lever) => lever.label.startsWith("Response time"))).toMatchObject({ points: -22, perDay: -2, action: expect.stringMatching(/^brief a code-fix pane on what made today's/) });
  });

  it("is zero with nothing open and nothing read", () => {
    expect(nousScore(input())).toMatchObject({ score: 0 });
  });
});

describe("the Score service", () => {
  const fakeInput = (plans: number) => async (): Promise<NousScoreInput> => input({ now: NOW,
    plans: Array.from({ length: plans }, (_, index) => ({ id: `clipboard:${index}`, title: `Plan ${index}`, createdAt: at(HOUR), working: true, stalled: null })) });

  it("stores a snapshot every round, keeps Δ24h and Δ7d against the snapshots then, and answers the routes", async () => {
    const repository = new InMemoryNousRepository();
    await repository.addScoreSnapshot({ ownerUserId: owner, at: at(7 * 24 * HOUR + 5 * 60_000), score: 4, parts: {} });
    await repository.addScoreSnapshot({ ownerUserId: owner, at: at(24 * HOUR + 5 * 60_000), score: -2, parts: {} });
    let clock = NOW;
    const score = createNousScore({ repository, owners: async () => [owner], input: fakeInput(3), now: () => clock });
    await score.snapshot();
    const view = score.cached(owner)!;
    expect(view).toMatchObject({ score: -6, change24h: -4, change7d: -10 });
    expect(nousScoreLine(view)).toContain("Score: −6 (Δ24h −4, Δ7d −10), worst: Open plans −6 (Plan 0 −2)");
    expect(nousScoreLine(view)).toContain("Open panes: 0 open (0), Idle open panes: 0 panes idle past 60 min (0)");
    expect(nousScoreLine(view)).toContain("Daily Nous errors: Today: 0 · 7 days: 0 (0)");
    expect(nousScoreLine(view)).toContain("Unmet goals cost per day, more without progress or past deadline.");
    expect(nousScoreLine(view)).toContain("Negative by variable: Open plans −6 (100 %)");
    expect((await repository.listScoreSnapshots(owner, at(HOUR))).map((row) => row.score)).toEqual([-6]);

    const app = Fastify();
    registerNousScoreRoutes(app, { score, routeOptions: {}, owner: async () => owner, parseQuery: (schema, value) => schema.parse(value) });
    try {
      clock = NOW + 30_000;
      expect((await app.inject("/api/nous/score")).json()).toMatchObject({ score: -6, tiles: expect.arrayContaining([expect.objectContaining({ key: "plans", points: -6 })]) });
      const history = (await app.inject("/api/nous/score/history?range=7d")).json();
      expect(history.range).toBe("7d");
      expect(history.points.map((point: { value: number }) => point.value)).toEqual([-2, -6]);
      expect((await app.inject("/api/nous/score/history?range=1y")).statusCode).toBeGreaterThanOrEqual(400);
    } finally { await app.close(); }
  });

  afterEach(() => vi.useRealTimers());

  it("Score reset (operator 9/11 nous_msg:8d5af119): reads 0 at the reset, an error after it lowers it, nothing before it ever counts", async () => {
    const repository = new InMemoryNousRepository();
    await repository.addScoreSnapshot({ ownerUserId: owner, at: at(2 * HOUR), score: -50, parts: { openPanes: 9 } });
    const fact = (endedAt: string) => nousTurnFactsSchema.parse({ turnId: endedAt, ownerUserId: owner, reason: "OPERATOR", status: "DONE",
      startedAt: endedAt, endedAt, planPoints: 0, tools: { read: { calls: 1, failed: 1, refused: 0 } }, outcomes: [] });
    const facts = [fact(at(HOUR))];
    let reset: NousScoreReset | null = null;
    let clock = NOW;
    const service = createNousScore({ repository, owners: async () => [owner], now: () => clock, saveReset: async (_owner, value) => { reset = value; },
      input: async (_owner, now) => input({ now, reset,
        plans: [{ id: "clipboard:old", title: "Old", createdAt: at(3 * 24 * HOUR), working: false, stalled: null }],
        requests: [{ id: "nous_msg:old", summary: "Old", openedAt: at(48 * HOUR) }],
        completedPlans: [{ id: "clipboard:done", title: "Done before", at: at(HOUR) }],
        // Already overdue at the reset: no overdue day may start counting seconds after it (stable read −20 on 9/11).
        goals: [{ id: "nous_goal:late", text: "Late", createdAt: at(3 * 24 * HOUR), status: "ACTIVE", limit: { kind: "DATE", until: at(24 * HOUR) }, progressDays: [] }],
        dailyErrors: nousScoreErrors({ now, timeZone: "UTC", facts, decisions: [], lessons: [], ...(reset ? { resetAt: Date.parse(reset.at) } : {}) }) }) });
    await service.snapshot();
    expect(service.cached(owner)!.score).toBeLessThan(0);
    clock = NOW + 1_000;
    const view = await service.reset(owner);
    expect(view).toMatchObject({ score: 0, resetAt: new Date(NOW + 1_000).toISOString(), change24h: null });
    expect(view.tiles.find((tile) => tile.key === "completed")!.items).toEqual([]);
    expect(view.breakdown.some((entry) => entry.label === "Score reset")).toBe(false);
    // Operator 11/11: every tile reads 0 at the reset, no offset tile.
    expect(view.tiles.filter((tile) => tile.points !== 0 || tile.key === "reset")).toEqual([]);
    expect(view.tiles.find((tile) => tile.key === "plans")!.items.at(-1)).toMatchObject({ label: `At the reset ${new Date(NOW + 1_000).toISOString().slice(0, 16).replace("T", " ")} UTC` });
    expect((await service.history(owner, "24h")).points.map((point) => point.value)).toEqual([0]);
    // Half an hour later: what was open counts from the reset (no growth yet), the error before it never, the new one does.
    clock = NOW + HOUR / 2;
    facts.push(fact(new Date(NOW + 60_000).toISOString()));
    expect(reset).toEqual({ at: new Date(NOW + 1_000).toISOString(), offset: expect.any(Number), tiles: expect.objectContaining({ plans: expect.any(Number) }) });
    expect(parseScoreReset(JSON.stringify(reset))).toEqual(reset);
    await service.snapshot();
    expect(service.cached(owner)!.score).toBe(NOUS_SCORE_WEIGHTS.toolFailure);
    // Eight days on, the old work leaving the window gives nothing back: only its growth since the reset and the new error count.
    clock = NOW + 8 * 24 * HOUR;
    const later = nousScore(input({ now: clock, reset, plans: [{ id: "clipboard:old", title: "Old", createdAt: at(3 * 24 * HOUR), working: false, stalled: null }] }));
    const fresh = nousScore(input({ now: clock, plans: [{ id: "clipboard:old", title: "Old", createdAt: new Date(NOW + 1_000).toISOString(), working: false, stalled: null }] }));
    expect(later.tiles.find((tile) => tile.key === "plans")!.points).toBe(fresh.tiles.find((tile) => tile.key === "plans")!.points - reset!.tiles!.plans!);
    // A reset stored before 11/11 (one offset, no tiles) keeps its offset tile.
    expect(nousScore(input({ now: clock, reset: { at: reset!.at, offset: 7 } })).tiles.find((tile) => tile.key === "reset")!.points).toBe(-7);
  });

  it("warms every owner and history range seconds after boot, and again at the snapshot interval", async () => {
    vi.useFakeTimers();
    const builder = vi.fn(fakeInput(2));
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner, "user:second"], input: builder, now: () => NOW });
    service.start(); service.start();
    try {
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_STARTUP_MS);
      expect(builder).toHaveBeenCalledTimes(2);
      expect(service.cached(owner)?.score).toBe(-4);
      expect(service.cached("user:second")?.score).toBe(-4);
      expect((await service.history(owner, "24h")).points).toEqual([{ at: at(0), value: -4 }]);
      expect((await service.history(owner, "30d")).range).toBe("30d");
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_SNAPSHOT_MS - NOUS_SCORE_STARTUP_MS);
      expect(builder).toHaveBeenCalledTimes(4);
    } finally { service.stop(); }
    await vi.advanceTimersByTimeAsync(NOUS_SCORE_SNAPSHOT_MS);
    expect(builder).toHaveBeenCalledTimes(4);
  });

  it("13/11 Score push: each snapshot hands Nous a held item per variable over 5 % of a negative Score that no pane works on", async () => {
    const errors = [{ day: "2026-11-03", calls: 40, failed: 20, refused: 0, corrections: 0, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0, tools: { space_plan_update: 12 } }];
    const plans = [{ id: "clipboard:a", title: "A", createdAt: at(2 * HOUR), working: true, stalled: null }];
    let working: string[] = [];
    const push = vi.fn(async () => undefined);
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner], now: () => NOW, push,
      input: async () => input({ now: NOW, dailyErrors: errors, plans, working }) });
    await service.snapshot();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]).toEqual([owner, expect.objectContaining({ line: expect.stringContaining("open or brief a code-fix pane now"),
      items: [expect.objectContaining({ key: "score:Daily Nous errors", kind: "PLAN", always: true, refs: ["Daily Nous errors"] })] })]);
    working = ["Fix the daily Nous errors"];
    await service.snapshot();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("never recomputes on a read: the view and every range come from memory, and the snapshots are read from the database once", async () => {
    let clock = NOW;
    const repository = new InMemoryNousRepository();
    const historyRead = vi.spyOn(repository, "listScoreSnapshots");
    const builder = vi.fn(async () => input({ now: clock }));
    const service = createNousScore({ repository, owners: async () => [owner], input: builder, now: () => clock });
    await service.snapshot();
    const old = service.cached(owner);
    clock += 6 * HOUR;
    for (let read = 0; read < 50; read++) {
      expect(await service.view(owner)).toBe(old);
      for (const range of ["24h", "7d", "30d"] as const) expect((await service.history(owner, range)).range).toBe(range);
    }
    expect(builder).toHaveBeenCalledTimes(1);
    expect(historyRead).toHaveBeenCalledTimes(1);
    // The next snapshot appends to the kept rows instead of reading them again.
    await service.snapshot();
    expect((await service.history(owner, "24h")).points.map((point) => point.at)).toEqual([at(0), new Date(clock).toISOString()]);
    expect(historyRead).toHaveBeenCalledTimes(1);
  });

  it("recomputes once, a delay after the operator writes, however many messages come; a failed recompute keeps the last view", async () => {
    vi.useFakeTimers();
    let fail = false;
    const warn = vi.fn();
    const builder = vi.fn(async () => { if (fail) throw new Error("input offline"); return input(); });
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner], input: builder, now: () => NOW, warn });
    try {
      const first = await service.view(owner);
      service.changed(owner); service.changed(owner); service.changed(owner);
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_EVENT_DELAY_MS - 1);
      expect(builder).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(builder).toHaveBeenCalledTimes(2);
      fail = true;
      service.changed(owner);
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_EVENT_DELAY_MS);
      expect(warn.mock.calls.map(([error]) => (error as Error).message)).toEqual(["input offline"]);
      expect((await service.view(owner)).score).toBe(first.score);
      // stop() drops a pending one.
      service.changed(owner); service.stop();
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_EVENT_DELAY_MS);
      expect(builder).toHaveBeenCalledTimes(3);
    } finally { service.stop(); }
  });

  it("recomputes the room owner's view a delay after a pane closes, so a closed pane leaves Score levers before the next snapshot", async () => {
    vi.useFakeTimers();
    const bus = new SpaceEventBus();
    const builder = vi.fn(async () => input());
    const roomOwner = vi.fn(async (roomId: string) => (roomId === "room:a" ? owner : "user:other"));
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner], input: builder, now: () => NOW, events: bus, roomOwner });
    const event = (type: "PANE_CLOSED" | "PANE_UPDATED") => ({ id: "event:1", roomId: "room:a", paneId: "pane:a", turnId: null, workflowId: null, traceId: "trace:1",
      type, message: "Pane closed.", payload: {}, createdAt: new Date(NOW).toISOString() }) as Parameters<SpaceEventBus["publish"]>[0];
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_STARTUP_MS); // the first snapshot
      const before = builder.mock.calls.length;
      bus.publish(event("PANE_UPDATED"));
      bus.publish(event("PANE_CLOSED"));
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_EVENT_DELAY_MS - 1);
      expect(builder).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(roomOwner).toHaveBeenCalledTimes(1);
      expect(builder).toHaveBeenCalledTimes(before + 1);
      expect(builder.mock.calls.at(-1)![0]).toBe(owner);
      // stop() unsubscribes.
      service.stop();
      bus.publish(event("PANE_CLOSED"));
      await vi.advanceTimersByTimeAsync(NOUS_SCORE_EVENT_DELAY_MS);
      expect(roomOwner).toHaveBeenCalledTimes(1);
    } finally { service.stop(); }
  });

  it("charges each completed day its average open panes from the snapshots, stores the count with each snapshot and reads it back after a restart", async () => {
    const repository = new InMemoryNousRepository();
    const snap = (iso: string, parts: Record<string, number>) => repository.addScoreSnapshot({ ownerUserId: owner, at: iso, score: 0, parts });
    await snap("2026-10-20T12:00:00.000Z", { openPanes: 99 }); // outside the 7-day window
    await snap("2026-11-01T08:00:00.000Z", { panes: -30 }); // written before the count was kept
    await snap("2026-11-01T09:00:00.000Z", { openPanes: 4 });
    await snap("2026-11-02T01:00:00.000Z", { openPanes: 10 });
    await snap("2026-11-02T23:00:00.000Z", { openPanes: 20 });
    await snap("2026-11-03T01:00:00.000Z", { openPanes: 50 }); // today: the open panes themselves are charged
    expect(paneDaysOf(await repository.listScoreSnapshots(owner, at(30 * 24 * HOUR)), NOW, "UTC"))
      .toEqual([{ day: "2026-11-01", average: 4, peak: 4 }, { day: "2026-11-02", average: 15, peak: 20 }]);
    const panes = async () => input({ panes: [{ id: "pane:a", title: "A", idleSince: null }, { id: "pane:b", title: "B", idleSince: null }] });
    await createNousScore({ repository, owners: async () => [owner], input: panes, now: () => NOW }).snapshot();
    expect((await repository.listScoreSnapshots(owner, at(HOUR))).at(-1)!.parts).toMatchObject({ openPanes: 2, panes: -5.8 });
    // A new process (an API restart) reads the counts back from the stored snapshots.
    const restarted = createNousScore({ repository, owners: async () => [owner], input: panes, now: () => NOW + 60_000 });
    const tile = (await restarted.view(owner)).tiles.find((entry) => entry.key === "panes")!;
    expect(tile).toMatchObject({ points: -5.8, detail: "2 open · 9.5 open a day on average" });
    expect(tile.items.filter((item) => !item.id).map((item) => [item.label, item.points, item.detail])).toEqual([
      ["2026-11-02", -3, "15 open on average · peak 20 · -0.2 a pane a day"], ["2026-11-01", -0.8, "4 open on average · peak 4 · -0.2 a pane a day"]]);
  });

  it("14/11 (nous_msg:cf45a823): the view carries 24 h and 30 days' own tiles and score from the same reads; the 7 days' stay the score", async () => {
    const repository = new InMemoryNousRepository();
    await repository.addScoreSnapshot({ ownerUserId: owner, at: "2026-10-20T12:00:00.000Z", score: 0, parts: { openPanes: 99 } }); // in 30 days only
    await repository.addScoreSnapshot({ ownerUserId: owner, at: "2026-11-02T20:00:00.000Z", score: 0, parts: { openPanes: 10 } });
    const failure = { day: "2026-11-03", calls: 1, failed: 1, refused: 0, corrections: 0, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0 };
    const score = createNousScore({ repository, owners: async () => [owner], now: () => NOW, input: async () => ({ ...input({
      completedPlans: [{ id: "c1", title: "A", at: at(2 * HOUR) }, { id: "c2", title: "B", at: at(3 * 24 * HOUR) }, { id: "c3", title: "C", at: at(20 * 24 * HOUR) }] }),
    // The loader cuts each range's errors itself; a range without its own takes the 7 days'.
    periods: { "24h": { dailyErrors: [failure] } } }) });
    await score.snapshot();
    const view = score.cached(owner)!;
    const points = (tiles: NousScore["tiles"]) => Object.fromEntries(tiles.filter((tile) => ["completed", "panes", "dailyErrors"].includes(tile.key)).map((tile) => [tile.key, tile.points]));
    expect(points(view.tiles)).toEqual({ completed: 10, panes: -2, dailyErrors: 0 });
    expect(points(view.periods!["24h"]!.tiles)).toEqual({ completed: 5, panes: -2, dailyErrors: -2 });
    expect(points(view.periods!["30d"]!.tiles)).toEqual({ completed: 15, panes: -21.8, dailyErrors: 0 });
    expect([view.score, view.periods!["24h"]!.score, view.periods!["30d"]!.score]).toEqual([8, 1, -6.8]);
    expect((await repository.listScoreSnapshots(owner, at(HOUR))).at(-1)!.score).toBe(8);
  });

  it("keeps each owner's score and range cache separate", async () => {
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner, "user:other"],
      input: async (who) => fakeInput(who === owner ? 1 : 3)(), now: () => NOW });
    await service.snapshot();
    expect((await service.view(owner)).score).toBe(-2);
    expect((await service.view("user:other")).score).toBe(-6);
    expect((await service.history(owner, "24h")).points.at(-1)?.value).toBe(-2);
    expect((await service.history("user:other", "24h")).points.at(-1)?.value).toBe(-6);
  });

  it("coalesces the first cold reads and appends a live point when there are no snapshots", async () => {
    const builder = vi.fn(fakeInput(1));
    const service = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner], input: builder, now: () => NOW });
    const [a, b] = await Promise.all([service.view(owner), service.view(owner)]);
    expect(a).toBe(b); expect(builder).toHaveBeenCalledTimes(1);
    expect((await service.history(owner, "24h")).points).toEqual([{ at: at(0), value: -2 }]);
  });

  it("has no change before a snapshot of that age exists", async () => {
    const score = createNousScore({ repository: new InMemoryNousRepository(), owners: async () => [owner], input: fakeInput(0), now: () => NOW });
    expect(await score.view(owner)).toMatchObject({ score: 0, change24h: null, change7d: null });
    expect(nousScoreLine(score.cached(owner)!)).toMatch(/^Score: 0 \(Δ24h –, Δ7d –\), /);
  });
});
