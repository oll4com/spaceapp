import { useId, useRef, useState, type PointerEvent } from "react";
import { formatCountdown, formatDateTime, formatPercent, type GatewayTimeFormatPreference } from "./space-gateway-model.js";

/**
 * Charts of the Space Gateway workspace. Categorical colors come from the validated dark palette in fixed order
 * (`--gw-series-1..5`, checked against the panel surface: worst adjacent CVD ΔE 8.4, normal 19.3, all ≥ 3:1); a
 * sixth "Other" share is neutral gray. Text never takes a series color; every chart has a legend with values.
 */
export const seriesColor = (index: number) => `var(--gw-series-${(index % 5) + 1})`;
export const otherColor = "var(--gw-series-other)";

export interface DonutSlice { key: string; label: string; value: number; detail?: string; other?: boolean }

export function Donut({ slices: input, label, centerValue, centerDetail, formatValue, emptyText = "No data in this period." }: {
  slices: DonutSlice[];
  label: string;
  centerValue: string;
  centerDetail?: string;
  formatValue: (value: number) => string;
  emptyText?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  // Five categorical colors in fixed order; never cycled. Anything past the fifth share joins a gray "Other".
  let slices = input;
  const named = input.filter((slice) => !slice.other);
  const folded = named.slice(5);
  const otherSlices = [...input.filter((slice) => slice.other), ...folded];
  if (otherSlices.length > 1 || folded.length > 0) {
    const otherTotal = otherSlices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
    slices = [...named.slice(0, 5), { key: "__other", label: otherSlices.length === 1 ? otherSlices[0]!.label : `Other (${otherSlices.length})`, value: otherTotal,
      detail: otherSlices.map((slice) => slice.label).slice(0, 4).join(", ") + (otherSlices.length > 4 ? ", …" : ""), other: true }];
  }
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.filter((slice) => slice.value > 0).length > 1 ? 1.6 : 0;
  let offset = 0;
  const colored = slices.map((slice, index) => ({ ...slice, color: slice.other ? otherColor : seriesColor(index) }));
  const shown = colored.find((slice) => slice.key === active) ?? null;
  return (
    <figure className="gw-donut" aria-label={label}>
      <div className="gw-donut-plot">
        <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${colored.map((slice) => `${slice.label} ${formatValue(slice.value)}`).join(", ") || emptyText}`}>
          <circle cx="50" cy="50" r={radius} className="gw-donut-track" />
          {total > 0 ? colored.map((slice) => {
            const length = (Math.max(0, slice.value) / total) * circumference;
            const dash = Math.max(0, length - gap);
            const element = (
              <circle key={slice.key} cx="50" cy="50" r={radius} className={`gw-donut-slice${active && active !== slice.key ? " is-dim" : ""}`}
                style={{ stroke: slice.color }} strokeDasharray={`${dash} ${circumference - dash}`} strokeDashoffset={-offset}
                onPointerEnter={() => setActive(slice.key)} onPointerLeave={() => setActive(null)}>
                <title>{`${slice.label}: ${formatValue(slice.value)}${slice.detail ? ` · ${slice.detail}` : ""}`}</title>
              </circle>
            );
            offset += length;
            return element;
          }) : null}
        </svg>
        <div className="gw-donut-center" aria-hidden="true">
          <strong>{shown ? formatValue(shown.value) : centerValue}</strong>
          <span>{shown ? shown.label : centerDetail}</span>
        </div>
      </div>
      {colored.length === 0 ? <figcaption className="space-gateway-empty">{emptyText}</figcaption> : (
        <ul className="gw-legend">
          {colored.map((slice) => (
            <li key={slice.key} className={active === slice.key ? "is-active" : undefined} onPointerEnter={() => setActive(slice.key)} onPointerLeave={() => setActive(null)}>
              <i style={{ background: slice.color }} aria-hidden="true" />
              <span className="gw-legend-label" title={slice.label}>{slice.label}</span>
              <span className="gw-legend-value">{formatValue(slice.value)}{slice.detail ? <small>{slice.detail}</small> : null}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export interface TrendSeries { id: string; label: string; points: { t: string; value: number }[]; muted?: boolean }

/** One y-axis from zero; hover shows a crosshair and every series' value at that time. */
export function TrendChart({ series, label, formatValue, percent = false, height = 160, timeFormat = "24H", showDate = true, legendValue = "last", dateOnly = false }: {
  series: TrendSeries[];
  label: string;
  formatValue: (value: number) => string;
  percent?: boolean;
  height?: number;
  timeFormat?: GatewayTimeFormatPreference;
  /** Dates in the tooltip; the axis always shows them. */
  showDate?: boolean;
  /** The legend shows each series' latest value, or its total over the chart (counts per bucket). */
  legendValue?: "last" | "sum";
  /** Points are whole UTC days: labels show the date only. */
  dateOnly?: boolean;
}) {
  const pointLabel = (t: string, withDate = true) => (dateOnly
    ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : formatDateTime(t, timeFormat, { date: withDate }));
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const visible = series.filter((entry) => entry.points.length > 0);
  if (visible.length === 0) return <div className="gw-chart-empty">No data in this period.</div>;
  const times = [...new Set(visible.flatMap((entry) => entry.points.map((point) => point.t)))].sort();
  const width = 720;
  const max = percent ? 100 : Math.max(1, ...visible.flatMap((entry) => entry.points.map((point) => point.value)));
  const x = (t: string) => (times.length === 1 ? width / 2 : (times.indexOf(t) / (times.length - 1)) * width);
  const y = (value: number) => height - 4 - (Math.max(0, Math.min(max, value)) / max) * (height - 12);
  const colorOf = (entry: TrendSeries, index: number) => (entry.muted ? otherColor : seriesColor(index));
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    setHover(Math.round(ratio * (times.length - 1)));
  };
  const hoverTime = hover === null ? null : times[hover] ?? null;
  return (
    <figure className="gw-trend" aria-labelledby={titleId}>
      <figcaption id={titleId} className="sr-only">{label}</figcaption>
      <div className="gw-trend-axis" aria-hidden="true"><span>{formatValue(max)}</span><span>{formatValue(0)}</span></div>
      <div className="gw-trend-plot" ref={plotRef} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
          aria-label={`${label}: ${visible.map((entry) => legendValue === "sum" ? `${entry.label} ${formatValue(entry.points.reduce((sum, point) => sum + point.value, 0))} in total`
            : `${entry.label} now ${formatValue(entry.points.at(-1)!.value)}`).join(", ")}`}>
          {[0.25, 0.5, 0.75].map((fraction) => <line key={fraction} className="gw-grid" x1="0" x2={width} y1={y(max * fraction)} y2={y(max * fraction)} />)}
          <line className="gw-baseline" x1="0" x2={width} y1={y(0)} y2={y(0)} />
          {visible.map((entry, index) => (
            <polyline key={entry.id} className="gw-trend-line" style={{ stroke: colorOf(entry, index) }} vectorEffect="non-scaling-stroke"
              points={entry.points.map((point) => `${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ")} />
          ))}
          {hoverTime ? <line className="gw-crosshair" x1={x(hoverTime)} x2={x(hoverTime)} y1="0" y2={height} vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {hoverTime ? (
          <div className="gw-tooltip" role="status" style={{ left: `${(x(hoverTime) / width) * 100}%` }}>
            <strong>{pointLabel(hoverTime, showDate)}</strong>
            {visible.map((entry, index) => {
              const point = entry.points.find((item) => item.t === hoverTime);
              return <span key={entry.id}><i style={{ background: colorOf(entry, index) }} />{entry.label}<b>{point ? formatValue(point.value) : "—"}</b></span>;
            })}
          </div>
        ) : null}
      </div>
      <div className="gw-trend-x" aria-hidden="true">
        <span>{pointLabel(times[0]!)}</span>
        <span>{pointLabel(times.at(-1)!)}</span>
      </div>
      {visible.length > 1 ? (
        <ul className="gw-legend is-inline">
          {visible.map((entry, index) => (
            <li key={entry.id}><i style={{ background: colorOf(entry, index) }} aria-hidden="true" /><span className="gw-legend-label">{entry.label}</span>
              <span className="gw-legend-value">{formatValue(legendValue === "sum" ? entry.points.reduce((sum, point) => sum + point.value, 0) : entry.points.at(-1)!.value)}</span></li>
          ))}
        </ul>
      ) : null}
    </figure>
  );
}

export function Sparkline({ values, max }: { values: number[]; max?: number }) {
  if (values.length < 2) return <span className="gw-sparkline is-empty" aria-hidden="true" />;
  const top = max ?? Math.max(1, ...values);
  const points = values.map((value, index) => `${((index / (values.length - 1)) * 80).toFixed(1)},${(18 - (Math.min(top, value) / top) * 16).toFixed(1)}`).join(" ");
  return <svg className="gw-sparkline" viewBox="0 0 80 20" aria-hidden="true"><polyline points={points} vectorEffect="non-scaling-stroke" /></svg>;
}

/** Remaining share of a usage window with its reset countdown. */
export function RemainingBar({ label, remaining, resetAt, now, compact = false }: {
  label: string; remaining: number | null; resetAt?: string | null; now?: number; compact?: boolean;
}) {
  const tone = remaining === null ? "muted" : remaining <= 10 ? "critical" : remaining <= 30 ? "warn" : "ok";
  return (
    <div className={`gw-remaining${compact ? " is-compact" : ""}`} title={`${label}: ${remaining === null ? "unknown" : `${formatPercent(remaining)} left`}${resetAt ? ` · ${formatCountdown(resetAt, now)}` : ""}`}>
      <span className="gw-remaining-label">{label}</span>
      <span className="gw-remaining-track"><span className={`tone-fill-${tone}`} style={{ width: `${remaining ?? 0}%` }} /></span>
      <span className="gw-remaining-value">{remaining === null ? "—" : formatPercent(remaining)}</span>
      {!compact && resetAt !== undefined ? <span className="gw-remaining-reset">{formatCountdown(resetAt ?? null, now)}</span> : null}
    </div>
  );
}

/** How much of a key limit is used; tone by codex-lb's thresholds (40, 70, 90 percent). */
export function LimitBar({ label, used, max, format }: { label: string; used: number; max: number; format: (value: number) => string }) {
  const percent = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const tone = percent >= 90 ? "critical" : percent >= 70 ? "serious" : percent >= 40 ? "warn" : "ok";
  return (
    <div className="gw-remaining is-limit" title={`${label}: ${format(used)} of ${format(max)}`}>
      <span className="gw-remaining-label">{label}</span>
      <span className="gw-remaining-track"><span className={`tone-fill-${tone}`} style={{ width: `${percent}%` }} /></span>
      <span className="gw-remaining-value">{format(used)} / {format(max)}</span>
    </div>
  );
}

export function StatusChip({ status, children }: { status: "OK" | "DEGRADED" | "UNAVAILABLE" | "STALE"; children?: string }) {
  const text = children ?? { OK: "OK", DEGRADED: "Degraded", UNAVAILABLE: "Unavailable", STALE: "Stale" }[status];
  const icon = { OK: "●", DEGRADED: "▲", UNAVAILABLE: "○", STALE: "◌" }[status];
  return <span className={`gw-status gw-status-${status.toLowerCase()}`}><span aria-hidden="true">{icon}</span>{text}</span>;
}
