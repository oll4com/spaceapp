import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  recordAlarmEvent,
  getAlarmLogs,
  clearAlarmLogs,
  ALARM_LOG_STORAGE_KEY
} from "../src/features/desktop-widgets/alarm-log-service.js";
import { AlarmLogModal } from "../src/features/desktop-widgets/AlarmLogModal.js";

const readyEntry = {
  triggerSource: "quota_available_transition" as const,
  provider: "claude" as const,
  proOnly: false,
  availableCount: 1,
  totalCount: 6,
  availableAccounts: [{ title: "ntheo", provider: "Claude", fiveHourPercent: 71, weeklyPercent: 28 }],
  nextBack: { title: "lab", provider: "Claude", backAt: "2026-10-11T08:10:00.000Z" }
};

describe("Alarm Log Service and Modal", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("records an alarm event with timestamp and the ready accounts in localStorage", () => {
    const entry = recordAlarmEvent(readyEntry);
    expect(entry.id).toMatch(/^alarm_/);
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
    expect(entry.localTime).toBeTruthy();
    const logs = getAlarmLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ provider: "claude", availableCount: 1, totalCount: 6 });
    expect(logs[0]?.availableAccounts[0]).toMatchObject({ title: "ntheo", provider: "Claude" });
    expect(JSON.parse(localStorage.getItem(ALARM_LOG_STORAGE_KEY) ?? "[]")).toHaveLength(1);
  });

  it("keeps the newest events first and clears them cleanly", () => {
    recordAlarmEvent(readyEntry);
    recordAlarmEvent({ ...readyEntry, triggerSource: "manual_test" });
    expect(getAlarmLogs().map((log) => log.triggerSource)).toEqual(["manual_test", "quota_available_transition"]);
    clearAlarmLogs();
    expect(getAlarmLogs()).toEqual([]);
  });

  it("renders AlarmLogModal with the empty state and logged alarm cards", () => {
    const { rerender } = render(<AlarmLogModal isOpen={true} onClose={() => {}} />);
    expect(screen.getByText("No alarm events recorded yet.")).toBeTruthy();

    recordAlarmEvent(readyEntry);
    rerender(<AlarmLogModal isOpen={false} onClose={() => {}} />);
    rerender(<AlarmLogModal isOpen={true} onClose={() => {}} />);
    expect(screen.getByText("1 event")).toBeTruthy();
    expect(screen.getByText("Quota became available")).toBeTruthy();
    expect(screen.getByText("CLAUDE")).toBeTruthy();
    expect(screen.getByText("ntheo · Claude · 5h 71% · wk 28%")).toBeTruthy();
    expect(screen.getByText("lab")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Clear all recorded alarm events"));
    expect(screen.getByText("No alarm events recorded yet.")).toBeTruthy();
  });
});
