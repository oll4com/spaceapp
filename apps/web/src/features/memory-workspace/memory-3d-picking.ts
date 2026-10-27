import { projectMemoryPoint, type MemoryCamera3D } from "./memory-3d.js";
/** Median BVH is built only when layout positions change; camera and pointer moves do not rebuild it. */
export class MemoryPickIndex {
  private order: number[];
  private boxes: Array<{
    min: number[];
    max: number[];
    start: number;
    end: number;
    left: number;
    right: number;
  }> = [];
  constructor(
    private positions: Float32Array,
    private radii: Float32Array,
  ) {
    this.order = Array.from({ length: radii.length }, (_, i) => i);
    const build = (start: number, end: number): number => {
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = start; i < end; i++)
        for (let a = 0; a < 3; a++) {
          const x = positions[this.order[i]! * 3 + a]!;
          min[a] = Math.min(min[a]!, x);
          max[a] = Math.max(max[a]!, x);
        }
      const node = { min, max, start, end, left: -1, right: -1 },
        id = this.boxes.push(node) - 1;
      if (end - start <= 16) return id;
      let axis = 0;
      for (let a = 1; a < 3; a++)
        if (max[a]! - min[a]! > max[axis]! - min[axis]!) axis = a;
      const middle = (start + end) >>> 1,
        value = (i: number) => positions[this.order[i]! * 3 + axis]!;
      // In-place quickselect avoids sorting every level or allocating large subarrays.
      let low = start,
        high = end - 1;
      while (low < high) {
        const pivot = value((low + high) >>> 1);
        let l = low,
          r = high;
        while (l <= r) {
          while (value(l) < pivot) l++;
          while (value(r) > pivot) r--;
          if (l <= r) {
            [this.order[l], this.order[r]] = [this.order[r]!, this.order[l]!];
            l++;
            r--;
          }
        }
        if (middle <= r) high = r;
        else if (middle >= l) low = l;
        else break;
      }
      node.left = build(start, middle);
      node.right = build(middle, end);
      return id;
    };
    if (radii.length) build(0, radii.length);
  }
  pick(
    x: number,
    y: number,
    camera: MemoryCamera3D,
    scale: number,
    width: number,
    height: number,
    extent: number,
    focusIndex = -1,
  ) {
    if (!this.boxes.length) return -1;
    const cy = Math.cos(camera.yaw),
      sy = Math.sin(camera.yaw),
      cp = Math.cos(camera.pitch),
      sp = Math.sin(camera.pitch);
    const inverse = (x: number, y: number, z: number) => {
      const d = -sp * y + cp * z;
      return [cy * x - sy * d, cp * y + sp * z, sy * x + cy * d];
    };
    const rays = [
      {
        origin: inverse(0, 0, -650 / scale),
        direction: inverse(
          (x - width / 2) / (650 * camera.zoom),
          -(y - height / 2) / (650 * camera.zoom),
          1,
        ),
      },
    ];
    // projectMemoryPoint clamps perspective near the camera. On tall viewports,
    // that region becomes orthographic, so query its parallel ray as well.
    if (extent * scale > 530)
      rays.push({
        origin: inverse(
          ((x - width / 2) * 120) / (650 * scale * camera.zoom),
          (-(y - height / 2) * 120) / (650 * scale * camera.zoom),
          0,
        ),
        direction: inverse(0, 0, 1),
      });
    const margin =
      15 / (scale * Math.sqrt(camera.zoom)) +
      (10 * (1 + (extent * scale) / 650)) / (scale * camera.zoom);
    let best = -1,
      bestDepth = Infinity;
    const stack = [0];
    while (stack.length) {
      const box = this.boxes[stack.pop()!]!;
      const intersects = rays.some(({ origin, direction }) => {
        let near = -Infinity,
          far = Infinity;
        for (let a = 0; a < 3; a++) {
          const lo = box.min[a]! - margin,
            hi = box.max[a]! + margin,
            o = origin[a]!,
            d = direction[a]!;
          if (Math.abs(d) < 1e-12) {
            if (o < lo || o > hi) return false;
            continue;
          }
          const first = (lo - o) / d,
            last = (hi - o) / d;
          near = Math.max(near, Math.min(first, last));
          far = Math.min(far, Math.max(first, last));
        }
        return far >= near;
      });
      if (!intersects) continue;
      if (box.left >= 0) {
        stack.push(box.left, box.right);
        continue;
      }
      for (let j = box.start; j < box.end; j++) {
        const i = this.order[j]!,
          p = projectMemoryPoint(
            {
              x: this.positions[i * 3]!,
              y: this.positions[i * 3 + 1]!,
              z: this.positions[i * 3 + 2]!,
            },
            camera,
            scale,
            width,
            height,
          );
        const radius = Math.max(
          7,
          Math.max(1, this.radii[i]! * p.perspective * Math.sqrt(camera.zoom)) *
            (i === focusIndex ? 1.5 : 1) +
            3,
        );
        if (
          p.z < bestDepth &&
          (p.x - x) ** 2 + (p.y - y) ** 2 < radius * radius
        ) {
          best = i;
          bestDepth = p.z;
        }
      }
    }
    return best;
  }
}
