import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nousGoalsSettingsSchema, nousLowSpendSettingsSchema, nousModelsSettingsSchema, nousPaneBoardSettingsSchema, nousStandingOrdersSettingsSchema, type NousOperatorRequest, type NousState } from "@space/contracts";
import { NousDock } from "../src/features/nous/NousDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Requests (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): every message the operator sent Nous, newest first, one under the other, each
// with whether Nous completed it; Done shows its summary, a plan opens, earlier pages load.
const state: NousState = { status: "IDLE", settings: { enabled: true, maxTurnsPerHour: 20, lowTokenAutomatic: true, lowSpend: nousLowSpendSettingsSchema.parse({}), mayPromote: false,
  mayApproveWarm: false, maySecurityHotfix: false, askOwnHostChanges: false, maySend: false, mayDeleteOwn: false, mayPublish: false, mayRestartHosts: false, neverRefuse: false, shell: false, alwaysApprove: [],
  paneBoard: nousPaneBoardSettingsSchema.parse({}), standingOrders: nousStandingOrdersSettingsSchema.parse({}), models: nousModelsSettingsSchema.parse({}), fallbackModel: "none",
  telegramInbound: false, copilotQuestionsNousFirst: true, goals: nousGoalsSettingsSchema.parse({}) }, model: "gpt-6-astra", effort: "high", running: null, turnsThisHour: 0,
  lastError: null, openDecisions: 0, inbox: 0 };
const request = (n: number, text: string, patch: Partial<NousOperatorRequest>): NousOperatorRequest => ({ messageId: `nous_msg:req00000000${n}`, createdAt: `2026-10-31T0${n}:00:00.000Z`, text, status: "ANSWERED", ...patch });
const latest = [
  request(5, "Πρόσθεσε ένα tab με τα μηνύματά μου", { status: "DONE", doneSummary: "Το tab Requests δείχνει κάθε μήνυμα.", where: "stable", tickets: ["q-20261031-030000-abcd"] }),
  request(4, "Ξεκίνα το plan", { status: "IN_PROGRESS", planId: "clipboard:planReq00001", planPercent: 40 }),
  request(3, "Να το στείλω;", { status: "WAITS_FOR_YOU" })
];
const earlier = [request(2, "Τι ώρα είναι;", { status: "ANSWERED", answeredAt: "2026-10-31T02:01:00.000Z" }), request(1, "Μόλις τώρα", { status: "NOT_ANSWERED" })];
const counts = { DONE: 1, ANSWERED: 1, IN_PROGRESS: 14, WAITS_FOR_YOU: 1, NOT_DONE: 2, NOT_ANSWERED: 0 };
const plan = { id: "clipboard:planReq00001", text: "# Requests plan\n\nSteps.", source: "PLAN", title: "Requests plan", minimumModel: null, isCompleted: false, executionStatus: "IN_PROGRESS",
  progressPercentage: 40, activeAgent: null, lastProgressAt: null, roomId: null, paneId: null, paneTitle: null, occurrenceCount: 1, characterCount: 20, createdAt: "2026-10-31T04:00:00.000Z",
  lastUsedAt: "2026-10-31T04:00:00.000Z", steps: [] };

function serve() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/auth/csrf") return Response.json({ csrfToken: "csrf:nous", headerName: "x-space-csrf-token" });
    if (url === "/api/nous") return Response.json({ state });
    if (url.startsWith("/api/nous/messages")) return Response.json({ messages: [], waiting: [], attachments: {}, hasMore: false });
    if (url === "/api/nous/decisions") return Response.json({ decisions: [] });
    if (url === "/api/nous/requests") return Response.json({ requests: latest, hasMore: true, counts });
    if (url === "/api/nous/requests?status=IN_PROGRESS") return Response.json({ requests: [latest[1]], hasMore: false, counts });
    if (url === "/api/nous/requests?status=IN_PROGRESS&q=azure+%CE%B1%CE%B9%CF%84%CE%B7%CE%BC%CE%B1%CF%84%CE%B1") return Response.json({ requests: [latest[1]], hasMore: false, counts: { ...counts, IN_PROGRESS: 1 } });
    if (url === "/api/nous/requests?status=IN_PROGRESS&q=zzz") return Response.json({ requests: [], hasMore: false, counts: { ...counts, IN_PROGRESS: 0 } });
    if (url === "/api/nous/requests?status=NOT_ANSWERED") return Response.json({ requests: [], hasMore: false, counts });
    if (url === `/api/nous/requests?before=${encodeURIComponent(latest[2]!.messageId)}`) return Response.json({ requests: earlier, hasMore: false });
    if (url.startsWith("/api/clipboard-items?")) return Response.json({ data: [plan], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
    if (url === "/api/nous/shared-files") return Response.json([]);
    if (url.startsWith("/api/notifications")) return Response.json({ notifications: [], total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] });
    return Response.json({});
  }));
  return calls;
}

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lists every request newest first with its status, shows what was done, opens the plan and loads earlier requests", async () => {
  const calls = serve();
  render(<NousDock canRun />);
  fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: "Requests" }));
  const rows = async () => (await screen.findAllByRole("article")).map((row) => [row.getAttribute("aria-label"), row.querySelector(".nous-request-status")?.textContent]);
  expect(await rows()).toEqual([["Πρόσθεσε ένα tab με τα μηνύματά μου", "Done"], ["Ξεκίνα το plan", "In progress · 40%"], ["Να το στείλω;", "Waits for you"]]);
  const done = screen.getByRole("article", { name: "Πρόσθεσε ένα tab με τα μηνύματά μου" });
  fireEvent.click(within(done).getByText("What was done"));
  await waitFor(() => expect((within(done).getByText("What was done").closest("details") as HTMLDetailsElement).open).toBe(true));
  expect(within(done).getByText("Το tab Requests δείχνει κάθε μήνυμα.")).toBeTruthy();
  expect(within(done).getByText("Live on stable · q-20261031-030000-abcd")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Load earlier requests" }));
  await waitFor(async () => expect((await rows()).slice(3)).toEqual([["Τι ώρα είναι;", "Answered"], ["Μόλις τώρα", "Not answered yet"]]));
  expect(screen.queryByRole("button", { name: "Load earlier requests" })).toBeNull();
  expect(calls).toContain(`/api/nous/requests?before=${encodeURIComponent(latest[2]!.messageId)}`);

  fireEvent.click(within(screen.getByRole("article", { name: "Ξεκίνα το plan" })).getByRole("button", { name: "Open plan · 40%" }));
  expect(await within(await screen.findByRole("region", { name: "Plan" })).findByRole("article", { name: "Plan: Requests plan" })).toBeTruthy();
});

it("keeps a request's opened summary open after the dock reopens", async () => {
  serve();
  const { unmount } = render(<NousDock canRun />);
  fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: "Requests" }));
  const summary = await screen.findByText("What was done");
  fireEvent.click(summary);
  await waitFor(() => expect(localStorage.getItem("space.nous.ui.requests.done")).toBe(JSON.stringify([latest[0]!.messageId])));
  unmount();
  render(<NousDock canRun />);
  expect(((await screen.findByText("What was done")).closest("details") as HTMLDetailsElement).open).toBe(true);
});

// Operator 31/10 13:03 BKK: a status filter, each with how many there are over every request.
it("filters by status and shows each status's count", async () => {
  const calls = serve();
  render(<NousDock canRun />);
  fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: "Requests" }));
  const filter = await screen.findByRole("combobox", { name: "Status" });
  await waitFor(() => expect(within(filter).getAllByRole("option").map((option) => option.textContent))
    .toEqual(["All (19)", "Done (1)", "Answered (1)", "In progress (14)", "Waits for you (1)", "Not done (2)", "Not answered yet (0)"]));
  fireEvent.change(filter, { target: { value: "IN_PROGRESS" } });
  await waitFor(async () => expect((await screen.findAllByRole("article")).map((row) => row.getAttribute("aria-label"))).toEqual(["Ξεκίνα το plan"]));
  expect(calls).toContain("/api/nous/requests?status=IN_PROGRESS");
  expect(screen.queryByRole("button", { name: "Load earlier requests" })).toBeNull();
  fireEvent.change(filter, { target: { value: "NOT_ANSWERED" } });
  expect(await screen.findByText("No requests: Not answered yet")).toBeTruthy();
});

// Operator 6/11 13:02 BKK (nous_msg:82daac31): keywords search every request on the server together with the status he picked; the counts follow the search.
it("searches requests by keywords with the status filter and clears the search", async () => {
  const calls = serve();
  render(<NousDock canRun />);
  fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: "Requests" }));
  const filter = await screen.findByRole("combobox", { name: "Status" });
  fireEvent.change(filter, { target: { value: "IN_PROGRESS" } });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search requests" }), { target: { value: " azure αιτηματα " } });
  await waitFor(() => expect(within(filter).getByRole("option", { name: "In progress (1)" })).toBeTruthy());
  expect((await screen.findAllByRole("article")).map((row) => row.getAttribute("aria-label"))).toEqual(["Ξεκίνα το plan"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search requests" }), { target: { value: "zzz" } });
  expect(await screen.findByText("No requests match “zzz”")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await waitFor(() => expect(calls.at(-1)).toBe("/api/nous/requests?status=IN_PROGRESS"));
  expect(calls.filter((url) => url.includes("q="))).toEqual(["/api/nous/requests?status=IN_PROGRESS&q=azure+%CE%B1%CE%B9%CF%84%CE%B7%CE%BC%CE%B1%CF%84%CE%B1", "/api/nous/requests?status=IN_PROGRESS&q=zzz"]);
});

// Operator 3/11 12:51 BKK (nous_msg:40a252b1): the status he picked stays after the dock closes and opens again, kept per signed-in user.
it("keeps the status filter after the dock reopens", async () => {
  serve();
  const { unmount } = render(<NousDock canRun />);
  fireEvent.click(await within(screen.getByRole("group", { name: "Nous views" })).findByRole("button", { name: "Requests" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "Status" }), { target: { value: "IN_PROGRESS" } });
  await waitFor(async () => expect((await screen.findAllByRole("article")).map((row) => row.getAttribute("aria-label"))).toEqual(["Ξεκίνα το plan"]));
  unmount();
  render(<NousDock canRun />);
  expect((await screen.findByRole("combobox", { name: "Status" }) as HTMLSelectElement).value).toBe("IN_PROGRESS");
  await waitFor(async () => expect((await screen.findAllByRole("article")).map((row) => row.getAttribute("aria-label"))).toEqual(["Ξεκίνα το plan"]));
});
