import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nousGoalsSettingsSchema, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousStandingOrdersSettingsSchema, type NousGoalsView, type NousState } from "@space/contracts";
import { NousDock } from "../src/features/nous/NousDock.js";
import { NousSettingsCard } from "../src/features/nous/NousSettingsCard.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the Goals tab with the ACTIVE count (the composer's copy of it
// left the same day: no option twice), the Goals view (add, edit, reorder, pause, drop, delete), /goal and /goals in the composer, and the loop's Settings rows.
const at = "2026-10-27T08:00:00.000Z";
const settings = (patch: Partial<NousState["settings"]> = {}): NousState["settings"] => ({
  enabled: true, maxTurnsPerHour: 20, lowTokenAutomatic: true, lowSpend: nousLowSpendSettingsSchema.parse({}), mayPromote: false, mayApproveWarm: false, maySecurityHotfix: false, shell: false,
  alwaysApprove: [], paneBoard: nousPaneBoardSettingsSchema.parse({}), standingOrders: nousStandingOrdersSettingsSchema.parse({}), models: nousModelsSettingsSchema.parse({}), fallbackModel: "none",
  telegramInbound: false, copilotQuestionsNousFirst: true, goals: nousGoalsSettingsSchema.parse({}), ...patch
});
const state = (patch: Partial<NousState> = {}): NousState => ({ status: "IDLE", settings: settings(), model: "claude-fable-5-1", effort: "max", running: null, turnsThisHour: 0, lastError: null, openDecisions: 0, inbox: 0,
  goals: { active: 2, nextAt: "2026-10-27T08:01:00.000Z", held: null }, ...patch });
const goal = (id: string, text: string, patch: Partial<NousGoalsView["goals"][number]> = {}): NousGoalsView["goals"][number] => ({
  id, ownerUserId: "user:operator", text, status: "ACTIVE", priority: 1, progress: 0, criteria: null, planIds: [], waitsOn: null, note: null, evidence: null, lastWorkedAt: null, nextTurnAt: null,
  fingerprint: null, unchangedTurns: 0, createdAt: at, updatedAt: at, achievedAt: null, cost: { today: { turns: 0, costUsd: 0, unpriced: 0 }, month: { turns: 0, costUsd: 0, unpriced: 0 } }, events: [], ...patch
});
const view = (): NousGoalsView => ({
  goals: [
    goal("nous_goal:sell00000001", "Sell 100 SpaceApp licences by December", { progress: 40, criteria: "100 paid licences in Stripe", planIds: ["clipboard:plan00000001"],
      waitsOn: { kind: "THIRD_PARTY", what: "Stripe's account review", until: null }, note: "Pricing page shipped.", lastWorkedAt: "2026-10-27T07:50:00.000Z", nextTurnAt: new Date(Date.now() + 15 * 60_000).toISOString(), unchangedTurns: 3,
      cost: { today: { turns: 4, costUsd: 2.5, unpriced: 0 }, month: { turns: 12, costUsd: 9.75, unpriced: 1 } },
      events: [{ id: "9", goalId: "nous_goal:sell00000001", at: "2026-10-27T07:52:00.000Z", kind: "TURN", text: "Moved: pricing page.", turnId: "nous_turn:a" }] }),
    goal("nous_goal:jobs00000001", "Get the Job Copilot an interview a week", { priority: 2 }),
    goal("nous_goal:done00000001", "Finish the Vault review", { priority: 3, status: "ACHIEVED", progress: 100, evidence: "Ticket q-1 deployed and verified.", achievedAt: at })
  ],
  loop: { on: true, running: null, nextAt: "2026-10-27T08:01:00.000Z", held: null }
});

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
    expect(within(first).getByText("100 paid licences in Stripe")).toBeTruthy();
    expect(within(first).getByText(/Stripe's account review/)).toBeTruthy();
    expect(within(first).getByText(/Pricing page shipped\./)).toBeTruthy();
    expect(within(first).getByText(/today \$2\.50 \(4 turns\) · this month \$9\.75 \(12 turns, 1 unpriced\)/)).toBeTruthy();
    expect(within(first).getByText(/nothing moved in 3 turns/)).toBeTruthy();
    await waitFor(() => expect(within(first).getByText(/Pricing page \(60%\)/)).toBeTruthy());
    expect(screen.getByText(/Goal loop on · next goal turn/)).toBeTruthy();
    const achieved = screen.getByRole("article", { name: "Finish the Vault review" });
    expect(within(achieved).getByText("Achieved")).toBeTruthy();
    expect(within(achieved).getByText(/Ticket q-1 deployed and verified\./)).toBeTruthy();
    expect(within(achieved).getByRole("button", { name: "Reopen the goal" })).toBeTruthy();
    expect(calls.some((call) => call.url === "/api/nous/goals" && call.method === "GET")).toBe(true);
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
    const first = screen.getByRole("article", { name: "Sell 100 SpaceApp licences by December" });
    fireEvent.click(within(first).getByRole("button", { name: "Edit the goal" }));
    fireEvent.change(within(first).getByRole("textbox", { name: "Goal text" }), { target: { value: "Sell 200 SpaceApp licences by December" } });
    fireEvent.click(within(first).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/goals/nous_goal%3Asell00000001" && call.method === "PATCH")?.body).toEqual({ text: "Sell 200 SpaceApp licences by December" }));
    fireEvent.click(within(first).getByRole("button", { name: "Move down" }));
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/goals/reorder")?.body).toEqual({ ids: ["nous_goal:jobs00000001", "nous_goal:sell00000001", "nous_goal:new000000001"] }));
    fireEvent.click(within(first).getByRole("button", { name: "Pause the goal" }));
    await waitFor(() => expect(calls.filter((call) => call.method === "PATCH").at(-1)?.body).toEqual({ status: "PAUSED" }));
    const second = screen.getByRole("article", { name: "Get the Job Copilot an interview a week" });
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
    await waitFor(() => expect(calls.find((call) => call.url === "/api/nous/settings")?.body).toEqual({ goals: { loop: false, gapSeconds: 60, backoffMinutes: 15, backoffMaxMinutes: 60, unchangedTurns: 3 } }));
    const gap = screen.getByRole("spinbutton", { name: "Gap between goal turns (seconds)" });
    fireEvent.change(gap, { target: { value: "5" } });
    fireEvent.blur(gap);
    await waitFor(() => expect(calls.filter((call) => call.url === "/api/nous/settings").at(-1)?.body).toEqual({ goals: { loop: false, gapSeconds: 10, backoffMinutes: 15, backoffMaxMinutes: 60, unchangedTurns: 3 } }));
    expect(screen.getByRole("combobox", { name: "Nous model for goal turns" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Nous effort for goal turns" }) as HTMLSelectElement).value).toBe("max");
  });
});
