import { useEffect, useState } from "react";
import { RotateCcw } from "../ui-theme/app-icons.js";
import { Clock3 } from "../ui-theme/app-icons.js";
import {
  allTimeZones,
  browserTimeZone,
  defaultDateTimeSettings,
  formatUserTime,
  DATE_FORMAT_OPTIONS,
  TIME_ZONE_GROUPS,
  useDateTimeSettings,
  type DateFormat,
  type TimeFormat,
} from "./date-time-settings.js";
import "./date-time-settings.css";

export function DateTimeSettingsCard({ userId }: { userId?: string }) {
  const { settings, updateSettings, formatDateTime } = useDateTimeSettings(userId);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const presets = new Set(TIME_ZONE_GROUPS.flatMap((group) => group.options.map((option) => option.value)));
  const others = allTimeZones().filter((zone) => !presets.has(zone));
  if (!presets.has(settings.timeZone) && !others.includes(settings.timeZone)) others.unshift(settings.timeZone);
  const detected = browserTimeZone();

  const preview = formatDateTime(now, {
    includeSeconds: true,
    separator: ", ",
  });

  return (
    <section
      className="agent-settings-card settings-flat-card date-time-settings-card"
      aria-label="Date and time format settings"
    >
      <div className="agent-settings-section-title settings-flat-heading">
        <Clock3 aria-hidden="true" />
        <span>
          <strong>Date &amp; time</strong>
          <small>Reset returns to UTC, 24-hour time and day/month/year.</small>
        </span>
        <div className="settings-flat-heading-actions">
          <button
            type="button"
            className="date-time-reset-btn"
            title="Reset to defaults (UTC, 24-hour & DD/MM/YYYY)"
            aria-label="Reset date and time settings to defaults"
            onClick={() => updateSettings(defaultDateTimeSettings)}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Working time zone</strong>
          <small>Every time in Space is shown in this zone, and new scheduled tasks run in it. Now: {formatUserTime(now, {}, settings)}</small>
        </span>
        <button
          type="button"
          className="date-time-detect-btn"
          title={`Use this browser's time zone (${detected})`}
          onClick={() => updateSettings({ timeZone: detected })}
          disabled={settings.timeZone === detected}
        >
          Detect
        </button>
        <select
          aria-label="Working time zone"
          name="space-date-time-timezone"
          value={settings.timeZone}
          onChange={(event) => updateSettings({ timeZone: event.target.value })}
        >
          {TIME_ZONE_GROUPS.map((group) => (
            <optgroup key={group.group} label={group.group}>
              {group.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </optgroup>
          ))}
          {others.length ? (
            <optgroup label="All time zones">
              {others.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>)}
            </optgroup>
          ) : null}
        </select>
      </div>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Time format</strong>
          <small>Choose 24-hour clock (17:30) or 12-hour clock (5:30 PM).</small>
        </span>
        <select
          aria-label="Time format"
          name="space-date-time-format"
          value={settings.timeFormat}
          onChange={(event) => updateSettings({ timeFormat: event.target.value as TimeFormat })}
        >
          <option value="24h">24-hour (e.g. 17:30:00)</option>
          <option value="12h">12-hour (e.g. 5:30:00 PM)</option>
        </select>
      </label>

      <label className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Date format</strong>
          <small>Choose date display ordering (day, month, year).</small>
        </span>
        <select
          aria-label="Date format"
          name="space-date-time-date-format"
          value={settings.dateFormat}
          onChange={(event) => updateSettings({ dateFormat: event.target.value as DateFormat })}
        >
          {DATE_FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="settings-flat-row date-time-preview-row">
        <span className="settings-flat-row-copy">
          <strong>Preview</strong>
          <small>The current time with your choices.</small>
        </span>
        <code className="date-time-preview-value" aria-label="Clock preview">
          {preview}
        </code>
      </div>
    </section>
  );
}
