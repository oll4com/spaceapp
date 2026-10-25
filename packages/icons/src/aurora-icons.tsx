import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { AppIconName } from "./app-icon-map.js";

// Aurora Neon: Lucide geometry inked with one shared aurora gradient (glow and light-mode stops in styles.css).
const AURORA_INK_ID = "space-aurora-ink";
// currentColor is the SVG paint fallback where the gradient is not in the document.
const AURORA_INK = `url(#${AURORA_INK_ID}) currentColor`;

function ensureAuroraInk(): void {
  if (typeof document === "undefined" || document.getElementById(AURORA_INK_ID)) return;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("style", "position:absolute;pointer-events:none");
  // userSpaceOnUse keeps straight horizontal/vertical strokes (zero-height boxes) painted.
  svg.innerHTML = `<defs><linearGradient id="${AURORA_INK_ID}" class="space-aurora-ink" gradientUnits="userSpaceOnUse" x1="3" y1="3" x2="21" y2="21">`
    + `<stop offset="0" stop-color="#5eead4"/><stop offset="0.5" stop-color="#a78bfa"/><stop offset="1" stop-color="#f472b6"/>`
    + `</linearGradient></defs>`;
  document.body.appendChild(svg);
}

function makeAuroraIcon(name: AppIconName, Base: LucideIcon): LucideIcon {
  const Component = forwardRef<SVGSVGElement, LucideProps>(function AuroraNeonIcon({ color, className, ...props }, ref) {
    return <Base {...props} ref={ref} color={color ?? AURORA_INK} className={["space-aurora-icon", className].filter(Boolean).join(" ")} />;
  });
  Component.displayName = `AuroraNeon(${name})`;
  return Component as LucideIcon;
}

ensureAuroraInk();

const auroraIcons = new Map<AppIconName, LucideIcon>();

// One component per name, so a re-render never remounts the icon.
export function auroraIcon(name: AppIconName, Base: LucideIcon): LucideIcon {
  let icon = auroraIcons.get(name);
  if (!icon) auroraIcons.set(name, icon = makeAuroraIcon(name, Base));
  return icon;
}
