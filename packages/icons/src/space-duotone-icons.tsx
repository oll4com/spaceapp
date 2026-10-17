import { forwardRef, type ReactNode } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { AppIconName } from "./app-icon-map.js";
import "./space-duotone.css";

// Space Duotone: Lucide geometry with a lighter stroke and a soft tone inside closed shapes (space-duotone.css).
// Glyphs whose main shape is open get a drawn plate, so every icon carries the same two-tone weight.
// Most plates close the main Lucide outline; Terminal gets a window behind its prompt.
const plates: Partial<Record<AppIconName, ReactNode>> = {
  AlertTriangle: <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z" />,
  Archive: <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />,
  Bell: <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326z" />,
  Clipboard: <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2z" />,
  ClipboardList: <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2z" />,
  Database: <path d="M3 5A9 3 0 0 0 21 5V19A9 3 0 0 1 3 19z" />,
  Eye: <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0z" />,
  FolderOpen: <path d="M4 20h14.45a2 2 0 0 0 1.95-1.5l1.54-6A2 2 0 0 0 20 10V7a2 2 0 0 0-2-2h-6.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />,
  Gauge: <path d="M3.34 19a10 10 0 1 1 17.32 0z" />,
  Presentation: <path d="M3 3h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  Settings: <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915z" />,
  Terminal: <rect x="2" y="4" width="20" height="16" rx="3" />,
  TextCursorInput: <rect x="2" y="8" width="20" height="8" rx="2" />,
  Trash2: <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6z" />,
  Users: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2z" />
};

function makeSpaceIcon(name: AppIconName, Base: LucideIcon): LucideIcon {
  const plate = plates[name];
  const Component = forwardRef<SVGSVGElement, LucideProps>(function SpaceDuotoneIcon(
    { strokeWidth = 1.75, className, children, ...props },
    ref
  ) {
    // A caller that fills the icon (a set star, a solid badge) gets no tone or plate.
    const toned = props.fill === undefined || props.fill === "none";
    return (
      <Base {...props} ref={ref} strokeWidth={strokeWidth} className={["space-duotone-icon", className].filter(Boolean).join(" ")}>
        {toned && plate ? <g className="space-duotone-plate" fill="currentColor" stroke="none">{plate}</g> : null}
        {children}
      </Base>
    );
  });
  Component.displayName = `SpaceDuotone(${name})`;
  return Component as LucideIcon;
}

const spaceIcons = new Map<AppIconName, LucideIcon>();

// One component per name, so a re-render never remounts the icon.
export function spaceDuotoneIcon(name: AppIconName, Base: LucideIcon): LucideIcon {
  let icon = spaceIcons.get(name);
  if (!icon) spaceIcons.set(name, icon = makeSpaceIcon(name, Base));
  return icon;
}
