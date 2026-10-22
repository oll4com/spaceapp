import type { ReactNode } from "react";
import type { DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { QUOTA_WARNING_THRESHOLD_PERCENT } from "../system-health/health-model.js";
import {
  availabilityLabel,
  formatUntil,
  type AccountAvailability,
  type AccountAvailabilityFilter,
  type AvailabilityState,
  type QuotaWindows,
} from "./account-availability.js";
import "./account-quotas.css";

export interface AccountQuotaRow {
  key: string;
  label: string | null;
  quota: QuotaWindows;
  threshold: number;
  weeklyScope?: string | null;
}

export interface AccountQuotaEntry {
  id: string;
  title: string;
  details: string[];
  availability: AvailabilityState;
  offlineLabel?: string;
  hint?: string;
  /** Extra lines under the hint or the rows (the Claude API key's Anthropic bill). */
  notes?: string[];
  rows: AccountQuotaRow[];
  // Remaining share of the tightest window, used to list the roomiest accounts first.
  capacity: number;
  action?: ReactNode;
}

export type AvailabilityCounts = Record<AccountAvailabilityFilter, number>;

export function countAvailability(entries: Pick<AccountQuotaEntry, "availability">[]): AvailabilityCounts {
  const counts: AvailabilityCounts = { all: entries.length, available: 0, soon: 0, exhausted: 0 };
  for (const entry of entries) {
    const state = entry.availability.state;
    if (state === "available" || state === "soon" || state === "exhausted") counts[state] += 1;
  }
  return counts;
}

const filterOptions: Array<{ key: AccountAvailabilityFilter; label: string; title: string }> = [
  { key: "all", label: "All", title: "Show every account" },
  { key: "available", label: "Available", title: "5h and weekly quota left now" },
  { key: "soon", label: "Back soon", title: "Limit reached; usable again within a few hours" },
  { key: "exhausted", label: "Exhausted", title: "Weekly quota used up until the weekly reset" },
];

export function AvailabilityFilterBar({ counts, value, onChange }: {
  counts: AvailabilityCounts;
  value: AccountAvailabilityFilter;
  onChange: (value: AccountAvailabilityFilter) => void;
}) {
  return (
    <div className="account-availability-filter" role="group" aria-label="Account availability">
      {filterOptions.map((option) => (
        <button
          key={option.key}
          type="button"
          className={`is-${option.key}${value === option.key ? " is-active" : ""}`}
          aria-pressed={value === option.key}
          aria-label={`${option.label} (${counts[option.key]})`}
          title={option.title}
          onClick={() => onChange(option.key)}
        >
          <b>{counts[option.key]}</b>
          <span>{option.key !== "all" ? <i className="account-availability-dot" aria-hidden="true" /> : null}{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AvailabilityCountChips({ counts }: { counts: AvailabilityCounts }) {
  return (
    <span className="account-availability-counts">
      <span className="is-available" title={`${counts.available} available`}><i className="account-availability-dot" aria-hidden="true" />{counts.available}</span>
      <span className="is-soon" title={`${counts.soon} back soon`}><i className="account-availability-dot" aria-hidden="true" />{counts.soon}</span>
      <span className="is-exhausted" title={`${counts.exhausted} exhausted`}><i className="account-availability-dot" aria-hidden="true" />{counts.exhausted}</span>
    </span>
  );
}

function cellTone(remaining: number | null | undefined, threshold: number): "critical" | "warning" | "healthy" | "none" {
  if (remaining == null) return "none";
  if (remaining < threshold) return "critical";
  return remaining <= QUOTA_WARNING_THRESHOLD_PERCENT ? "warning" : "healthy";
}

const toneTitle = { critical: "Exhausted", warning: "Near exhaustion", healthy: "Healthy" } as const;

function QuotaCell({ label, remaining, resetAt, threshold, clock, settings }: {
  label: string;
  remaining: number | null | undefined;
  resetAt: string | null | undefined;
  threshold: number;
  clock: number;
  settings?: DateTimeSettings;
}) {
  const tone = cellTone(remaining, threshold);
  const percent = remaining == null ? "—" : `${Math.round(remaining)}%`;
  const until = formatUntil(resetAt, clock, settings);
  const note = remaining == null
    ? "No data"
    : until
      ? `${tone === "critical" ? "back" : "resets"} ${until}`
      : null;
  return (
    <div className={`account-quota-cell is-${tone}`}>
      <div className="account-quota-cell-head">
        <span>{label}</span>
        <strong title={tone === "none" ? undefined : `${label}: ${toneTitle[tone]} (${percent})`}>{percent}</strong>
      </div>
      <span
        className="account-quota-bar"
        role="meter"
        aria-label={`${label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining == null ? undefined : Math.round(remaining)}
      >
        <span style={{ width: `${Math.min(Math.max(remaining ?? 0, 0), 100)}%` }} />
      </span>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

export function AccountQuotaCard({ entry, clock, settings }: {
  entry: AccountQuotaEntry;
  clock: number;
  settings?: DateTimeSettings;
}) {
  const state: AccountAvailability = entry.availability.state;
  const pill = state === "offline" ? entry.offlineLabel ?? "Offline" : availabilityLabel(entry.availability, clock, settings);
  return (
    <li className={`toolbar-metric-account-card account-quota-card is-${state}`} data-availability={state}>
      <div className="account-quota-head">
        <strong className="account-quota-title">{entry.title}</strong>
        <span className={`account-availability-pill is-${state}`}>{pill}</span>
      </div>
      {entry.details.length || entry.action ? (
        <div className="account-quota-meta">
          <small>{entry.details.join(" · ")}</small>
          {entry.action}
        </div>
      ) : null}
      {entry.rows.length ? entry.rows.map((row) => (
        <div key={row.key} className="account-quota-row">
          {row.label ? <span className="account-quota-row-label">{row.label}</span> : null}
          <div className="account-quota-cells">
            {/* A known week without a 5h figure: the account has no 5h limit (Codex Prolite). */}
            {row.quota.fiveHourRemainingPercent == null && row.quota.weeklyRemainingPercent != null ? null : (
              <QuotaCell
                label="5h"
                remaining={row.quota.fiveHourRemainingPercent}
                resetAt={row.quota.fiveHourResetAt}
                threshold={row.threshold}
                clock={clock}
                settings={settings}
              />
            )}
            <QuotaCell
              label={row.weeklyScope ? `Week · ${row.weeklyScope}` : "Week"}
              remaining={row.quota.weeklyRemainingPercent}
              resetAt={row.quota.weeklyResetAt}
              threshold={row.threshold}
              clock={clock}
              settings={settings}
            />
          </div>
        </div>
      )) : entry.hint ? <span className="toolbar-metric-dim">{entry.hint}</span> : null}
      {entry.notes?.map((note) => <span key={note} className="account-quota-note">{note}</span>)}
    </li>
  );
}
