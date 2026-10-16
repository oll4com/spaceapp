/** Accessibility and data attributes every 3D canvas carries, identical for the WebGL and Canvas 2D renderers. */
export const memory3DCanvasProps = (loading: boolean, showTitles: boolean, volume: string) => ({
  tabIndex: 0,
  role: "application" as const,
  "aria-label": "3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open.",
  "aria-busy": loading,
  "data-titles-visible": showTitles,
  "data-layout-volume": volume
});
