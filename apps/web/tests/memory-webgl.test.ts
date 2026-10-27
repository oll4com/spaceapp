import { describe, expect, it } from "vitest";
import {
  createMemoryLayout3D,
  layoutMemoryNetwork3D,
  projectMemoryPoint,
  DEFAULT_MEMORY_CAMERA,
} from "../src/features/memory-workspace/memory-3d.js";
import { MemoryPickIndex } from "../src/features/memory-workspace/memory-3d-picking.js";
import {
  memoryLabelCandidates,
  selectMemoryLabels,
  LABEL_CANDIDATES,
  LABEL_LIMIT,
} from "../src/features/memory-workspace/memory-3d-labels.js";
import { syntheticMemoryGraph } from "../src/demo/synthetic-memory-graph.js";

describe("large memory graph primitives", () => {
  it("streams detached usable positions and converges identically across batch sizes", () => {
    const { nodes, edges } = syntheticMemoryGraph(80),
      stepper = createMemoryLayout3D(nodes, edges),
      first = stepper.snapshot(),
      copy = structuredClone(first);
    expect(first.size).toBe(80);
    expect(stepper.done).toBe(false);
    for (let i = 0; i < 60; i++) stepper.advance(3);
    expect(stepper.done).toBe(true);
    expect(first).toEqual(copy);
    expect(stepper.snapshot()).toEqual(layoutMemoryNetwork3D(nodes, edges));
    expect(stepper.snapshot()).not.toEqual(first);
  });
  it("bounds labels at50k while preserving core and focused-node priority", () => {
    const { nodes } = syntheticMemoryGraph(50000),
      candidates = memoryLabelCandidates(nodes);
    expect(candidates.length).toBeLessThanOrEqual(LABEL_CANDIDATES);
    expect(candidates[0]!.label).toBe("gemini.md");
    let measured = 0;
    const coords = new Map(
      nodes.map((n, i) => [
        n.id,
        { x: (i % 50) - 25, y: (Math.floor(i / 50) % 50) - 25, z: 0 },
      ]),
    );
    const result = selectMemoryLabels(
      candidates,
      nodes[49999],
      coords,
      DEFAULT_MEMORY_CAMERA,
      4,
      1000,
      700,
      () => {
        measured++;
        return 70;
      },
    );
    expect(result[0]?.id).toBe(nodes[49999]!.id);
    expect(result.length).toBeLessThanOrEqual(LABEL_LIMIT);
    expect(measured).toBeLessThanOrEqual(LABEL_CANDIDATES);
    for (let i = 0; i < result.length; i++)
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i]!,
          b = result[j]!;
        expect(
          Math.abs(a.y - b.y) < 16 &&
            a.x < b.x + b.width + 5 &&
            a.x + a.width + 5 > b.x,
        ).toBe(false);
      }
  });
  it("BVH picking matches exhaustive frontmost circles through camera rotation and zoom", () => {
    const xyz = new Float32Array(2000 * 3),
      radii = new Float32Array(2000).fill(2.1);
    for (let i = 0; i < 2000; i++) {
      xyz[i * 3] = Math.sin(i * 13) * 150;
      xyz[i * 3 + 1] = Math.cos(i * 7) * 140;
      xyz[i * 3 + 2] = Math.sin(i * 19) * 160;
    }
    radii[0] = 10;
    const picker = new MemoryPickIndex(xyz, radii);
    for (const scale of [1, 4])
      for (const zoom of [0.35, 1, 5])
        for (const yaw of [0, 1.5, 3])
          for (let q = 0; q < 15; q++) {
            const camera = { yaw, pitch: 0.4, zoom },
              x = 400 + q * 11,
              y = 300 + q * 5;
            let expected = -1,
              z = Infinity;
            for (let i = 0; i < radii.length; i++) {
              const p = projectMemoryPoint(
                  { x: xyz[i * 3]!, y: xyz[i * 3 + 1]!, z: xyz[i * 3 + 2]! },
                  camera,
                  scale,
                  1000,
                  700,
                ),
                r = Math.max(
                  7,
                  Math.max(1, radii[i]! * p.perspective * Math.sqrt(zoom)) *
                    (i === 0 ? 1.5 : 1) +
                    3,
                );
              if (p.z < z && (p.x - x) ** 2 + (p.y - y) ** 2 < r * r) {
                expected = i;
                z = p.z;
              }
            }
            expect(picker.pick(x, y, camera, scale, 1000, 700, 300, 0)).toBe(
              expected,
            );
          }
  });
  it("handles empty BVHs and caps deterministic synthetic data", () => {
    expect(
      new MemoryPickIndex(new Float32Array(), new Float32Array()).pick(
        0,
        0,
        DEFAULT_MEMORY_CAMERA,
        1,
        500,
        500,
        60,
      ),
    ).toBe(-1);
    const graph = syntheticMemoryGraph(50001);
    expect(graph.nodes).toHaveLength(50000);
    expect(graph.edges).toHaveLength(150000);
    expect(syntheticMemoryGraph(30)).toEqual(syntheticMemoryGraph(30));
  });
});
