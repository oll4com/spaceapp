import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { MemoryGraph3D } from "../features/memory-workspace/MemoryGraph3D.js";
import type { MemoryAtlasPosition } from "../features/memory-workspace/memory-atlas.js";
import type { MemoryPoint3D } from "../features/memory-workspace/memory-3d.js";
import "../features/memory-workspace/memory-atlas.css";

type Fixture = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D> };
type FrameSample = { cpuMs: number; renderer: string; nodes: number; edges: number; labels: number; drawCalls: number | null };
type PickSample = { durationMs?: number; latencyMs?: number };
const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
/** Keep empty measurements explicit instead of reporting an apparent zero-duration sample. */
function summary(values: number[]) { return { samples: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: values.length ? Math.max(...values) : null }; }

/** Fixed coordinates and three edges per node isolate rendering from layout convergence. */
async function fixture(count: number): Promise<Fixture> {
  const result: Fixture = { nodes: [], edges: [], positions: new Map(), coordinates: new Map() };
  for (let i = 0; i < count; i++) {
    const id = `node-${i}`;
    result.nodes.push({ id, label: i === 0 ? "space.md" : `memory-${i}`, type: i % 127 === 0 ? "SOURCE" : "MEMORY", sourcePath: `/synthetic/source-${Math.floor(i / 127)}.md`, recordId: i % 127 === 0 ? null : id });
    result.coordinates.set(id, { x: Math.sin(i * 13.371) * 280, y: Math.sin(i * 17.123 + 1) * 280, z: Math.sin(i * 23.971 + 2) * 280 });
    result.positions.set(id, { x: 0, y: 0, color: ["#57ccff", "#ff79bc", "#ab95ff", "#53e2ba"][i % 4]!, hub: i % 127 === 0, groupId: `group-${i % 4}` });
    for (let e = 1; e <= 3; e++) result.edges.push({ id: `edge-${i}-${e}`, source: id, target: `node-${(i + e * 97) % count}`, type: "DERIVED_FROM" });
    if (i % 500 === 499) await yieldToBrowser();
  }
  return result;
}

/** Mount the production renderer and collect visible-tab frame and picking measurements. */
function Benchmark() {
  const [count, setCount] = useState(() => {
    const requested = Number(new URLSearchParams(location.search).get("nodes"));
    return [2_000, 10_000, 50_000].includes(requested) ? requested : 2_000;
  });
  const [data, setData] = useState<Fixture | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [titles, setTitles] = useState(true);
  const [status, setStatus] = useState("Choose a size and load the renderer.");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [running, setRunning] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const longTasks = useRef<Array<{ startTime: number; duration: number }>>([]);
  const generation = useRef(0);
  useEffect(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.current.push({ startTime: entry.startTime, duration: entry.duration }); });
    observer.observe({ type: "longtask", buffered: true });
    return () => observer.disconnect();
  }, []);
  const load = async () => {
    const version = ++generation.current;
    setStatus("Generating synthetic fixture in bounded chunks…"); setResult(null); setData(null); longTasks.current = [];
    const started = performance.now();
    const next = await fixture(count);
    if (version !== generation.current) return;
    setData(next); setStatus(`Loaded ${next.nodes.length.toLocaleString()} nodes and ${next.edges.length.toLocaleString()} edges in ${(performance.now() - started).toFixed(1)} ms. Ready.`);
  };
  const run = async () => {
    const canvas = host.current?.querySelector<HTMLCanvasElement>('canvas[role="application"]');
    if (!canvas || !data) return;
    if (canvas.getAttribute("aria-busy") === "true" || Number(canvas.dataset.nodeCount) !== (canvas.dataset.renderer === "canvas2d" ? Math.min(2_000, data.nodes.length) : data.nodes.length)) {
      setStatus("Wait for graph buffers and the spatial index to finish preparing, then run again."); return;
    }
    if (document.visibilityState !== "visible") { setStatus("Keep this tab visible before benchmarking."); return; }
    setRunning(true); setStatus("Benchmarking 360 measured frames after 60 warm-up frames…"); setResult(null);
    const frames: FrameSample[] = [], picks: PickSample[] = [], intervals: number[] = [];
    let tick = 0, previous = 0, timedOut = false;
    const frame = (event: Event) => { if (tick > 60) frames.push((event as CustomEvent<FrameSample>).detail); };
    const pick = (event: Event) => { if (tick > 60) picks.push((event as CustomEvent<PickSample>).detail); };
    window.addEventListener("memory-graph-frame", frame); window.addEventListener("memory-graph-pick", pick);
    const started = performance.now();
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => { timedOut = true; resolve(); }, 20_000);
      const step = (now: number) => {
        if (timedOut) return;
        tick++;
        if (tick % 60 === 0) setStatus(`Benchmark frame ${tick}/420; document ${document.visibilityState}.`);
        if (tick > 60 && previous) intervals.push(now - previous);
        previous = now;
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: tick % 8 === 0 ? "ArrowUp" : "ArrowRight", bubbles: true, cancelable: true }));
        if (tick % 4 === 0) canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: tick % 80 < 40 ? 8 : -8, bubbles: true, cancelable: true }));
        if (tick % 3 === 0) {
          const rect = canvas.getBoundingClientRect();
          canvas.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: rect.left + rect.width * (.5 + Math.sin(tick) * .35), clientY: rect.top + rect.height * (.5 + Math.cos(tick) * .35), bubbles: true }));
        }
        if (tick < 420 && document.visibilityState === "visible") requestAnimationFrame(step);
        else { clearTimeout(deadline); resolve(); }
      };
      requestAnimationFrame(step);
    });
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    window.removeEventListener("memory-graph-frame", frame); window.removeEventListener("memory-graph-pick", pick);
    setResult({ fixture: "synthetic fixed coordinates; actual MemoryGraph3D component", nodeCount: data.nodes.length, edgeCount: data.edges.length,
      viewport: { width: canvas.clientWidth, height: canvas.clientHeight, dpr: devicePixelRatio }, browser: navigator.userAgent,
      renderer: canvas.dataset.renderer, gpu: canvas.dataset.gpuRenderer ?? "not reported", tabVisible: document.visibilityState === "visible", elapsedMs: performance.now() - started, framesExecuted: tick, timedOut,
      rafFrameIntervalMs: summary(intervals), renderCpuMs: summary(frames.map(f => f.cpuMs)),
      pickingCpuMs: summary(picks.flatMap(p => p.durationMs === undefined ? [] : [p.durationMs])), pickingQueryResultMs: summary(picks.flatMap(p => p.latencyMs === undefined ? [] : [p.latencyMs])),
      maxLabelCount: Math.max(0, ...frames.map(f => f.labels)), actualRenderedNodes: Number(canvas.dataset.nodeCount), actualRenderedEdges: Number(canvas.dataset.edgeCount),
      loadAndRenderLongTasks: longTasks.current, profileMeasures: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("memory-")).map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })), rawFrameIntervalsMs: intervals, rawRenderCpuMs: frames.map(f => f.cpuMs) });
    setStatus("Measurement complete. Frame intervals include presentation scheduling; CPU submission time is reported separately.");
    setRunning(false);
  };
  const loseContext = () => {
    const canvas = host.current?.querySelector<HTMLCanvasElement>('canvas[role="application"]');
    const gl = canvas?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) { setStatus("Context-loss extension unavailable; no context change made."); return; }
    extension.loseContext(); setStatus("Context lost. Verify the capped Canvas fallback; restoration will be requested after 5 seconds.");
    setTimeout(() => extension.restoreContext(), 5_000);
  };
  return <main style={{ fontFamily: "system-ui", background: "#09111b", color: "#d4e6f1", minHeight: "100vh", padding: 20, boxSizing: "border-box" }}>
    <h1 style={{ fontSize: 22 }}>3D memory graph — reproducible renderer benchmark</h1>
    <p>Standalone development harness. Synthetic data only; no backend, embeddings, credentials or provider requests. Force-layout/load testing is separate.</p>
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <label>Nodes <select aria-label="Node count" disabled={running} value={count} onChange={e => setCount(Number(e.target.value))}>{[2_000, 10_000, 50_000].map(n => <option value={n} key={n}>{n.toLocaleString()}</option>)}</select></label>
      <button disabled={running} onClick={() => void load()}>Load fixture</button><button disabled={!data || running} onClick={() => void run()}>Run benchmark</button>
      <button disabled={!data || running} onClick={loseContext}>Test context loss and recovery</button>
      <label><input type="checkbox" checked={titles} onChange={e => setTitles(e.target.checked)}/> Show titles</label>
    </div>
    <p role="status">{status}</p>
    <div ref={host} style={{ position: "relative", height: 650, border: "1px solid #2b4455" }}>
      <style>{`.memory-3d-surface{inset:0!important}.memory-3d-surface canvas{position:absolute;inset:0}`}</style>
      {data ? <MemoryGraph3D {...data} showTitles={titles} selectedNodeId={selected} onSelectNode={setSelected} loading={false} resetToken={0}/> : null}
    </div>
    <p>Selected node: <output>{selected ?? "none"}</output></p>
    <pre id="benchmark-result" data-complete={result !== null} data-raw-result={result ? JSON.stringify(result) : undefined} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result ? JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => !key.startsWith("raw"))), null, 2) : "No measured result yet."}</pre>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Benchmark/>);
