import { useEffect, useMemo, useState } from "react";
import { tokenUsageTotal, type TokenUsageBreakdown, type TokenUsageFigures, type TokenUsagePeriod } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockChips } from "../dock-kit/DockKit.js";
import { rangeFits, useHistoryPeriodDays } from "../history-period/use-history-period.js";
import { LoadWave } from "./NousLoad.js";
import { useNousUiState } from "./nous-ui-state.js";
import "./nous-load.css";

/**
 * Token usage (operator 5/11 17:26 BKK, plan clipboard:qH5emwVaV6yO): who consumed the tokens per day, week and month: each process (Nous
 * turn kinds, panes, copilots), each provider (never per account: operator 6/11), a graph per day in the Load tab's style, and what grew against the span before.
 * GET /api/nous/token-usage reads Space Gateway's request logs (a minute's cache); Nous reads the same through space_token_usage.
 */
const PERIODS: Array<{ id: TokenUsagePeriod; label: string; days: string }> = [
  { id: "day", label: "Day", days: "1d" }, { id: "week", label: "Week", days: "7d" }, { id: "month", label: "Month", days: "30d" }];
const isPeriod = (value: unknown): value is TokenUsagePeriod => PERIODS.some((option) => option.id === value);
const SPAN: Record<TokenUsagePeriod, string> = { day: "today so far", week: "the last 7 days", month: "the last 30 days" };
const fmt = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(Math.round(value));
const usd = (value: number) => `$${value >= 100 ? value.toFixed(0) : value.toFixed(2)}`;

export function NousTokenUsage({ active }: { active: boolean }) {
  const [chosen, setPeriod] = useNousUiState<TokenUsagePeriod>("tokenUsage.period", "day", isPeriod);
  const historyDays = useHistoryPeriodDays();
  const period = rangeFits(PERIODS.find((option) => option.id === chosen)!.days, historyDays) ? chosen : "day";
  const [data, setData] = useState<TokenUsageBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const read = () => void api.nousTokenUsage(period).then((next) => { if (!stopped) { setData(next); setError(null); } },
      (failure: unknown) => { if (!stopped) setError(failure instanceof Error && failure.message ? failure.message : "Token usage could not be read."); });
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, 60_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, period]);
  const shown = data?.period === period ? data : null;
  const daily = useMemo(() => shown?.days.map((day) => Object.values(day.providers).reduce((sum, value) => sum + value, 0)) ?? [], [shown]);

  return (
    <section className="nous-load nous-token-usage" aria-label="Token usage">
      <h3>Token usage</h3>
      <DockChips label="Token usage period" value={period} onChange={setPeriod}
        options={PERIODS.filter((option) => rangeFits(option.days, historyDays)).map(({ id, label }) => ({ id, label }))} />
      {!shown ? <p className="nous-muted">{error ?? "Reading token usage…"}</p> : <TokenUsageView data={shown} daily={daily} animate={active} />}
    </section>
  );
}

function TokenUsageView({ data, daily, animate }: { data: TokenUsageBreakdown; daily: number[]; animate: boolean }) {
  const total = tokenUsageTotal(data.totals);
  const before = tokenUsageTotal(data.previousTotals);
  const change = before ? Math.round((total / before - 1) * 100) : null;
  const top = Math.max(1, ...daily);
  return <>
    <div className="nous-load-main">
      <div className="nous-load-graph">
        <LoadWave values={daily.length ? daily : [0]} target={top} bounds={[0, top]} animate={animate}
          label={`Tokens per day over ${SPAN[data.period]}: ${daily.map(fmt).join(", ")}`} />
      </div>
      <div className="nous-load-now">
        <p className="nous-load-percent">{fmt(total)}</p>
        <p className="nous-muted">tokens {SPAN[data.period]} · {data.totals.requests.toLocaleString("en-US")} requests · {usd(data.totals.costUsd)}</p>
        {change !== null ? <p className="nous-muted">{change >= 0 ? "▲" : "▼"} {Math.abs(change)}% against the same span before ({fmt(before)})</p> : null}
        <p className="nous-muted">Input {fmt(data.totals.inputTokens)}, of it cache re-read {fmt(data.totals.cachedInputTokens)} · output {fmt(data.totals.outputTokens)}</p>
      </div>
    </div>
    <Bars title="By process" total={total} rows={data.processes.map((row) => ({ ...row, name: row.label, note: row.detail }))} />
    <Bars title="By provider" total={total} rows={data.providers.map((row) => ({ ...row, name: row.key, note: null }))} />
    <h4>Grew most against the span before</h4>
    {data.risers.length ? <ul className="nous-token-risers">
      {data.risers.map((row) => <li key={row.key}><span>{row.label}</span><span>{fmt(row.before)} → {fmt(row.tokens)}</span></li>)}
    </ul> : <p className="nous-muted">Nothing grew.</p>}
    <footer className="nous-load-footer">
      <span>Space Gateway request logs · days in {data.timeZone}</span>
      <span>Updated {formatUserTime(data.until)}</span>
    </footer>
  </>;
}

type BarRow = TokenUsageFigures & { key: string; name: string; note: string | null; parts?: Array<TokenUsageFigures & { label: string }> };

function Bars({ title, total, rows }: { title: string; total: number; rows: BarRow[] }) {
  return <>
    <h4>{title}</h4>
    <BarList label={title} total={total} rows={rows} />
  </>;
}

/** A category's parts (each CLI outside panes, CLI panes without a pane tag...) show as a nested list under its row. */
function BarList({ label, total, rows }: { label: string; total: number; rows: BarRow[] }) {
  return (
    <ul className="nous-load-parts" aria-label={label}>
      {rows.map((row) => {
        const tokens = tokenUsageTotal(row);
        const share = total ? tokens / total * 100 : 0;
        return (
          <li key={row.key} title={`${row.requests.toLocaleString("en-US")} requests · input ${fmt(row.inputTokens)} (cache re-read ${fmt(row.cachedInputTokens)}, cache write ${fmt(row.cacheCreationTokens)}) · output ${fmt(row.outputTokens)} · ${fmt(row.requests ? row.inputTokens / row.requests : 0)} a request · ${usd(row.costUsd)}`}>
            <span className="nous-load-part-label">{row.name}</span>
            <span className="nous-load-part-value">{fmt(tokens)}</span>
            <span className="nous-load-bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
            <span className="nous-load-part-detail">{share.toFixed(1)}% · {row.requests.toLocaleString("en-US")} req · {fmt(row.requests ? row.inputTokens / row.requests : 0)}/req · {usd(row.costUsd)}{row.note ? ` · ${row.note}` : ""}</span>
            {row.parts?.length ? <BarList label={`${row.name} by part`} total={total}
              rows={row.parts.map((part) => ({ ...part, key: part.label, name: part.label, note: null }))} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
