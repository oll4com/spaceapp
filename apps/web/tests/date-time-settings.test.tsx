import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultDateTimeSettings,
  DATE_TIME_SETTINGS_STORAGE_KEY,
  DATE_TIME_SETTINGS_UPDATED_EVENT,
  formatAppDate,
  formatAppDateTime,
  formatAppTime,
  formatUserTime,
  readDateTimeSettings,
  timeZoneLabel,
  writeDateTimeSettings,
} from "../src/features/date-time-settings/date-time-settings.js";
import { DateTimeSettingsCard } from "../src/features/date-time-settings/DateTimeSettingsCard.js";
import { formatAccountReset, formatWeeklyReset } from "../src/features/toolbar-metrics/ToolbarMetrics.js";

describe("DateTimeSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to UTC, 24-hour time format, and DD/MM/YYYY date format", () => {
    expect(defaultDateTimeSettings.timeZone).toBe("UTC");
    expect(defaultDateTimeSettings.timeFormat).toBe("24h");
    expect(defaultDateTimeSettings.dateFormat).toBe("DD/MM/YYYY");

    const settings = readDateTimeSettings();
    expect(settings.timeZone).toBe("UTC");
    expect(settings.timeFormat).toBe("24h");
    expect(settings.dateFormat).toBe("DD/MM/YYYY");
  });

  it("persists settings and dispatches space:date-time-settings-updated event", () => {
    const listener = vi.fn();
    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, listener);

    writeDateTimeSettings({ timeZone: "Europe/Berlin", timeFormat: "12h", dateFormat: "DD/MM/YY" });

    const raw = localStorage.getItem(DATE_TIME_SETTINGS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.timeZone).toBe("Europe/Berlin");
    expect(parsed.timeFormat).toBe("12h");
    expect(parsed.dateFormat).toBe("DD/MM/YY");

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]![0] as CustomEvent;
    expect(event.detail.timeZone).toBe("Europe/Berlin");
    expect(event.detail.timeFormat).toBe("12h");
    expect(event.detail.dateFormat).toBe("DD/MM/YY");

    window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, listener);
  });

  it("supports user-specific settings persistence", () => {
    const userId = "user:operator";
    writeDateTimeSettings({ timeZone: "UTC", timeFormat: "24h", dateFormat: "YYYY-MM-DD" }, userId);

    const userRaw = localStorage.getItem(`${DATE_TIME_SETTINGS_STORAGE_KEY}.${userId}`);
    expect(userRaw).toBeTruthy();

    const read = readDateTimeSettings(userId);
    expect(read.timeZone).toBe("UTC");
    expect(read.timeFormat).toBe("24h");
    expect(read.dateFormat).toBe("YYYY-MM-DD");
  });

  describe("formatAppTime", () => {
    const sampleUtc = "2026-09-26T10:30:22Z";

    it("formats 24h time in Bangkok (UTC+7) by default", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
      });
      expect(formatted).toContain("17:30:22");
      expect(formatted).not.toContain("PM");
      expect(formatted).not.toContain("AM");
    });

    it("formats 12h time when 12h is selected", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "12h",
      });
      expect(formatted).toContain("5:30:22");
      expect(formatted).toMatch(/PM|μμ/i);
    });

    it("formats time in Europe/Berlin (UTC+2) in 24h", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "Europe/Berlin",
        timeFormat: "24h",
      });
      expect(formatted).toContain("12:30:22");
    });

    it("formats time in Europe/Athens (UTC+3) in 24h", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "Europe/Athens",
        timeFormat: "24h",
      });
      expect(formatted).toContain("13:30:22");
    });

    it("formats time in UTC in 24h", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "UTC",
        timeFormat: "24h",
      });
      expect(formatted).toContain("10:30:22");
    });

    it("gracefully falls back on invalid timeZone", () => {
      const formatted = formatAppTime(sampleUtc, undefined, {
        timeZone: "Invalid/Zone_Name",
        timeFormat: "24h",
      });
      expect(formatted).toBeTruthy();
      expect(formatted).not.toBe("--");
    });

    it("handles null or undefined input cleanly", () => {
      expect(formatAppTime(null)).toBe("--");
      expect(formatAppTime(undefined)).toBe("--");
      expect(formatAppTime("invalid-date")).toBe("--");
    });
  });

  describe("formatAppDateTime & Resets", () => {
    const sampleUtc = "2026-09-26T12:49:00Z";

    it("formats date and time in Bangkok 24h format for account resets", () => {
      const formatted = formatAppDateTime(sampleUtc, {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
      });

      // 12:49 UTC + 7 = 19:49 Bangkok time
      expect(formatted).toContain("19:49");
      expect(formatted).not.toContain("07:49 PM");
    });

    it("formats weekly reset in ToolbarMetrics using Bangkok 24h", () => {
      const res = formatWeeklyReset(sampleUtc, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
      });
      expect(res).toContain("week resets ");
      expect(res).toContain("19:49");
      expect(res).not.toContain("PM");
    });

    it("formats 5h reset countdown in ToolbarMetrics using Bangkok 24h", () => {
      const baseMs = Date.parse("2026-09-26T08:00:00Z");
      // 4 hours in the future (exceeds 3h relative threshold)
      const futureIso = new Date(baseMs + 4 * 3600_000).toISOString();
      const res = formatAccountReset(futureIso, baseMs, "5h resets", {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
      });

      // baseMs = 08:00 UTC = 15:00 Bangkok. +4h = 12:00 UTC = 19:00 Bangkok
      expect(res).toContain("5h resets: ");
      expect(res).toContain("19:00");
      expect(res).not.toContain("PM");
    });
  });

  describe("formatAppDate & DateFormat patterns", () => {
    const sampleUtc = "2026-09-28T14:30:00Z";

    it("formats DD/MM/YYYY by default", () => {
      const formatted = formatAppDate(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
        dateFormat: "DD/MM/YYYY",
      });
      expect(formatted).toBe("28/09/2026");
    });

    it("formats DD/MM/YY when DD/MM/YY is selected", () => {
      const formatted = formatAppDate(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
        dateFormat: "DD/MM/YY",
      });
      expect(formatted).toBe("28/09/26");
    });

    it("formats MM/DD/YYYY when MM/DD/YYYY is selected", () => {
      const formatted = formatAppDate(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
        dateFormat: "MM/DD/YYYY",
      });
      expect(formatted).toBe("09/28/2026");
    });

    it("formats YYYY-MM-DD when YYYY-MM-DD is selected", () => {
      const formatted = formatAppDate(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
        dateFormat: "YYYY-MM-DD",
      });
      expect(formatted).toBe("2026-09-28");
    });

    it("combines date format and time format in formatAppDateTime", () => {
      const formatted = formatAppDateTime(sampleUtc, undefined, {
        timeZone: "Asia/Bangkok",
        timeFormat: "24h",
        dateFormat: "DD/MM/YYYY",
      });
      // 14:30 UTC + 7 = 21:30 Bangkok time
      expect(formatted).toBe("28/09/2026 21:30");
    });
  });

  describe("DateTimeSettingsCard UI Component", () => {
    it("renders with default selections (UTC, 24h, and DD/MM/YYYY)", () => {
      render(<DateTimeSettingsCard />);

      const timezoneSelect = screen.getByLabelText("Working time zone") as HTMLSelectElement;
      const formatSelect = screen.getByLabelText("Time format") as HTMLSelectElement;
      const dateSelect = screen.getByLabelText("Date format") as HTMLSelectElement;

      expect(timezoneSelect.value).toBe("UTC");
      expect(formatSelect.value).toBe("24h");
      expect(dateSelect.value).toBe("DD/MM/YYYY");
      expect(screen.getByLabelText("Clock preview")).toBeTruthy();
    });

    it("updates timezone when selected and saves to storage", () => {
      render(<DateTimeSettingsCard />);

      const timezoneSelect = screen.getByLabelText("Working time zone") as HTMLSelectElement;
      fireEvent.change(timezoneSelect, { target: { value: "Asia/Bangkok" } });

      expect(timezoneSelect.value).toBe("Asia/Bangkok");
      const saved = readDateTimeSettings();
      expect(saved.timeZone).toBe("Asia/Bangkok");
    });

    it("updates time format to 12h and saves to storage", () => {
      render(<DateTimeSettingsCard />);

      const formatSelect = screen.getByLabelText("Time format") as HTMLSelectElement;
      fireEvent.change(formatSelect, { target: { value: "12h" } });

      expect(formatSelect.value).toBe("12h");
      const saved = readDateTimeSettings();
      expect(saved.timeFormat).toBe("12h");
    });

    it("updates date format to DD/MM/YY and saves to storage", () => {
      render(<DateTimeSettingsCard />);

      const dateSelect = screen.getByLabelText("Date format") as HTMLSelectElement;
      fireEvent.change(dateSelect, { target: { value: "DD/MM/YY" } });

      expect(dateSelect.value).toBe("DD/MM/YY");
      const saved = readDateTimeSettings();
      expect(saved.dateFormat).toBe("DD/MM/YY");
    });

    it("detects the browser's working time zone and shows the local time with its label", () => {
      render(<DateTimeSettingsCard />);
      const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const detect = screen.getByRole("button", { name: "Detect" });
      if (browser !== "UTC") {
        fireEvent.click(detect);
        expect((screen.getByLabelText("Working time zone") as HTMLSelectElement).value).toBe(browser);
      }
      expect(readDateTimeSettings().timeZone).toBe(browser);
      expect(screen.getByText(/^Every time in Space is shown in this zone.*Now: \d\d:\d\d /)).toBeTruthy();
    });

    it("resets to defaults when reset button is clicked", () => {
      writeDateTimeSettings({ timeZone: "America/New_York", timeFormat: "12h", dateFormat: "MM/DD/YYYY" });

      render(<DateTimeSettingsCard />);
      const resetButton = screen.getByRole("button", { name: "Reset date and time settings to defaults" });
      fireEvent.click(resetButton);

      const timezoneSelect = screen.getByLabelText("Working time zone") as HTMLSelectElement;
      const formatSelect = screen.getByLabelText("Time format") as HTMLSelectElement;
      const dateSelect = screen.getByLabelText("Date format") as HTMLSelectElement;

      expect(timezoneSelect.value).toBe("UTC");
      expect(formatSelect.value).toBe("24h");
      expect(dateSelect.value).toBe("DD/MM/YYYY");
    });
  });

  it("labels a time with the user's working zone (19:00 ICT)", () => {
    const at = "2026-10-17T12:00:00Z";
    const bangkok = { timeZone: "Asia/Bangkok", timeFormat: "24h" as const, dateFormat: "DD/MM/YYYY" as const };
    expect(formatUserTime(at, {}, bangkok)).toBe("19:00 ICT");
    expect(formatUserTime(at, { withDate: true }, bangkok)).toBe("17/10/2026 19:00 ICT");
    expect(timeZoneLabel("Europe/Athens", new Date(at))).toBe("EEST");
    expect(formatUserTime(null)).toBe("--");
  });
});
