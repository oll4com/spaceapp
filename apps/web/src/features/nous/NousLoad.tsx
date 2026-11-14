import { useEffect, useMemo, useRef, useState } from "react";
import type { NousLoad as NousLoadView, NousLoadAverage, NousLoadRange } from "@space/contracts";
import { api, type InstanceLink } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockChips, DockState } from "../dock-kit/DockKit.js";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import { ChartSpline } from "../ui-theme/app-icons.js";
import { rangeFits, useHistoryPeriodDays } from "../history-period/use-history-period.js";
import { useNousUiState } from "./nous-ui-state.js";
import { frameLoop } from "../../window-idle.js";
import "./nous-load.css";

/**
 * Load (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server's capacity and of the token pools Nous and its
 * agents use, as a flowing graph with no numbers on it; the numbers sit beside it. The last answer per range shows at once (localStorage),
 * then GET /api/nous/load refreshes it every 10 s while the tab is open; the graph moves only while it is shown.
 */
const RANGES: Array<{ id: NousLoadRange; label: string }> = [{ id: "1h", label: "1 h" }, { id: "24h", label: "24 h" }, { id: "7d", label: "7 days" }, { id: "30d", label: "30 days" }];
const RANGE_WORDS: Record<NousLoadRange, string> = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days" };
const POLL_MS = 10_000;
const isRange = (value: unknown): value is NousLoadRange => RANGES.some((option) => option.id === value);
const cacheKey = (range: NousLoadRange) => `space.nous.load.v1:${range}`;
const cached = (range: NousLoadRange): NousLoadView | null => {
  try { return JSON.parse(localStorage.getItem(cacheKey(range)) ?? "null") as NousLoadView | null; } catch { return null; }
};
const keep = (range: NousLoadRange, load: NousLoadView) => { try { localStorage.setItem(cacheKey(range), JSON.stringify(load)); } catch { /* storage full or off: the next read refreshes */ } };
const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : "The load could not be read.";
const whole = (value: number | null) => value === null ? "–" : `${Math.round(value)}%`;

export function NousLoad({ active }: { active: boolean }) {
  // The range stays as the operator left it (nous_msg:40a252b1); one longer than the history period reads as the last hour.
  const [chosen, setRange] = useNousUiState<NousLoadRange>("load.range", "1h", isRange);
  const historyDays = useHistoryPeriodDays();
  const range = rangeFits(chosen, historyDays) ? chosen : "1h";
  const [load, setLoad] = useState<NousLoadView | null>(() => cached(range));
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setShown(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const read = () => void api.nousLoad(range).then((next) => {
      if (stopped) return;
      setLoad(next);
      setError(null);
      keep(range, next);
    }, (failure: unknown) => { if (!stopped) setError(messageOf(failure)); });
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, range]);

  const pick = (next: NousLoadRange) => { setRange(next); setLoad(cached(next)); };
  const values = useMemo(() => load?.series.map((point) => point.value) ?? [], [load]);
  if (!load) return error ? <DockState kind="error" icon={ChartSpline} title="The load could not be read" detail={error} /> : <DockState kind="loading" icon={ChartSpline} title="Reading the load" />;
  const overall = load.overall ?? 0;
  const { averages } = load;
  return (
    <section className="nous-load" aria-label="Load">
      <DockChips label="Load range" value={range} onChange={pick} options={RANGES.filter((option) => rangeFits(option.id, historyDays))} />
      <div className="nous-load-main">
        <div className="nous-load-graph">
          <LoadWave values={values} target={load.target} animate={active && shown}
            label={`Share of capacity in use over ${RANGE_WORDS[range]}; ${whole(load.overall)} now, target ${load.target}%`} />
        </div>
        <div className="nous-load-now" aria-live="polite">
          <p className="nous-load-percent"><AnimatedNumber value={Math.round(overall)} /><span>%</span></p>
          <p className="nous-muted">of capacity in use · target {load.target}%{load.targetMode ? ` · ${load.targetMode}` : ""}</p>
          {load.host ? <p className="nous-muted">Physical host: {load.host} · OVERLOADED only past 90%</p> : null}
          {load.limit ? <p className="nous-load-limit">At a limit: {load.limit}</p>
            : load.overall !== null ? <p className="nous-load-headroom">{overall < load.target ? `${Math.round(load.target - overall)}% headroom to use` : "At or above the target"}</p> : null}
        </div>
      </div>
      <ul className="nous-load-parts" aria-label="Parts">
        {load.parts.map((part) => (
          <li key={part.key} title={part.detail}>
            <span className="nous-load-part-label">{part.label}</span>
            <span className="nous-load-bar" aria-hidden="true"><span style={{ width: `${part.percent ?? 0}%` }} /></span>
            <span className="nous-load-part-value">{whole(part.percent)}</span>
            <span className="nous-load-part-detail">{part.detail}</span>
          </li>
        ))}
      </ul>
      <LinkedLoads active={active} range={range} local={load.overall} />
      <dl className="nous-load-averages" aria-label="Averages">
        <Average label="Last hour" average={averages.hour} versus="the hour before" />
        <Average label="Today" average={averages.today} versus="yesterday" />
        <Average label="7 days" average={averages.week} versus="the 7 days before" />
        <Average label="30 days" average={averages.month} versus="the 30 days before" />
      </dl>
      <footer className="nous-load-footer">
        <span>{averages.bestDay ? `Best day ${averages.bestDay.day}: ${Math.round(averages.bestDay.value)}%` : "No full day yet"}</span>
        <span>{error ? error : load.at ? `Updated ${formatUserTime(load.at)}` : "No sample yet"}</span>
      </footer>
    </section>
  );
}

type LinkedLoad = { link: InstanceLink; load: NousLoadView | null; error: string | null; last: NousLoadView | null };
/** A linked SpaceApp answers through its link's round trip (instance-link/routes.ts), so it is read less often than this one. */
const LINK_POLL_MS = 30_000;

/**
 * Space Link Λ7 (ADR-014): each SpaceApp this Nous manages, with its own load, and the average over all of them. One that does not
 * answer keeps its last reading, marked stale. Nothing shows without links.
 * shortcut: an equal-weight average and no token-pool deduplication across SpaceApps on the same accounts; upgrade when pools are shared.
 */
function LinkedLoads({ active, range, local }: { active: boolean; range: NousLoadRange; local: number | null }) {
  const [rows, setRows] = useState<LinkedLoad[]>([]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const read = () => void api.linkedLoads(range).then(({ instances }) => {
      if (!stopped) setRows((before) => (instances ?? []).map((row) => ({ ...row, last: row.load ?? before.find((old) => old.link.id === row.link.id)?.last ?? null })));
    }, () => undefined);
    read();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") read(); }, LINK_POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, range]);
  if (!rows.length) return null;
  const readings = [local, ...rows.map((row) => row.load?.overall ?? null)].filter((value): value is number => value !== null);
  const total = readings.length ? readings.reduce((sum, value) => sum + value, 0) / readings.length : null;
  return (
    <section className="nous-load-linked" aria-label="Linked SpaceApps">
      <p><strong>{whole(total)}</strong> average over this SpaceApp and {rows.length} linked</p>
      <ul>
        {rows.map(({ link, load, error, last }) => (
          <li key={link.id} title={link.origins.join(", ")}>
            <span>{link.label}</span>
            {load ? <span>{whole(load.overall)}{load.level ? ` · ${load.level}` : ""}{load.at ? ` · ${formatUserTime(load.at)}` : ""}</span>
              : <span className="nous-load-stale">{last ? `${whole(last.overall)}${last.at ? ` at ${formatUserTime(last.at)}` : ""}, stale: ` : ""}{error}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Average({ label, average, versus }: { label: string; average: NousLoadAverage; versus: string }) {
  const change = average.value !== null && average.previous !== null ? Math.round((average.value - average.previous) * 10) / 10 : null;
  const trend = change === null ? null : change > 0.4 ? "up" : change < -0.4 ? "down" : "flat";
  return (
    <div className="nous-load-average">
      <dt>{label}</dt>
      <dd>
        <strong>{whole(average.value)}</strong>
        {trend ? <span className={`nous-load-trend is-${trend}`} title={`${change! > 0 ? "+" : ""}${change} points from ${versus}`}
          aria-label={`${trend === "flat" ? "about the same as" : `${trend} ${Math.abs(change!)} points from`} ${versus}`}>
          {trend === "up" ? "▲" : trend === "down" ? "▼" : "▬"}{trend === "flat" ? "" : ` ${Math.abs(change!)}`}</span> : null}
      </dd>
    </div>
  );
}

/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
function curve(context: CanvasRenderingContext2D, points: Array<[number, number]>) {
  context.moveTo(points[0]![0], points[0]![1]);
  for (let index = 0; index < points.length - 1; index += 1) {
    const [p0, p1, p2, p3] = [points[index - 1] ?? points[index]!, points[index]!, points[index + 1]!, points[index + 2] ?? points[index + 1]!];
    context.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
}
const rgba = (color: string, alpha: number) => {
  const [r = 120, g = 140, b = 255] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * The graph: a filled wave whose crest ripples, a light sweeping across it and a pulse on the newest point; the target is a dashed line.
 * No text is drawn. About 30 frames a second, only while `animate` (the tab open and the page shown) and never under reduced motion.
 */
export function LoadWave({ values, target, animate, label, bounds = [0, 100] }: { values: number[]; target: number; animate: boolean; label: string;
  /** The values at the floor and the top (the Score view's go negative); the dashed line is `target`. */
  bounds?: [number, number] }) {
  const [low, high] = bounds;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // A new series morphs from the one drawn before over 0.8 s.
  const morph = useRef({ from: values, to: values, started: 0 });
  useEffect(() => {
    const current = morph.current;
    morph.current = { from: current.to.length === values.length ? current.to : values, to: values, started: performance.now() };
  }, [values]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext?.("2d");
    if (!canvas || !context) return;
    let last = 0;
    const draw = (time: number) => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (!width || !height) return;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const color = getComputedStyle(canvas).color;
      const { from, to, started } = morph.current;
      const progress = Math.min(1, (time - started) / 800);
      const ease = 1 - (1 - progress) ** 3;
      const shown = to.map((value, index) => (from[index] ?? value) + (value - (from[index] ?? value)) * ease);
      const pad = 6;
      const y = (value: number) => height - pad - ((Math.min(high, Math.max(low, value)) - low) / (high - low || 1)) * (height - 2 * pad);
      // The target and the floor: a dashed line and a hairline, no labels.
      context.setLineDash([4, 6]);
      context.strokeStyle = rgba(color, 0.35);
      context.lineWidth = 1;
      context.beginPath(); context.moveTo(0, y(target)); context.lineTo(width, y(target)); context.stroke();
      context.setLineDash([]);
      context.strokeStyle = rgba(color, 0.12);
      context.beginPath(); context.moveTo(0, y(low)); context.lineTo(width, y(low)); context.stroke();
      const series = shown.length > 1 ? shown : [shown[0] ?? low, shown[0] ?? low];
      const step = width / (series.length - 1);
      // The crest ripples a little, flowing left to right; the data stays where it is.
      const ripple = (x: number) => animate ? Math.sin(x / 26 - time / 700) * 1.6 : 0;
      const points = series.map((value, index): [number, number] => [index * step, y(value) + ripple(index * step)]);
      const fill = context.createLinearGradient(0, pad, 0, height);
      fill.addColorStop(0, rgba(color, 0.5)); fill.addColorStop(1, rgba(color, 0.02));
      context.beginPath(); curve(context, points); context.lineTo(width, height); context.lineTo(0, height); context.closePath();
      context.fillStyle = fill; context.fill();
      if (animate) {
        // A soft light sweeps across the area every 6 s.
        const sweep = ((time / 6_000) % 1) * (width + 160) - 80;
        const light = context.createLinearGradient(sweep - 80, 0, sweep + 80, 0);
        light.addColorStop(0, rgba(color, 0)); light.addColorStop(0.5, rgba(color, 0.22)); light.addColorStop(1, rgba(color, 0));
        context.save(); context.beginPath(); curve(context, points); context.lineTo(width, height); context.lineTo(0, height); context.closePath(); context.clip();
        context.fillStyle = light; context.fillRect(0, 0, width, height); context.restore();
      }
      context.beginPath(); curve(context, points);
      context.strokeStyle = color; context.lineWidth = 2; context.shadowColor = rgba(color, 0.6); context.shadowBlur = 8; context.stroke(); context.shadowBlur = 0;
      const [headX, headY] = points.at(-1)!;
      const pulse = animate ? (time % 1_600) / 1_600 : 0;
      if (animate) { context.beginPath(); context.arc(headX - 3, headY, 3 + pulse * 9, 0, Math.PI * 2); context.fillStyle = rgba(color, 0.35 * (1 - pulse)); context.fill(); }
      context.beginPath(); context.arc(headX - 3, headY, 3, 0, Math.PI * 2); context.fillStyle = color; context.fill();
    };
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const tick = (time: number) => {
      if (time - last >= 33) { last = time; draw(time); }
    };
    if (animate && !reduced) return frameLoop(tick);
    else {
      // Still: draw once, again when the series' morph ends, and on resize.
      draw(performance.now() + 800);
      const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => draw(performance.now() + 800));
      resize?.observe(canvas);
      return () => resize?.disconnect();
    }
  }, [animate, target, values, low, high]);
  return <canvas ref={canvasRef} className="nous-load-canvas" role="img" aria-label={label} />;
}
