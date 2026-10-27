import { useEffect, useState } from "react";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";
type Atlas = ReturnType<typeof createMemoryAtlas>;
type State = {
  atlas: Atlas;
  graph: MemoryGraphOverviewResponse;
  depth: Map<string, MemoryPoint3D>;
  done: boolean;
  query: string;
  limit: number;
};
/** Independent 3D loading ensures its larger response never changes the 2D map or races another search. */
export function useLargeMemoryGraph(
  enabled: boolean,
  query: string,
  limit: number,
) {
  const [state, setState] = useState<State | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || typeof Worker === "undefined") return;
    const controller = new AbortController();
    let active = true,
      worker: Worker | null = null,
      atlas: Atlas | undefined;
    setPending(true);
    setError(null);
    setState(null);
    void api
      .memoryGraphOverview({
        signal: controller.signal,
        q: query || undefined,
        month: "all",
        relationMode: "RELATIONS",
        limit,
      })
      .then(async (graph) => {
        if (!active) return;
        worker = new Worker(
          new URL("./memory-network-layout.worker.ts", import.meta.url),
          { type: "module" },
        );
        worker.onmessage = (
          event: MessageEvent<{
            atlas?: Omit<Atlas, "nodes" | "edges">;
            nodeIds?: string[];
            xyz: Float32Array;
            done: boolean;
          }>,
        ) => {
          if (!active) return;
          if (event.data.atlas && event.data.nodeIds) {
            const ids = new Set(event.data.nodeIds);
            atlas = {
              ...event.data.atlas,
              nodes: graph.data.nodes.filter((node) => ids.has(node.id)),
              edges: graph.data.edges.filter(
                (edge) => ids.has(edge.source) && ids.has(edge.target),
              ),
            };
          }
          if (!atlas) return;
          const depth = new Map(
            atlas.nodes.map((node, i) => [
              node.id,
              {
                x: event.data.xyz[i * 3]!,
                y: event.data.xyz[i * 3 + 1]!,
                z: event.data.xyz[i * 3 + 2]!,
              },
            ]),
          );
          setState({
            atlas,
            graph,
            depth,
            done: event.data.done,
            query,
            limit,
          });
          setPending(false);
          if (event.data.done) worker?.terminate();
        };
        worker.onerror = (event) => {
          if (active) {
            setError(
              `Memory layout could not be calculated: ${event.message || "worker unavailable"}`,
            );
            setPending(false);
          }
          worker?.terminate();
        };
        // Bounded messages avoid serializing the whole 50k/150k graph in one main-thread task.
        for (
          let offset = 0,
            count = Math.max(
              graph.data.nodes.length,
              Math.ceil(graph.data.edges.length / 3),
            );
          offset < Math.max(count, 1);
          offset += 5000
        ) {
          if (!active) return;
          worker.postMessage({
            nodes: graph.data.nodes.slice(offset, offset + 5000),
            edges: graph.data.edges.slice(offset * 3, (offset + 5000) * 3),
            mode: "3d",
            final: offset + 5000 >= count,
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })
      .catch((caught) => {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : "Memory could not be loaded.",
          );
          setPending(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
      worker?.terminate();
    };
  }, [enabled, query, limit]);
  const matching =
    enabled && state?.query === query && state.limit === limit ? state : null;
  return {
    state: matching,
    pending: enabled && pending,
    error: enabled ? error : null,
  };
}
