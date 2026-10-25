import { expect, it } from "vitest";
import { browserReconnectDelayMs } from "../src/features/browser-pane/browser-reconnect.js";

it("browser socket reconnects back off to a minute instead of retrying every 2 s forever", () => {
  // Stream: the first four retries keep their old 250 ms..2 s pace, then double to the cap.
  expect([0, 1, 2, 3, 4, 7, 8, 30].map((attempt) => browserReconnectDelayMs(attempt, 250))).toEqual([250, 500, 1000, 2000, 4000, 32_000, 60_000, 60_000]);
  // Audio: the first retry stays at 2 s.
  expect([0, 1, 4, 5, 99].map((attempt) => browserReconnectDelayMs(attempt, 2000))).toEqual([2000, 4000, 32_000, 60_000, 60_000]);
  expect(browserReconnectDelayMs(-1, 2000)).toBe(2000);
});
