import { forwardRef, type ReactNode } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import type { AppIconName } from "./app-icon-map.js";

type IconRenderer = (props: LucideProps) => ReactNode;

function makeMotionIcon(name: string, render: IconRenderer): LucideIcon {
  const Component = forwardRef<SVGSVGElement, LucideProps>(function MotionGeometricIcon(
    {
      absoluteStrokeWidth: _absoluteStrokeWidth,
      children: _children,
      color = "currentColor",
      fill = "none",
      size = 24,
      stroke = "currentColor",
      strokeWidth = 2,
      className,
      ...props
    },
    ref
  ) {
    return (
      <svg
        ref={ref}
        {...props}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill}
        stroke={stroke}
        color={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={["motion-geometric-icon", className].filter(Boolean).join(" ")}
        xmlns="http://www.w3.org/2000/svg"
      >
        {render({ ...props, color, fill, size, stroke, strokeWidth, className })}
      </svg>
    );
  });
  Component.displayName = `MotionGeometric(${name})`;
  return Component as LucideIcon;
}

export const motionGeometricIcons: Partial<Record<AppIconName, LucideIcon>> = {
  // 1. Create (+) - HUD Target Reticle Plus
  Plus: makeMotionIcon("Plus", ({ strokeWidth }) => (
    <>
      <path d="M12 4v16m-8-8h16" />
      <path d="M4 8V4h4M16 4h4v4M4 16v4h4M16 20h4v-4" strokeWidth={Number(strokeWidth) * 0.65} opacity={0.65} />
    </>
  )),

  // 2. Layout - Modular Split Viewport Grid
  PanelsTopLeft: makeMotionIcon("PanelsTopLeft", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M3 9.5h18M11 9.5v11.5" />
    </>
  )),
  LayoutDashboard: makeMotionIcon("LayoutDashboard", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M3 9.5h18M11 9.5v11.5" />
    </>
  )),

  // 3. Docks - Orbital Docking Pods Matrix (4-pod with central core)
  Grid2X2: makeMotionIcon("Grid2X2", () => (
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="2" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="2" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="2" />
      <rect x="14" y="14" width="6.5" height="6.5" rx="2" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  )),
  Grid3X3: makeMotionIcon("Grid3X3", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" opacity={0.7} />
    </>
  )),
  Boxes: makeMotionIcon("Boxes", () => (
    <>
      <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l6 3.42a2 2 0 0 0 2.06 0l6-3.42a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71l-6-3.42a2 2 0 0 0-2.06 0z" />
      <path d="m12 12.5 6-3.42M12 12.5v9M12 12.5l-6-3.42" />
    </>
  )),

  // 4. Tools - Cyber Omni-Tool & Precision HUD Caliper
  Wrench: makeMotionIcon("Wrench", ({ strokeWidth }) => (
    <>
      <path d="M7 3v4.5l3 3.5v2" />
      <path d="M17 3v4.5l-3 3.5v2" />
      <line x1="9.5" y1="4.5" x2="14.5" y2="4.5" strokeWidth={Number(strokeWidth) * 0.75} opacity={0.7} />
      <circle cx="12" cy="11" r="1.4" fill="currentColor" stroke="none" />
      <path d="M9 13h6v6.5a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 19.5V13z" />
      <line x1="11" y1="17" x2="13" y2="17" strokeWidth={Number(strokeWidth) * 0.75} opacity={0.65} />
    </>
  )),

  // 5. Sticky Note - Holographic Data Slate
  File: makeMotionIcon("File", () => (
    <>
      <path d="M4 4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z" />
      <path d="M14 2v6h6M8 12.5h8M8 16.5h5" />
    </>
  )),

  // 6. Rooms - Multi-Bay Station Chambers
  PanelLeft: makeMotionIcon("PanelLeft", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <circle cx="6" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="6" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  )),
  PanelRight: makeMotionIcon("PanelRight", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <circle cx="18" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="16.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  )),
  Columns2: makeMotionIcon("Columns2", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </>
  )),
  Columns3: makeMotionIcon("Columns3", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </>
  )),

  // 7. Music - Sonic Spectrum Resonator
  Music2: makeMotionIcon("Music2", () => (
    <path d="M3 10v4M7 6v12M11 3v18M15 8v8M19 11v2M22 12v0.01" />
  )),

  // 8. Keyboard - Cyberdeck Matrix
  Keyboard: makeMotionIcon("Keyboard", () => (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="M6 8.5h.01M10 8.5h.01M14 8.5h.01M18 8.5h.01M6.5 12h.01M12 12h.01M17.5 12h.01M7 15.5h10" />
    </>
  )),

  // 9. Fullscreen - HUD Viewport Warp Brackets
  Maximize2: makeMotionIcon("Maximize2", () => (
    <path d="M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M8 21H4a1 1 0 0 1-1-1v-4M16 21h4a1 1 0 0 0 1-1v-4" />
  )),
  Minimize2: makeMotionIcon("Minimize2", () => (
    <path d="M4 14h4a1 1 0 0 0 1-1v-4M20 14h-4a1 1 0 0 1-1-1v-4M4 10h4a1 1 0 0 1 1 1v4M20 10h-4a1 1 0 0 0-1 1v4" />
  )),

  // 10. Expand - Retractable Shutter Canopy
  PanelTopOpen: makeMotionIcon("PanelTopOpen", () => (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M9 13.5l3 3 3-3" />
    </>
  )),

  // 11. Live AI Agent - AI Reactor Core with Energy Rings
  Bot: makeMotionIcon("Bot", () => (
    <>
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.8" stroke="currentColor" strokeDasharray="3.5 2" />
      <circle cx="12" cy="12" r="9.6" stroke="currentColor" opacity={0.6} />
    </>
  )),
  Sparkles: makeMotionIcon("Sparkles", () => (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
      <circle cx="19" cy="5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none" />
    </>
  )),
  Radio: makeMotionIcon("Radio", () => (
    <>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 7.76a6 6 0 0 0 0 8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
    </>
  )),

  // Core System & Developer Tools
  Terminal: makeMotionIcon("Terminal", () => (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m7 9 4 3-4 3M13 15h4" />
    </>
  )),
  Cpu: makeMotionIcon("Cpu", () => (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </>
  )),
  Crosshair: makeMotionIcon("Crosshair", ({ strokeWidth }) => (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
      <path d="M7 7l-2-2M17 7l2-2M7 17l-2 2M17 17l2 2" strokeWidth={Number(strokeWidth) * 0.65} opacity={0.65} />
    </>
  )),
  HardDrive: makeMotionIcon("HardDrive", () => (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2.5" />
      <line x1="2" y1="13" x2="22" y2="13" />
      <circle cx="6" cy="15.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15.5" r="1" fill="currentColor" stroke="none" />
    </>
  )),
  Activity: makeMotionIcon("Activity", () => (
    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
  )),
  Gauge: makeMotionIcon("Gauge", () => (
    <>
      <path d="m12 14 3-3" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      <circle cx="12" cy="14" r="2" fill="currentColor" stroke="none" />
    </>
  )),
  Network: makeMotionIcon("Network", () => (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="19" r="2.5" />
      <circle cx="19" cy="19" r="2.5" />
      <path d="M10.5 7.2 6.5 16.8M13.5 7.2l4 9.6M7.5 19h9" />
    </>
  )),
  Brain: makeMotionIcon("Brain", () => (
    <>
      <path d="M12 5a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V8a3 3 0 0 0-3-3z" />
      <circle cx="6" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="14.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="14.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9 8H6M9 13H5.5M15 8h3M15 13h3.5" />
    </>
  )),
  BrainCircuit: makeMotionIcon("BrainCircuit", () => (
    <>
      <path d="M12 5a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V8a3 3 0 0 0-3-3z" />
      <circle cx="6" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="9" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9 8H6M15 8h3" />
    </>
  )),
  Rocket: makeMotionIcon("Rocket", () => (
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>
  )),
  Shield: makeMotionIcon("Shield", () => (
    <path d="M12 2 4 5v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V5z" />
  )),
  ShieldCheck: makeMotionIcon("ShieldCheck", () => (
    <>
      <path d="M12 2 4 5v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V5z" />
      <path d="m9 12 2 2 4-4" />
    </>
  )),
  Settings2: makeMotionIcon("Settings2", () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12" />
      <circle cx="12" cy="12" r="7" strokeDasharray="2 3" opacity={0.65} />
    </>
  )),
  SlidersHorizontal: makeMotionIcon("SlidersHorizontal", () => (
    <>
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="3" y1="17" x2="21" y2="17" />
      <rect x="7" y="4" width="4" height="6" rx="1" />
      <line x1="9" y1="4.5" x2="9" y2="9.5" opacity={0.65} />
      <rect x="13" y="14" width="4" height="6" rx="1" />
      <line x1="15" y1="14.5" x2="15" y2="19.5" opacity={0.65} />
      <circle cx="3" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="21" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="3" cy="17" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="21" cy="17" r="0.8" fill="currentColor" stroke="none" />
    </>
  )),
  Folder: makeMotionIcon("Folder", () => (
    <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
  )),
  FolderOpen: makeMotionIcon("FolderOpen", () => (
    <>
      <path d="m6 14 1.5-6h13l-2.5 12h-14L6 14z" />
      <path d="M6 8V5a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1" />
    </>
  )),
  Search: makeMotionIcon("Search", () => (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35M11 7v2M11 13v2M7 11h2M13 11h2" opacity={0.7} />
    </>
  )),
  Clock3: makeMotionIcon("Clock3", () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  )),
  Check: makeMotionIcon("Check", () => (
    <path d="M20 6 9 17l-5-5" />
  )),
  CheckCircle2: makeMotionIcon("CheckCircle2", () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5" />
    </>
  )),
  ChevronLeft: makeMotionIcon("ChevronLeft", () => (
    <path d="m15 18-6-6 6-6" />
  )),
  ChevronRight: makeMotionIcon("ChevronRight", () => (
    <path d="m9 18 6-6-6-6" />
  )),
  X: makeMotionIcon("X", () => (
    <path d="m18 6-12 12M6 6l12 12" />
  )),
  RefreshCw: makeMotionIcon("RefreshCw", () => (
    <>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </>
  )),
  RotateCcw: makeMotionIcon("RotateCcw", () => (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  )),
  RotateCw: makeMotionIcon("RotateCw", () => (
    <>
      <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </>
  )),
  Play: makeMotionIcon("Play", () => (
    <polygon points="7 4 19 12 7 20 7 4" />
  )),
  Pause: makeMotionIcon("Pause", () => (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1.5" />
      <rect x="14" y="4" width="4" height="16" rx="1.5" />
    </>
  )),
  Save: makeMotionIcon("Save", () => (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </>
  )),
  Trash2: makeMotionIcon("Trash2", () => (
    <>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  )),
  Star: makeMotionIcon("Star", () => (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  )),
  Lock: makeMotionIcon("Lock", () => (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      <circle cx="12" cy="16" r="1.3" fill="currentColor" stroke="none" />
    </>
  )),
  Link: makeMotionIcon("Link", () => (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  )),
  Zap: makeMotionIcon("Zap", () => (
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  )),
  Send: makeMotionIcon("Send", () => (
    <>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </>
  )),
  Palette: makeMotionIcon("Palette", () => (
    <>
      <circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.92 0 1.67-.75 1.67-1.67 0-.43-.16-.83-.44-1.13-.27-.3-.44-.7-.44-1.13 0-.92.75-1.67 1.67-1.67H16c3.31 0 6-2.69 6-6 0-4.97-4.48-9.4-10-9.4z" />
    </>
  )),
  Globe: makeMotionIcon("Globe", () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  )),
  Download: makeMotionIcon("Download", () => (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  )),
  Upload: makeMotionIcon("Upload", () => (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  )),
  UserCheck: makeMotionIcon("UserCheck", () => (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <polyline points="16 11 18 13 22 9" />
    </>
  )),
  Users: makeMotionIcon("Users", () => (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  )),
  MessageSquare: makeMotionIcon("MessageSquare", () => (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  )),
  Images: makeMotionIcon("Images", () => (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="m21 15-5-5L5 21" />
    </>
  ))
};
