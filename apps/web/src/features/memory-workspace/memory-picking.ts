import type { MemoryCamera3D } from "./memory-3d.js";

export type MemoryPickIndex = { points: Float32Array; radii: Float32Array; order: Uint32Array; bounds: Float32Array; tree: Int32Array };
const LEAF_SIZE = 24;

/** Built in the layout worker. Median splits bound leaf work even for coincident points. */
export function buildMemoryPickIndex(points: Float32Array, radii: Float32Array): MemoryPickIndex {
  const count = radii.length, order = Uint32Array.from({ length: count }, (_, i) => i);
  const bounds: number[] = [], tree: number[] = [];
  const build = (start: number, end: number): number => {
    const id = tree.length / 4;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, radius = 0;
    for (let i = start; i < end; i++) {
      const point = order[i]!, at = point * 3, x = points[at]!, y = points[at + 1]!, z = points[at + 2]!;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z); radius = Math.max(radius, radii[point]!);
    }
    const x = (minX + maxX) / 2, y = (minY + maxY) / 2, z = (minZ + maxZ) / 2;
    bounds.push(x, y, z, Math.hypot(maxX - x, maxY - y, maxZ - z), radius);
    tree.push(start, end, -1, -1);
    if (end - start > LEAF_SIZE) {
      const sizes = [maxX - minX, maxY - minY, maxZ - minZ];
      const axis = sizes[0]! >= sizes[1]! && sizes[0]! >= sizes[2]! ? 0 : sizes[1]! >= sizes[2]! ? 1 : 2;
      order.subarray(start, end).sort((a, b) => points[a * 3 + axis]! - points[b * 3 + axis]! || a - b);
      const middle = start + Math.floor((end - start) / 2);
      tree[id * 4 + 2] = build(start, middle); tree[id * 4 + 3] = build(middle, end);
    }
    return id;
  };
  if (count) build(0, count);
  return { points, radii, order, bounds: new Float32Array(bounds), tree: new Int32Array(tree) };
}

/** Conservative projected-sphere pruning, then exact circle/depth tests in small leaves. */
export function pickMemoryNode(index: MemoryPickIndex, camera: MemoryCamera3D, scale: number, width: number, height: number, screenX: number, screenY: number, focus = -1, scratch?: Int32Array): number {
  if (!index.tree.length) return -1;
  const { bounds, tree, points, radii, order } = index;
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const px = screenX - width / 2, py = height / 2 - screenY, zoomScale = scale * camera.zoom, rootZoom = Math.sqrt(camera.zoom);
  const stack = scratch && scratch.length >= tree.length / 4 ? scratch : new Int32Array(tree.length / 4);
  stack[0] = 0;
  let remaining = 1, selected = -1, bestDepth = Infinity;
  while (remaining) {
    const id = stack[--remaining]!, at = id * 5, cx = bounds[at]!, yy = bounds[at + 1]!, zz = bounds[at + 2]!, radius = bounds[at + 3]!;
    const x = cx * cy + zz * sy, d = -cx * sy + zz * cy, y = yy * cp - d * sp, z = yy * sp + d * cp;
    if (z - radius > bestDepth) continue;
    const near = 650 / Math.max(120, 650 + (z - radius) * scale), far = 650 / Math.max(120, 650 + (z + radius) * scale);
    const padding = Math.max(7, bounds[at + 4]! * near * rootZoom * 1.5 + 3);
    const minX = (x - radius) * zoomScale, maxX = (x + radius) * zoomScale, minY = (y - radius) * zoomScale, maxY = (y + radius) * zoomScale;
    if (px < Math.min(minX * near, minX * far) - padding || px > Math.max(maxX * near, maxX * far) + padding || py < Math.min(minY * near, minY * far) - padding || py > Math.max(maxY * near, maxY * far) + padding) continue;
    const row = id * 4, left = tree[row + 2]!, right = tree[row + 3]!;
    if (left >= 0) {
      const l = left * 5, r = right * 5;
      const leftDepth = bounds[l + 1]! * sp + (-bounds[l]! * sy + bounds[l + 2]! * cy) * cp;
      const rightDepth = bounds[r + 1]! * sp + (-bounds[r]! * sy + bounds[r + 2]! * cy) * cp;
      if (leftDepth < rightDepth) { stack[remaining++] = right; stack[remaining++] = left; }
      else { stack[remaining++] = left; stack[remaining++] = right; }
      continue;
    }
    for (let i = tree[row]!; i < tree[row + 1]!; i++) {
      const node = order[i]!, offset = node * 3, nx = points[offset]! * cy + points[offset + 2]! * sy, nd = -points[offset]! * sy + points[offset + 2]! * cy;
      const ny = points[offset + 1]! * cp - nd * sp, nz = points[offset + 1]! * sp + nd * cp;
      if (nz > bestDepth) continue;
      const perspective = 650 / Math.max(120, 650 + nz * scale);
      const hitRadius = Math.max(7, Math.max(1, radii[node]! * perspective * rootZoom) * (node === focus ? 1.5 : 1) + 3);
      const dx = nx * zoomScale * perspective - px, dy = ny * zoomScale * perspective - py;
      if (dx * dx + dy * dy <= hitRadius * hitRadius && (nz < bestDepth || selected < 0 || node < selected)) { selected = node; bestDepth = nz; }
    }
  }
  return selected;
}
