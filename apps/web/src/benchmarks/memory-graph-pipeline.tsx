import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createDemoRuntime } from "../demo/demo-runtime.js";
import { SpaceRuntimeProvider, type SpaceRuntime } from "../runtime/SpaceRuntime.js";
import { MemoryWorkspace } from "../features/memory-workspace/MemoryWorkspace.js";
import "../styles.css";

type LongTask = { startTime: number; duration: number };
type Frame = { nodes: number; edges: number; cpuMs: number; renderer: string };

/** The production workspace and offline API, with observable local-only timing. */
/** Observe the actual offline workspace pipeline, including layout convergence and long tasks. */
function PipelineBenchmark() {
  const [runtime, setRuntime] = useState<SpaceRuntime | null>(null);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const tasks = useRef<LongTask[]>([]);
  const frames = useRef<Array<Frame & { progress: number; elapsedMs: number }>>([]);
  const started = useRef(0);
  useEffect(() => {
    const onFrame = (event: Event) => {
      const detail = (event as CustomEvent<Frame>).detail;
      const workspace = host.current?.querySelector<HTMLElement>("#memory-atlas");
      if (!workspace || !detail.nodes) return;
      frames.current.push({ ...detail, progress: Number(workspace.dataset.layoutProgress), elapsedMs: performance.now() - started.current });
    };
    window.addEventListener("memory-graph-frame", onFrame);
    let observer: PerformanceObserver | undefined;
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.startTime >= started.current) tasks.current.push({ startTime: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: "longtask", buffered: true });
    }
    return () => { window.removeEventListener("memory-graph-frame", onFrame); observer?.disconnect(); };
  }, []);
  const load = () => {
    tasks.current = []; frames.current = []; started.current = performance.now();
    setResult(null); setVersion(value => value + 1); setRuntime(createDemoRuntime().runtime);
  };
  const capture = () => {
    const workspace = host.current?.querySelector<HTMLElement>("#memory-atlas");
    const graph = host.current?.querySelector<HTMLElement>(".memory-graph-layout");
    const canvas = host.current?.querySelector<HTMLCanvasElement>('canvas[role="application"]');
    setResult({ fixture: "actual MemoryWorkspace + DemoStore + layout worker + MemoryGraph3D", elapsedMs: performance.now() - started.current,
      url: location.href, workspace: workspace ? { ...workspace.dataset } : null, graph: graph ? { ...graph.dataset } : null,
      canvas: canvas ? { ...canvas.dataset, busy: canvas.getAttribute("aria-busy"), width: canvas.clientWidth, height: canvas.clientHeight } : null,
      longTasks: tasks.current, maxLongTaskMs: Math.max(0, ...tasks.current.map(task => task.duration)),
      firstFullGraphFrameMs: frames.current.find(frame => frame.nodes === 50_000)?.elapsedMs ?? null,
      fullGraphFramesDuringConvergence: frames.current.filter(frame => frame.nodes === 50_000 && frame.progress < 1).length,
      streamedProgress: [...new Set(frames.current.filter(frame => frame.nodes === 50_000).map(frame => frame.progress))],
      profileMeasures: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("memory-") && entry.startTime >= started.current).map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })),
      rawFrames: frames.current });
  };
  return <main style={{ padding: 16, color: "#d4e6f1", background: "#09111b", minHeight: "100vh", fontFamily: "system-ui" }}>
    <h1 style={{ fontSize: 20 }}>Memory graph — full offline pipeline</h1>
    <p>Use ?memoryNodes=50000&amp;memoryProfile=1. Load, switch to 3D, interact while converging, then capture. This uses the production workspace and worker, with the local demo API.</p>
    <div style={{ display: "flex", gap: 12, marginBottom: 12 }}><button onClick={load}>Load demo pipeline</button><button onClick={capture} disabled={!runtime}>Capture pipeline results</button></div>
    <div ref={host} className="pipeline-workspace-host" style={{ position: "relative", height: 750 }}>
      <style>{`.pipeline-workspace-host>.memory-workspace{position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none}`}</style>
      {runtime ? <SpaceRuntimeProvider key={version} runtime={runtime}><MemoryWorkspace shellMode="desktop" activeRoomId={null} initialMode="atlas" onClose={() => setRuntime(null)} /></SpaceRuntimeProvider> : null}
    </div>
    <pre id="pipeline-result" data-complete={result !== null} data-raw-result={result ? JSON.stringify(result) : undefined} style={{ whiteSpace: "pre-wrap" }}>{result ? JSON.stringify(Object.fromEntries(Object.entries(result).filter(([key]) => !key.startsWith("raw") && key !== "profileMeasures")), null, 2) : "No captured result yet."}</pre>
  </main>;
}

createRoot(document.getElementById("root")!).render(<PipelineBenchmark/>);
