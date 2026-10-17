import type { MemoryGraphNode } from "@space/contracts";
import { MEMORY_LABEL_CANDIDATES, memoryLabelsAtZoom } from "./memory-webgl-data.js";

type Label = { text: string; width: number };

/** Graph-scoped label preparation; camera motion does not change text metrics. */
export class MemoryLabelCache {
  private readonly labels = new Map<number, Label>();
  private visible: number[] = [];
  private zoomed: boolean | undefined;
  private focus = -1;

  constructor(private readonly nodes: MemoryGraphNode[], private readonly candidates: number[]) {}

  atZoom(zoom: number, focus: number): number[] {
    const zoomed = zoom >= 1.6;
    if (this.zoomed !== zoomed || this.focus !== focus) {
      this.visible = memoryLabelsAtZoom(this.nodes, this.candidates, zoom, focus);
      this.zoomed = zoomed; this.focus = focus;
    }
    return this.visible;
  }

  measure(index: number, measureText: (text: string) => number): Label {
    const cached = this.labels.get(index);
    if (cached) return cached;
    const original = this.nodes[index]!.label;
    const text = original.length > 48 ? `${original.slice(0, 45)}…` : original;
    const label = { text, width: measureText(text) };
    // Hover may visit every node in a large graph. Retain only a bounded cache,
    // including room for a focused node outside the normal candidate pool.
    if (this.labels.size >= MEMORY_LABEL_CANDIDATES + 1) this.labels.delete(this.labels.keys().next().value!);
    this.labels.set(index, label);
    return label;
  }
}
