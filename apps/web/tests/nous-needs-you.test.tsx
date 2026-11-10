import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardItem, NousDecision, NousOverview, SpaceNotification } from "@space/contracts";
import { NousNeedsYou, PlanNeedsYou } from "../src/features/nous/NousNeedsYou.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Plan clipboard:PHmjUTRmWM6C (operator 31/10 13:20 BKK): Needs you lists Nous's open decisions with the cards; a plan held on the operator shows
// what it needs from them, answered from the plan. Its filters left on 3/11 (operator «αφαίρεσε όλα αυτά τα φίλτρα, δεν υπάρχει λόγος»).
const at = (minute: number) => `2026-10-31T06:0${minute}:00.000Z`;
const alex = "room:alex00000001", cleo = "room:cleo00000001";
const card = (id: string, minute: number, patch: Partial<SpaceNotification>): SpaceNotification => ({
  id: `notification:${id}`, ownerUserId: "user:operator", roomId: alex, paneId: "pane:andy00000001", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION",
  title: `${id} needs you`, body: "Which colour?", link: null, dedupeKey: null, status: "OPEN", payload: {}, createdAt: at(minute), updatedAt: at(minute), readAt: null, resolvedAt: null,
  ...patch
} as SpaceNotification);
const andy = card("andy", 1, { payload: { planId: "clipboard:planColour01", ask: { question: "Which colour?", options: ["Red", "Blue"], recommended: "Blue", answer: { kind: "PANE" } } } });
const bob = card("bob", 2, { paneId: "pane:bob000000001", source: "NOUS", kind: "NEEDS_HANDS", body: "• Sign in to GitHub",
  payload: { items: [{ text: "Sign in to GitHub", steps: ["Open https://github.com/login", "Use the work account"] }] } });
const emma = card("emma", 3, { roomId: cleo, paneId: "pane:emma00000001", source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", body: "Approve the reply",
  payload: { ask: { question: "Send this reply?", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailrev:x" } } } });
const decision = (id: string, minute: number, patch: Partial<NousDecision>): NousDecision => ({
  id: `nous_decision:${id}`, ownerUserId: "user:operator", category: "DIRECTION", title: `Decide ${id}`, body: "", options: [], recommendation: null, refs: {}, action: null,
  status: "OPEN", answer: null, outcome: null, createdAt: at(minute), answeredAt: null, ...patch
});
const colourAsk = decision("colour", 4, { refs: { planId: "clipboard:planColour01" } });
const freeAsk = decision("free", 5, {});
const row = (id: string, title: string, patch: Partial<NousOverview["plans"][number]> = {}): NousOverview["plans"][number] =>
  ({ id: `clipboard:${id}`, title, progress: 10, status: "IN_PROGRESS", room: null, pane: null, nextStep: null, ...patch });
const plans = [row("planColour01", "Colour plan", { hold: { kind: "OPERATOR", what: "Pick a colour", until: null, source: "PLAN" } }),
  row("planMail0001", "Mail cleanup", { room: "Cleo", pane: "Emma", paneId: "pane:emma00000001" })];
const board = { rooms: [
  { roomId: alex, name: "Alex", panes: [{ paneId: "pane:andy00000001", name: "Andy" }, { paneId: "pane:bob000000001", name: "Bob" }] },
  { roomId: cleo, name: "Cleo", panes: [{ paneId: "pane:emma00000001", name: "Emma" }] }
], paused: null, callsToday: 0, settings: {}, generatedAt: at(0) };
const renderDecision = (item: NousDecision) => <article aria-label={item.title}>{item.title}</article>;
const shown = () => screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"));

let calls: Array<{ url: string; body: unknown }> = [];
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:nous", headerName: "x-space-csrf-token" });
    if (url === "/api/nous/pane-board") return Response.json({ board });
    if (url === "/api/nous/messages") return Response.json({ message: { id: "nous_msg:sent00000001" } }, { status: 202 });
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Needs you list (plan clipboard:PHmjUTRmWM6C; no filters since operator 3/11 12:36 BKK, nous_msg:15e7b144)", () => {
  it("lists every card and Nous's open decisions by group (questions with the decisions, approvals, in a pane), newest first in each, with no filter controls", async () => {
    render(<NousNeedsYou requests={[andy, bob, emma]} decisions={[colourAsk, freeAsk]} renderDecision={renderDecision} plans={plans} />);
    // Plan clipboard:ytwWl09xNH0Z (design §3.3): an empty group is not shown.
    expect(shown()).toEqual(["Decide free", "Decide colour", "andy needs you", "emma needs you", "bob needs you"]);
    expect([...document.querySelectorAll(".ny-group-title")].map((title) => title.textContent)).toEqual(["Questions3", "Approvals1", "In a pane1"]);
    expect(screen.getByText("5 wait for you")).toBeTruthy();
    // The pane board loads (the cards name their panes from it) and still no filter appears.
    await waitFor(() => expect(calls.some((call) => call.url === "/api/nous/pane-board")).toBe(true));
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Clear the filters" })).toBeNull();
  });

  it("says so when nothing waits", () => {
    render(<NousNeedsYou requests={[]} />);
    expect(screen.getByText("Nothing waits for you")).toBeTruthy();
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
  });
});

describe("a plan's \"What it needs from you\" (plan clipboard:PHmjUTRmWM6C step 2)", () => {
  const plan = (patch: Partial<ClipboardItem> = {}) => ({ id: "clipboard:planColour01", title: "Colour plan", text: "# Colour plan", paneId: null, waitsOn: null, ...patch }) as ClipboardItem;

  it("lists the open cards and decisions tied to the plan with their answers, and nothing else", async () => {
    const answered = decision("old", 6, { refs: { planId: "clipboard:planColour01" }, status: "APPROVED" });
    render(<PlanNeedsYou plan={plan({ waitsOn: { kind: "OPERATOR", what: "Pick a colour", until: null } })} hold={null} needs={[andy, bob, emma]}
      decisions={[colourAsk, freeAsk, answered]} renderDecision={renderDecision} />);
    const section = screen.getByRole("region", { name: "What it needs from you" });
    expect(within(section).getByText("Pick a colour")).toBeTruthy();
    expect(shown()).toEqual(["Decide colour", "andy needs you"]);
    // The card keeps its question, and closed its recommended answer; the rest on Details.
    expect(within(section).getByRole("heading", { name: "Which colour?" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Blue" }).className).toContain("is-primary");
    fireEvent.click(within(section).getByRole("button", { name: "Details" }));
    expect(within(section).getByRole("button", { name: "Blue (Recommended)" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Red" })).toBeTruthy();
  });

  it("takes the plan's pane and an id its wait names; a plan neither held on you nor asked about shows nothing", () => {
    const { unmount } = render(<PlanNeedsYou plan={plan({ id: "clipboard:planMail0001", paneId: "pane:emma00000001" })} hold={{ kind: "OPERATOR", what: `Answer ${bob.id} first`, until: null, source: "PANE" }}
      needs={[andy, bob, emma]} decisions={[]} renderDecision={renderDecision} />);
    expect(shown()).toEqual(["emma needs you", "bob needs you"]);
    unmount();
    render(<PlanNeedsYou plan={plan({ id: "clipboard:planOther001" })} hold={{ kind: "NOUS", what: "Nous checks the logs", until: null, source: "PANE" }} needs={[bob]} decisions={[]} renderDecision={renderDecision} />);
    expect(screen.queryByRole("region", { name: "What it needs from you" })).toBeNull();
  });

  it("held on you with no card, says what it waits on and sends the answer to Nous with the plan's id", async () => {
    render(<PlanNeedsYou plan={plan()} hold={{ kind: "OPERATOR", what: "Pick a colour", until: null, source: "PLAN" }} needs={[]} decisions={[]} renderDecision={renderDecision} />);
    expect(screen.getByText("Pick a colour")).toBeTruthy();
    expect(screen.getByText("No card or decision asks it yet. Answer here and Nous gets it with this plan.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Your answer to Nous about this plan" }), { target: { value: "Blue, please" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Nous" }));
    expect(await screen.findByText("Sent to Nous with this plan.")).toBeTruthy();
    expect(calls.find((call) => call.url === "/api/nous/messages")?.body).toEqual({ content: "[Plan Colour plan · clipboard:planColour01] Blue, please" });
  });
});
