import { describe, expect, it } from "vitest";
import { renderNousWorld } from "../src/nous/digest.js";
import { createRequestWaitAlerts, NOUS_OPERATOR_WAIT_MS, queuedTexts, renderRequestsWaiting, requestScheduleOf, requestWaitLine, waitingRequestsOf, waitsBehindBusyPane,
  type QueuedText, type RequestWaits, type WaitingPane } from "../src/nous/requests-waiting.js";

const now = Date.parse("2026-10-31T04:00:00.000Z");
const owner = "user:operator";
const note = (key: string, value: Record<string, unknown>) => ({ key, text: JSON.stringify(value), updatedAt: "2026-10-31T03:00:00.000Z" });
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("Operator requests waiting (operator 31/10 «Αργείς», «το πολύ 3 λεπτά»)", () => {
  it("never lets a request wait for a busy pane more than 3 minutes", () => {
    expect(NOUS_OPERATOR_WAIT_MS).toBe(180_000);
    const busy: WaitingPane = { label: "Alex/Max", status: "working", since: minutesAgo(30) };
    expect(waitsBehindBusyPane(busy, { at: minutesAgo(3) }, now)).toBe(true);
    expect(waitsBehindBusyPane(busy, { at: minutesAgo(2.9) }, now)).toBe(false);
    expect(waitsBehindBusyPane({ ...busy, status: "waiting" }, { at: minutesAgo(5) }, now)).toBe(true);
    // An idle pane takes its text at its next empty prompt; no text queued means the pane may be working on the request itself.
    expect(waitsBehindBusyPane({ ...busy, status: "idle" }, { at: minutesAgo(5) }, now)).toBe(false);
    expect(waitsBehindBusyPane(busy, null, now)).toBe(false);
  });

  it("finds the oldest text waiting for each pane: Nous's held queue and Space Control's after-turn prompts", () => {
    const schedule = (id: string, paneIds: string[], createdAt: string, extra: Record<string, unknown> = {}) => ({ kind: "schedule", actorId: owner, key: id,
      value: { id, status: "SCHEDULED", condition: "AFTER_TURN", createdAt, command: { actions: [{ kind: "pane", operation: "prompt", text: `text of ${id}`, target: { paneIds } }] }, ...extra } });
    const queued = queuedTexts([
      schedule("control_schedule:a", ["pane:max00001"], minutesAgo(4), { sourceRequestId: "req-1" }),
      schedule("control_schedule:e", ["pane:max00001"], minutesAgo(5)),
      schedule("control_schedule:b", ["pane:max00001"], minutesAgo(9), { status: "COMPLETED" }),
      schedule("control_schedule:c", ["pane:emma0001"], minutesAgo(9), { condition: "AT_TIME" }),
      { kind: "nous_held", actorId: owner, key: "pane:emma0001", value: { status: "HELD", items: [{ heldAt: minutesAgo(6) }, { heldAt: minutesAgo(1) }] } },
      // A held model or configure change is not a queued text (13/11 nous_held:aqAaIJEF5B8q, Felix/Iris): only the text after it counts.
      { kind: "nous_held", actorId: owner, key: "pane:iris0001", value: { status: "HELD", items: [{ heldAt: minutesAgo(40), model: { modelId: "claude-opus-5-5" } }, { heldAt: minutesAgo(2) }] } },
      { kind: "nous_held", actorId: owner, key: "pane:felix001", value: { status: "HELD", items: [{ heldAt: minutesAgo(40), configure: { kind: "configure" } }] } },
      { ...schedule("control_schedule:d", ["pane:emma0001"], minutesAgo(20)), actorId: "user:other" }
    ], owner);
    expect(Object.fromEntries(queued)).toEqual({
      "pane:max00001": { at: minutesAgo(5), schedules: [{ id: "control_schedule:a", text: "text of control_schedule:a\nreq-1" }, { id: "control_schedule:e", text: "text of control_schedule:e" }] },
      "pane:emma0001": { at: minutesAgo(6) },
      "pane:iris0001": { at: minutesAgo(2) }
    });
  });

  it("advises cancelling only the request's own queued text: a schedule whose text or source carries the request's id (13/11: an unrelated HOLD note was named)", () => {
    const pane: WaitingPane = { label: "Andy/Bruno", status: "working", since: minutesAgo(30) };
    const request = { key: "request-done:open:af4", messageId: "nous_msg:af451f63aa0011223344556677889900", summary: "Ship it", pane: "pane:bruno001", openedAt: minutesAgo(20) };
    const hold = { id: "control_schedule:m2rFytm74rnd", text: "HOLD: the AWS case waits for Jack (nous_msg:0badc0de)" };
    const waitsWith = (queued: QueuedText): RequestWaits => ({ words: () => null, pane: () => pane, queued: () => queued });
    const unrelated = requestWaitLine(request, waitsWith({ at: minutesAgo(5), schedules: [hold] }));
    expect(unrelated).toContain("open a new pane for it now (space_open_panes) and send it there with alsoTo: true. Never wait");
    expect(unrelated).not.toContain("cancel");
    expect(requestScheduleOf(request, { at: minutesAgo(5), schedules: [hold, { id: "control_schedule:own", text: "Do nous_msg:af451f63 now" }] })).toBe("control_schedule:own");
    expect(requestScheduleOf(request, { at: minutesAgo(5), schedules: [hold, { id: "control_schedule:src", text: "Ship\nnous_msg:af451f63aa0011223344556677889900" }] })).toBe("control_schedule:src");
    expect(requestScheduleOf({ messageId: null }, { at: minutesAgo(5), schedules: [hold] })).toBeNull();
    expect(requestScheduleOf(request, null)).toBeNull();
  });

  it("lists every PENDING request still open (any age since 31/10) with the operator's words, age, pane and state, and brings ONE urgent line's text for a request behind a busy pane", () => {
    const notes = [
      note("request-done:open:aaa", { messageId: "nous_msg:emma0001", summary: "Fix the brief hold", pane: "pane:emma0001", turnId: "t1", openedAt: minutesAgo(30), reportedAt: "x" }),
      note("request-done:open:bbb", { messageId: "nous_msg:max00001", summary: "Rename the tab", pane: "pane:max00001", turnId: "t2", openedAt: minutesAgo(10), reportedAt: "x" }),
      note("request-done:open:ccc", { messageId: null, summary: "Check the mail", turnId: "t3", openedAt: minutesAgo(120), reportedAt: "x" }),
      note("request-done:open:ddd", { messageId: null, summary: "Too old", turnId: "t4", openedAt: minutesAgo(49 * 60), reportedAt: "x" }),
      note("request-done:open:eee", { messageId: null, summary: "Closed pane", pane: "pane:gone0001", turnId: "t5", openedAt: minutesAgo(60), reportedAt: "x" }),
      note("request-done:plan:fff", { planId: "clipboard:x" }),
      { key: "request-done:open:bad", text: "not json", updatedAt: "x" }
    ];
    const requests = waitingRequestsOf(notes, now);
    expect(requests.map((request) => request.summary)).toEqual(["Too old", "Check the mail", "Closed pane", "Fix the brief hold", "Rename the tab"]);
    requests.shift();
    const panes = new Map<string, WaitingPane>([
      ["pane:emma0001", { label: "Alex/Emma", status: "working", since: "2026-10-31T03:10:00.000Z" }],
      ["pane:max00001", { label: "Alex/Max", status: "working", since: "2026-10-31T03:50:00.000Z" }]
    ]);
    // Emma's text has waited 4 minutes behind her turn; Max works on his request with nothing queued.
    const queued = new Map<string, QueuedText>([["pane:emma0001", { at: "2026-10-31T03:56:00.000Z", schedules: [{ id: "control_schedule:a", text: "Κάνε το brief πιο γρήγορο (nous_msg:emma0001)" }] }]]);
    const words = new Map([["nous_msg:emma0001", "Κάνε το brief  πιο γρήγορο"]]);
    const waits: RequestWaits = { words: (id) => words.get(id) ?? null, pane: (id) => panes.get(id) ?? null, queued: (id) => queued.get(id) ?? null };
    expect(renderRequestsWaiting(requests, waits, now).split("\n")).toEqual([
      "## Operator requests waiting (reported PENDING and still open, oldest first: move each one on now; never let one wait for a busy pane more than 3 minutes)",
      "- «Check the mail» · 2 h ago · no pane named",
      "- «Closed pane» · 1 h ago · pane:gone0001 is closed or gone",
      "- [nous_msg:emma0001] «Κάνε το brief πιο γρήγορο» · 30 min ago · Alex/Emma working since 03:10 UTC · waits 3+ min behind a busy pane: open a new pane for it now",
      "- [nous_msg:max00001] «Rename the tab» · 10 min ago · Alex/Max working since 03:50 UTC"
    ]);
    expect(requestWaitLine(requests[2]!, waits)).toBe("Operator request [nous_msg:emma0001] «Κάνε το brief πιο γρήγορο» has waited 3+ min behind Alex/Emma (working since 03:10 UTC; "
      + "its text waits since 03:56 UTC): open a new pane for it now (space_open_panes) and send it there with alsoTo: true, then cancel the text queued for Alex/Emma "
      + "(space_execute {\"kind\":\"watch\",\"operation\":\"cancel\",\"id\":\"control_schedule:a\"}). Never wait for a busy agent more than 3 minutes (operator 31/10).");
    expect(renderRequestsWaiting([], waits, now)).toBe("");
  });

  it("brings Nous ONE urgent line per request and queued text, again only for a newer text", async () => {
    const lines: Array<{ key: string; line: string }> = [];
    let queuedAt = minutesAgo(2);
    let clock = now;
    const request = { key: "request-done:open:aaa", messageId: "nous_msg:emma0001", summary: "Fix the brief hold", pane: "pane:emma0001", openedAt: minutesAgo(30) };
    const alerts = createRequestWaitAlerts({ notice: async (_owner, key, line) => { lines.push({ key, line }); },
      waits: async () => ({ requests: [request, { ...request, key: "request-done:open:none", pane: undefined }], now: clock, words: () => null,
        pane: () => ({ label: "Alex/Emma", status: "working", since: minutesAgo(40) }), queued: () => ({ at: queuedAt }) }) });
    await alerts(owner);
    expect(lines).toEqual([]);
    clock = now + 60_000;
    await alerts(owner);
    await alerts(owner);
    expect(lines).toEqual([{ key: "request-waits:request-done:open:aaa", line: expect.stringContaining("has waited 3+ min behind Alex/Emma") }]);
    queuedAt = new Date(clock - NOUS_OPERATOR_WAIT_MS - 30_000).toISOString();
    await alerts(owner);
    expect(lines).toHaveLength(2);
  });

  it("sits right after the goals in the world, in the part never cut", () => {
    const text = renderNousWorld({ rooms: [], notifications: [], plans: [], tasks: [], trains: "", decisions: [], notes: [], now: "2026-10-31T04:00:00.000Z",
      goals: "## Goals\n- one", requestsWaiting: "## Operator requests waiting\n- «x»" });
    expect(text.indexOf("## Operator requests waiting")).toBeGreaterThan(text.indexOf("## Goals"));
    expect(text.indexOf("## Operator requests waiting")).toBeLessThan(text.indexOf("## Rooms and panes"));
  });
});
