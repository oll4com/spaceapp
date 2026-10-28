import { describe, expect, it } from "vitest";
import { clipboardItemSchema, type ClipboardItem, type NousGlobalHold } from "@space/contracts";
import type { PaneReport } from "@space/db";
import { buildPlanMap, createPlanHoldsMonitor, renderPlanMap, stalledHold } from "../src/nous/plan-map.js";

const NOW = new Date("2026-10-25T10:00:00.000Z");
const plan = (id: string, title: string, patch: Partial<ClipboardItem> = {}): ClipboardItem => clipboardItemSchema.parse({
  id: `clipboard:${id}`, text: title, title, source: "PLAN", minimumModel: "m", occurrenceCount: 1, characterCount: title.length,
  createdAt: "2026-10-20T00:00:00.000Z", lastUsedAt: "2026-10-20T00:00:00.000Z", ...patch
});
const report = (planId: string, status: PaneReport["status"], summary: string, needs: string | null = null): PaneReport => ({
  id: `report:${planId}`, roomId: "room:main0001", paneId: "pane:xxxx0001", at: "2026-10-25T09:00:00.000Z", source: "AGENT", status, summary, planId, step: null, percent: null, ticket: null, next: null, needs, body: null
});
const queuePaused: NousGlobalHold = { kind: "QUEUE_PAUSED", text: "The dev merge queue is paused (host identity changed).", since: "2026-10-25T08:00:00.000Z" };
const build = (plans: ClipboardItem[], extra: Partial<Parameters<typeof buildPlanMap>[0]> = {}) =>
  buildPlanMap({ plans, executions: [], summaries: [], reports: [], holds: [], now: NOW, ...extra });

describe("the plan map (operator request 2026-10-25)", () => {
  it("takes each plan's hold in order: its own wait, an unfinished dependency, its execution, its pane's board line, its pane's report, then a server-wide hold", () => {
    const plans = [
      plan("mail0001", "Fix the mail server", { waitsOn: { kind: "THIRD_PARTY", what: "the hosting company", until: null } }),
      plan("site0001", "Launch the site", { dependsOn: ["clipboard:mail0001"], waitsOn: null }),
      plan("exec0001", "Managed one", { paneId: "pane:exec0001" }),
      plan("pane0001", "Pane one", { paneId: "pane:board001" }),
      plan("rep00001", "Report one", { paneId: "pane:xxxx0001" }),
      plan("free0001", "Free one"),
      plan("date0001", "Old date", { waitsOn: { kind: "DATE", what: "the weekend", until: "2026-10-24T00:00:00.000Z" } })
    ];
    const map = build(plans, {
      executions: [{ planId: "clipboard:exec0001", status: "WAITING_FOR_INPUT", statusReason: "The stage needs the operator's answer.", nextRetryAt: null }],
      summaries: [{ paneId: "pane:board001", waitsOn: "PROMOTE", until: null, detail: "Its ticket waits for the promote.", line: "Done; waits for the promote" }],
      reports: [report("clipboard:rep00001", "BLOCKED", "Cannot reach the API", "a VPN route")],
      holds: [queuePaused]
    });
    const hold = (id: string) => map.nodes.get(`clipboard:${id}`)!.hold;
    expect(hold("mail0001")).toEqual({ kind: "THIRD_PARTY", what: "the hosting company", until: null, source: "PLAN" });
    expect(hold("site0001")).toEqual({ kind: "PLAN", what: "Fix the mail server", until: null, source: "DEPENDENCY" });
    expect(hold("exec0001")).toMatchObject({ kind: "OPERATOR", what: "The stage needs the operator's answer.", source: "EXECUTION" });
    expect(hold("pane0001")).toMatchObject({ kind: "PROMOTE", what: "Its ticket waits for the promote.", source: "PANE" });
    expect(hold("rep00001")).toMatchObject({ kind: "NOUS", what: "a VPN route", source: "REPORT" });
    expect(hold("free0001")).toMatchObject({ kind: "SERVER", what: queuePaused.text, source: "SERVER" });
    // A wait on a date that passed is over: the server hold applies instead.
    expect(hold("date0001")?.source).toBe("SERVER");
  });

  it("layers plans by dependency depth, never recursing into a loop, and counts what each root unsticks", () => {
    const plans = [
      plan("a0000001", "A"), plan("b0000001", "B", { dependsOn: ["clipboard:a0000001"] }), plan("c0000001", "C", { dependsOn: ["clipboard:b0000001"] }),
      plan("d0000001", "D", { dependsOn: ["clipboard:a0000001", "clipboard:gone0001"] }),
      plan("l1000001", "L1", { dependsOn: ["clipboard:l2000001"] }), plan("l2000001", "L2", { dependsOn: ["clipboard:l1000001"] })
    ];
    const map = build(plans);
    expect(map.ordered.map((node) => `${node.id.slice(10)}:${node.level}`)).toEqual(["a0000001:0", "b0000001:1", "d0000001:1", "l2000001:1", "c0000001:2", "l1000001:2"]);
    expect(map.nodes.get("clipboard:d0000001")!.dependsOn).toEqual(["clipboard:a0000001"]);
    // A plan others depend on is a blocker of its own: finishing A unsticks A, B, C and D.
    expect(map.unblockFirst[0]).toEqual({ kind: "FINISH", what: "A", planIds: ["clipboard:a0000001"], unsticks: 4 });
  });

  it("lists the server-wide hold first in Unblock first, then only blockers someone can act on, merged, ranked by what they unstick; dates are one timeline", () => {
    const plans = [
      plan("mail0001", "Fix the mail server", { waitsOn: { kind: "THIRD_PARTY", what: "the hosting company", until: null }, dueAt: "2026-10-24T09:00:00.000Z" }),
      plan("site0001", "Launch the site", { dependsOn: ["clipboard:mail0001"], dueAt: "2026-10-30T09:00:00.000Z" }),
      plan("news0001", "Newsletter", { dependsOn: ["clipboard:site0001"] }),
      plan("vpn00001", "VPN route", { waitsOn: { kind: "OPERATOR", what: "the Nord password", until: null } }),
      plan("vpn00002", "VPN route two", { waitsOn: { kind: "OPERATOR", what: "The Nord  password", until: null } }),
      plan("wait0001", "Kept for Monday", { waitsOn: { kind: "DATE", what: "the Monday check", until: "2026-10-26T02:00:00.000Z" } }),
      plan("free0001", "Free one")
    ];
    const map = build(plans, { holds: [queuePaused] });
    // A wait for a date is not a blocker; two plans waiting on the same thing are one blocker.
    expect(map.unblockFirst.map((item) => [item.kind, item.planIds.map((id) => id.slice(10)), item.unsticks])).toEqual([
      ["SERVER", [], 7], ["THIRD_PARTY", ["mail0001"], 3], ["OPERATOR", ["vpn00001", "vpn00002"], 2], ["FINISH", ["site0001"], 2]]);
    expect(map.dates).toEqual([
      { planId: "clipboard:mail0001", title: "Fix the mail server", at: "2026-10-24T09:00:00.000Z", kind: "DUE", overdue: true },
      { planId: "clipboard:wait0001", title: "Kept for Monday", at: "2026-10-26T02:00:00.000Z", kind: "RESUMES", overdue: false },
      { planId: "clipboard:site0001", title: "Launch the site", at: "2026-10-30T09:00:00.000Z", kind: "DUE", overdue: false }
    ]);
    const text = renderPlanMap(map, "Asia/Bangkok");
    expect(text).toContain("## Plan map");
    expect(text).toContain("- QUEUE_PAUSED: The dev merge queue is paused (host identity changed). (since 2026-10-25 15:00)");
    expect(text).toContain("- SERVER: The dev merge queue is paused (host identity changed). · holds every plan");
    expect(text).toContain('- waits on a third party: the hosting company → [clipboard:mail0001] "Fix the mail server" · unsticks 3 plans');
    expect(text).toContain('- waits on you: the Nord password → [clipboard:vpn00001] "VPN route", [clipboard:vpn00002] "VPN route two" · unsticks 2 plans');
    expect(text).toContain('- finish [clipboard:site0001] "Launch the site" (0%) · unsticks 2 plans');
    expect(text).toContain('- 2026-10-24 16:00 due [clipboard:mail0001] "Fix the mail server" — OVERDUE');
    expect(text).toContain('- 2026-10-26 09:00 resumes [clipboard:wait0001] "Kept for Monday"');
    expect(text).toContain('- [clipboard:news0001] "Newsletter" 0% · waits on another plan: Launch the site (until 2026-10-30 16:00) · needs: [clipboard:site0001] "Launch the site"');
    expect(text).toContain("1 other plan waits on nothing recorded.");
    expect(text).not.toContain('[clipboard:free0001] "Free one" 0%');
  });

  it("keeps a plan held on a date, another plan or the server out of the stalled nudges, not one held on a person", () => {
    const map = build([
      plan("date0001", "Dated", { waitsOn: { kind: "DATE", what: "the launch window", until: "2026-11-01T00:00:00.000Z" } }),
      plan("root0001", "Root", { waitsOn: { kind: "THIRD_PARTY", what: "the registrar", until: null } }),
      plan("leaf0001", "Leaf", { dependsOn: ["clipboard:root0001"] }),
      plan("free0001", "Free")
    ], { holds: [queuePaused] });
    expect(stalledHold(map, "clipboard:date0001")).toBe("waits on a date: the launch window (until 2026-11-01 00:00)");
    expect(stalledHold(map, "clipboard:leaf0001")).toBe("waits on another plan: Root");
    expect(stalledHold(map, "clipboard:free0001")).toContain("waits on the server");
    expect(stalledHold(map, "clipboard:root0001")).toBeNull();
  });

  it("announces a server-wide hold once when it appears and once when it clears, and an overdue plan once", () => {
    const monitor = createPlanHoldsMonitor();
    const overdue = plan("late0001", "Late", { dueAt: "2026-10-24T09:00:00.000Z" });
    const first = monitor.observe("user:1", build([overdue], { holds: [queuePaused] }));
    expect(first.map((line) => line.key)).toEqual(["plan-hold:QUEUE_PAUSED", "plan-overdue:clipboard:late0001"]);
    expect(first[0]!.line).toContain("Server-wide hold: The dev merge queue is paused");
    expect(monitor.observe("user:1", build([overdue], { holds: [queuePaused] }))).toEqual([]);
    const cleared = monitor.observe("user:1", build([overdue]));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.line).toContain("Server-wide hold cleared");
    expect(monitor.observe("user:2", build([], { holds: [queuePaused] }))).toHaveLength(1);
  });
});
