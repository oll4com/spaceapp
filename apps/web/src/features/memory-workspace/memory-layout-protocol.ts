import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { createMemoryAtlas, MemoryAtlasPosition } from "./memory-atlas.js";

export type MemoryAtlas = ReturnType<typeof createMemoryAtlas>;
export type SerializedMemoryAtlas = Omit<MemoryAtlas, "positions"> & { positions: Array<[string, MemoryAtlasPosition]> };

/** Reuse graph objects already held by the receiver; only numeric buffers cross back. */
export type ReferencedMemoryAtlas = Omit<MemoryAtlas, "nodes" | "edges" | "positions"> & {
  nodeIndices: Uint32Array;
  edgeIndices: Uint32Array;
  positionNodeIndices: Uint32Array;
  positionCoordinates: Float64Array;
  positionColorIndices: Uint32Array;
  positionGroupIndices: Uint32Array;
  positionMonthIndices: Uint32Array;
  positionHubs: Uint8Array;
  colors: string[];
  groupIds: string[];
  monthLabels: string[];
};

export interface MemoryLayoutRequest {
  kind: "layout";
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  mode: "2d" | "3d";
}

/** Large requests cross in bounded batches; the worker starts only after layout-end. */
export type MemoryLayoutInput = MemoryLayoutRequest
  | { kind: "layout-begin"; requestId: number; mode: "3d"; nodeCount: number; edgeCount: number }
  | { kind: "layout-nodes"; requestId: number; offset: number; nodes: MemoryGraphNode[] }
  | { kind: "layout-edges"; requestId: number; offset: number; edges: MemoryGraphEdge[] }
  | { kind: "layout-end"; requestId: number };

export type MemoryLayoutMessage =
  | { kind: "atlas"; atlas: SerializedMemoryAtlas }
  | { kind: "atlas-references"; atlas: ReferencedMemoryAtlas }
  | { kind: "depth"; ids?: string[]; coordinates: Float32Array; complete: boolean; step: number }
  | { kind: "positions"; positions: Array<[string, { x: number; y: number }]>; complete: true }
  | { kind: "error"; message: string };
