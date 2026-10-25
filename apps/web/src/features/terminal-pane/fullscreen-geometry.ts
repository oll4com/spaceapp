export interface FullscreenGeometry {
  cols: number;
  rows: number;
}

let lastFullscreenGeometry: FullscreenGeometry | null = null;

export function recordFullscreenGeometry(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) return;
  if (lastFullscreenGeometry && lastFullscreenGeometry.cols === cols && lastFullscreenGeometry.rows === rows) return;
  lastFullscreenGeometry = { cols, rows };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<FullscreenGeometry>("space:fullscreen-geometry", { detail: { cols, rows } }));
  }
}

export function readFullscreenGeometry(): FullscreenGeometry | null {
  return lastFullscreenGeometry ? { ...lastFullscreenGeometry } : null;
}
