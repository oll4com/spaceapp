// Exact tile geometry from public/brand/space-logo.svg, without its opaque
// background. Shared by the arcade canvas watermark and its small brand mark.
export const SPACE_LOGO_TILES = [
  { x: 137, y: 137, size: 90, radius: 25.2 },
  { x: 285, y: 285, size: 90, radius: 25.2 },
  { x: 255, y: 107, size: 150, radius: 42 },
  { x: 107, y: 255, size: 150, radius: 42 },
];

export function SpaceappMark() {
  return <svg viewBox="0 0 512 512" fill="none" aria-hidden="true">
    {SPACE_LOGO_TILES.map(tile => <rect key={`${tile.x}:${tile.y}`} x={tile.x} y={tile.y} width={tile.size} height={tile.size} rx={tile.radius} stroke="currentColor" strokeWidth="16" />)}
  </svg>;
}
