// Displacement map for the lens: 50% gray leaves the backdrop in place; red steers x and green steers y
// near the edges, so the glass bends what is behind it inward like a rounded lens.
const LENS_MAP = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>" +
    "<linearGradient id='x'><stop offset='0' stop-color='#f00'/><stop offset='.22' stop-color='#800000'/><stop offset='.78' stop-color='#800000'/><stop offset='1' stop-color='#000'/></linearGradient>" +
    "<linearGradient id='y' x2='0' y2='1'><stop offset='0' stop-color='#0f0'/><stop offset='.3' stop-color='#008000'/><stop offset='.7' stop-color='#008000'/><stop offset='1' stop-color='#000'/></linearGradient>" +
    "<rect width='100' height='100' fill='url(#x)'/><rect width='100' height='100' fill='url(#y)' style='mix-blend-mode:screen'/></svg>"
)}`;

/** Liquid Glass edge refraction, used as `backdrop-filter: url(#space-liquid-glass-lens)` by controls that float on the wallpaper. */
export function LiquidGlassLens() {
  return (
    <svg className="liquid-glass-lens" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="space-liquid-glass-lens" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feImage href={LENS_MAP} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="24" xChannelSelector="R" yChannelSelector="G" result="bent" />
        <feGaussianBlur in="bent" stdDeviation="3" />
        <feColorMatrix type="saturate" values="1.7" />
      </filter>
    </svg>
  );
}
