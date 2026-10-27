import { describe, expect, it } from "vitest";
import {
  MODERN_APPEARANCE_STORAGE_KEY,
  MODERN_ICON_PACK_STORAGE_KEY,
  MODERN_TOOLBAR_MIGRATION_MARKER_SUFFIX,
  UI_BACKGROUND_STORAGE_KEY,
  UI_THEME_STORAGE_KEY,
  migrateModernToolbarPreference,
  modernPaneToolbarStorageKeys,
  modernRoomToolbarStorageKeys,
  readModernAppearance,
  readModernIconPack,
  readUiBackground,
  readUiTheme,
  resolveModernColorMode,
  shouldMeasureToolbarLayout,
  writeModernAppearance,
  writeModernIconPack,
  writeUiBackground,
  writeUiTheme,
  LIQUID_GLASS_TINT_STORAGE_KEY,
  readLiquidGlassTint,
  writeLiquidGlassTint
} from "../src/ui-theme.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("Space UI theme preferences", () => {
  it("uses Modern by default while preserving an explicit Classic preference", () => {
    const storage = new MemoryStorage();

    expect(readUiTheme(storage)).toBe("modern");

    storage.setItem(UI_THEME_STORAGE_KEY, "unknown");
    expect(readUiTheme(storage)).toBe("modern");

    storage.setItem(UI_THEME_STORAGE_KEY, "classic");
    expect(readUiTheme(storage)).toBe("classic");
    expect(writeUiTheme(storage, "codex")).toBe("codex");
    expect(readUiTheme(storage)).toBe("codex");
    expect(writeUiTheme(storage, "motion")).toBe("motion");
    expect(readUiTheme(storage)).toBe("motion");
    expect(writeUiTheme(storage, "aurora")).toBe("aurora");
    expect(readUiTheme(storage)).toBe("aurora");
    expect(writeUiTheme(storage, "liquid-glass")).toBe("liquid-glass");
    expect(readUiTheme(storage)).toBe("liquid-glass");
    expect(writeUiTheme(storage, "jarvis")).toBe("jarvis");
    expect(readUiTheme(storage)).toBe("jarvis");
    expect(writeUiTheme(storage, "aira")).toBe("aira");
    expect(readUiTheme(storage)).toBe("aira");
  });

  it("stores the opt-in Modern selection without touching Classic theme keys", () => {
    const storage = new MemoryStorage();
    storage.setItem("space.room.theme", "forest");

    expect(writeUiTheme(storage, "modern")).toBe("modern");
    expect(storage.getItem(UI_THEME_STORAGE_KEY)).toBe("modern");
    expect(storage.getItem("space.room.theme")).toBe("forest");
  });

  it("defaults Modern appearance to System and resolves the current color mode", () => {
    const storage = new MemoryStorage();

    expect(readModernAppearance(storage)).toBe("system");
    expect(resolveModernColorMode("system", true)).toBe("dark");
    expect(resolveModernColorMode("system", false)).toBe("light");
    expect(resolveModernColorMode("dark", false)).toBe("dark");
    expect(resolveModernColorMode("light", true)).toBe("light");
  });

  it("keeps DOM layout measurement on Classic and lets Modern use stable CSS layout", () => {
    expect(shouldMeasureToolbarLayout("classic")).toBe(true);
    expect(shouldMeasureToolbarLayout("modern")).toBe(false);
  });

  it("stores Modern appearance in an isolated namespace", () => {
    const storage = new MemoryStorage();
    storage.setItem("space.room.theme", "copper");

    expect(writeModernAppearance(storage, "light")).toBe("light");
    expect(storage.getItem(MODERN_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(storage.getItem("space.room.theme")).toBe("copper");
  });

  it("stores an icon pack with Space Duotone as the default and keeps a chosen Lucide", () => {
    const storage = new MemoryStorage();
    storage.setItem("space.room.theme", "forest");

    expect(readModernIconPack(storage)).toBe("space");
    storage.setItem(MODERN_ICON_PACK_STORAGE_KEY, "unsupported");
    expect(readModernIconPack(storage)).toBe("space");
    expect(writeModernIconPack(storage, "lucide")).toBe("lucide");
    expect(readModernIconPack(storage)).toBe("lucide");
    expect(writeModernIconPack(storage, "material-rounded")).toBe("material-rounded");
    expect(storage.getItem(MODERN_ICON_PACK_STORAGE_KEY)).toBe("material-rounded");
    expect(writeModernIconPack(storage, "motion")).toBe("motion");
    expect(readModernIconPack(storage)).toBe("motion");
    expect(storage.getItem(MODERN_ICON_PACK_STORAGE_KEY)).toBe("motion");
    expect(writeModernIconPack(storage, "aurora")).toBe("aurora");
    expect(readModernIconPack(storage)).toBe("aurora");
    expect(storage.getItem("space.room.theme")).toBe("forest");
  });

  it("provides only Modern-namespaced room and pane toolbar keys", () => {
    expect(modernRoomToolbarStorageKeys()).toEqual({
      hidden: "space.modern.toolbar.room.hiddenActionIds.v1",
      order: "space.modern.toolbar.room.actionOrder.v1"
    });
    expect(modernPaneToolbarStorageKeys("CHAT")).toEqual({
      hidden: "space.modern.toolbar.pane.sharedCodex.hiddenActionIds.v1",
      order: "space.modern.toolbar.pane.sharedCodex.actionOrder.v1"
    });
    expect(modernPaneToolbarStorageKeys("TERMINAL")).toEqual(modernPaneToolbarStorageKeys("CHAT"));
    expect(modernPaneToolbarStorageKeys("BROWSER")).toEqual({
      hidden: "space.modern.toolbar.pane.BROWSER.hiddenActionIds.v1",
      order: "space.modern.toolbar.pane.BROWSER.actionOrder.v1"
    });
  });

  it("copies a Classic toolbar preference once without writing to the Classic key", () => {
    const storage = new MemoryStorage();
    const classicKey = "space.roomToolbar.hiddenActionIds.v3";
    const modernKey = modernRoomToolbarStorageKeys().hidden;
    storage.setItem(classicKey, JSON.stringify(["theme", "clip-tool"]));

    migrateModernToolbarPreference(storage, classicKey, modernKey);

    expect(storage.getItem(modernKey)).toBe(JSON.stringify(["theme", "clip-tool"]));
    expect(storage.getItem(classicKey)).toBe(JSON.stringify(["theme", "clip-tool"]));
    expect(storage.getItem(`${modernKey}${MODERN_TOOLBAR_MIGRATION_MARKER_SUFFIX}`)).toBe("true");

    storage.removeItem(modernKey);
    storage.setItem(classicKey, JSON.stringify(["reload-room"]));
    migrateModernToolbarPreference(storage, classicKey, modernKey);

    expect(storage.getItem(modernKey)).toBeNull();
    expect(storage.getItem(classicKey)).toBe(JSON.stringify(["reload-room"]));
  });

  it("preserves an existing Modern toolbar preference during first-use migration", () => {
    const storage = new MemoryStorage();
    const classicKey = "space.browserToolbar.actionOrder";
    const modernKey = modernPaneToolbarStorageKeys("BROWSER").order;
    storage.setItem(classicKey, JSON.stringify(["refresh", "stop"]));
    storage.setItem(modernKey, JSON.stringify(["stop", "refresh"]));

    migrateModernToolbarPreference(storage, classicKey, modernKey);

    expect(storage.getItem(modernKey)).toBe(JSON.stringify(["stop", "refresh"]));
    expect(storage.getItem(classicKey)).toBe(JSON.stringify(["refresh", "stop"]));
  });

  it("stores and reads UI background with spaceapp as default", () => {
    const storage = new MemoryStorage();

    expect(readUiBackground(storage)).toBe("spaceapp");
    storage.setItem(UI_BACKGROUND_STORAGE_KEY, "invalid");
    expect(readUiBackground(storage)).toBe("spaceapp");

    expect(writeUiBackground(storage, "none")).toBe("none");
    expect(storage.getItem(UI_BACKGROUND_STORAGE_KEY)).toBe("none");
    expect(readUiBackground(storage)).toBe("none");

    expect(writeUiBackground(storage, "aurora")).toBe("aurora");
    expect(readUiBackground(storage)).toBe("aurora");
    expect(writeUiBackground(storage, "liquid-glass")).toBe("liquid-glass");
    expect(readUiBackground(storage)).toBe("liquid-glass");
    expect(writeUiBackground(storage, "jarvis")).toBe("jarvis");
    expect(readUiBackground(storage)).toBe("jarvis");
    expect(writeUiBackground(storage, "aira")).toBe("aira");
    expect(readUiBackground(storage)).toBe("aira");
    expect(writeUiBackground(storage, "spaceapp")).toBe("spaceapp");
    expect(storage.getItem(UI_BACKGROUND_STORAGE_KEY)).toBe("spaceapp");
    expect(readUiBackground(storage)).toBe("spaceapp");
  });

  it("stores the Liquid Glass tint and applies it live through --lg-tint", () => {
    const storage = new MemoryStorage();
    expect(readLiquidGlassTint(storage)).toBe(50);
    for (const invalid of ["abc", "-5", "101", "7.5"]) {
      storage.setItem(LIQUID_GLASS_TINT_STORAGE_KEY, invalid);
      expect(readLiquidGlassTint(storage)).toBe(50);
    }
    expect(writeLiquidGlassTint(storage, 0)).toBe(0);
    expect(readLiquidGlassTint(storage)).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--lg-tint")).toBe("0");
    writeLiquidGlassTint(storage, 100);
    expect(document.documentElement.style.getPropertyValue("--lg-tint")).toBe("100");
  });
});
