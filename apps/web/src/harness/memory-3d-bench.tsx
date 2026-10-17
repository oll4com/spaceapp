/**
 * Frame-time harness for the 3D memory graph, served by the app's own Vite dev server.
 *
 * Why this exists: the standalone harness measured the renderer in isolation. The acceptance
 * criteria ask for real frame times of the shipped component, so this mounts `MemoryGraph3D`
 * itself with a synthetic 50,000-node / 150,000-edge graph, drives the real pointer interaction to
 * rotate the camera, and records `requestAnimationFrame` deltas.
 *
 * Open /memory-3d-bench.html on the dev server; the JSON result renders at the bottom of the page.
 */
import { createRoot } from "react-dom/client";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { MemoryGraph3D } from "../features/memory-workspace/MemoryGraph3D.js";
import { createMemoryNetworkLayout3D } from "../features/memory-workspace/memory-3d.js";
import type { MemoryAtlasPosition } from "../features/memory-workspace/memory-atlas.js";
import type { MemoryPoint3D } from "../features/memory-workspace/memory-3d.js";

/**
 * Long tasks are what the acceptance criteria forbid on the main thread (>100 ms during load or
 * layout). The observer is installed after the synthetic graph is built and before the component
 * mounts, so the entries it reports belong to the component, not to this harness's data creation.
 */
const longTasks: Array<{ start: number; duration: number }> = [];
let observer: PerformanceObserver | null = null;
function startLongTaskObserver() {
  if (typeof PerformanceObserver === "undefined") return;
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
  });
  try { observer.observe({ entryTypes: ["longtask"] }); } catch { /* not supported in this browser */ }
}

const NODES = Number(new URLSearchParams(location.search).get("nodes") ?? 50000);
const EDGES = Math.round(NODES * 3);
const FRAMES = 240;
const WARMUP = 40;

const TYPES: MemoryGraphNode["type"][] = ["MEMORY", "MEMORY", "MEMORY", "SECTION", "SECTION", "SOURCE", "ROOM", "TOPIC", "PROVENANCE", "CACHE_RECORD"];
const EDGE_TYPES: MemoryGraphEdge["type"][] = ["CONTAINS", "DERIVED_FROM", "TAGGED_WITH", "SEMANTICALLY_RELATED", "BELONGS_TO_ROOM", "CACHED_AS"];

let seed = 0x9e3779b9;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

function buildGraph(nodeCount: number, edgeCount: number) {
  const nodes: MemoryGraphNode[] = [];
  const coordinates = new Map<string, MemoryPoint3D>();
  const positions = new Map<string, MemoryAtlasPosition>();
  const palette = ["#7395ad", "#72c0b1", "#b79c79", "#79a7df", "#e0b45b", "#ba8bca"];

  for (let i = 0; i < nodeCount; i += 1) {
    const type = i === 0 ? "SOURCE" : TYPES[(rnd() * TYPES.length) | 0]!;
    const id = `n${i}`;
    nodes.push({
      id,
      type,
      label: i === 0 ? "space_memory.md" : type === "SOURCE" ? `source-${i}.md` : `memory-record-${i}`,
      sourcePath: type === "SOURCE" ? `memory/space_memory_${i}.md` : `memory/records/${i % 997}/record.md`,
      recordId: type === "SOURCE" ? null : id,
    });
    coordinates.set(id, { x: (rnd() - 0.5) * 240, y: (rnd() - 0.5) * 240, z: (rnd() - 0.5) * 240 });
    positions.set(id, { color: palette[(rnd() * palette.length) | 0]! } as MemoryAtlasPosition);
  }

  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const type = EDGE_TYPES[(rnd() * EDGE_TYPES.length) | 0]!;
    edges.push({
      id: `e${i}`,
      type,
      source: `n${(rnd() * nodeCount) | 0}`,
      target: `n${(rnd() * nodeCount) | 0}`,
      ...(type === "TAGGED_WITH" ? { origin: rnd() < 0.4 ? "EXPLICIT_TAG" : "DERIVED_TFIDF" } : {}),
    } as MemoryGraphEdge);
  }
  return { nodes, edges, coordinates, positions };
}

const out = document.getElementById("out")!;
const root = document.getElementById("root")!;
const { nodes, edges, coordinates, positions } = buildGraph(NODES, EDGES);

let selection: string | null = null;
function mount(mountSelection: string | null) {
  createRoot(root).render(
    <MemoryGraph3D
      nodes={nodes}
      edges={edges}
      positions={positions}
      coordinates={coordinates}
      showTitles
      selectedNodeId={mountSelection}
      onSelectNode={(id) => { selection = id; mount(id); }}
      loading={false}
      resetToken={0}
    />
  );
}
mount(selection);
startLongTaskObserver();

requestAnimationFrame(() => requestAnimationFrame(() => {
  const canvas = root.querySelector("canvas");
  if (!canvas) { out.textContent = JSON.stringify({ ok: false, reason: "no canvas" }); return; }
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // Drive the real interaction path: pointerdown, then a stream of pointermove frames.
  canvas.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: cx, clientY: cy, bubbles: true }));
  const deltas: number[] = [];
  const rotationSamples: string[] = [];
  let previous = performance.now();
  let frame = 0;

  const step = async () => {
    const t = performance.now();
    const delta = t - previous;
    previous = t;
    frame += 1;
    if (frame > WARMUP) deltas.push(delta);
    if (frame % 40 === 0) rotationSamples.push(canvas.dataset.rotation ?? "none");

    canvas.dispatchEvent(new PointerEvent("pointermove", {
      pointerId: 1,
      buttons: 1,
      clientX: cx + Math.sin(frame / 12) * 220,
      clientY: cy + Math.cos(frame / 17) * 120,
      bubbles: true,
    }));
    // Wheel is a second, capture-independent way to change the camera: it exercises the same
    // render path under a moving camera even if pointer capture is unavailable.
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: Math.sin(frame / 9) * 6, bubbles: true, cancelable: true }));

    if (frame < FRAMES + WARMUP) { requestAnimationFrame(step); return; }

    canvas.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: cx, clientY: cy, bubbles: true }));
    const sorted = [...deltas].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

    // `PerformanceObserver` delivers on a later task, so give it two before reading its buffer;
    // otherwise the count reads as zero and under-reports blocking that did happen.
    const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await yieldToEventLoop();
    await yieldToEventLoop();
    // Snapshot the frame phase here, BEFORE the layout simulation below. That simulation is a
    // deliberate main-thread reproduction of the cost the worker moves off-thread, so counting it in
    // the same bucket would measure the harness rather than the view.
    const frameLongTasks = longTasks.slice();

    // What the one-shot layout used to cost the main thread: run the same 180 steps, yielding to the
    // event loop between chunks so the loop does not become one unbounded task.
    const layoutStarted = performance.now();
    const stepper = createMemoryNetworkLayout3D(nodes, edges);
    while (stepper.completedSteps < stepper.totalSteps) {
      stepper.runSteps(12);
      await yieldToEventLoop();
    }
    const layoutTotalMs = performance.now() - layoutStarted;
    void stepper.snapshot();
    await yieldToEventLoop();
    await yieldToEventLoop();
    const layoutLongTasks = longTasks.slice(frameLongTasks.length);
    const summarize = (entries: typeof longTasks) => ({
      count: entries.length,
      over100ms: entries.filter((entry) => entry.duration > 100).length,
      worst: entries.length ? Math.max(...entries.map((entry) => entry.duration)) : 0,
    });

    const rotation = canvas.dataset.rotation ?? "";
    const result = {
      ok: true,
      renderer: canvas.dataset.renderer ?? "unknown",
      nodes: NODES,
      edges: EDGES,
      frames: deltas.length,
      p50ms: +at(0.5).toFixed(2),
      p95ms: +at(0.95).toFixed(2),
      p99ms: +at(0.99).toFixed(2),
      maxMs: +Math.max(...deltas).toFixed(2),
      meets_33ms_p95: at(0.95) <= 33,
      rotationChanged: rotation !== "0.300,-0.150",
      rotationSamples,
      longtasks: {
        ...summarize(frameLongTasks),
        entries: frameLongTasks.slice(0, 6),
      },
      // Reported separately: this is the cost the worker is supposed to take off the main thread,
      // measured on the main thread on purpose. Folding it into `longtasks` would grade the harness.
      longtasks_during_layout_sim: summarize(layoutLongTasks),
      // Total cost of 180 layout steps at this size. If this ran as one task it would block the
      // main thread for this long; the worker now runs it in 15 chunks off-thread.
      layout_180_steps_total_ms: +layoutTotalMs.toFixed(0),
      labels: document.querySelectorAll("canvas").length,
      ua: navigator.userAgent.includes("HeadlessChrome") ? "headless" : "headed",
    };
    out.textContent = JSON.stringify(result);
    // Headless screenshots fire before a 280-frame loop finishes, so hand the result to the runner.
    void fetch("http://127.0.0.1:9977/result", {
      method: "POST",
      mode: "no-cors",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(result),
    }).catch(() => undefined);
  };
  requestAnimationFrame(step);
}));
