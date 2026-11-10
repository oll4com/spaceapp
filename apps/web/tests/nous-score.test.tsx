import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NousScore as NousScoreView, NousScoreTile } from "@space/contracts";
import { NousScore, scoreRows } from "../src/features/nous/NousScore.js";
import { NOUS_SCORE_POLL_MS } from "../src/features/nous/nous-score-query.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

// Score, compact (operator 5/11 10:36 BKK «the lowest possible usage but with the best results»): one sorted list, and reads only while the
// tab is shown, the page visible and the window focused, every 5 minutes; the history only when a newer score (snapshot) arrives.
const tile = (key: NousScoreTile["key"], points: number): NousScoreTile => ({ key, label: key, points, detail: `${key} detail`, items: [] });

it("lists costs first by their share of the negative, then what gives points, then zeros", () => {
  const rows = scoreRows([tile("done", 8), tile("panes", -10), tile("utilization", 0), tile("plans", -30), tile("completed", 20)]);
  expect(rows.map((row) => [row.key, row.share])).toEqual([["plans", 75], ["panes", 25], ["completed", null], ["done", null], ["utilization", null]]);
});

let at = "2026-11-05T03:00:00.000Z";
let focused = true;
function serve() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/nous/score")) urls.push(url);
    if (url.startsWith("/api/nous/score/history")) return Response.json({ range: "24h", points: [{ at, value: -40 }] });
    if (url.startsWith("/api/nous/score")) return Response.json({ at, score: -40, change24h: -4, change7d: null, tiles: [tile("plans", -40)] } satisfies Partial<NousScoreView>);
    return Response.json({});
  }));
  return urls;
}
const scores = (urls: string[]) => urls.filter((url) => url === "/api/nous/score").length;
const histories = (urls: string[]) => urls.filter((url) => url.startsWith("/api/nous/score/history")).length;
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => {
  installSpaceRuntime(liveRuntime); localStorage.clear();
  at = "2026-11-05T03:00:00.000Z"; focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reads the score every 5 minutes only while focused, and the history only when a newer score arrives", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const urls = serve();
  render(<QueryClientProvider client={new QueryClient()}><NousScore active /></QueryClientProvider>);
  await waitFor(() => expect([scores(urls), histories(urls)]).toEqual([1, 1]));
  // The same snapshot: the score is read again, the history is not.
  await wait(NOUS_SCORE_POLL_MS - 1_000);
  expect(scores(urls)).toBe(1);
  await wait(1_000);
  await waitFor(() => expect(scores(urls)).toBe(2));
  expect(histories(urls)).toBe(1);
  // A newer snapshot brings the history with it.
  at = "2026-11-05T03:15:00.000Z";
  await wait(NOUS_SCORE_POLL_MS);
  await waitFor(() => expect([scores(urls), histories(urls)]).toEqual([3, 2]));
  // Behind another window: nothing is read.
  focused = false;
  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await wait(3 * NOUS_SCORE_POLL_MS);
  expect([scores(urls), histories(urls)]).toEqual([3, 2]);
  focused = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await wait(NOUS_SCORE_POLL_MS);
  await waitFor(() => expect(scores(urls)).toBe(4));
});

it("reads nothing while the dock is not shown", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const urls = serve();
  render(<QueryClientProvider client={new QueryClient()}><NousScore active={false} /></QueryClientProvider>);
  await wait(3 * NOUS_SCORE_POLL_MS);
  expect(urls).toEqual([]);
});
