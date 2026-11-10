import { useCallback, useState } from "react";
import { MONITORING_CHART_WINDOWS, type MonitoringChartWindow } from "@space/contracts";
import { api } from "../../api.js";
import { usePanePolling } from "../../use-pane-polling.js";
import { TrendChart, type TrendSeries } from "../space-gateway/gateway-charts.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import type { MonitoringChart, MonitoringCharts } from "./types.js";

const REFRESH_MS = 60_000;

export function formatChartValue(unit: MonitoringChart["unit"], value: number): string {
  if (unit === "percent") return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
  if (unit === "seconds") return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
  if (unit === "rate") return `${value < 10 ? value.toFixed(2) : Math.round(value)}/s`;
  if (unit === "bytes") return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(value / 1024 ** 2)} MiB`;
  return String(Math.round(value * 10) / 10);
}

/** Prometheus points as the trend chart's series; NaN (no traffic to divide by, no histogram samples) leaves a point out. */
export function chartSeries(chart: MonitoringChart): TrendSeries[] {
  return chart.series.map((series, index) => ({
    id: `${chart.id}-${index}`,
    // Each chart groups by one label (job, status or queue), so its value names the line.
    label: Object.values(series.labels)[0] ?? chart.title,
    points: series.points.map(([at, value]) => ({ t: new Date(at * 1000).toISOString(), value: Number(value) })).filter((point) => Number.isFinite(point.value))
  })).filter((series) => series.points.length > 0);
}

/** Charts: Space's own metrics as the collector scrapes them (targets up, requests, errors, p95, memory, load, Nous turns, merge queue), refreshed every minute while shown. */
export function ChartsTab({ paneId, visible }: { paneId: string; visible: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [range, setRange] = useState<MonitoringChartWindow>("6h");
  const [answer, setAnswer] = useState<MonitoringCharts | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setAnswer(await api.monitoringCopilotCharts(paneId, range));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : uiText(language, "The charts could not be read."));
    }
  }, [language, paneId, range]);
  usePanePolling(load, REFRESH_MS, visible, true, `${paneId}:${range}`);
  const shown = answer?.window === range ? answer : null;

  return (
    <div className="mc-charts" role="tabpanel" id="jc-panel-charts" aria-labelledby="jc-tab-charts">
      <div className="jc-actions" role="group" aria-label={t("Chart window")}>
        {MONITORING_CHART_WINDOWS.map((option) => (
          <button key={option} type="button" className={`jc-button${option === range ? " primary" : ""}`} aria-pressed={option === range} onClick={() => setRange(option)}>
            {t("Last {window}", { window: option })}
          </button>
        ))}
        <button type="button" className="jc-button ghost" onClick={() => void load()}>{t("Refresh")}</button>
      </div>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {!shown && !message ? <p className="jc-muted jc-empty">{t("Reading the collector…")}</p> : null}
      {shown?.charts.map((chart) => {
        const series = chartSeries(chart);
        const title = t(chart.title);
        const latest = series.length === 1 ? series[0]!.points.at(-1)!.value : null;
        return (
          <section key={chart.id} className="mc-chart" aria-label={title} data-chart={chart.id}>
            <h3>{title}{latest === null ? null : <span className="mc-chart-now">{formatChartValue(chart.unit, latest)}</span>}</h3>
            {chart.error ? <p className="jc-message" role="status">{chart.error}</p>
              : series.length ? <TrendChart series={series} label={title} height={120} formatValue={(value) => formatChartValue(chart.unit, value)} />
              : <p className="jc-muted jc-empty">{t("No data in this window.")}</p>}
          </section>
        );
      })}
    </div>
  );
}
