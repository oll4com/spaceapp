import type { MemoryPoint3D } from "./memory-3d.js";

export type MemoryCoordinates = {
  readonly size: number;
  get(id: string): MemoryPoint3D | undefined;
  keys(): IterableIterator<string>;
  values(): IterableIterator<MemoryPoint3D>;
};

/** Zero-copy worker positions. Materialize objects only for visible labels/fallback. */
export class IndexedMemoryCoordinates implements MemoryCoordinates {
  constructor(private readonly index: ReadonlyMap<string, number>, private readonly points: Float32Array) {}
  get size() { return this.points.length / 3; }
  get(id: string): MemoryPoint3D | undefined {
    const index = this.index.get(id);
    if (index === undefined) return undefined;
    const offset = index * 3;
    return { x: this.points[offset]!, y: this.points[offset + 1]!, z: this.points[offset + 2]! };
  }
  keys() { return this.index.keys(); }
  *values() {
    for (let i = 0; i < this.points.length; i += 3) yield { x: this.points[i]!, y: this.points[i + 1]!, z: this.points[i + 2]! };
  }
}
