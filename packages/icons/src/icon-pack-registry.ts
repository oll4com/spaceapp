// The selectable icon packs; Space Duotone is the default (operator decision 2026-10-14), Lucide its base geometry.
export type ModernIconPack = "lucide" | "material-rounded" | "motion" | "aurora" | "space";
export const DEFAULT_ICON_PACK: ModernIconPack = "space";
import type { AppIconName } from "./app-icon-map.js";
import type { LucideIcon } from "lucide-react";
import { spaceDuotoneIcon } from "./space-duotone-icons.js";

// Lucide and the default Space Duotone ship with the app; the other packs load on demand.
// main.tsx awaits the stored pack before the first render, so the selected pack never flashes Lucide icons.
export type AppIconPackIcons = Partial<Record<AppIconName, LucideIcon>>;
// A style pack restyles the default icon instead of drawing its own (Aurora inks, Space Duotone tones the Lucide geometry).
export type AppIconPackStyle = (name: AppIconName, base: LucideIcon) => LucideIcon;
type LoadedIconPack = AppIconPackIcons | AppIconPackStyle;
type OnDemandIconPack = Exclude<ModernIconPack, "lucide" | "space">;

const iconPackLoaders: Record<OnDemandIconPack, () => Promise<LoadedIconPack>> = {
  "material-rounded": () => import("./material-rounded-icons.js").then((module) => module.materialRoundedAppIcons),
  motion: () => import("./motion-geometric-icons.js").then((module) => module.motionGeometricIcons),
  aurora: () => import("./aurora-icons.js").then((module) => module.auroraIcon)
};
const loadedIconPacks = new Map<Exclude<ModernIconPack, "lucide">, LoadedIconPack>([["space", spaceDuotoneIcon]]);
const pendingIconPacks = new Map<OnDemandIconPack, Promise<void>>();

export function isAppIconPackReady(pack: ModernIconPack): boolean {
  return pack === "lucide" || loadedIconPacks.has(pack);
}

export function getLoadedAppIconPack(pack: ModernIconPack): LoadedIconPack | undefined {
  return pack === "lucide" ? undefined : loadedIconPacks.get(pack);
}

export function loadAppIconPack(pack: ModernIconPack): Promise<void> {
  if (pack === "lucide" || pack === "space" || loadedIconPacks.has(pack)) return Promise.resolve();
  let pending = pendingIconPacks.get(pack);
  if (!pending) {
    pending = iconPackLoaders[pack]()
      .then((icons) => { loadedIconPacks.set(pack, icons); })
      .finally(() => { pendingIconPacks.delete(pack); });
    pendingIconPacks.set(pack, pending);
  }
  return pending;
}
