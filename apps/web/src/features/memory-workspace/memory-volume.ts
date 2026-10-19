/** Same measure as memory3DVolumeRatio, straight from the layout's coordinate arrays (no per-point objects). */
export function volumeRatioFromArrays(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, count: number): number {
  if (count < 4) return 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) { cx += x[i]!; cy += y[i]!; cz += z[i]!; }
  cx /= count; cy /= count; cz /= count;
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < count; i++) {
    const a = x[i]! - cx, b = y[i]! - cy, c = z[i]! - cz;
    xx += a * a; yy += b * b; zz += c * c; xy += a * b; xz += a * c; yz += b * c;
  }
  const determinant = xx * yy * zz + 2 * xy * xz * yz - xx * yz * yz - yy * xz * xz - zz * xy * xy;
  return Math.max(0, determinant / Math.max(1e-12, ((xx + yy + zz) / 3) ** 3));
}
