import { DEFAULT_ICON_PACK, type ModernIconPack } from "@space/icons";

export type { ModernIconPack };
export type UiTheme = "classic" | "modern" | "codex" | "motion" | "aurora" | "liquid-glass";
export type ModernAppearance = "system" | "dark" | "light";
export type ModernColorMode = "dark" | "light";
export type UiBackground = "spaceapp" | "aurora" | "liquid-glass" | "none";

export const UI_THEME_STORAGE_KEY = "space.uiTheme.v1";
export const MODERN_APPEARANCE_STORAGE_KEY = "space.modern.appearance.mode.v1";
export const MODERN_ICON_PACK_STORAGE_KEY = "space.modern.iconPack.v1";
export const UI_BACKGROUND_STORAGE_KEY = "space.uiBackground.v1";
export const LIQUID_GLASS_TINT_STORAGE_KEY = "space.liquidGlass.tint.v1";
export const DEFAULT_LIQUID_GLASS_TINT = 50;
export const MODERN_TOOLBAR_MIGRATION_MARKER_SUFFIX = ".classicRead.v1";

type ToolbarStorageKeys = {
  hidden: string;
  order: string;
};

export function modernRoomToolbarStorageKeys(): ToolbarStorageKeys {
  return {
    hidden: "space.modern.toolbar.room.hiddenActionIds.v1",
    order: "space.modern.toolbar.room.actionOrder.v1"
  };
}

export function modernPaneToolbarStorageKeys(mode: string): ToolbarStorageKeys {
  const scope = mode === "CHAT" || mode === "TERMINAL" ? "sharedCodex" : mode;
  return {
    hidden: `space.modern.toolbar.pane.${scope}.hiddenActionIds.v1`,
    order: `space.modern.toolbar.pane.${scope}.actionOrder.v1`
  };
}

export function migrateModernToolbarPreference(storage: Storage, classicKey: string, modernKey: string): void {
  const markerKey = `${modernKey}${MODERN_TOOLBAR_MIGRATION_MARKER_SUFFIX}`;
  try {
    if (storage.getItem(markerKey) === "true") return;
    if (storage.getItem(modernKey) === null) {
      const classicValue = storage.getItem(classicKey);
      if (classicValue !== null) storage.setItem(modernKey, classicValue);
    }
    storage.setItem(markerKey, "true");
  } catch {
    // Browser-local preferences are best effort only.
  }
}

export function readUiTheme(storage: Storage): UiTheme {
  const theme = storage.getItem(UI_THEME_STORAGE_KEY);
  return theme === "classic" || theme === "codex" || theme === "motion" || theme === "aurora" || theme === "liquid-glass" ? theme : "modern";
}

export function writeUiTheme(storage: Storage, theme: UiTheme): UiTheme {
  storage.setItem(UI_THEME_STORAGE_KEY, theme);
  return theme;
}

export function readModernAppearance(storage: Storage): ModernAppearance {
  const stored = storage.getItem(MODERN_APPEARANCE_STORAGE_KEY);
  return stored === "dark" || stored === "light" ? stored : "system";
}

export function writeModernAppearance(storage: Storage, appearance: ModernAppearance): ModernAppearance {
  storage.setItem(MODERN_APPEARANCE_STORAGE_KEY, appearance);
  return appearance;
}

export function readModernIconPack(storage: Storage): ModernIconPack {
  const stored = storage.getItem(MODERN_ICON_PACK_STORAGE_KEY);
  return stored === "lucide" || stored === "material-rounded" || stored === "motion" || stored === "aurora" || stored === "space"
    ? stored
    : DEFAULT_ICON_PACK;
}

export function writeModernIconPack(storage: Storage, iconPack: ModernIconPack): ModernIconPack {
  storage.setItem(MODERN_ICON_PACK_STORAGE_KEY, iconPack);
  return iconPack;
}

export function readUiBackground(storage: Storage): UiBackground {
  const stored = storage.getItem(UI_BACKGROUND_STORAGE_KEY);
  return stored === "none" || stored === "aurora" || stored === "liquid-glass" ? stored : "spaceapp";
}

export function writeUiBackground(storage: Storage, background: UiBackground): UiBackground {
  storage.setItem(UI_BACKGROUND_STORAGE_KEY, background);
  return background;
}

export function readLiquidGlassTint(storage: Storage): number {
  const stored = Number(storage.getItem(LIQUID_GLASS_TINT_STORAGE_KEY) ?? Number.NaN);
  return Number.isInteger(stored) && stored >= 0 && stored <= 100 ? stored : DEFAULT_LIQUID_GLASS_TINT;
}

/** Stores the Liquid Glass tint (0 ultra clear, 100 fully tinted) and applies it live through --lg-tint. */
export function writeLiquidGlassTint(storage: Storage, tint: number): number {
  storage.setItem(LIQUID_GLASS_TINT_STORAGE_KEY, String(tint));
  applyLiquidGlassTint(tint);
  return tint;
}

export function applyLiquidGlassTint(tint: number): void {
  if (typeof document !== "undefined") document.documentElement.style.setProperty("--lg-tint", String(tint));
}

export function resolveModernColorMode(appearance: ModernAppearance, prefersDark: boolean): ModernColorMode {
  return appearance === "system" ? (prefersDark ? "dark" : "light") : appearance;
}

export function shouldMeasureToolbarLayout(theme: UiTheme): boolean {
  return theme === "classic";
}
