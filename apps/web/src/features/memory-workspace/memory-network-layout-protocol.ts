import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { createMemoryAtlas } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";

export type MemoryNetworkLayoutRequest = {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  mode?: "2D" | "3D";
  prepareAtlas?: boolean;
};

export type MemoryNetworkLayoutChunk =
  | { kind: "begin"; mode?: "2D" | "3D"; prepareAtlas?: boolean }
  | { kind: "nodes"; nodes: MemoryGraphNode[] }
  | { kind: "edges"; edges: MemoryGraphEdge[] }
  | { kind: "finish" };

export type MemoryNetworkLayoutWorkerRequest = MemoryNetworkLayoutRequest | MemoryNetworkLayoutChunk;

/** Each row uses the existing raw topology's node index; strings are dictionary encoded. */
export type PackedMemoryAtlas = {
  xy: Float32Array;
  groupIndices: Uint16Array;
  colorIndices: Uint16Array;
  hubs: Uint8Array;
  monthIndices: Uint16Array;
  groupIds: string[];
  colors: string[];
  months: string[];
};

export type MemoryNetworkLayoutMessage = {
  atlas?: ReturnType<typeof createMemoryAtlas>;
  /** Full 3D topology is already held by the UI; avoid cloning it back. */
  rawGraph?: boolean;
  positions?: Array<[string, { x: number; y: number }]>;
  depth?: Array<[string, MemoryPoint3D]>;
  packedAtlas?: PackedMemoryAtlas;
  packedPositions?: Float32Array;
  packedDepth?: Float32Array;
  done: boolean;
  progress: number;
};
