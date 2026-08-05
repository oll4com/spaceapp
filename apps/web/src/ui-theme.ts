export type UiTheme = "classic" | "modern";
export type ModernAppearance = "system" | "dark" | "light";
export type ModernColorMode = "dark" | "light";
export type ModernIconPack = "lucide" | "material-rounded";

export const UI_THEME_STORAGE_KEY = "space.uiTheme.v1";
export const MODERN_APPEARANCE_STORAGE_KEY = "space.modern.appearance.mode.v1";
export const MODERN_ICON_PACK_STORAGE_KEY = "space.modern.iconPack.v1";
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
  return storage.getItem(UI_THEME_STORAGE_KEY) === "classic" ? "classic" : "modern";
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
  return storage.getItem(MODERN_ICON_PACK_STORAGE_KEY) === "material-rounded"
    ? "material-rounded"
    : "lucide";
}

export function writeModernIconPack(storage: Storage, iconPack: ModernIconPack): ModernIconPack {
  storage.setItem(MODERN_ICON_PACK_STORAGE_KEY, iconPack);
  return iconPack;
}

export function resolveModernColorMode(appearance: ModernAppearance, prefersDark: boolean): ModernColorMode {
  return appearance === "system" ? (prefersDark ? "dark" : "light") : appearance;
}

export function shouldMeasureToolbarLayout(theme: UiTheme): boolean {
  return theme === "classic";
}
