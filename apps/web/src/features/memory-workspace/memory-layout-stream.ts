import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import { generateSyntheticMemoryGraph } from "../../demo/synthetic-memory-graph.js";
import { createLayoutState, LAYOUT_STEPS_3D, stepLayout, type MemoryLayoutState3D } from "./memory-3d.js";
import { buildMemoryScene, sceneTransferables, type MemoryScene } from "./memory-scene.js";

export interface ResponseMeta { recordCount: number | null; totalMatchingNodes: number; totalMatchingEdges: number; truncated: boolean; isStale: boolean; rawNodeCount: number }
export type GraphSource =
  | { kind: "inline"; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; meta: ResponseMeta }
  | { kind: "url"; url: string }
  | { kind: "synthetic"; size: number };
export type WorkerRequest =
  | { type: "scene"; id: number; source: GraphSource }
  | { type: "layout2d"; id: number; nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }
  | { type: "cancel"; id: number };
export type WorkerMessage =
  | { type: "scene"; id: number; scene: MemoryScene; meta: ResponseMeta }
  | { type: "positions"; id: number; seq: number; step: number; totalSteps: number; done: boolean; x: Float64Array; y: Float64Array; z: Float64Array }
  | { type: "layout2d"; id: number; positions: Array<[string, { x: number; y: number }]> }
  | { type: "error"; id: number; message: string };

export interface StreamIo {
  now(): number;
  yieldToEvents(): Promise<void>;
  isCancelled(): boolean;
  post(message: WorkerMessage, transfer: ArrayBuffer[]): void;
  fetchJson?(url: string): Promise<unknown>;
}
export const SLICE_MS = 12, POST_INTERVAL_MS = 80;

/**
 * Steps the layout in time-budgeted slices (a slice always finishes the step it started, so one step is the
 * minimum), yielding between slices. A snapshot is posted only when the step count advanced since the last one,
 * at most every POST_INTERVAL_MS, plus the initial and the final state.
 */
export async function streamLayout(id: number, state: MemoryLayoutState3D, io: StreamIo, sliceMs = SLICE_MS, postIntervalMs = POST_INTERVAL_MS): Promise<"done" | "cancelled"> {
  let seq = 0, lastStep = -1, lastAt = -Infinity;
  const post = (done: boolean) => {
    const x = state.x.slice(), y = state.y.slice(), z = state.z.slice();
    io.post({ type: "positions", id, seq: seq++, step: state.step, totalSteps: LAYOUT_STEPS_3D, done, x, y, z }, [x.buffer, y.buffer, z.buffer] as ArrayBuffer[]);
    lastStep = state.step; lastAt = io.now();
  };
  if (io.isCancelled()) return "cancelled";
  post(state.step >= LAYOUT_STEPS_3D);
  while (state.step < LAYOUT_STEPS_3D) {
    await io.yieldToEvents();
    if (io.isCancelled()) return "cancelled";
    const started = io.now();
    let done = false;
    while (!done) { done = stepLayout(state, 1); if (io.now() - started >= sliceMs) break; }
    if (done || (state.step !== lastStep && io.now() - lastAt >= postIntervalMs)) post(done);
  }
  return "done";
}

const metaOf = (nodes: number, edges: number, response: Record<string, unknown>): ResponseMeta => ({
  recordCount: (response.summary as { recordCount?: number } | undefined)?.recordCount ?? null,
  totalMatchingNodes: (response.totalMatchingNodes as number | undefined) ?? nodes,
  totalMatchingEdges: (response.totalMatchingEdges as number | undefined) ?? edges,
  truncated: (response.truncated as boolean | undefined) ?? false,
  isStale: (response.isStale as boolean | undefined) ?? false,
  rawNodeCount: nodes
});

async function loadSource(source: GraphSource, io: StreamIo): Promise<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; meta: ResponseMeta }> {
  if (source.kind === "inline") return source;
  if (source.kind === "synthetic") {
    const graph = generateSyntheticMemoryGraph(source.size);
    return { nodes: graph.nodes, edges: graph.edges, meta: metaOf(graph.nodes.length, graph.edges.length, { summary: graph.summary }) };
  }
  const body = await (io.fetchJson ?? defaultFetchJson)(source.url) as { data: { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } & Record<string, unknown> };
  return { nodes: body.data.nodes, edges: body.data.edges, meta: metaOf(body.data.nodes.length, body.data.edges.length, body.data) };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    // Prefer the API's own message (it explains a 403 for large graphs); fall back to a status-specific sentence.
    const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
    const apiMessage = typeof body?.error?.message === "string" ? body.error.message : null;
    throw new Error(apiMessage
      ?? (response.status === 403 ? "Loading a large memory graph requires administrator permissions."
        : response.status === 401 ? "Your session has expired. Sign in again to load the memory graph."
          : `The memory graph request failed (${response.status}).`));
  }
  return response.json();
}

/** Loads (or generates) the graph, posts the scene once, then streams layout snapshots. Shared by the worker and the no-Worker fallback. */
export async function runSceneJob(id: number, source: GraphSource, io: StreamIo): Promise<void> {
  try {
    const loaded = await loadSource(source, io);
    if (io.isCancelled()) return;
    const { scene, sortedNodes, sortedEdges } = buildMemoryScene(loaded.nodes, loaded.edges);
    io.post({ type: "scene", id, scene, meta: loaded.meta }, sceneTransferables(scene));
    await streamLayout(id, createLayoutState(sortedNodes, sortedEdges, true), io);
  } catch (error) {
    if (!io.isCancelled()) io.post({ type: "error", id, message: error instanceof Error ? error.message : "The memory graph could not be loaded." }, []);
  }
}

export interface WorkerLike { postMessage(message: WorkerRequest): void; terminate(): void; onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null; onerror: ((event: ErrorEvent) => void) | null }

/** Main-thread view of one scene job. Positions live in plain fields so snapshots never re-render React. */
export class MemorySceneStream {
  scene: MemoryScene | null = null;
  meta: ResponseMeta | null = null;
  x: Float64Array | null = null; y: Float64Array | null = null; z: Float64Array | null = null;
  step = 0; done = false; error: string | null = null; version = 0; lastSeq = -1;
  private listeners = new Set<() => void>();
  private worker: WorkerLike | null = null;
  private disposed = false;
  private static nextId = 1;
  readonly id = MemorySceneStream.nextId++;

  constructor(private readonly source: GraphSource, private readonly createWorker: (() => WorkerLike) | null) {}

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit() { this.version++; for (const listener of [...this.listeners]) listener(); }

  /** Applies one worker message; stale ids, replayed or reordered snapshots are ignored. */
  handle(message: WorkerMessage) {
    if (this.disposed || message.id !== this.id) return;
    if (message.type === "scene") { this.scene = message.scene; this.meta = message.meta; }
    else if (message.type === "positions") {
      if (message.seq <= this.lastSeq) return;
      this.lastSeq = message.seq; this.x = message.x; this.y = message.y; this.z = message.z; this.step = message.step; this.done = message.done;
    } else if (message.type === "error") this.error = message.message;
    else return;
    this.emit();
  }

  start() {
    if (this.createWorker) {
      const worker = this.worker = this.createWorker();
      worker.onmessage = event => this.handle(event.data);
      worker.onerror = event => this.handle({ type: "error", id: this.id, message: `Memory layout could not be calculated: ${event.message || "worker unavailable"}` });
      worker.postMessage({ type: "scene", id: this.id, source: this.source });
      return;
    }
    // No Worker (tests, very old browsers): same job on this thread, yielding between slices.
    void runSceneJob(this.id, this.source, {
      now: () => performance.now(), isCancelled: () => this.disposed,
      yieldToEvents: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
      post: message => this.handle(message)
    });
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    this.worker?.postMessage({ type: "cancel", id: this.id });
    this.worker?.terminate();
    this.worker = null;
  }
}
