import { useState } from "react";
import type { SystemAnalyticsModelsResponse, SystemAnalyticsRange } from "@space/contracts";
import { formatUsd } from "./token-totals.js";

type Timeline = NonNullable<SystemAnalyticsModelsResponse["timeline"]>;
type Composition = NonNullable<SystemAnalyticsModelsResponse["composition"]>;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const formatCompact = (value: number) => compact.format(value);

/** A round axis top at or above `value` (its half is round too), so the bars fill most of the height. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find((step) => step * power >= value) ?? 10) * power;
}

function bucketLabel(at: string, range: SystemAnalyticsRange): string {
  const date = new Date(at);
  if (range === "30d") return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (range === "7d") return date.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A bar segment with rounded top corners; the baseline end stays square. */
function topRounded(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

// The SVG scales to the dock's width (about 400px): sizes are in 600-wide user units, so 16 renders near 11px.
const WIDTH = 600;
const HEIGHT = 240;
const PLOT = { left: 58, right: 10, top: 12, bottom: 30 };

/** Tokens per hour or day, Space Gateway at the base and direct calls on top, with a tooltip per bar. */
export function TokenTimelineChart({ timeline, range }: { timeline: Timeline; range: SystemAnalyticsRange }) {
  const [active, setActive] = useState<number | null>(null);
  const points = timeline.points;
  const max = niceMax(Math.max(...points.map((point) => point.gatewayTokens + point.directTokens), 0));
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const band = plotWidth / points.length;
  const barWidth = Math.max(Math.min(band * 0.7, 28), 2);
  const y = (value: number) => PLOT.top + plotHeight - (value / max) * plotHeight;
  const totals = points.reduce((sum, point) => ({ gateway: sum.gateway + point.gatewayTokens, direct: sum.direct + point.directTokens }), { gateway: 0, direct: 0 });
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const step = timeline.bucketSeconds >= 86_400 ? "day" : timeline.bucketSeconds >= 3600 ? `${timeline.bucketSeconds / 3600} h` : `${timeline.bucketSeconds / 60} min`;
  const hovered = active === null ? null : points[active] ?? null;

  return <figure className="token-chart" aria-label="Tokens over time">
    <div className="token-chart-legend">
      <span><i className="series-gateway" />Space Gateway <strong>{formatCompact(totals.gateway)}</strong></span>
      <span><i className="series-direct" />Direct <strong>{formatCompact(totals.direct)}</strong></span>
      <small>One bar per {step}</small>
    </div>
    <div className="token-chart-plot" onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
        aria-label={`Tokens per ${step}: ${formatCompact(totals.gateway)} through Space Gateway, ${formatCompact(totals.direct)} direct`}>
        {[0, 0.5, 1].map((share) => <g key={share} className="token-chart-grid">
          <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={y(max * share)} y2={y(max * share)} />
          <text x={PLOT.left - 8} y={y(max * share) + 5} textAnchor="end">{formatCompact(max * share)}</text>
        </g>)}
        {points.map((point, index) => {
          const x = PLOT.left + index * band + (band - barWidth) / 2;
          const gatewayTop = y(point.gatewayTokens);
          const directTop = y(point.gatewayTokens + point.directTokens);
          const gatewayHeight = PLOT.top + plotHeight - gatewayTop;
          // A 2px surface gap separates the two segments.
          const directHeight = Math.max(gatewayTop - directTop - (point.gatewayTokens > 0 ? 2 : 0), 0);
          return <g key={point.at} className={active === index ? "is-active" : undefined}>
            {point.gatewayTokens > 0 && <path className="series-gateway"
              d={point.directTokens > 0 && directHeight > 0 ? `M${x},${gatewayTop}h${barWidth}v${gatewayHeight}h${-barWidth}Z` : topRounded(x, gatewayTop, barWidth, gatewayHeight)} />}
            {directHeight > 0 && <path className="series-direct" d={topRounded(x, directTop, barWidth, directHeight)} />}
            <rect className="token-chart-hit" x={PLOT.left + index * band} y={PLOT.top} width={band} height={plotHeight} tabIndex={0}
              aria-label={`${bucketLabel(point.at, range)}: ${formatCompact(point.gatewayTokens)} Space Gateway, ${formatCompact(point.directTokens)} direct, API value ${formatUsd(point.costUsd)}`}
              onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} />
          </g>;
        })}
        {labelIndexes.map((index) => <text key={index} className="token-chart-axis" x={PLOT.left + index * band + band / 2} y={HEIGHT - 8}
          textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{bucketLabel(points[index]!.at, range)}</text>)}
      </svg>
      {hovered && active !== null && <div className="token-chart-tooltip" role="status"
        style={{ left: `${((PLOT.left + active * band + band / 2) / WIDTH) * 100}%` }}>
        <strong>{bucketLabel(hovered.at, range)}</strong>
        <span><i className="series-gateway" />Space Gateway {hovered.gatewayTokens.toLocaleString()}</span>
        <span><i className="series-direct" />Direct {hovered.directTokens.toLocaleString()}</span>
        <span>API value {formatUsd(hovered.costUsd)}</span>
      </div>}
    </div>
    <details className="token-chart-table">
      <summary>Show as table</summary>
      <table><thead><tr><th>From</th><th>Space Gateway</th><th>Direct</th><th>API value</th></tr></thead><tbody>
        {points.map((point) => <tr key={point.at}><td>{bucketLabel(point.at, range)}</td><td>{point.gatewayTokens.toLocaleString()}</td>
          <td>{point.directTokens.toLocaleString()}</td><td>{formatUsd(point.costUsd)}</td></tr>)}
      </tbody></table>
    </details>
  </figure>;
}

const compositionParts: Array<{ key: keyof Composition; label: string; hint: string }> = [
  { key: "cacheRead", label: "Cache reads", hint: "Prompt read back from the provider's cache (billed at a fraction of input)" },
  { key: "cacheWrite", label: "Cache writes", hint: "Prompt stored in the cache for the next call" },
  { key: "freshInput", label: "Fresh input", hint: "Input billed at the full input price" },
  { key: "output", label: "Output", hint: "Answers, tool calls and thinking" }
];

/** One 100% bar: how much of the period's tokens are cache reads, cache writes, fresh input and output. */
export function TokenCompositionBar({ composition }: { composition: Composition }) {
  const total = compositionParts.reduce((sum, part) => sum + composition[part.key], 0);
  if (total === 0) return null;
  const share = (value: number) => (value / total) * 100;
  const percent = (value: number) => {
    const value100 = share(value);
    return value100 > 0 && value100 < 0.1 ? "< 0.1%" : `${value100.toFixed(1)}%`;
  };
  return <figure className="token-composition" aria-label="What the tokens are">
    <div className="token-composition-bar" role="img" aria-label={compositionParts.map((part) => `${part.label} ${percent(composition[part.key])}`).join(", ")}>
      {/* Each part keeps its color whatever else is empty: color follows the part, never its rank. */}
      {compositionParts.map((part, index) => composition[part.key] > 0 &&
        <span key={part.key} className={`series-${index + 1}`} style={{ flexGrow: composition[part.key] }}
          title={`${part.label}: ${composition[part.key].toLocaleString()} (${percent(composition[part.key])})`} />)}
    </div>
    <ul className="token-composition-legend">
      {compositionParts.map((part, index) => <li key={part.key} title={part.hint}>
        <i className={`series-${index + 1}`} />
        <span>{part.label}</span><strong>{formatCompact(composition[part.key])}</strong><small>{percent(composition[part.key])}</small>
      </li>)}
    </ul>
  </figure>;
}

/** A thin bar inside a card: this row's share of the largest row. */
export function ShareBar({ value, max, tone = "model" }: { value: number; max: number; tone?: "model" | "gateway" | "direct" }) {
  const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 1 : 0) : 0;
  return <span className="token-share" aria-hidden="true"><i className={`is-${tone}`} style={{ width: `${width}%` }} /></span>;
}
