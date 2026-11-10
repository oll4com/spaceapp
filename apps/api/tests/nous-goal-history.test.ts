// A goal's work history (operator 1/11 03:35 BKK «Θέλω να μπορώ ανα goal να δω ιστορικό εργασιών που έχουν γίνει», plan clipboard:jNDx8l-vMEl9):
// what the goal's turns did, its plans' pane reports and their tickets, newest first and whole; the log's repeated waits and idle turns folded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { historySince, nousTurnFactsSchema, type DeployQueueTicket, type NousGoalHistoryEntry } from "@space/contracts";
import { InMemoryNousGoalsRepository, InMemoryNousRepository, InMemoryPaneReportsRepository } from "@space/db";
import { createGoalHistory, goalHistoryPage, NOUS_GOAL_WORK_TOOLS } from "../src/nous/goal-history.js";

const owner = "user:operator";
const at = (minute: number) => new Date(Date.parse("2026-10-31T10:00:00.000Z") + minute * 60_000).toISOString();

/** The in-memory stores stamp rows with the clock: each row is written at the minute it is set to. */
const clock = (minute: number) => vi.setSystemTime(Date.parse(at(minute)));

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock(-10);
  const repository = new InMemoryNousRepository();
  const goals = new InMemoryNousGoalsRepository();
  const reports = new InMemoryPaneReportsRepository();
  const goal = await goals.create(owner, "Ship the Nous app to the Play Store");
  const other = await goals.create(owner, "Another goal");
  const turn = async (turnId: string, goalId: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
    repository.addTurnFacts(nousTurnFactsSchema.parse({ turnId, ownerUserId: owner, reason: "GOAL", status: "DONE", tools: {}, planPoints: 0, outcomes: [],
      startedAt: at(start), endedAt: at(end), goalId, costUsd: 0.25, ...extra }));
  const tool = async (minute: number, turnId: string, name: string, content: string, meta: Record<string, unknown> = {}) => {
    clock(minute);
    const row = await repository.addMessage({ ownerUserId: owner, turnId, kind: "TOOL", status: "RUNNING", content: "…", meta: { name } });
    await repository.updateMessage(owner, row.id, { status: "DONE", content, meta: { name, ...meta } });
  };
  const event = (minute: number, input: Parameters<typeof goals.addEvent>[1]) => { clock(minute); return goals.addEvent(owner, input); };
  await event(-10, { goalId: goal.id, kind: "CREATED", text: "Set by the operator: \"Ship the Nous app to the Play Store\"" });
  clock(3);
  const decision = await repository.createDecision({ ownerUserId: owner, category: "RELEASE", title: "Publish 0.3.0?", body: "The build passed the APK proof.",
    options: [], recommendation: null, refs: { roomId: "room:alex0001", paneId: "pane:oscar00001" }, action: null } as never);
  await repository.answerDecision(owner, decision.id, { status: "APPROVED", answer: "yes" });
  await turn("nous_turn:t1", goal.id, 0, 4);
  await tool(1, "nous_turn:t1", "space_copilot_brief", "Briefed Oscar: “Build the history screen, then show me…”", { text: "Build the history screen, then show me the APK previews of an opened goal.", result: "brief appbrief:1 for pane:oscar00001" });
  await tool(2, "nous_turn:t1", "space_read_pane", "Read Oscar");
  await tool(3, "nous_turn:t1", "space_ask_operator", "Asked the operator: Publish 0.3.0?", { result: `Asked (${decision.id}). The operator answers in the Nous dock.` });
  await tool(3.5, "nous_turn:t1", "space_plan_update", "Updated a plan", { result: "clipboard:plan0000001 step 2 done, 60%" });
  await event(2, { goalId: goal.id, kind: "PROGRESS", text: "0% → 30%", turnId: "nous_turn:t1" });
  await event(3, { goalId: goal.id, kind: "WAITS", text: "OPERATOR: the release yes", turnId: "nous_turn:t1" });
  await event(4, { goalId: goal.id, kind: "TURN", text: "Moved: the brief went to Oscar.", turnId: "nous_turn:t1" });
  // Three turns that moved nothing: the same wait recorded again, a note, an answer each.
  for (const [index, id] of ["nous_turn:t2", "nous_turn:t3", "nous_turn:t4"].entries()) {
    await turn(id, goal.id, 10 + index * 10, 12 + index * 10, index === 1 ? { status: "FAILED" } : {});
    await event(11 + index * 10, { goalId: goal.id, kind: "WAITS", text: "OPERATOR: the release  yes", turnId: id });
    await event(12 + index * 10, { goalId: goal.id, kind: "TURN", text: `Nothing moved ${index + 1}.`, turnId: id });
  }
  await turn("nous_turn:other", other.id, 5, 6);
  await tool(5.5, "nous_turn:other", "space_send_to_pane", "Sent to Bob", { text: "Another goal's text" });
  await goals.update(owner, goal.id, { planIds: ["clipboard:plan0000001"] });
  await reports.add(owner, { roomId: "room:alex0001", paneId: "pane:oscar00001", at: at(8), source: "AGENT", status: "DONE", summary: "History screen built",
    planId: "clipboard:plan0000001", step: 2, percent: 60, ticket: "q-20261031-100800-ab12", body: "Previews: art:1, art:2", next: "Release build" });
  await reports.add(owner, { roomId: "room:alex0001", paneId: "pane:oscar00001", at: at(9), source: "AUTO", status: "HEARTBEAT", summary: "Still working", planId: "clipboard:plan0000001" });
  const ticket = { id: "q-20261031-100800-ab12", status: "DEPLOYED", branch: "feat/x", summary: "Goal history screen", sha: "abc", submittedAt: at(8), updatedAt: at(9),
    note: null, deployedCommit: "abcdef1234567890", conflictFiles: [], autoResolvedFiles: [], remotes: "ok" } as DeployQueueTicket;
  const deps: Parameters<typeof createGoalHistory>[0] = { goal: (who, id) => goals.get(who, id), events: (who, id) => goals.listEvents(who, [id], Number.MAX_SAFE_INTEGER),
    turnFacts: (who, since) => repository.listTurnFacts(who, since), toolRows: (who, turnIds, names, since) => repository.listTurnTools(who, turnIds, names, since),
    decision: (who, id) => repository.getDecision(who, id), planReports: (who, planIds) => reports.listForPlans(who, planIds),
    ticket: async (id) => id === ticket.id ? ticket : null, onStable: async () => false,
    pane: async (paneId) => paneId === "pane:oscar00001" ? { roomId: "room:alex0001", name: "Oscar" } : null, since: async () => historySince(null) };
  return { history: createGoalHistory(deps), deps, goal, decision };
}

describe("Nous goal work history", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("shows what the goal's turns did, whole, with the decision's answer, its plan's reports and their ticket; folds idle turns and repeated waits", async () => {
    const { history, deps, goal, decision } = await fixture();
    const page = (await history.page(owner, goal.id, {}))!;
    const pick = (id: string) => page.entries.find((entry) => entry.id.startsWith(id)) as NousGoalHistoryEntry;
    expect(page.entries.map((entry) => entry.kind)).toEqual(["TURN", "TICKET", "REPORT", "TURN", "PLAN", "DECISION", "BRIEF", "GOAL"]);
    expect(page.counts).toEqual({ TURN: 2, TICKET: 1, REPORT: 1, PLAN: 1, DECISION: 1, BRIEF: 1, GOAL: 1 });
    // The busy turn: progress and its new wait folded in; the idle ones (one failed) are one entry with the newest answer.
    expect(pick("turn:")).toMatchObject({ title: "Goal turn · 4 min · $0.25 · progress 0% → 30%", detail: "Moved: the brief went to Oscar.\n\nWaits on OPERATOR: the release yes" });
    expect(pick("turns:")).toMatchObject({ title: "3 goal turns, no new work (1 not done)", since: at(10), at: at(32), detail: "Nothing moved 3." });
    // The brief whole, its pane named and linked; a read is no work; another goal's turn is not here.
    expect(pick("tool:")).toBeTruthy();
    expect(page.entries.find((entry) => entry.kind === "BRIEF")).toMatchObject({ title: "Briefed Oscar",
      detail: "Build the history screen, then show me the APK previews of an opened goal.", refs: { paneId: "pane:oscar00001", roomId: "room:alex0001", paneName: "Oscar" } });
    expect(JSON.stringify(page)).not.toContain("Read Oscar");
    expect(JSON.stringify(page)).not.toContain("Another goal's text");
    expect(page.entries.find((entry) => entry.kind === "DECISION")).toMatchObject({ refs: { decisionId: decision.id, paneId: "pane:oscar00001", roomId: "room:alex0001" },
      detail: "The build passed the APK proof.\n\nYour answer: approved: yes" });
    expect(page.entries.find((entry) => entry.kind === "PLAN")).toMatchObject({ refs: { planId: "clipboard:plan0000001" } });
    // The plan's pane report (not its heartbeat) and the ticket it names, with where it is.
    expect(page.entries.find((entry) => entry.kind === "REPORT")).toMatchObject({ title: "Oscar done step 2 (60%): History screen built",
      detail: "Previews: art:1, art:2\n\nNext: Release build", refs: { paneName: "Oscar", planId: "clipboard:plan0000001", ticket: "q-20261031-100800-ab12" } });
    expect(page.entries.find((entry) => entry.kind === "TICKET")).toMatchObject({ title: "q-20261031-100800-ab12 deployed on dev, not on stable yet: Goal history screen",
      detail: "Commit abcdef123456", at: at(9) });
    expect(pick("event:")).toMatchObject({ kind: "GOAL", title: "Set by the operator: \"Ship the Nous app to the Play Store\"" });
    expect(await history.page("user:someone", goal.id, {})).toBeNull();
    // The history window (operator 1/11 03:37 BKK, at most 3 months): only what happened inside it.
    const lastDay = (await createGoalHistory({ ...deps, since: async () => historySince({ history: { periodDays: 7 } }, Date.parse(at(32 + 7 * 1440))) }).page(owner, goal.id, {}))!;
    expect(lastDay.entries.map((item) => item.kind)).toEqual(["TURN"]);
    expect(lastDay.counts).toEqual({ TURN: 1 });
    expect(Object.keys(NOUS_GOAL_WORK_TOOLS)).not.toContain("space_read_pane");
  });

  it("pages by the oldest time held without splitting one time, filters by kind and counts every kind", () => {
    const entry = (id: string, minute: number, kind: NousGoalHistoryEntry["kind"] = "TURN"): NousGoalHistoryEntry => ({ id, at: at(minute), kind, title: id, detail: null, refs: {} });
    const entries = [entry("e", 5), entry("d", 4, "BRIEF"), entry("c", 3), entry("b", 3), entry("a", 1)];
    const first = goalHistoryPage(entries, {}, 3);
    expect(first.entries.map((item) => item.id)).toEqual(["e", "d", "c", "b"]);
    expect(first.hasMore).toBe(true);
    expect(goalHistoryPage(entries, { before: first.entries.at(-1)!.at }, 3)).toEqual({ entries: [entries[4]], hasMore: false, counts: { TURN: 4, BRIEF: 1 } });
    expect(goalHistoryPage(entries, { kind: "BRIEF" }, 3).entries.map((item) => item.id)).toEqual(["d"]);
  });
});
