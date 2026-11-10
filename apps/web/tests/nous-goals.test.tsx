import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nousGoalsSettingsSchema, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousStandingOrdersSettingsSchema, type NousGoalHistoryEntry, type NousGoalsView, type NousState } from "@space/contracts";
import { NOUS_FOCUS_EVENT, type NousFocusDetail } from "../src/features/nous-focus/nous-focus-events.js";
import { NousDock } from "../src/features/nous/NousDock.js";
import { NousSettingsCard } from "../src/features/nous/NousSettingsCard.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the Goals tab with the ACTIVE count (the composer's copy of it
// left the same day: no option twice), the Goals view (add, edit, reorder, pause, drop, delete), /goal and /goals in the composer, and the loop's Settings rows.
const at = "2026-10-27T08:00:00.000Z";
const settings = (patch: Partial<NousState["settings"]> = {}): NousState["settings"] => ({
  enabled: true, maxTurnsPerHour: 20, lowTokenAutomatic: true, lowSpend: nousLowSpendSettingsSchema.parse({}), mayPromote: false, mayApproveWarm: false, maySecurityHotfix: false, askOwnHostChanges: false, maySend: false, mayDeleteOwn: false, mayPublish: false, mayRestartHosts: false, neverRefuse: false, shell: false,
  alwaysApprove: [], paneBoard: nousPaneBoardSettingsSchema.parse({}), standingOrders: nousStandingOrdersSettingsSchema.parse({}), models: nousModelsSettingsSchema.parse({}), fallbackModel: "none",
  telegramInbound: false, copilotQuestionsNousFirst: true, goals: nousGoalsSettingsSchema.parse({}), ...patch
});
const state = (patch: Partial<NousState> = {}): NousState => ({ status: "IDLE", settings: settings(), model: "claude-fable-5-1", effort: "max", running: null, turnsThisHour: 0, lastError: null, openDecisions: 0, inbox: 0,
  goals: { active: 2, nextAt: "2026-10-27T08:01:00.000Z", held: null }, ...patch });
const goal = (id: string, text: string, patch: Partial<NousGoalsView["goals"][number]> = {}): NousGoalsView["goals"][number] => ({
  id, ownerUserId: "user:operator", text, status: "ACTIVE", priority: 1, progress: 0, criteria: null, planIds: [], waitsOn: null, limit: null, note: null, evidence: null, lastWorkedAt: null, nextTurnAt: null,
  fingerprint: null, unchangedTurns: 0, createdAt: at, updatedAt: at, achievedAt: null, cost: { today: { turns: 0, costUsd: 0, unpriced: 0 }, month: { turns: 0, costUsd: 0, unpriced: 0 } }, events: [], ...patch
});
const view = (): NousGoalsView => ({
  goals: [
    goal("nous_goal:sell00000001", "Sell 100 SpaceApp licences by December", { progress: 40, limit: { kind: "DATE", until: "2026-12-31T16:59:00.000Z" }, criteria: "100 paid licences in Stripe", planIds: ["clipboard:plan00000001"],
      waitsOn: { kind: "THIRD_PARTY", what: "Stripe's account review", until: null }, note: "Pricing page shipped.", lastWorkedAt: "2026-10-27T07:50:00.000Z", nextTurnAt: new Date(Date.now() + 15 * 60_000).toISOString(), unchangedTurns: 3,
      cost: { today: { turns: 4, costUsd: 2.5, unpriced: 0 }, month: { turns: 12, costUsd: 9.75, unpriced: 1 } },
      events: [{ id: "9", goalId: "nous_goal:sell00000001", at: "2026-10-27T07:52:00.000Z", kind: "TURN", text: "Moved: pricing page.", turnId: "nous_turn:a" }] }),
    goal("nous_goal:jobs00000001", "Get the Job Copilot an interview a week", { priority: 2, progress: 25 }),
    goal("nous_goal:done00000001", "Finish the Vault review", { priority: 3, status: "ACHIEVED", progress: 100, limit: { kind: "TARGET", what: "Every review finding closed" }, evidence: "Ticket q-1 deployed and verified.", achievedAt: at })
  ],
  loop: { on: true, running: null, nextAt: "2026-10-27T08:01:00.000Z", held: null }
});

// A goal's work history (plan clipboard:jNDx8l-vMEl9): a newest page, an older page and the BRIEF filter.
const entry = (id: string, at: string, kind: NousGoalHistoryEntry["kind"], title: string, patch: Partial<NousGoalHistoryEntry> = {}): NousGoalHistoryEntry =>
  ({ id, at, kind, title, detail: null, refs: {}, ...patch });
const turns = entry("turns:t9", "2026-10-27T07:52:00.000Z", "TURN", "3 goal turns, no new work", { since: "2026-10-27T07:20:00.000Z", detail: "Waiting on Stripe." });
const brief = entry("tool:b1", "2026-10-27T07:10:00.000Z", "BRIEF", "Briefed Oscar", { detail: "Build the pricing page with the three plans, then show me the previews.",
  refs: { paneId: "pane:oscar00001", roomId: "room:alex00001", paneName: "Oscar" } });
const report = entry("report:r1", "2026-10-27T07:05:00.000Z", "REPORT", "Oscar done step 2 (60%): Pricing page built", { refs: { planId: "clipboard:plan00000001" } });
const older = entry("turn:t1", "2026-10-27T06:00:00.000Z", "TURN", "Goal turn · 4 min · progress 0% → 30%", { detail: "Moved: the brief went to Oscar." });
const historyCounts = { TURN: 2, BRIEF: 1, REPORT: 1 };
function historyPage(url: string) {
  const query = new URL(url, "http://space.local").searchParams;
  if (query.get("kind") === "BRIEF") return { entries: [brief], hasMore: false, counts: historyCounts };
  if (query.get("before")) return { entries: [older], hasMore: false, counts: historyCounts };
  return { entries: [turns, brief, report], hasMore: true, counts: historyCounts };
}

// Cards start collapsed (operator request 2026-10-31): the header row is a button that opens the card.
const head = (card: HTMLElement) => within(card).getByRole("button", { name: /^(Active|Paused|Achieved|Dropped)/ });
const expand = (card: HTMLElement) => { fireEvent.click(head(card)); return card; };

function serve(options: { state?: NousState; view?: NousGoalsView } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let current = options.view ?? view();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:nous", headerName: "x-space-csrf-token" });
    if (url === "/api/nous") return Response.json({ state: options.state ?? state() });
    if (url === "/api/nous/messages" && method === "GET") return Response.json({ messages: [], waiting: [], attachments: {} });
    if (url === "/api/nous/messages" && method === "POST") return Response.json({ message: { id: "nous_msg:new00001", ownerUserId: "user:operator", turnId: null, kind: "OPERATOR", status: "DONE", content: body.content, meta: { goalCommand: "CREATE" }, createdAt: at, updatedAt: at } }, { status: 202 });
    if (url === "/api/nous/decisions") return Response.json({ decisions: [] });
    if (url === "/api/nous/goals" && method === "GET") return Response.json({ view: current });
    if (url === "/api/nous/goals" && method === "POST") { current = { ...current, goals: [...current.goals, goal("nous_goal:new000000001", body.text, { priority: 4 })] }; return Response.json({ goal: current.goals.at(-1) }, { status: 201 }); }
    if (url.startsWith("/api/nous/goals/") && url.includes("/history")) return Response.json(historyPage(url));
    if (url === "/api/nous/goals/reorder") return Response.json({ goals: current.goals });
    if (url.startsWith("/api/nous/goals/") && method === "PATCH") return Response.json({ goal: { ...current.goals[0], ...body } });
    if (url.startsWith("/api/nous/goals/") && method === "DELETE") return Response.json({ removed: true });
    if (url === "/api/nous/overview") return Response.json({ overview: { plans: [{ id: "clipboard:plan00000001", title: "Pricing page", progress: 60, status: "IN_PROGRESS", room: "Main", pane: "Andy", nextStep: null }], needsHands: [], trains: "", planMap: null } });
    if (url === "/api/nous/settings") return Response.json({ settings: settings(body) });
    if (url.startsWith("/api/notifications")) return Response.json({ notifications: [], total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] });
    return Response.json({});
  }));
  return calls;
}

describe("Nous goals in the dock", () => {
  beforeEach(() => installSpaceRuntime(liveRuntime));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("shows the active count on the Goals tab only, and opens the Goals view with every goal's state", async () => {
    const calls = serve();
    render(<NousDock canRun />);
    const button = await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Goals\s*2$/ });
    const tools = screen.getByRole("button", { name: "Attach files" }).closest(".nous-composer-tools") as HTMLElement;
    expect(within(tools).queryByRole("button", { name: /Goals/ })).toBeNull();
    fireEvent.click(button);
    const first = await screen.findByRole("article", { name: "Sell 100 SpaceApp licences by December" });
    expect(within(first).getByText("Active")).toBeTruthy();
    expect(within(first).getByText("40%")).toBeTruthy();
    expect(within(first).getByText("#1")).toBeTruthy();
    expect(within(first).getByText("Sell 100 SpaceApp licences by December")).toBeTruthy();
    expect(head(first).getAttribute("aria-expanded")).toBe("false");
    expect(within(first).queryByText("100 paid licences in Stripe")).toBeNull();
    expect(within(first).queryByRole("button", { name: "Edit the goal" })).toBeNull();
    expand(first);
    expect(head(first).getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(head(first).getAttribute("aria-controls")!)?.closest("article")).toBe(first);
    expect(within(first).getByText("100 paid licences in Stripe")).toBeTruthy();
    expect(within(first).getByText(/^By .*(2026|Dec)/)).toBeTruthy();
    expect(first.querySelector(".nous-goal-bar")).not.toBeNull();
    expect([...first.querySelectorAll(".nous-goal-facts dt")].slice(0, 2).map((dt) => dt.textContent)).toEqual(["Limit", "Criteria"]);
    // Masked shots blur only the goal's own words: the status, percent, bar and Limit row stay readable.
    const masked = (element: Element | null) => Boolean(element?.closest('[data-sensitive-masked="manual"]'));
    for (const selector of [".nous-goal-status", ".nous-goal-percent", ".nous-goal-bar", ".nous-goal-facts dd"]) expect(masked(first.querySelector(selector))).toBe(false);
    for (const selector of [".nous-goal-line", ".nous-goal-text", ".nous-goal-facts dd:nth-of-type(2)"]) expect(masked(first.querySelector(selector))).toBe(true);
    // Operator 1/11 03:39 BKK: a goal without a limit shows no percentage, collapsed or open.
    const unlimited = screen.getByRole("article", { name: "Get the Job Copilot an interview a week" });
    expect(within(unlimited).queryByText("25%")).toBeNull();
    expand(unlimited);
    expect(within(unlimited).queryByText(/%/)).toBeNull();
    expect(unlimited.querySelector(".nous-goal-bar")).toBeNull();
    expect(within(unlimited).queryByText("Limit")).toBeNull();
    fireEvent.click(head(unlimited));
    expect(within(first).getByText(/Stripe's account review/)).toBeTruthy();
    expect(within(first).getByText(/Pricing page shipped\./)).toBeTruthy();
    expect(within(first).getByText(/today \$2\.50 \(4 turns\) · this month \$9\.75 \(12 turns, 1 unpriced\)/)).toBeTruthy();
    expect(within(first).getByText(/nothing moved in 3 turns/)).toBeTruthy();
    await waitFor(() => expect(within(first).getByText(/Pricing page \(60%\)/)).toBeTruthy());
    expect(screen.getByText(/Goal loop on · next goal turn/)).toBeTruthy();
    const achieved = expand(screen.getByRole("article", { name: "Finish the Vault review" }));
    expect(head(first).getAttribute("aria-expanded")).toBe("true");
    expect(within(achieved).getByText("Achieved")).toBeTruthy();
    expect(within(achieved).getByText(/Ticket q-1 deployed and verified\./)).toBeTruthy();
    expect(within(achieved).getByText("100%")).toBeTruthy();
    expect(within(achieved).getByText("Every review finding closed")).toBeTruthy();
    expect(within(achieved).getByRole("button", { name: "Reopen the goal" })).toBeTruthy();
    expect(calls.some((call) => call.url === "/api/nous/goals" && call.method === "GET")).toBe(true);
    fireEvent.click(head(first));
    expect(head(first).getAttribute("aria-expanded")).toBe("false");
    expect(within(first).queryByText("100 paid licences in Stripe")).toBeNull();
  });

  // Operator 2026-10-31 (plan clipboard:d8nCNBw2mzDK): what was opened stays open after a reload or a dock close, per device.
  it("keeps the Goals view, the open cards and their work histories after a remount, and forgets goals that are gone", async () => {
    serve();
    render(<NousDock canRun />);
    fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Goals\s*2$/ }));
    const first = expand(await screen.findByRole("article", { name: "Sell 100 SpaceApp licences by December" }));
    fireEvent.click(within(first).getByText("Work history"));
    await waitFor(() => expect((within(first).getByText("Work history · 4").closest("details") as HTMLDetailsElement).open).toBe(true));
    cleanup();
    render(<NousDock canRun />);
    const again = await screen.findByRole("article", { name: "Sell 100 SpaceApp licences by December" });
    expect(head(again).getAttribute("aria-expanded")).toBe("true");
    expect((within(again).getByText(/^Work history/).closest("details") as HTMLDetailsElement).open).toBe(true);
    expect(head(screen.getByRole("article", { name: "Get the Job Copilot an interview a week" })).getAttribute("aria-expanded")).toBe("false");
    cleanup();
    vi.unstubAllGlobals();
    serve({ view: { ...view(), goals: [goal("nous_goal:jobs00000001", "Get the Job Copilot an interview a week")] } });
    render(<NousDock canRun />);
    await screen.findByRole("article", { name: "Get the Job Copilot an interview a week" });
    await waitFor(() => expect(localStorage.getItem("space.nous.ui.goals.open")).toBe("[]"));
    expect(localStorage.getItem("space.nous.ui.goals.history")).toBe("[]");
  });

  // Operator 1/11 03:35 BKK «ανα goal να δω ιστορικό εργασιών» (plan clipboard:jNDx8l-vMEl9): what was done, whole, by kind, older pages, links.
  it("shows a goal's work history when opened: whole entries newest first, kind filters with counts, Load earlier, and links to the pane and the plan", async () => {
    const calls = serve();
    const focus: NousFocusDetail[] = [];
    const onFocus = (event: Event) => focus.push((event as CustomEvent<NousFocusDetail>).detail);
    window.addEventListener(NOUS_FOCUS_EVENT, onFocus);
    try {
      render(<NousDock canRun />);
      fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Goals\s*2$/ }));
      const card = expand(await screen.findByRole("article", { name: "Sell 100 SpaceApp licences by December" }));
      // Nothing is read until the history is opened.
      expect(calls.some((call) => call.url.includes("/history"))).toBe(false);
      fireEvent.click(within(card).getByText("Work history"));
      expect(await within(card).findByText("3 goal turns, no new work")).toBeTruthy();
      expect(within(card).getByText("Build the pricing page with the three plans, then show me the previews.")).toBeTruthy();
      expect(within(card).getByText("Work history · 4")).toBeTruthy();
      const chips = within(card).getByRole("group", { name: "Show in the work history" });
      expect(within(chips).getAllByRole("button").map((button) => button.textContent)).toEqual(["All4", "Turn2", "Brief1", "Report1"]);
      fireEvent.click(within(card).getByRole("button", { name: "Load earlier" }));
      expect(await within(card).findByText("Moved: the brief went to Oscar.")).toBeTruthy();
      expect(calls.some((call) => call.url === `/api/nous/goals/nous_goal%3Asell00000001/history?before=${encodeURIComponent(report.at)}`)).toBe(true);
      expect(within(card).queryByRole("button", { name: "Load earlier" })).toBeNull();
      fireEvent.click(within(chips).getByRole("button", { name: /^Brief/ }));
      await waitFor(() => expect(within(card).queryByText("3 goal turns, no new work")).toBeNull());
      expect(calls.some((call) => call.url.endsWith("/history?kind=BRIEF"))).toBe(true);
      fireEvent.click(within(card).getByRole("button", { name: "Open Oscar" }));
      expect(focus).toEqual([{ roomId: "room:alex00001", paneId: "pane:oscar00001", immediate: true }]);
      fireEvent.click(within(chips).getByRole("button", { name: /^All/ }));
      fireEvent.click(await within(card).findByRole("button", { name: "Open plan" }));
      expect((window.history.state as { nousPlan?: string } | null)?.nousPlan).toBe("clipboard:plan00000001");
    } finally {
      window.removeEventListener(NOUS_FOCUS_EVENT, onFocus);
    }
  });

  it("falls back to the conversation when the stored view is corrupt or unknown", async () => {
    serve();
    for (const stored of ["{not json", "\"nowhere\""]) {
      localStorage.setItem("space.nous.ui.tab", stored);
      render(<NousDock canRun />);
      expect(await screen.findByRole("textbox", { name: "Message Nous" })).toBeTruthy();
      cleanup();
    }
  });

  it("shows only a goal's first line in its collapsed row", async () => {
    serve({ view: { ...view(), goals: [goal("nous_goal:multi0000001", "Ship the installer\nThen write the release notes")] } });
    render(<NousDock canRun />);
    fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Goals\s*2$/ }));
    const card = await screen.findByRole("article", { name: "Ship the installer\nThen write the release notes" });
    expect(within(card).getByText("Ship the installer")).toBeTruthy();
    expect(within(card).queryByText(/Then write the release notes/)).toBeNull();
    expand(card);
    expect(within(card).getByRole("heading", { name: /Then write the release notes/ })).toBeTruthy();
  });

  it("adds, edits, reorders, pauses, drops and deletes goals from the view, each through its own request", async () => {
    const calls = serve();
    render(<NousDock canRun />);
    fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: /^Goals\s*2$/ }));
    const box = await screen.findByRole("textbox", { name: "New goal" });
    fireEvent.change(box, { target: { value: "Reach 1,000 GitHub stars" } });
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/goals" && call.method === "POST")?.body).toEqual({ text: "Reach 1,000 GitHub stars" }));
    await screen.findByRole("article", { name: "Reach 1,000 GitHub stars" });
    const first = expand(screen.getByRole("article", { name: "Sell 100 SpaceApp licences by December" }));
    fireEvent.click(within(first).getByRole("button", { name: "Edit the goal" }));
    fireEvent.change(within(first).getByRole("textbox", { name: "Goal text" }), { target: { value: "Sell 200 SpaceApp licences by December" } });
    fireEvent.click(within(first).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/goals/nous_goal%3Asell00000001" && call.method === "PATCH")?.body).toEqual({ text: "Sell 200 SpaceApp licences by December" }));
    fireEvent.click(within(first).getByRole("button", { name: "Move down" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/goals/reorder")?.body).toEqual({ ids: ["nous_goal:jobs00000001", "nous_goal:sell00000001", "nous_goal:new000000001"] }));
    fireEvent.click(within(first).getByRole("button", { name: "Pause the goal" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ status: "PAUSED" }));
    expect(head(first).getAttribute("aria-expanded")).toBe("true");
    const second = expand(screen.getByRole("article", { name: "Get the Job Copilot an interview a week" }));
    fireEvent.click(within(second).getByRole("button", { name: "Drop the goal" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)).toMatchObject({ url: "/api/nous/goals/nous_goal%3Ajobs00000001", body: { status: "DROPPED" } }));
    fireEvent.click(within(second).getByRole("button", { name: "Delete the goal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.some((call) => call.url === "/api/nous/goals/nous_goal%3Ajobs00000001" && call.method === "DELETE")).toBe(true));
  });

  it("opens the Goals view on /goals or /goal alone without a request, and sends /goal <text> to Nous then opens the view", async () => {
    const calls = serve();
    render(<NousDock canRun />);
    const field = await screen.findByRole("textbox", { name: "Message Nous" });
    fireEvent.change(field, { target: { value: "/goals" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByRole("textbox", { name: "New goal" });
    expect(calls.some((call) => call.url === "/api/nous/messages" && call.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    const again = await screen.findByRole("textbox", { name: "Message Nous" });
    fireEvent.change(again, { target: { value: "/goal Sell 100 licences" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/messages" && call.method === "POST")?.body).toMatchObject({ content: "/goal Sell 100 licences" }));
    await screen.findByRole("textbox", { name: "New goal" });
  });

  it("holds the loop's switch and numbers in Settings and saves them whole", async () => {
    const calls = serve();
    render(<NousSettingsCard />);
    const loop = await screen.findByRole("switch", { name: "Nous goal loop" });
    await waitFor(() => expect((loop as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(loop);
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/settings")?.body).toEqual({ goals: { loop: false, gapSeconds: 600, backoffMinutes: 30, backoffMaxMinutes: 120, unchangedTurns: 2 } }));
    const gap = screen.getByRole("spinbutton", { name: "Gap between goal turns (seconds)" });
    fireEvent.change(gap, { target: { value: "5" } });
    fireEvent.blur(gap);
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/nous/settings").at(-1)?.body).toEqual({ goals: { loop: false, gapSeconds: 10, backoffMinutes: 30, backoffMaxMinutes: 120, unchangedTurns: 2 } }));
    expect(screen.getByRole("combobox", { name: "Nous model for goal turns" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Nous effort for goal turns" }) as HTMLSelectElement).value).toBe("high");
  });
});
