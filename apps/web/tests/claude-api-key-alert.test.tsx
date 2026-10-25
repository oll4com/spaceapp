import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GatewayClaudeApiKeyUse } from "@space/contracts";
import {
  CLAUDE_API_KEY_ALERT_STORAGE_KEY, claudeApiKeyAlertText, judgeClaudeApiKeyUse, raiseClaudeApiKeyAlert, readAnnouncedUse,
  useClaudeApiKeyFallbackWatch, writeAnnouncedUse
} from "../src/features/toolbar-metrics/claude-api-key-alert.js";
import { ALARM_LOG_STORAGE_KEY, getAlarmLogs } from "../src/features/desktop-widgets/alarm-log-service.js";

vi.mock("../src/features/desktop-widgets/audio-chime.js", () => ({ playChime: vi.fn() }));
import { playChime } from "../src/features/desktop-widgets/audio-chime.js";

const nowMs = Date.parse("2026-10-13T09:00:00.000Z");
const at = (minutes: number) => new Date(nowMs + minutes * 60_000).toISOString();
const use = (lastUsedAt: string | null, requests = lastUsedAt ? 2 : 0): GatewayClaudeApiKeyUse => ({
  fallbackEnabled: true, checkedAt: at(0),
  account: { id: `gw_account:${"d".repeat(32)}`, label: "Claude API key …kkkk", status: "ACTIVE", createdAt: at(-600), lastUsedAt, requests, costUsd: requests * 0.21 }
});

beforeEach(() => {
  localStorage.removeItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY);
  localStorage.removeItem(ALARM_LOG_STORAGE_KEY);
  vi.mocked(playChime).mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("judgeClaudeApiKeyUse", () => {
  it("announces a use once: new uses alert, announced or older ones stay quiet", () => {
    expect(judgeClaudeApiKeyUse(use(null), null, nowMs)).toEqual({ alert: false, announcedAt: null });
    expect(judgeClaudeApiKeyUse(null, at(-5), nowMs)).toEqual({ alert: false, announcedAt: at(-5) });
    expect(judgeClaudeApiKeyUse(use(at(-5)), null, nowMs)).toEqual({ alert: true, announcedAt: at(-5) });
    expect(judgeClaudeApiKeyUse(use(at(-5)), at(-5), nowMs)).toEqual({ alert: false, announcedAt: at(-5) });
    expect(judgeClaudeApiKeyUse(use(at(-5)), at(-3), nowMs)).toEqual({ alert: false, announcedAt: at(-3) });
    expect(judgeClaudeApiKeyUse(use(at(-1)), at(-5), nowMs)).toEqual({ alert: true, announcedAt: at(-1) });
    // A fresh browser learns of an old use without ringing, but remembers it.
    expect(judgeClaudeApiKeyUse(use(at(-25 * 60)), null, nowMs)).toEqual({ alert: false, announcedAt: at(-25 * 60) });
    expect(judgeClaudeApiKeyUse(use(at(-23 * 60)), null, nowMs)).toEqual({ alert: true, announcedAt: at(-23 * 60) });
  });

  it("keeps the announced use in storage and ignores junk", () => {
    expect(readAnnouncedUse()).toBeNull();
    writeAnnouncedUse(at(-2));
    expect(readAnnouncedUse()).toBe(at(-2));
    localStorage.setItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY, "not a date");
    expect(readAnnouncedUse()).toBeNull();
    writeAnnouncedUse(null);
    expect(localStorage.getItem(CLAUDE_API_KEY_ALERT_STORAGE_KEY)).toBeNull();
  });

  it("writes the banner text and raises a chime, an alarm log entry and a notification when allowed", () => {
    expect(claudeApiKeyAlertText(use(at(-7), 3), nowMs))
      .toBe("Claude API key in use: Space Gateway sent 3 requests through the paid key ($0.63), last 7m ago. Every Claude account was out of quota; the accounts take over again at their reset.");
    expect(claudeApiKeyAlertText(use(at(0), 1), nowMs)).toMatch(/^Claude API key in use: Space Gateway sent 1 request through the paid key \(\$0\.21\), last just now\./);
    const notifications: Array<{ title: string; options?: NotificationOptions }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      constructor(title: string, options?: NotificationOptions) { notifications.push({ title, options }); }
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.useFakeTimers();
    raiseClaudeApiKeyAlert(use(at(-7), 3), { nowMs });
    vi.advanceTimersByTime(2500);
    expect(vi.mocked(playChime)).toHaveBeenCalledTimes(3);
    expect(getAlarmLogs()).toHaveLength(1);
    expect(getAlarmLogs()[0]).toMatchObject({ triggerSource: "claude_api_key_fallback", provider: "claude" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Claude API key in use");
    vi.unstubAllGlobals();
  });
});

function Probe({ load }: { load: () => Promise<GatewayClaudeApiKeyUse> }) {
  const watch = useClaudeApiKeyFallbackWatch({ enabled: true, load, pollMs: 1000, now: () => nowMs });
  return <div>
    <span data-testid="requests">{watch.use?.account?.requests ?? "none"}</span>
    {watch.banner ? <p role="alert">{claudeApiKeyAlertText(watch.banner, nowMs)}</p> : null}
    <button type="button" onClick={watch.dismiss}>Dismiss</button>
  </div>;
}

describe("useClaudeApiKeyFallbackWatch", () => {
  it("polls, alerts once per new use and keeps the banner until dismissed", async () => {
    let current = use(null);
    const load = vi.fn(async () => current);
    render(<Probe load={load} />);
    await waitFor(() => expect(screen.getByTestId("requests").textContent).toBe("0"));
    expect(screen.queryByRole("alert")).toBeNull();
    current = use(at(-1), 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/sent 1 request through the paid key/));
    expect(readAnnouncedUse()).toBe(at(-1));
    expect(getAlarmLogs()).toHaveLength(1);
    // The same use again: no second alarm.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(getAlarmLogs()).toHaveLength(1);
    screen.getByRole("button", { name: "Dismiss" }).click();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    // A later use rings again.
    current = use(at(0), 2);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    await waitFor(() => expect(getAlarmLogs()).toHaveLength(2));
    expect(screen.getByRole("alert").textContent).toMatch(/sent 2 requests/);
  });
});
