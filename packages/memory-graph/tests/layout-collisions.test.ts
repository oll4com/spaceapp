import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { removeCollisions } from "../src/layout.js";
import type { MemoryGraphNode, MemoryGraphPosition } from "../src/types.js";

const radius = { SOURCE: 2.8, TOPIC: 2.4, ROOM: 2.4, PROVENANCE: 2.1, SECTION: 2.1, MEMORY: 1.7, CACHE_RECORD: 1.5 } as const;
const types = Object.keys(radius) as Array<keyof typeof radius>;

function stableFraction(value: string): number {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 12), 16) / 0xffffffffffff;
}

/** The all-pairs loop the grid replaced (2026-10-19), kept as the reference the grid must match exactly. */
function allPairs(nodes: MemoryGraphNode[], positions: Map<string, MemoryGraphPosition>): void {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const radii = ordered.map((node) => radius[node.type as keyof typeof radius]);
  const posArray = ordered.map((node) => positions.get(node.id)!);
  for (let pass = 0; pass < 48; pass += 1) {
    let moved = false;
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
      const leftPosition = posArray[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const minimumDistance = radii[leftIndex]! + radii[rightIndex]! + 0.65;
        const rightPosition = posArray[rightIndex]!;
        const dx = rightPosition.x - leftPosition.x;
        if (Math.abs(dx) >= minimumDistance) continue;
        const dy = rightPosition.y - leftPosition.y;
        if (Math.abs(dy) >= minimumDistance) continue;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimumDistance) continue;
        let unitX: number;
        let unitY: number;
        if (distance < 0.000001) {
          const angle = stableFraction(`${ordered[leftIndex]!.id}\n${ordered[rightIndex]!.id}`) * Math.PI * 2;
          unitX = Math.cos(angle);
          unitY = Math.sin(angle);
          distance = 1;
        } else {
          unitX = dx / distance;
          unitY = dy / distance;
        }
        const shift = (minimumDistance - distance) / 2;
        leftPosition.x -= unitX * shift;
        leftPosition.y -= unitY * shift;
        rightPosition.x += unitX * shift;
        rightPosition.y += unitY * shift;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const values = [...positions.values()];
  const centerX = values.reduce((total, position) => total + position.x, 0) / values.length;
  const centerY = values.reduce((total, position) => total + position.y, 0) / values.length;
  for (const position of values) {
    position.x -= centerX;
    position.y -= centerY;
  }
}

describe("memory graph collision removal", () => {
  // The all-pairs reference over 1,500 nodes took 4.5 s alone and passed the default 5 s only without load (1.1.7 public suite).
  it("moves every node exactly like comparing all pairs, on a crowded layout with stacked nodes", () => {
    const nodes = Array.from({ length: 1_500 }, (_, index) => ({
      id: `node:${stableFraction(`id:${index}`).toString(36)}`,
      type: types[index % types.length]!
    }) as MemoryGraphNode);
    const seed = (stacked: boolean) => new Map(nodes.map((node, index) => [node.id, stacked && index % 50 === 0
      ? { x: 1, y: 1 }
      : { x: (stableFraction(`x:${index}`) - 0.5) * 120, y: (stableFraction(`y:${index}`) - 0.5) * 120 }]));
    const expected = seed(true);
    const actual = seed(true);

    allPairs(nodes, expected);
    removeCollisions(nodes, actual);

    expect([...actual]).toEqual([...expected]);
    expect([...actual.values()].some((position, index) => position.x !== seed(true).get(nodes[index]!.id)!.x)).toBe(true);
  }, 30_000);
});
