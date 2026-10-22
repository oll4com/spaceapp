// Nous's pane board (plan clipboard:Y9cgKVHFaHrr): rooms in order with their panes, the waits-on chip and filters, the operator's
// items under each pane, a reply per pane (prompt options, copilot question, Nous) and a refetch when the stream says it changed.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NousDecision, NousPaneBoard as Board, NousPaneBoardPane } from "@space/contracts";
import { nousPaneBoardSettingsSchema } from "@space/contracts";
import { NousPaneBoard } from "../src/features/nous/NousPaneBoard.js";
import { NOUS_PANE_BOARD_EVENT } from "../src/features/nous-focus/nous-focus-events.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const at = "2026-10-19T09:00:00.000Z";
const pane = (paneId: string, name: string, roomId: string, patch: Partial<NousPaneBoardPane> = {}): NousPaneBoardPane => ({
  paneId, roomId, name, mode: "TERMINAL", runtimeId: "cli:claude", model: "claude-opus-5-5", state: "working", plan: null,
  summary: { line: `${name} runs the tests`, waitsOn: "NONE", needsOperator: false, until: null, detail: null, source: "MODEL", model: "claude-haiku-5-5", generatedAt: at },
  report: null, prompt: null, notifications: [], decisionIds: [], copilotItems: [], ...patch
});
const board = (patch: Partial<Board> = {}): Board => ({
  rooms: [
    { roomId: "room:alpha0001", name: "Alpha", panes: [
      pane("pane:andy0001", "Andy", "room:alpha0001", { plan: { id: "clipboard:plan0001", title: "Pane board", progress: 40, nextStep: "5. Web (PENDING)" } }),
      pane("pane:bob00001", "Bob", "room:alpha0001", { state: "waiting",
        summary: { line: "Ρωτά αν θα τρέξει το migration", waitsOn: "OPERATOR", needsOperator: true, until: null, detail: "Approve the migration", source: "MODEL", model: "claude-haiku-5-5", generatedAt: at },
        prompt: { question: "Run the migration now?", options: [{ key: "1", label: "Yes" }, { key: "2", label: "No, later" }] },
        notifications: [{ id: "notification:card0001", source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", title: "Sign in to GitHub", body: "• Sign in", card: true }],
        decisionIds: ["nous_decision:abcdef123456"] })
    ] },
    { roomId: "room:beta00001", name: "Beta", panes: [
      pane("pane:mail0001", "Mia", "room:beta00001", { mode: "MAIL_COPILOT", state: "idle",
        summary: { line: "Waits for the promote", waitsOn: "PROMOTE", needsOperator: false, until: null, detail: null, source: "FALLBACK", model: null, generatedAt: at },
        copilotItems: [{ copilot: "MAIL", kind: "QUESTION", id: "q1", title: "Which signature?", detail: "Formal or short" }] })
    ] }
  ],
  paused: null, callsToday: 3, settings: nousPaneBoardSettingsSchema.parse({}), generatedAt: at, ...patch
});
const decision = { id: "nous_decision:abcdef123456", ownerUserId: "user:operator", category: "RELEASE", title: "Promote dev to stable?", body: "", options: [], recommendation: null,
  refs: { paneId: "pane:bob00001" }, action: null, status: "OPEN", answer: null, outcome: null, createdAt: at, answeredAt: null } as NousDecision;

function serve(current: { board: Board }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:board", headerName: "x-space-csrf-token" });
    if (url === "/api/nous/pane-board") return Response.json({ board: current.board });
    if (url === "/api/nous/pane-board/refresh") return Response.json({ started: true }, { status: 202 });
    if (url.endsWith("/answer")) return Response.json({ routed: "NOUS", display: "Sent." });
    return Response.json({ error: { message: `unexpected ${url}` } }, { status: 404 });
  }));
  return calls;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Nous pane board", () => {
  it("lists the rooms with their panes and filters by what they wait on", async () => {
    serve({ board: board() });
    const renderDecision = vi.fn((item: NousDecision) => <p>{item.title}</p>);
    render(<NousPaneBoard active decisions={[decision]} overview={null} renderDecision={renderDecision} />);
    const alpha = await screen.findByRole("region", { name: "Room Alpha" });
    expect(within(alpha).getAllByRole("listitem").filter((item) => item.classList.contains("nous-board-pane")).map((item) => item.getAttribute("aria-label")))
      .toEqual(["Andy in Alpha", "Bob in Alpha"]);
    const bob = within(alpha).getByRole("listitem", { name: "Bob in Alpha" });
    expect(within(bob).getByTitle("Waits on").textContent).toBe("You");
    expect(within(bob).getByText("Ρωτά αν θα τρέξει το migration")).toBeTruthy();
    expect(within(bob).getByText("Sign in to GitHub")).toBeTruthy();
    expect(within(bob).getByText("Promote dev to stable?")).toBeTruthy();
    expect(within(screen.getByRole("listitem", { name: "Andy in Alpha" })).getByText("Pane board · 40%")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Mia in Beta" })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Waits on" })).getByRole("button", { name: /^Needs me/ }));
    expect(screen.queryByRole("listitem", { name: "Andy in Alpha" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Room Beta" })).toBeNull();
    expect(screen.getByRole("listitem", { name: "Bob in Alpha" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Waits on" })).getByRole("button", { name: /^Promote/ }));
    expect(screen.getByRole("listitem", { name: "Mia in Beta" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Room Alpha" })).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Waits on" })).getByRole("button", { name: /^All/ }));
    // A room folds away.
    fireEvent.click(within(screen.getByRole("region", { name: "Room Alpha" })).getByRole("button", { name: /Alpha/ }));
    expect(screen.queryByRole("listitem", { name: "Bob in Alpha" })).toBeNull();
  });

  it("answers a prompt option, a copilot question and Nous from each pane's row", async () => {
    const calls = serve({ board: board() });
    render(<NousPaneBoard active decisions={[]} overview={null} renderDecision={() => null} />);
    const bob = await screen.findByRole("listitem", { name: "Bob in Alpha" });
    fireEvent.click(within(bob).getByRole("button", { name: "1. Yes" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/pane-board/pane%3Abob00001/answer")?.body).toEqual({ text: "1", target: { kind: "PROMPT" } }));
    expect(await within(bob).findByText("Sent.")).toBeTruthy();

    const mia = screen.getByRole("listitem", { name: "Mia in Beta" });
    fireEvent.click(within(mia).getByRole("button", { name: "Answer" }));
    fireEvent.change(within(mia).getByRole("textbox", { name: "Reply about Mia" }), { target: { value: "Short" } });
    fireEvent.click(within(mia).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/pane-board/pane%3Amail0001/answer")?.body)
      .toEqual({ text: "Short", target: { kind: "COPILOT_QUESTION", copilot: "MAIL", questionId: "q1" } }));

    const andy = screen.getByRole("listitem", { name: "Andy in Alpha" });
    expect(within(andy).queryByRole("group", { name: "Reply to Andy as" })).toBeNull();
    fireEvent.change(within(andy).getByRole("textbox", { name: "Reply about Andy" }), { target: { value: "Πάρε το επόμενο βήμα" } });
    fireEvent.click(within(andy).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/pane-board/pane%3Aandy0001/answer")?.body).toEqual({ text: "Πάρε το επόμενο βήμα", target: { kind: "NOUS" } }));
  });

  it("refetches when the stream says the board changed and says when summaries are paused", async () => {
    const current = { board: board() };
    const calls = serve(current);
    render(<NousPaneBoard active decisions={[]} overview={null} renderDecision={() => null} />);
    await screen.findByRole("listitem", { name: "Andy in Alpha" });
    current.board = board({ paused: "DAILY_CAP", rooms: [{ roomId: "room:alpha0001", name: "Alpha", panes: [pane("pane:andy0001", "Andy", "room:alpha0001", {
      summary: { line: "Step 6 done", waitsOn: "NONE", needsOperator: false, until: null, detail: null, source: "FALLBACK", model: null, generatedAt: at } })] }] });
    window.dispatchEvent(new CustomEvent(NOUS_PANE_BOARD_EVENT, { detail: { paneId: "pane:andy0001" } }));
    expect(await screen.findByText("Step 6 done", undefined, { timeout: 4_000 })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Summaries paused (daily cap)");
    fireEvent.click(screen.getByRole("button", { name: "Refresh the summaries" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/nous/pane-board/refresh" && call.method === "POST")).toBe(true));
  });
});
