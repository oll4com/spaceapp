import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { scoreQuery, scoreHistoryQuery, NOUS_SCORE_POLL_MS } from "./nous-score-query.js";
import type { NousScoreRange, NousScoreTile } from "@space/contracts";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockChips, DockState } from "../dock-kit/DockKit.js";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import { Star } from "../ui-theme/app-icons.js";
import { rangeFits, useHistoryPeriodDays } from "../history-period/use-history-period.js";
import { LoadWave } from "./NousLoad.js";
import { useNousUiState } from "./nous-ui-state.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import "./nous-load.css";

/**
 * Score (operator 3/11 23:11 BKK, plan clipboard:1NF6u6gcCwtj): Nous's performance as points that can go negative. Operator 5/11 10:36 BKK:
 * compact, in the Load style (the score with its 24 h and 7 day change, the graph, then ONE list of what gives and costs points, biggest cost
 * first; the bottom breakdown that repeated it is gone), and the least load: a still graph, reads only while the tab is shown and focused.
 * A row's detail and items open only when clicked (operator rule 3/11 12:25: nothing expands or takes focus by itself).
 */
const RANGES: Array<{ id: NousScoreRange; label: string }> = [{ id: "24h", label: "24 h" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }];
const isRange = (value: unknown): value is NousScoreRange => RANGES.some((option) => option.id === value);
const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : "The score could not be read.";
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${(Math.abs(Math.round(value * 10) / 10)).toLocaleString("en-US")}`;
const tone = (value: number) => value < 0 ? " is-negative" : value > 0 ? " is-positive" : "";

/** The one list: costs first, biggest share of the negative first, then what gives points, biggest first; each cost with its share. */
export function scoreRows(tiles: NousScoreTile[]): Array<NousScoreTile & { share: number | null }> {
  const lost = tiles.reduce((sum, tile) => sum + Math.min(0, tile.points), 0);
  const rank = (tile: NousScoreTile) => tile.points < 0 ? 0 : tile.points > 0 ? 1 : 2;
  return [...tiles].sort((a, b) => rank(a) - rank(b) || Math.abs(b.points) - Math.abs(a.points))
    .map((tile) => ({ ...tile, share: tile.points < 0 && lost < 0 ? tile.points / lost * 100 : null }));
}

/** Visible and focused: the tab reads nothing while the window is behind another one or the page is hidden. */
function useForeground(): boolean {
  const read = () => typeof document === "undefined" || (document.visibilityState === "visible" && document.hasFocus());
  const [foreground, setForeground] = useState(read);
  useEffect(() => {
    const update = () => setForeground(read());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); window.removeEventListener("blur", update); };
  }, []);
  return foreground;
}

export function NousScore({ active }: { active: boolean }) {
  const [chosen, setRange] = useNousUiState<NousScoreRange>("score.range", "24h", isRange);
  const historyDays = useHistoryPeriodDays();
  const language = useUiLanguage();
  const range = rangeFits(chosen, historyDays) ? chosen : "24h";
  const [open, setOpen] = useState<NousScoreTile["key"] | null>(null);
  const foreground = useForeground();
  const queries = useQueryClient();
  const scoreRequest = useQuery({ ...scoreQuery(), enabled: active, refetchInterval: active && foreground ? NOUS_SCORE_POLL_MS : false });
  const historyRequest = useQuery({ ...scoreHistoryQuery(range), enabled: active });
  const score = scoreRequest.data;
  const history = historyRequest.data;
  // A newer score is a newer snapshot: only then is the history read again (every range, the shown one at once).
  const seenAt = useRef<string | null>(null);
  useEffect(() => {
    const at = score?.at ?? null;
    if (at && seenAt.current && at !== seenAt.current) void queries.invalidateQueries({ queryKey: ["nous", "score", "history"] });
    if (at) seenAt.current = at;
  }, [score?.at, queries]);
  const failure = scoreRequest.error ?? historyRequest.error;
  const error = failure ? messageOf(failure) : null;

  const values = useMemo(() => history?.points.map((point) => point.value) ?? (score ? [score.score] : []), [history, score]);
  // The graph's floor and top hold zero and every point, with a little room around them.
  const bounds = useMemo((): [number, number] => {
    const low = Math.min(0, ...values), high = Math.max(0, ...values);
    const pad = Math.max(5, (high - low) * 0.1);
    return [low - pad, high + pad];
  }, [values]);
  const rows = useMemo(() => score ? scoreRows(score.tiles) : [], [score]);
  if (!score) return error ? <DockState kind="error" icon={Star} title="The score could not be read" detail={error} /> : <DockState kind="loading" icon={Star} title="Reading the score" />;
  const widest = Math.max(1, ...rows.map((row) => Math.abs(row.points)));
  return (
    <section className={`nous-load nous-score${score.score < 0 ? " is-negative" : ""}`} aria-label="Score">
      <header className="nous-score-head" aria-live="polite">
        <p className={`nous-load-percent nous-score-value${tone(score.score)}`}>
          {score.score < 0 ? <span>−</span> : null}<AnimatedNumber value={Math.abs(Math.round(score.score))} /><span>pts</span>
        </p>
        <p className="nous-score-changes" aria-label="Changes">
          <Change label="24 h" value={score.change24h} />
          <Change label="7 d" value={score.change7d} />
        </p>
        {score.resetAt ? <p className="nous-score-reset">{uiText(language, "Since reset")} {new Date(score.resetAt).toLocaleString()}</p> : null}
      </header>
      <DockChips label="Score range" value={range} onChange={setRange} options={RANGES.filter((option) => rangeFits(option.id, historyDays))} />
      <div className="nous-load-graph">
        <LoadWave values={values} target={0} bounds={bounds} animate={false}
          label={`Score over the last ${range === "24h" ? "24 hours" : range === "7d" ? "7 days" : "30 days"}; ${signed(score.score)} now`} />
      </div>
      <ul className="nous-score-tiles" aria-label="Breakdown">
        {rows.map((row) => {
          const expanded = open === row.key;
          return (
            <li key={row.key} className={expanded ? "is-open" : undefined}>
              <button type="button" className="nous-score-tile" aria-expanded={expanded} aria-controls={`nous-score-${row.key}`}
                onClick={() => setOpen(expanded ? null : row.key)}>
                <span className="nous-load-part-label">{uiText(language, row.label)}</span>
                <span className={`nous-load-part-value${tone(row.points)}`}>{signed(row.points)}</span>
                <span className="nous-score-share">{row.share === null ? "" : row.share < 0.5 ? "<1 %" : `${Math.round(row.share)} %`}</span>
                <span className={`nous-load-bar${tone(row.points)}`} aria-hidden="true"><span style={{ width: `${(Math.abs(row.points) / widest) * 100}%` }} /></span>
              </button>
              {expanded ? (
                <div id={`nous-score-${row.key}`} className="nous-score-more">
                  <p className="nous-load-part-detail">{row.share === null ? "" : `${row.share < 0.5 ? "<1" : Math.round(row.share)} % of the negative · `}{row.detail}</p>
                  {row.items.length ? (
                    <ol className="nous-score-items" aria-label={`${row.label}: what gives or costs these points`}>
                      {row.items.map((item, index) => (
                        <li key={`${item.id ?? "item"}-${index}`}>
                          <span className="nous-score-item-label">{item.label}{item.id ? <small> {item.id}</small> : null}</span>
                          <span className={`nous-load-part-value${tone(item.points)}`}>{signed(item.points)}</span>
                          <span className="nous-load-part-detail">{item.detail}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <footer className="nous-load-footer">
        <span>Recomputed every 15 minutes and 2 minutes after you write; kept 30 days</span>
        <span>{error ? error : `Updated ${formatUserTime(score.at)}`}</span>
      </footer>
    </section>
  );
}

function Change({ label, value }: { label: string; value: number | null }) {
  const trend = value === null ? null : value > 0.4 ? "up" : value < -0.4 ? "down" : "flat";
  return (
    <span className={`nous-score-change${trend ? ` is-${trend}` : ""}`}
      aria-label={value === null ? `${label}: no data yet` : trend === "flat" ? `${label}: about the same` : `${label}: ${trend} ${Math.abs(Math.round(value * 10) / 10)} points`}>
      {trend === "up" ? "▲ " : trend === "down" ? "▼ " : ""}{value === null ? "–" : signed(value)} <small>{label}</small>
    </span>
  );
}
