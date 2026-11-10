// Nous's Score (operator 3/11 23:11 BKK, plan clipboard:1NF6u6gcCwtj): points that can go negative; open plans and operator requests cost
// points while they stay open, finished work and the scorecard give them.
import { nousDecisionSchema, nousTurnFactsSchema } from "@space/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { NOUS_PERSONA, NOUS_SCORE_FIRST_RULE } from "../src/nous/service.js";
import { createNousScore, nousScore, nousScoreErrors, nousScoreLeversText, paneDaysOf, NOUS_SCORE_EVENT_DELAY_MS, NOUS_SCORE_STARTUP_MS, NOUS_SCORE_SNAPSHOT_MS, nousScoreLine, NOUS_SCORE_WEIGHTS, registerNousScoreRoutes,
  type NousScoreInput, type NousScoreReset } from "../src/nous/score.js";

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
    expect(NOUS_SCORE_WEIGHTS).toEqual({ openPlan: -2, openPlanPerDay: -2, planAgeExponent: 2, openPane: -1, paneIdlePast1h: -2, paneDay: -0.2, goalPerDay: -2, goalNoProgressDay: -3, goalOverdueDay: -20, toolFailure: -2, lesson: -5, decisionDeclined: -5, predictionMiss: -3, chatError: -1, decisionFailed: -3, planNoWorkingPane: -3, planStalled: -5, openRequest: -2, requestPast1h: -2,
      requestPast6h: -4, requestPast24h: -8, planCompleted: 5, requestDone: 3, utilizationPerPoint: 0.5, lostAtResetPerPoint: -95, correction: -5, couldHaveDecided: -3, scorecardPerPoint: 0.5,
      dailyTaskMissed: -5, slowReply: -2, slowReplyPast10x: -2, slowDone: -2, slowDonePast24h: -4, projectShortfallPerPoint: -0.2, projectDay: -1, programOpen: -1, programNotApplied: -0.2,
      marketingPerPoint: -0.2, marketingDayBelowTarget: -1, marketingFailed: -2, marketingZeroReach: -0.5, marketingDayWithoutResult: -1, idleBrowserPerHour: -2, browserReaped: -2,
      approvedNotDone: -5, approvedNotDonePerHour: -0.25, approvedNotDoneAgeExponent: 2, approvedNotDoneGraceHours: 2 });
    for (const key of ["openPlan", "openPlanPerDay", "planNoWorkingPane", "planStalled", "openRequest", "requestPast1h", "requestPast6h", "requestPast24h", "correction", "couldHaveDecided"] as const) {
      expect(NOUS_SCORE_WEIGHTS[key]).toBeLessThan(0);
    }
    for (const key of ["planCompleted", "requestDone", "utilizationPerPoint", "scorecardPerPoint"] as const) expect(NOUS_SCORE_WEIGHTS[key]).toBeGreaterThan(0);
  });
});

describe("nousScore", () => {
  it("charges marketing below its target, more each day in a row, its failed and no-reach posts of the window and days without a result", () => {
    const row = (number: number, status: string, hoursAgo: number, score: number | null) => ({ id: `mktpost:p${number}`, number, channel: "X", status, at: at(hoursAgo * HOUR), score, title: `Post ${number}` });
    const marketing = { score: 30, target: 50, daysBelowTarget: 4, daysWithoutResult: 2,
      posts: [row(4, "PUBLISHED", 2, 0), row(3, "FAILED", 5, 0), row(2, "PUBLISHED", 6, 40), row(1, "PUBLISHED", 24 * 9, 0)] };
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
    expect(requests.items.map((item) => item.points)).toEqual([-16, -8, -4, -2]);
    expect(requests.points).toBe(-30);
    expect(score).toBe(-60);
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
      ["clipboard:a", -167, -38], ["nous_goal:g", -15, -5], ["nous_msg:3", -8, -8], ["nous_msg:4", -16, 0],
      ["Utilization 70% against 90%", -10, 0], ["2 panes idle or finished past 1 h", -6, -0.4], ["clipboard:b", -2, -2]]);
    expect(levers[0]!.action).toContain("complete it with its proof");
    expect(levers.at(-1)!.action).toBe("Alex works on it: send the next step the moment it reports");
    const text = nousScoreLeversText(levers, { tiles });
    expect(text.split("\n")[1]).toBe("- Plan [clipboard:a] \"Release\" 97% · −167 now → −205 tomorrow · complete it with its proof (space_plan_update), it removes all of it");
    expect(text).toContain("No move removes Daily Nous errors −6: they leave the 7-day window by themselves; add no new ones.");
    expect(nousScoreLeversText([], { tiles: [] })).toBe("## Score levers now (your first measure: take the top move first; points now → tomorrow if left · the move that cuts them)\n- none");
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
    expect(points).toEqual({ plans: 0, requests: 0, approvedNotDone: 0, completed: 5, done: 3, utilization: -10, lostTokens: 0, panes: 0, browsers: 0, goals: 0, projects: 0, dailyTasks: 0, response: 0, dailyErrors: 0, scorecard: 2.5 });
    expect(score).toBe(0.5);
  });

  it("charges every open pane and more only after an hour idle or finished", () => {
    const result = nousScore(input({ panes: [
      { id: "pane:working", title: "Working", idleSince: null },
      { id: "pane:hour", title: "Exactly one hour", idleSince: at(HOUR) },
      { id: "pane:forgotten", title: "Done yesterday", idleSince: at(24 * HOUR) }
    ] }));
    expect(result.tiles.find((tile) => tile.key === "panes")).toMatchObject({ points: -5, detail: "3 open · 1 idle past 1 h" });
    expect(result.score).toBe(-5);
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
    expect(levers).toContain("- Browser of Dino (Job Copilot 6) unused 3 h · −6 now → −54 tomorrow · close it: close its pane if it is done, or its tabs (space_browser_close_tab)");
    expect(levers).toContain("- Browser of Bob (Browser 2) unused 45 min · −2 now → −50 tomorrow · close it");
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
    expect(levers).toContain("- Approved [nous_decision:b] «Reply nous_decision:b»: no send of ours a@x.com thread t-nous_decision:b since the approval · −7.2 now → −187.2 tomorrow · run it now and confirm it (space_mail_read SENT)");
    expect(levers).toContain("- Approved [nous_decision:g] «Reply nous_decision:g»: Failed: pane closed · −7.2 now");
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
      decisions: [decision], lessons: [{ key: "lessons-score", createdAt: at(HOUR), updatedAt: at(HOUR) }, { key: "other", createdAt: at(HOUR), updatedAt: at(HOUR) }] });
    expect(dailyErrors).toEqual([
      { day: "2026-11-02", calls: 8, failed: 2, refused: 2, corrections: 1, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0 },
      { day: "2026-11-03", calls: 8, failed: 2, refused: 2, corrections: 1, lessons: 1, declined: 1, predictionMisses: 1, couldHaveDecided: 1, chatErrors: 0, decisionsFailed: 0 }
    ]);
    const result = nousScore(input({ dailyErrors, timeZone: "Asia/Bangkok" }));
    expect(result.tiles.find((tile) => tile.key === "dailyErrors")).toMatchObject({ points: -34, detail: expect.stringContaining("Today: 7 · 7 days: 10") });
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

  it("charges each judged day a DAILY task's text never reached its pane, and judges a day only after the scheduler's 12 h wait", () => {
    const task = { id: "task:daily01", title: "API check", createdAt: at(3 * 24 * HOUR), time: "01:00", timeZone: "UTC" };
    const result = nousScore(input({
      dailyTasks: [task, { ...task, id: "task:later", title: "Later today", time: "10:00", createdAt: at(HOUR) }],
      // 1/11 typed; 2/11 skipped (never typed); 3/11 nothing; another task's run never counts.
      taskRuns: [{ taskId: task.id, dueAt: "2026-11-01T01:00:00.000Z", typed: true }, { taskId: task.id, dueAt: "2026-11-02T01:00:00.000Z", typed: false },
        { taskId: "task:other", dueAt: "2026-11-03T01:00:00.000Z", typed: true }]
    }));
    expect(result.tiles.find((tile) => tile.key === "dailyTasks")).toMatchObject({ points: -10, detail: "2 daily · 2 missed days in 7 days",
      items: [{ id: task.id, points: -10, detail: "01:00 daily · ran 1 of 3 days · missed 2026-11-02, 2026-11-03" }, { id: "task:later", points: 0, detail: "10:00 daily · ran 0 of 0 days" }] });
  });

  it("judges no day before the oldest task run, when the run log did not exist yet", () => {
    const task = { id: "task:old", title: "Old daily", createdAt: at(30 * 24 * HOUR), time: "01:00", timeZone: "UTC" };
    // The log starts with another task's run on 2/11: 28/10-1/11 have no rows and are not misses; 3/11 has none and is one.
    const result = nousScore(input({ dailyTasks: [task], taskRuns: [{ taskId: "task:other", dueAt: "2026-11-02T01:00:00.000Z", typed: true },
      { taskId: task.id, dueAt: "2026-11-02T01:00:00.000Z", typed: true }] }));
    expect(result.tiles.find((tile) => tile.key === "dailyTasks")?.items).toEqual([expect.objectContaining({ points: -5, detail: "01:00 daily · ran 1 of 2 days · missed 2026-11-03" })]);
    // No run at all: every due day in the window is judged, as before.
    expect(nousScore(input({ dailyTasks: [task] })).tiles.find((tile) => tile.key === "dailyTasks")?.points).toBe(-35);
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
    expect(tile).toMatchObject({ points: -16, detail: expect.stringMatching(/^Today: 5 messages/) });
  });

  it("charges the Startup programs by their success rate and each program still open; no programs cost nothing", () => {
    // One row since the oll4.com funding page went (operator 7/11, nous_msg:e9c06cd838de45f4bccda467); a row left on its page counts there.
    const program = (id: string, page: string, status: string) => ({ id, page: page as "startup", parent: "Parent", program: id, status: status as never, appliedAt: null, createdAt: at(HOUR) });
    const result = nousScore(input({ programs: [program("a", "startup", "APPROVED"), program("b", "startup", "REJECTED"), program("c", "startup", "APPLIED"),
      program("d", "startup", "DRAFT"), program("e", "startup", "CANCELLED"), program("f", "oll4-funding", "NOT_APPLIED")] }));
    const tile = result.tiles.find((entry) => entry.key === "projects")!;
    // 1 of 3 sent approved: 66.7 points short × 0.2.
    expect(tile.items.map((item) => [item.label, item.points])).toEqual([
      ["Startup programs: 1 of 3 applications approved (33 %)", -13.3], ["Parent › c", -1], ["Parent › d", -1], ["Parent › f", -0.2]]);
    expect(tile.items.some((item) => item.label.includes("oll4.com funding"))).toBe(false);
    // A program not applied to yet costs a fifth of one in progress (nous_msg:44e3fd48): new candidates do not swamp the Score.
    expect(tile).toMatchObject({ points: -15.5, detail: "1 projects · lower success and more days cost more" });
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
      ["Startup programs: 0 of 1 applications approved (0 %)", -30], ["Crypto methods: 1 of 4 tested passed (25 %)", -30], ["Freelance: 2 of 2 proposals won a contract (100 %)", 0]]);
    expect(items[0]!.detail).toBe("89 d since the first · -0.2 a point below 100 % success, -1 a day × the share short");
    // The breakdown: every costing tile and each project on its own, biggest first, with its share of the negative and the number behind it.
    expect(result.breakdown).toEqual([
      { label: "Job applications", points: -109, share: 64.5, detail: "0 of 3428 sent got an offer, 0 % · 89 d" },
      { label: "Startup programs", points: -30, share: 17.8, detail: "0 of 1 applications approved, 0 % · 10 d" },
      { label: "Crypto methods", points: -30, share: 17.8, detail: "1 of 4 tested passed, 25 % · 20 d" }]);
    const more = nousScore(input({ projects: [{ name: "Job applications", succeeded: 0, tried: 10, what: "sent got an offer", since: at(90 * 24 * HOUR) }],
      plans: [{ id: "clipboard:p", title: "P", createdAt: at(HOUR), working: true, stalled: null }] }));
    expect(more.breakdown.map((entry) => [entry.label, entry.points, entry.share])).toEqual([["Job applications", -110, 98.2], ["Open plans", -2, 1.8]]);
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
    expect(nousScoreLine(view)).toContain("Open panes: 0 open · 0 idle past 1 h (0)");
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
    expect((await service.history(owner, "24h")).points.map((point) => point.value)).toEqual([0]);
    // Half an hour later: what was open counts from the reset (no growth yet), the error before it never, the new one does.
    clock = NOW + HOUR / 2;
    facts.push(fact(new Date(NOW + 60_000).toISOString()));
    expect(reset).toEqual({ at: new Date(NOW + 1_000).toISOString(), offset: expect.any(Number) });
    await service.snapshot();
    expect(service.cached(owner)!.score).toBe(NOUS_SCORE_WEIGHTS.toolFailure);
    // Eight days on, the old work leaving the window gives nothing back: only its growth since the reset and the new error count.
    clock = NOW + 8 * 24 * HOUR;
    const later = nousScore(input({ now: clock, reset, plans: [{ id: "clipboard:old", title: "Old", createdAt: at(3 * 24 * HOUR), working: false, stalled: null }] }));
    const fresh = nousScore(input({ now: clock, plans: [{ id: "clipboard:old", title: "Old", createdAt: new Date(NOW + 1_000).toISOString(), working: false, stalled: null }] }));
    expect(later.tiles.find((tile) => tile.key === "plans")!.points).toBe(fresh.tiles.find((tile) => tile.key === "plans")!.points);
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
    expect(tile).toMatchObject({ points: -5.8, detail: "2 open · 0 idle past 1 h · 9.5 open a day on average" });
    expect(tile.items.filter((item) => !item.id).map((item) => [item.label, item.points, item.detail])).toEqual([
      ["2026-11-02", -3, "15 open on average · peak 20 · -0.2 a pane a day"], ["2026-11-01", -0.8, "4 open on average · peak 4 · -0.2 a pane a day"]]);
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
