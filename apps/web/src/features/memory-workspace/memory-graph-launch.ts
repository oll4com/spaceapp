import { startTransition } from "react";

export const MEMORY_GRAPH_LAUNCH_SIZES = [2_000, 10_000, 50_000] as const;
export type MemoryGraphLaunchSize = (typeof MEMORY_GRAPH_LAUNCH_SIZES)[number];

export interface MemoryGraphLaunch {
  nodes: MemoryGraphLaunchSize;
  edges: number;
  benchmark: boolean;
}

const MAX_EDGES = 150_000;

/** Snap a requested node count onto the sizes the 3D view can load. */
export function snapMemoryGraphLaunchSize(requested: number): MemoryGraphLaunchSize {
  if (requested < 5_000) return 2_000;
  if (requested < 30_000) return 10_000;
  return 50_000;
}

/**
 * `?memoryNodes=50000&memoryEdges=150000&benchmark=1` opens the atlas in 3D
 * so the frame-time harness can run without clicking through the shell.
 */
export function readMemoryGraphLaunch(search?: string): MemoryGraphLaunch | null {
  const source = search ?? (typeof window === "undefined" ? "" : window.location.search);
  const params = new URLSearchParams(source.startsWith("?") || source === "" ? source : `?${source}`);
  const raw = params.get("memoryNodes");
  if (!raw) return null;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested < 1) return null;
  const nodes = snapMemoryGraphLaunchSize(requested);
  const edgeParam = params.get("memoryEdges");
  const edgeRaw = edgeParam === null || edgeParam.trim() === "" ? Number.NaN : Number(edgeParam);
  const edges = Number.isFinite(edgeRaw) && edgeRaw >= 0
    ? Math.min(MAX_EDGES, Math.floor(edgeRaw))
    : Math.min(MAX_EDGES, nodes * 3);
  return { nodes, edges, benchmark: params.get("benchmark") === "1" };
}

let memoryLaunchStartup = true;

/** Time-slice only the first shell publish of a direct 3D launch. Later room updates stay synchronous. */
export function publishMemoryLaunchShell(publish: () => void, search?: string): boolean {
  const startup = memoryLaunchStartup && readMemoryGraphLaunch(search) !== null;
  memoryLaunchStartup = false;
  if (startup) startTransition(publish);
  else publish();
  return startup;
}

export function resetMemoryLaunchShellStartup() {
  memoryLaunchStartup = true;
}
