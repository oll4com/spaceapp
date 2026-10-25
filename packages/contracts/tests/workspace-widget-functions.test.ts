import { describe, expect, it } from "vitest";
import * as widgets from "../src/index.js";

describe("local workspace widget functions", () => {
  it("does not repeat an active movement alert and starts exactly at the countdown boundary", () => {
    const state = { remainingSeconds: 2, intervalMinutes: 15, isRunning: true, isAlertActive: false };
    expect(widgets.advanceWorkspaceMovementReminder(state)).toMatchObject({ remainingSeconds: 1, isAlertActive: false });
    expect(widgets.advanceWorkspaceMovementReminder({ ...state, remainingSeconds: 1 })).toMatchObject({ remainingSeconds: 900, isAlertActive: true, alertReason: "pushups" });
    expect(widgets.advanceWorkspaceMovementReminder({ ...state, isAlertActive: true })).toMatchObject({ remainingSeconds: 2, isAlertActive: true });
    expect(widgets.advanceWorkspaceMovementReminder({ ...state, isRunning: false })).toMatchObject({ remainingSeconds: 2, isAlertActive: false });
    // The widget passes the seconds left until its wall-clock deadline instead of counting ticks.
    expect(widgets.advanceWorkspaceMovementReminder(state, 0)).toMatchObject({ remainingSeconds: 900, isAlertActive: true });
    expect(widgets.advanceWorkspaceMovementReminder(state, 42)).toMatchObject({ remainingSeconds: 42, isAlertActive: false });
  });
  it("formats 24-hour and 12-hour clocks without losing midnight or seconds", () => {
    expect(widgets.formatWorkspaceClock(new Date(2026, 0, 1, 0, 5, 9), false)).toEqual({ hours: "12", minutes: "05", seconds: "09", ampm: "AM" });
    expect(widgets.formatWorkspaceClock(new Date(2026, 0, 1, 13, 5, 9), true)).toEqual({ hours: "13", minutes: "05", seconds: "09", ampm: "" });
  });
  it("keeps paused countdowns stable and completes a running countdown at zero", () => {
    expect(widgets.advanceWorkspaceCountdown({ remainingSeconds: 2, isRunning: false })).toEqual({ remainingSeconds: 2, isRunning: false, isCompleted: false });
    expect(widgets.advanceWorkspaceCountdown({ remainingSeconds: 2, isRunning: true })).toEqual({ remainingSeconds: 1, isRunning: true, isCompleted: false });
    expect(widgets.advanceWorkspaceCountdown({ remainingSeconds: 1, isRunning: true })).toEqual({ remainingSeconds: 0, isRunning: false, isCompleted: true });
  });
});
