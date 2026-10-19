import type { MemoryGraphOverviewPayload, MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition, createMemoryAtlas } from "./memory-atlas.js";
import type { MemoryRenderModel } from "./memory-3d-model.js";

export type MemoryArchiveRequest = { kind: "archive"; demo: boolean; count: number; query: string };
export type MemoryArchiveAtlas = ReturnType<typeof createMemoryAtlas>;
export type MemoryArchiveMessage =
  | { kind: "header"; data: Omit<MemoryGraphOverviewPayload, "nodes" | "edges">; atlas: Omit<MemoryArchiveAtlas, "nodes" | "edges" | "positions"> }
  | { kind: "nodes"; nodes: MemoryGraphNode[] }
  | { kind: "edges"; edges: MemoryGraphEdge[] }
  | { kind: "positions"; positions: Array<[string, MemoryAtlasPosition]> }
  | { kind: "ready"; model: Omit<MemoryRenderModel, "nodes" | "index" | "neighbors"> }
  | { kind: "frame"; xyz: Float32Array; step: number; done: boolean }
  | { kind: "error"; message: string };
