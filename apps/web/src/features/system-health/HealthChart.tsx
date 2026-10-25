import type { SystemHealthSeries } from "@space/contracts";
import { formatHealthValue } from "./health-model.js";

export function HealthChart({
  series,
  compact = false,
  percent = false,
  rangeSeconds = 60,
  endAt,
}: {
  series: SystemHealthSeries[];
  compact?: boolean;
  percent?: boolean;
  rangeSeconds?: number;
  endAt?: string;
}) {
  const entries = series.filter((s) => s.points.length);
  if (!entries.length)
    return (
      <div className={`health-chart-empty${compact ? " is-compact" : ""}`}>
        {compact ? "" : "History starts with the first available sample."}
      </div>
    );
  const width = 720,
    height = compact ? 100 : 230;
  const end = endAt
    ? Date.parse(endAt)
    : Math.max(
        ...entries.flatMap((s) => s.points.map((p) => Date.parse(p.at))),
      );
  const start = end - rangeSeconds * 1000;
  const max = percent
    ? 100
    : Math.max(1, ...entries.flatMap((s) => s.points.map((p) => p.max)));
  const colors = [
    "var(--health-ok)",
    "#528fef",
    "#a774df",
    "var(--health-warn)",
  ];
  return (
    <div className={`health-chart${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="health-chart-axis">
          <span>{formatHealthValue(max, entries[0]!.unit)}</span>
          <span>0</span>
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={entries.map((s) => s.label).join(" and ")}
      >
        {!compact && (
          <g className="health-chart-grid">
            {Array.from({ length: 13 }, (_, i) => (
              <line key={`x${i}`} x1={i * 60} x2={i * 60} y1={0} y2={height} />
            ))}
            {Array.from({ length: 6 }, (_, i) => (
              <line
                key={`y${i}`}
                x1={0}
                x2={width}
                y1={(i * height) / 5}
                y2={(i * height) / 5}
              />
            ))}
          </g>
        )}
        {entries.map((s, index) => {
          const points = s.points.filter(
            (p) => Date.parse(p.at) >= start && Date.parse(p.at) <= end,
          );
          const gap =
            rangeSeconds > 7 * 86400
              ? 7200_000
              : rangeSeconds > 86400
                ? 1800_000
                : 30_000;
          const segments: (typeof points)[] = [];
          for (const point of points) {
            const current = segments.at(-1);
            if (
              !current ||
              Date.parse(point.at) - Date.parse(current.at(-1)!.at) > gap
            )
              segments.push([point]);
            else current.push(point);
          }
          return (
            <g key={s.id} style={{ color: colors[index % colors.length] }}>
              {segments.map((segment, n) => {
                const xy = segment.map((p) => ({
                  x:
                    ((Date.parse(p.at) - start) / (rangeSeconds * 1000)) *
                    width,
                  y: height - 4 - Math.min(1, p.avg / max) * (height - 8),
                }));
                return (
                  <g key={n}>
                    {!compact && (
                      <polygon
                        points={`${xy[0]!.x},${height} ${xy.map((p) => `${p.x},${p.y}`).join(" ")} ${xy.at(-1)!.x},${height}`}
                        fill="currentColor"
                        opacity=".09"
                      />
                    )}
                    <polyline
                      points={xy.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={compact ? 5 : 2}
                      vectorEffect="non-scaling-stroke"
                    />
                    {xy.length === 1 && (
                      <circle
                        cx={xy[0]!.x}
                        cy={xy[0]!.y}
                        r={3}
                        fill="currentColor"
                      />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {!compact && (
        <div className="health-chart-times">
          <span>
            {rangeSeconds >= 86400
              ? new Date(start).toLocaleDateString()
              : new Date(start).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
          </span>
          <span>
            {rangeSeconds >= 86400
              ? new Date(end).toLocaleDateString()
              : new Date(end).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
          </span>
        </div>
      )}
      {!compact && (
        <div className="health-chart-legend">
          {entries.map((s, i) => (
            <span key={s.id}>
              <i style={{ background: colors[i % colors.length] }} />
              {s.label}
            </span>
          ))}
          <small>
            Latest{" "}
            {rangeSeconds === 60
              ? "60 seconds"
              : rangeSeconds < 86400
                ? `${Math.round(rangeSeconds / 60)} minutes`
                : `${Math.round(rangeSeconds / 86400)} days`}
          </small>
        </div>
      )}
    </div>
  );
}
