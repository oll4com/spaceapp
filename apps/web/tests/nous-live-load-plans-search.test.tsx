import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NousOverview } from "@space/contracts";
import { NousLiveStats } from "../src/features/nous/NousLiveStats.js";
import { searchPlans } from "../src/features/nous/nous-search.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Operator 13/11 07:51 BKK (nous_msg:ceb66b0357124a2d8586e795): the Load in Live, and a search in the board's Plans.
const plans = [
  { title: "Σχέδιο φόρων", pane: "Andy", room: "Main", nextStep: "3. Υποβολή" },
  { title: "Dock search", pane: null, room: null, nextStep: "Ship the filter" },
  { title: "Nous load tile", pane: "Hugo", room: "Λογιστήριο", nextStep: null }
];

beforeEach(() => installSpaceRuntime(liveRuntime));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("finds plans by title, pane, room and next step, every word, ignoring case and Greek accents", () => {
  const titles = (query: string) => searchPlans(plans, query).map((plan) => plan.title);
  expect(titles("")).toEqual(plans.map((plan) => plan.title));
  expect(titles("σχεδιο")).toEqual(["Σχέδιο φόρων"]);
  expect(titles("ΦΟΡΩΝ")).toEqual(["Σχέδιο φόρων"]);
  expect(titles("φόρος")).toEqual([]);
  expect(titles("λογιστηριο")).toEqual(["Nous load tile"]);
  expect(titles("andy υποβολη")).toEqual(["Σχέδιο φόρων"]);
  expect(titles("SHIP")).toEqual(["Dock search"]);
  expect(titles("hugo ship")).toEqual([]);
});

it("shows the Load view's capacity in use and target as a Live tile that opens the Load view", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return Response.json(url.startsWith("/api/nous/load") ? { at: "2026-11-13T00:50:00.000Z", overall: 69.6, target: 90, level: "CALM", limit: null, range: "1h", parts: [], series: [],
      averages: { hour: { value: null, previous: null }, today: { value: null, previous: null }, week: { value: null, previous: null }, month: { value: null, previous: null }, bestDay: null } } : {});
  }));
  const open = vi.fn();
  const overview = { plans: [], needsHands: [], trains: "", planMap: "", live: { rooms: 2, agents: { running: 1, waiting: 0, idle: 1, total: 2 } } } as unknown as NousOverview;
  render(<NousLiveStats overview={overview} active onOpenLoad={open} />);
  const tile = await screen.findByRole("button", { name: "Open the Load view: 70% of capacity in use, target 90%" });
  expect(tile.textContent).toBe("70%");
  expect(within(tile.closest("div") as HTMLElement).getByText("target 90%")).toBeTruthy();
  expect(urls).toContain("/api/nous/load?range=1h");
  fireEvent.click(tile);
  expect(open).toHaveBeenCalledOnce();
});
