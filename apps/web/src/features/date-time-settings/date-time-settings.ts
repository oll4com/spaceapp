import { useCallback, useEffect, useState } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { api } from "../../api.js";

export type TimeFormat = "24h" | "12h";
export type DateFormat = "DD/MM/YYYY" | "DD/MM/YY" | "MM/DD/YYYY" | "YYYY-MM-DD";

export interface DateTimeSettings {
  timeZone: string;
  timeFormat: TimeFormat;
  dateFormat?: DateFormat;
}

export const DATE_TIME_SETTINGS_STORAGE_KEY = "space.dateTime.settings";
export const DATE_TIME_SETTINGS_UPDATED_EVENT = "space:date-time-settings-updated";

/**
 * Default settings:
 * Thailand (Asia/Bangkok, UTC+7), 24-hour time format, and DD/MM/YYYY date format.
 */
export const defaultDateTimeSettings: DateTimeSettings = {
  timeZone: "UTC",
  timeFormat: "24h",
  dateFormat: "DD/MM/YYYY",
};

export interface DateFormatOption {
  value: DateFormat;
  label: string;
}

export const DATE_FORMAT_OPTIONS: DateFormatOption[] = [
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY (e.g. 28/09/2026) · Default" },
  { value: "DD/MM/YY", label: "DD/MM/YY (e.g. 28/09/26)" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY (e.g. 09/28/2026)" },
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD (e.g. 2026-09-28)" },
];

export function formatDateByPattern(
  date: Date,
  format: DateFormat = "DD/MM/YYYY",
  timeZone?: string
): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  if (timeZone && timeZone !== "system") {
    options.timeZone = timeZone;
  }
  let day = "";
  let month = "";
  let year = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
    for (const p of parts) {
      if (p.type === "day") day = p.value;
      else if (p.type === "month") month = p.value;
      else if (p.type === "year") year = p.value;
    }
  } catch {
    day = String(date.getDate()).padStart(2, "0");
    month = String(date.getMonth() + 1).padStart(2, "0");
    year = String(date.getFullYear());
  }

  const yy = year.slice(-2);
  switch (format) {
    case "DD/MM/YY":
      return `${day}/${month}/${yy}`;
    case "MM/DD/YYYY":
      return `${month}/${day}/${year}`;
    case "YYYY-MM-DD":
      return `${year}-${month}-${day}`;
    case "DD/MM/YYYY":
    default:
      return `${day}/${month}/${year}`;
  }
}

export interface TimeZoneOption {
  value: string;
  label: string;
}

export interface TimeZoneGroup {
  group: string;
  options: TimeZoneOption[];
}

export const TIME_ZONE_GROUPS: TimeZoneGroup[] = [
  {
    group: "Common & Presets",
    options: [
      { value: "UTC", label: "UTC (Universal Coordinated Time, UTC+0) · Default" },
      { value: "Asia/Bangkok", label: "Thailand (Bangkok, ICT, UTC+7)" },
      { value: "Europe/Athens", label: "Greece (Athens, EEST/EET, UTC+3/+2)" },
      { value: "Europe/Berlin", label: "Germany (Berlin, CEST/CET, UTC+2/+1)" },
      { value: "system", label: "System / Browser Local Time" },
    ],
  },
  {
    group: "Europe & Middle East",
    options: [
      { value: "Europe/London", label: "United Kingdom (London, GMT/BST, UTC+0/+1)" },
      { value: "Europe/Paris", label: "France (Paris, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Rome", label: "Italy (Rome, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Madrid", label: "Spain (Madrid, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Amsterdam", label: "Netherlands (Amsterdam, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Zurich", label: "Switzerland (Zurich, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Vienna", label: "Austria (Vienna, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Warsaw", label: "Poland (Warsaw, CET/CEST, UTC+1/+2)" },
      { value: "Europe/Bucharest", label: "Romania (Bucharest, EEST/EET, UTC+3/+2)" },
      { value: "Europe/Sofia", label: "Bulgaria (Sofia, EEST/EET, UTC+3/+2)" },
      { value: "Europe/Kyiv", label: "Ukraine (Kyiv, EEST/EET, UTC+3/+2)" },
      { value: "Europe/Istanbul", label: "Turkey (Istanbul, TRT, UTC+3)" },
      { value: "Asia/Dubai", label: "United Arab Emirates (Dubai, GST, UTC+4)" },
      { value: "Asia/Jerusalem", label: "Israel (Jerusalem, IDT/IST, UTC+3/+2)" },
      { value: "Asia/Riyadh", label: "Saudi Arabia (Riyadh, AST, UTC+3)" },
    ],
  },
  {
    group: "Asia & Pacific",
    options: [
      { value: "Asia/Bangkok", label: "Thailand (Bangkok, ICT, UTC+7)" },
      { value: "Asia/Singapore", label: "Singapore (SGT, UTC+8)" },
      { value: "Asia/Tokyo", label: "Japan (Tokyo, JST, UTC+9)" },
      { value: "Asia/Seoul", label: "South Korea (Seoul, KST, UTC+9)" },
      { value: "Asia/Hong_Kong", label: "Hong Kong (HKT, UTC+8)" },
      { value: "Asia/Shanghai", label: "China (Shanghai/Beijing, CST, UTC+8)" },
      { value: "Asia/Taipei", label: "Taiwan (Taipei, CST, UTC+8)" },
      { value: "Asia/Kolkata", label: "India (Kolkata/New Delhi, IST, UTC+5:30)" },
      { value: "Asia/Jakarta", label: "Indonesia (Jakarta, WIB, UTC+7)" },
      { value: "Asia/Manila", label: "Philippines (Manila, PHT, UTC+8)" },
      { value: "Asia/Kuala_Lumpur", label: "Malaysia (Kuala Lumpur, MYT, UTC+8)" },
      { value: "Australia/Sydney", label: "Australia (Sydney, AEST/AEDT, UTC+10/+11)" },
      { value: "Australia/Melbourne", label: "Australia (Melbourne, AEST/AEDT, UTC+10/+11)" },
      { value: "Australia/Perth", label: "Australia (Perth, AWST, UTC+8)" },
      { value: "Pacific/Auckland", label: "New Zealand (Auckland, NZST/NZDT, UTC+12/+13)" },
    ],
  },
  {
    group: "Americas",
    options: [
      { value: "America/New_York", label: "US Eastern (New York, EST/EDT, UTC-5/-4)" },
      { value: "America/Chicago", label: "US Central (Chicago, CST/CDT, UTC-6/-5)" },
      { value: "America/Denver", label: "US Mountain (Denver, MST/MDT, UTC-7/-6)" },
      { value: "America/Los_Angeles", label: "US Pacific (Los Angeles, PST/PDT, UTC-8/-7)" },
      { value: "America/Anchorage", label: "US Alaska (Anchorage, AKST/AKDT, UTC-9/-8)" },
      { value: "Pacific/Honolulu", label: "US Hawaii (Honolulu, HST, UTC-10)" },
      { value: "America/Toronto", label: "Canada Eastern (Toronto, EST/EDT, UTC-5/-4)" },
      { value: "America/Vancouver", label: "Canada Pacific (Vancouver, PST/PDT, UTC-8/-7)" },
      { value: "America/Sao_Paulo", label: "Brazil (São Paulo, BRT, UTC-3)" },
      { value: "America/Argentina/Buenos_Aires", label: "Argentina (Buenos Aires, ART, UTC-3)" },
      { value: "America/Mexico_City", label: "Mexico (Mexico City, CST, UTC-6)" },
    ],
  },
  {
    group: "Standard UTC Offsets",
    options: [
      { value: "Etc/GMT+12", label: "UTC-12:00" },
      { value: "Etc/GMT+11", label: "UTC-11:00" },
      { value: "Etc/GMT+10", label: "UTC-10:00" },
      { value: "Etc/GMT+9", label: "UTC-09:00" },
      { value: "Etc/GMT+8", label: "UTC-08:00" },
      { value: "Etc/GMT+7", label: "UTC-07:00" },
      { value: "Etc/GMT+6", label: "UTC-06:00" },
      { value: "Etc/GMT+5", label: "UTC-05:00" },
      { value: "Etc/GMT+4", label: "UTC-04:00" },
      { value: "Etc/GMT+3", label: "UTC-03:00" },
      { value: "Etc/GMT+2", label: "UTC-02:00" },
      { value: "Etc/GMT+1", label: "UTC-01:00" },
      { value: "Etc/GMT", label: "UTC+00:00 (UTC)" },
      { value: "Etc/GMT-1", label: "UTC+01:00" },
      { value: "Etc/GMT-2", label: "UTC+02:00" },
      { value: "Etc/GMT-3", label: "UTC+03:00" },
      { value: "Etc/GMT-4", label: "UTC+04:00" },
      { value: "Etc/GMT-5", label: "UTC+05:00" },
      { value: "Etc/GMT-6", label: "UTC+06:00" },
      { value: "Etc/GMT-7", label: "UTC+07:00" },
      { value: "Etc/GMT-8", label: "UTC+08:00" },
      { value: "Etc/GMT-9", label: "UTC+09:00" },
      { value: "Etc/GMT-10", label: "UTC+10:00" },
      { value: "Etc/GMT-11", label: "UTC+11:00" },
      { value: "Etc/GMT-12", label: "UTC+12:00" },
      { value: "Etc/GMT-13", label: "UTC+13:00" },
      { value: "Etc/GMT-14", label: "UTC+14:00" },
    ],
  },
];

function storageKeyForUser(userId?: string): string {
  return userId ? `${DATE_TIME_SETTINGS_STORAGE_KEY}.${userId}` : DATE_TIME_SETTINGS_STORAGE_KEY;
}

function getStorage(): Storage | null {
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function readDateTimeSettings(userId?: string): DateTimeSettings {
  const storage = getStorage();
  if (!storage) {
    return defaultDateTimeSettings;
  }
  try {
    const userRaw = userId ? storage.getItem(storageKeyForUser(userId)) : null;
    const globalRaw = storage.getItem(DATE_TIME_SETTINGS_STORAGE_KEY);
    const raw = userRaw ?? globalRaw;

    if (!raw) return defaultDateTimeSettings;
    const parsed = JSON.parse(raw) as Partial<DateTimeSettings>;

    const timeFormat: TimeFormat = parsed.timeFormat === "12h" ? "12h" : "24h";
    const timeZone: string = typeof parsed.timeZone === "string" && parsed.timeZone.trim() ? parsed.timeZone.trim() : defaultDateTimeSettings.timeZone;
    const rawDateFormat = typeof parsed.dateFormat === "string" ? parsed.dateFormat.trim().toUpperCase() : "";
    const dateFormat: DateFormat = (
      rawDateFormat === "DD/MM/YY" ||
      rawDateFormat === "MM/DD/YYYY" ||
      rawDateFormat === "YYYY-MM-DD"
    ) ? (rawDateFormat as DateFormat) : "DD/MM/YYYY";

    return {
      timeZone,
      timeFormat,
      dateFormat,
    };
  } catch {
    return defaultDateTimeSettings;
  }
}

export function applyServerDateTimeSettings(settings: DateTimeSettings, userId?: string): void {
  const storage = getStorage();
  if (storage) {
    try {
      const serialized = JSON.stringify(settings);
      storage.setItem(DATE_TIME_SETTINGS_STORAGE_KEY, serialized);
      if (userId) {
        storage.setItem(storageKeyForUser(userId), serialized);
      }
    } catch {
      // Session-only fallback when storage is disabled
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<DateTimeSettings>(DATE_TIME_SETTINGS_UPDATED_EVENT, {
        detail: settings,
      })
    );
  }
}

export function writeDateTimeSettings(settings: DateTimeSettings, userId?: string): void {
  const storage = getStorage();
  if (storage) {
    try {
      const serialized = JSON.stringify(settings);
      storage.setItem(DATE_TIME_SETTINGS_STORAGE_KEY, serialized);
      if (userId) {
        storage.setItem(storageKeyForUser(userId), serialized);
      }
    } catch {
      // Session-only fallback when storage is disabled
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<DateTimeSettings>(DATE_TIME_SETTINGS_UPDATED_EVENT, {
        detail: settings,
      })
    );
  }

  try {
    void api.updateUserSettings({ dateTime: settings }).catch(() => {
      // Session/offline fallback
    });
  } catch {
    // Runtime unavailable (e.g. isolated unit tests)
  }
}

export function formatAppTime(
  value: Date | string | number | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  settings?: DateTimeSettings
): string {
  if (value === null || value === undefined) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";

  const active = settings ?? readDateTimeSettings();
  const formatOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...options,
  };
  if (!options || (!("second" in options) && !("hour" in options))) {
    formatOptions.second = "2-digit";
  } else if (!("second" in options)) {
    delete formatOptions.second;
  }

  if (active.timeZone && active.timeZone !== "system") {
    formatOptions.timeZone = active.timeZone;
  }

  if (active.timeFormat === "24h") {
    formatOptions.hour12 = false;
    formatOptions.hourCycle = "h23";
  } else if (active.timeFormat === "12h") {
    formatOptions.hour12 = true;
  }

  try {
    return new Intl.DateTimeFormat(undefined, formatOptions).format(date);
  } catch {
    delete formatOptions.timeZone;
    try {
      return new Intl.DateTimeFormat(undefined, formatOptions).format(date);
    } catch {
      return date.toISOString();
    }
  }
}

export function formatAppDateTime(
  value: Date | string | number | null | undefined,
  options?: ({
    format?: DateFormat;
    timeZone?: string;
    includeSeconds?: boolean;
    includeTime?: boolean;
    separator?: string;
  } & Intl.DateTimeFormatOptions) | Intl.DateTimeFormatOptions,
  settings?: DateTimeSettings
): string {
  if (value === null || value === undefined) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";

  const active = settings ?? readDateTimeSettings();
  const format = (options && "format" in options && options.format)
    ? options.format
    : active.dateFormat ?? "DD/MM/YYYY";
  const timeZone = (options && "timeZone" in options && options.timeZone)
    ? options.timeZone
    : (active.timeZone && active.timeZone !== "system" ? active.timeZone : undefined);

  let weekdayPart = "";
  if (options && "weekday" in options && options.weekday) {
    try {
      weekdayPart = new Intl.DateTimeFormat("en-US", {
        weekday: options.weekday,
        ...(timeZone ? { timeZone } : {}),
      }).format(date);
    } catch {
      // fallback
    }
  }

  const datePart = formatDateByPattern(date, format, timeZone);

  if (options && "includeTime" in options && options.includeTime === false) {
    return weekdayPart ? `${weekdayPart}, ${datePart}` : datePart;
  }

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    ...(options && "includeSeconds" in options && options.includeSeconds ? { second: "2-digit" } : {}),
  };
  const timePart = formatAppTime(date, timeOptions, active);
  const separator = (options && "separator" in options && options.separator) ? options.separator : " ";

  const base = `${datePart}${separator}${timePart}`;
  return weekdayPart ? `${weekdayPart}, ${base}` : base;
}

export function formatAppDate(
  value: Date | string | number | null | undefined,
  options?: ({ format?: DateFormat; timeZone?: string } & Intl.DateTimeFormatOptions) | Intl.DateTimeFormatOptions,
  settings?: DateTimeSettings
): string {
  if (value === null || value === undefined) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";

  const active = settings ?? readDateTimeSettings();
  const format = (options && "format" in options && options.format)
    ? options.format
    : active.dateFormat ?? "DD/MM/YYYY";
  const timeZone = (options && "timeZone" in options && options.timeZone)
    ? options.timeZone
    : (active.timeZone && active.timeZone !== "system" ? active.timeZone : undefined);

  let weekdayPart = "";
  if (options && "weekday" in options && options.weekday) {
    try {
      weekdayPart = new Intl.DateTimeFormat("en-US", {
        weekday: options.weekday,
        ...(timeZone ? { timeZone } : {}),
      }).format(date);
    } catch {
      // fallback
    }
  }

  const datePart = formatDateByPattern(date, format, timeZone);
  return weekdayPart ? `${weekdayPart}, ${datePart}` : datePart;
}

export function useDateTimeSettings(userId?: string) {
  const [settings, setSettings] = useState<DateTimeSettings>(() => readDateTimeSettings(userId));

  useEffect(() => {
    setSettings(readDateTimeSettings(userId));
  }, [userId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function handleSettingsUpdate(event: Event) {
      const customEvent = event as CustomEvent<DateTimeSettings>;
      if (customEvent.detail) {
        setSettings(customEvent.detail);
      } else {
        setSettings(readDateTimeSettings(userId));
      }
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === DATE_TIME_SETTINGS_STORAGE_KEY || (userId && event.key === storageKeyForUser(userId))) {
        setSettings(readDateTimeSettings(userId));
      }
    }

    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
      window.removeEventListener("storage", handleStorage);
    };
  }, [userId]);

  const updateSettings = useCallback(
    (patch: Partial<DateTimeSettings>) => {
      const current = readDateTimeSettings(userId);
      const next: DateTimeSettings = {
        ...current,
        ...patch,
      };
      writeDateTimeSettings(next, userId);
      setSettings(next);
    },
    [userId]
  );

  const formatTime = useCallback(
    (value: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) => {
      return formatAppTime(value, options, settings);
    },
    [settings]
  );

  const formatDateTime = useCallback(
    (
      value: Date | string | number | null | undefined,
      options?: ({
        format?: DateFormat;
        timeZone?: string;
        includeSeconds?: boolean;
        includeTime?: boolean;
        separator?: string;
      } & Intl.DateTimeFormatOptions) | Intl.DateTimeFormatOptions
    ) => {
      return formatAppDateTime(value, options, settings);
    },
    [settings]
  );

  const formatDate = useCallback(
    (
      value: Date | string | number | null | undefined,
      options?: ({ format?: DateFormat; timeZone?: string } & Intl.DateTimeFormatOptions) | Intl.DateTimeFormatOptions
    ) => {
      return formatAppDate(value, options, settings);
    },
    [settings]
  );

  return {
    settings,
    updateSettings,
    formatTime,
    formatDateTime,
    formatDate,
  };
}
