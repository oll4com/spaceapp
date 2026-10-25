import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { NousOverview, SystemHealthSnapshot } from "@space/contracts";
import { api } from "../../api.js";
import { useDesktopWidgets } from "../desktop-widgets/widget-storage.js";
import type { DesktopWidgetId } from "../desktop-widgets/types.js";
import { useWidgetsVisibility } from "../desktop-widgets/use-widgets-visibility.js";
import { modeIcons } from "../pane-card/pane-mode-icons.js";
import { OPEN_YOUTUBE_FLOAT_EVENT } from "../pane-card/use-youtube-float-request.js";
import { OPEN_VIBE_MUSIC_EVENT } from "../room-toolbar/useToolbarPopovers.js";
import { loadPlanCompletion, PlanCompletionBar, type PlanCompletion } from "../clipboard-dock/PlanCompletionBar.js";
import { formatHealthValue } from "../system-health/health-model.js";
import { measureHealthRtt } from "../system-health/measure-health-rtt.js";
import { Cpu, Gauge, LayoutDashboard, MemoryStick, Music2, Network, Sparkles } from "../ui-theme/app-icons.js";

/**
 * The Nous dock's live stats (operator request 2026-10-17, plan clipboard:wr9yNPJwkDrp): rooms, agents by state, agents on a
 * plan, and the health rail's system figures as tiles with short sparklines. Read only: the snapshot and connection check the
 * rail itself uses, every 10 s while shown; rooms and agents come with Nous's overview.
 */
const SAMPLE_MS = 10_000;
const KEEP = 30;

interface Tile { id: string; label: string; icon: ComponentType<{ "aria-hidden"?: boolean | "true" }>; value: string; level: number | null }

function useSystemFigures(active: boolean) {
  const [snapshot, setSnapshot] = useState<SystemHealthSnapshot | null>(null);
  const [rtt, setRtt] = useState<number | null>(null);
  const [quota, setQuota] = useState<number | null>(null);
  const [history, setHistory] = useState<{ cpu: number[]; memory: number[] }>({ cpu: [], memory: [] });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let tick = 0;
    const sample = async () => {
      const [next, latency] = await Promise.all([api.systemHealth(true).catch(() => null), measureHealthRtt().catch(() => null)]);
      if (cancelled) return;
      if (next) {
        setSnapshot(next);
        const value = (id: string) => (next.metrics ?? []).find((metric) => metric.id === id)?.value ?? null;
        setHistory((current) => ({
          cpu: [...current.cpu, value("cpu") ?? 0].slice(-KEEP), memory: [...current.memory, value("memory") ?? 0].slice(-KEEP)
        }));
      }
      setRtt(latency);
      // The account figure changes slowly; the rail reads it once a minute too (a shared, cached request).
      if (tick++ % 6 === 0) {
        const environment = await api.codexEnvironment().catch(() => null);
        if (!cancelled) setQuota(environment?.lbUsage?.activeAccountsRemainingPercent ?? environment?.lbUsage?.allAccountsRemainingPercent ?? null);
      }
    };
    void sample();
    const timer = window.setInterval(() => void sample(), SAMPLE_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active]);
  return { snapshot, rtt, quota, history };
}

function Sparkline({ label, points, max }: { label: string; points: number[]; max?: number }) {
  if (points.length < 2) return <span className="nous-spark is-empty" aria-hidden="true" />;
  const top = max ?? Math.max(1, ...points);
  const path = points.map((value, index) => `${(index / (points.length - 1)) * 100},${30 - (Math.min(value, top) / top) * 28}`).join(" ");
  return (
    <svg className="nous-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`${label}, last ${points.length} samples`}>
      <polyline points={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function NousLiveStats({ overview, active }: { overview: NousOverview | null; active: boolean }) {
  const { snapshot, rtt, quota, history } = useSystemFigures(active);
  const live = overview?.live;
  const running = useRef<number[]>([]);
  const last = useRef<NousOverview | null>(null);
  if (overview && overview !== last.current && live) { last.current = overview; running.current = [...running.current, live.agents.running].slice(-KEEP); }
  const metric = (id: string) => (snapshot?.metrics ?? []).find((entry) => entry.id === id)?.value ?? null;
  const percent = (value: number | null) => value == null ? null : Math.max(0, Math.min(100, value));
  const tiles: Tile[] = [
    { id: "quota", label: "Account remaining", icon: Gauge, value: formatHealthValue(quota, "PERCENT"), level: percent(quota) },
    { id: "memory", label: "Memory", icon: MemoryStick, value: formatHealthValue(metric("memory"), "PERCENT"), level: percent(metric("memory")) },
    { id: "cpu", label: "CPU", icon: Cpu, value: formatHealthValue(metric("cpu"), "PERCENT"), level: percent(metric("cpu")) },
    { id: "rtt", label: "Connection latency", icon: Network, value: formatHealthValue(rtt, "MILLISECONDS"), level: null },
    { id: "agents", label: "Agents running of all", icon: LayoutDashboard, value: live ? `${live.agents.running}/${live.agents.total}` : "—", level: null }
  ];
  const onPlans = plansOnPanes(overview);
  return (
    <section className="nous-live" aria-label="Live stats" data-motion={active ? "on" : "off"}>
      <h3>Live</h3>
      <NousLivePlans overview={overview} active={active}>
        <dl className="nous-live-counts">
          <div><dt>Rooms</dt><dd>{live ? live.rooms : "—"}</dd></div>
          <div><dt>Running</dt><dd>{live ? live.agents.running : "—"}</dd></div>
          <div><dt>Idle</dt><dd>{live ? live.agents.idle : "—"}</dd></div>
          <div className={live?.agents.waiting ? "is-attention" : undefined}><dt>Waiting</dt><dd>{live ? live.agents.waiting : "—"}</dd></div>
          <div><dt>On a plan</dt><dd>{overview ? onPlans.length : "—"}</dd></div>
        </dl>
      </NousLivePlans>
      <div className="nous-live-tiles" role="list" aria-label="System">
        {tiles.map(({ id, label, icon: Icon, value, level }) => (
          <div key={id} role="listitem" className="nous-tile" data-tile={id} title={`${label}: ${value}`} aria-label={`${label}: ${value}`}>
            <Icon aria-hidden="true" />
            <strong>{value}</strong>
            {level !== null ? <span className="nous-tile-gauge" aria-hidden="true"><span style={{ width: `${level}%` }} /></span> : null}
          </div>
        ))}
      </div>
      <div className="nous-live-sparks">
        <div><span>CPU</span><Sparkline label="CPU" points={history.cpu} max={100} /></div>
        <div><span>RAM</span><Sparkline label="RAM" points={history.memory} max={100} /></div>
        <div><span>Running</span><Sparkline label="Agents running" points={running.current} /></div>
      </div>
    </section>
  );
}

const plansOnPanes = (overview: NousOverview | null) => (overview?.plans ?? []).filter((plan) => plan.pane);

/**
 * Live's plans: "Plans completed" (the Clipboard dock's figures, read again whenever the overview changes, plan clipboard:RXqSSUQSdwJK)
 * and one row per plan on a pane with its active mark. Live and the dock's Plans tab show this one list; with onOpen a row opens the plan.
 */
export function NousLivePlans({ overview, active, onOpen, children }: {
  overview: NousOverview | null; active: boolean; onOpen?(id: string): void; children?: ReactNode;
}) {
  const onPlans = plansOnPanes(overview);
  const activePlans = onPlans.filter((plan) => plan.active).length;
  const [completion, setCompletion] = useState<PlanCompletion | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadPlanCompletion().then((next) => { if (!cancelled) setCompletion(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [active, overview]);
  return (
    <>
      {completion ? <PlanCompletionBar {...completion} /> : null}
      {children}
      {onPlans.length ? (
        <p className="nous-live-plans-legend"><span className="nous-live-dot is-active" aria-hidden="true" />Active {activePlans}</p>
      ) : null}
      {onPlans.length ? (
        <ul className="nous-live-plans" aria-label="Agents on a plan">
          {onPlans.map((plan) => {
            const row = (
              <>
                {plan.active
                  ? <span className="nous-live-dot is-active" role="img" aria-label={`Active: ${plan.pane} is working`} title={`Active: ${plan.pane} is working`} />
                  : <span className="nous-live-dot" aria-hidden="true" />}
                <span className="nous-live-plan-name" title={plan.title}>{plan.pane} · {plan.title}</span>
                <span className="nous-progress" aria-hidden="true">
                  <span style={{ width: `${plan.progress}%` }} />
                </span>
                <span className="nous-live-plan-percent">{plan.progress}%</span>
              </>
            );
            return (
              <li key={plan.id} className={plan.active ? "is-active" : undefined}>
                {onOpen ? (
                  <button type="button" className="nous-live-plan-open" onClick={() => onOpen(plan.id)}
                    aria-label={`Open the plan ${plan.title}, ${plan.pane}, ${plan.progress}%${plan.active ? ", active" : ""}`}>{row}</button>
                ) : row}
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

const WIDGETS: Array<{ id: DesktopWidgetId; label: string }> = [
  { id: "clock", label: "Clock" }, { id: "countdown-timer", label: "Countdown timer" }, { id: "pushup-reminder", label: "Push-up reminder" },
  { id: "ai-quota", label: "AI Quota & Usage" }, { id: "streaming-metrics", label: "Streaming metrics" }, { id: "spaceapp-promo", label: "SpaceApp.dev promo" }
];

/** Full screen only: the existing music player and desktop widgets open as floats over Nous (their own windows and layers). */
export function NousLauncher() {
  const widgets = useDesktopWidgets();
  const { isWidgetVisible } = useWidgetsVisibility();
  const [menu, setMenu] = useState(false);
  const YouTube = modeIcons.YOUTUBE;
  const available = WIDGETS.filter((widget) => isWidgetVisible(widget.id));
  return (
    <div className="nous-launcher" role="toolbar" aria-label="Open over Nous">
      <button type="button" className="nous-launcher-button" aria-label="Music" title="Music"
        onClick={() => window.dispatchEvent(new Event(OPEN_VIBE_MUSIC_EVENT))}><Music2 aria-hidden="true" /></button>
      <button type="button" className="nous-launcher-button" aria-label="YouTube" title="YouTube" onClick={() => window.dispatchEvent(new Event(OPEN_YOUTUBE_FLOAT_EVENT))}><YouTube aria-hidden="true" /></button>
      <div className="nous-launcher-menu-anchor">
        <button type="button" className="nous-launcher-button" aria-label="Widgets" title="Widgets" aria-haspopup="menu" aria-expanded={menu}
          onClick={() => setMenu(!menu)}><Sparkles aria-hidden="true" /></button>
        {menu ? (
          <div className="nous-launcher-menu" role="menu" aria-label="Widgets">
            {available.length === 0 ? <p className="nous-muted">No widgets: turn them on in Settings → Widgets.</p> : null}
            {available.map((widget) => (
              <button key={widget.id} type="button" role="menuitemcheckbox" aria-checked={widgets.isWidgetEnabled(widget.id)}
                onClick={() => { widgets.toggleWidget(widget.id); setMenu(false); }}>{widget.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
