import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NousLoad as NousLoadView } from "@space/contracts";
import { NousLoad } from "../src/features/nous/NousLoad.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Load (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server and token capacity in use, a graph with no numbers on
// it and the numbers beside it; the last answer shows at once from localStorage, then GET /api/nous/load refreshes it every 10 s while open.
const view = (overall: number, extra: Partial<NousLoadView> = {}): NousLoadView => ({ at: "2026-10-31T07:00:00.000Z", overall, target: 90, level: "CALM", limit: null, range: "1h",
  parts: [{ key: "cpu", label: "CPU", percent: 31.5, detail: "16 cores" }, { key: "tokens", label: "Tokens", percent: null, detail: "no Gateway sample" }],
  series: [{ at: "2026-10-31T06:59:50.000Z", value: overall - 2 }, { at: "2026-10-31T07:00:00.000Z", value: overall }],
  averages: { hour: { value: 41, previous: 44 }, today: { value: 38, previous: 30 }, week: { value: 35.2, previous: 35 }, month: { value: null, previous: null }, bestDay: { day: "2026-10-30", value: 52 } },
  ...extra });

function serve(answer: (url: string) => NousLoadView, settings: object = {}) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/nous/load")) return Response.json(url.startsWith("/api/user-settings") ? settings : {});
    urls.push(url);
    return Response.json(answer(url));
  }));
  return urls;
}

beforeEach(() => { installSpaceRuntime(liveRuntime); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the cached answer at once, then the fresh one with its parts, averages and trends beside a graph without numbers", async () => {
  localStorage.setItem("space.nous.load.v1:1h", JSON.stringify(view(12)));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => { await gate; return Response.json(view(42)); }));
  render(<NousLoad active />);
  expect(screen.getByRole("img", { name: /12% now, target 90%/ })).toBeTruthy();
  release();
  expect(await screen.findByRole("img", { name: /over the last hour; 42% now, target 90%/ })).toBeTruthy();
  expect(screen.getByText("48% headroom to use")).toBeTruthy();
  const parts = screen.getByRole("list", { name: "Parts" });
  expect(within(parts).getByText("32%")).toBeTruthy();
  expect(within(parts).getByText("–")).toBeTruthy();
  const averages = screen.getByLabelText("Averages");
  expect(within(averages).getByLabelText("up 8 points from yesterday").textContent).toBe("▲ 8");
  expect(within(averages).getByLabelText("down 3 points from the hour before").textContent).toBe("▼ 3");
  expect(within(averages).getByLabelText("about the same as the 7 days before")).toBeTruthy();
  expect(screen.getByText("Best day 2026-10-30: 52%")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("space.nous.load.v1:1h")!).overall).toBe(42);
  // The graph draws no text: it is one canvas, named for screen readers.
  expect(document.querySelectorAll(".nous-load-graph > *")).toHaveLength(1);
  expect(document.querySelector(".nous-load-graph canvas")).toBeTruthy();
});

it("shows the Load target of the spend mode in force (Settings → Nous → Low-spend mode, 13/11)", async () => {
  serve(() => view(42, { target: 80, targetMode: "NORMAL" }));
  render(<NousLoad active />);
  expect(await screen.findByText("of capacity in use · target 80% · NORMAL")).toBeTruthy();
  expect(screen.getByText("38% headroom to use")).toBeTruthy();
});

it("names the hard limit instead of the headroom", async () => {
  serve(() => view(100, { level: "OVERLOADED", limit: "server OVERLOADED (CPU 95%)" }));
  render(<NousLoad active />);
  expect(await screen.findByText("At a limit: server OVERLOADED (CPU 95%)")).toBeTruthy();
});

it("reads every 10 s only while the tab is open, and reads the range chosen", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const urls = serve((url) => view(40, { range: url.endsWith("24h") ? "24h" : "1h" }));
  const { rerender } = render(<NousLoad active />);
  await waitFor(() => expect(urls).toEqual(["/api/nous/load?range=1h"]));
  await act(async () => { vi.advanceTimersByTime(10_000); });
  await waitFor(() => expect(urls).toHaveLength(2));
  fireEvent.click(await screen.findByRole("button", { name: "24 h" }));
  await waitFor(() => expect(urls.at(-1)).toBe("/api/nous/load?range=24h"));
  rerender(<NousLoad active={false} />);
  const count = urls.length;
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(urls).toHaveLength(count);
});

// History period (plan clipboard:8riKjb1krKyL): no range longer than the owner's period is offered.
it("offers no range longer than the History period", async () => {
  serve(() => view(40), { history: { periodDays: 7 } });
  render(<NousLoad active />);
  await screen.findByRole("button", { name: "7 days" });
  await waitFor(() => expect(screen.queryByRole("button", { name: "30 days" })).toBeNull());
});

it("lists each linked SpaceApp's load with the average over all, and keeps a stale reading for one that stops answering (Space Link Λ7)", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let answering = true;
  const link = { id: "link:b", label: "SpaceApp vm207", origins: ["https://vm207.example"], deviceId: "appdev:b", scopes: ["read"], createdAt: "2026-11-13T01:00:00.000Z", lastSeenAt: null, connected: true };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/instance-links/load")) return Response.json({ instances: [{ link, load: answering ? view(70) : null, error: answering ? null : "It did not answer." }] });
    return Response.json(url.startsWith("/api/nous/load") ? view(40) : {});
  }));
  render(<NousLoad active />);
  const linked = await screen.findByRole("region", { name: "Linked SpaceApps" });
  expect(linked.textContent).toContain("55% average over this SpaceApp and 1 linked");
  expect(within(linked).getByText("SpaceApp vm207")).toBeTruthy();
  answering = false;
  await act(async () => { vi.advanceTimersByTime(30_000); });
  await waitFor(() => expect(linked.textContent).toContain("70% at"));
  expect(linked.textContent).toContain("stale: It did not answer.");
  expect(linked.textContent).toContain("40% average over this SpaceApp and 1 linked");
});
