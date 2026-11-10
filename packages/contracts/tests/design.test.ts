import { describe, expect, it } from "vitest";
import {
  createPaneInputSchema, defaultDesignPaneMetadata, DESIGN_ASSET_DESCRIPTION_MAX, designAssetMadeBySchema, designAssetSchema, DESIGN_COLOR_PRESETS, DESIGN_FORMATS, DESIGN_SPACEAPP_BRAND_KIT_ID, designBrandKitSchema, designColorPresetSchema, designFormatRefSchema, designPaneMetadataSchema,
  designRequestCreateSchema, MARKETING_CHANNEL_DEFAULT_FORMAT, MARKETING_CHANNELS, nearestDesignAspectRatio, NOTIFICATION_SOURCES, paneSchema, resolveDesignFormat,
  resolveDesignPaneMetadata, roomPaneBatchItemSchema, SPACEAPP_BRAND_KIT, updateUserSettingsInputSchema, userSettingsSchema
} from "../src/index.js";

describe("Design pane contracts", () => {
  // The sizes it shares with Media Studio's capture engine (scripts/space-media-capture.mjs, not in the public tree):
  // design-capture-parity.test.ts.
  it("lists unique presets with safe areas inside the canvas, and accepts custom sizes only within 64-4096 px", () => {
    expect(new Set(DESIGN_FORMATS.map((format) => format.id)).size).toBe(DESIGN_FORMATS.length);
    for (const format of DESIGN_FORMATS) {
      expect(format.safeArea.left + format.safeArea.right, format.id).toBeLessThan(format.width);
      expect(format.safeArea.top + format.safeArea.bottom, format.id).toBeLessThan(format.height);
      expect(format.maxDurationSec === null, format.id).toBe(format.kind === "IMAGE");
    }
    expect(resolveDesignFormat("yt-banner")).toMatchObject({ width: 2560, height: 1440 });
    const ytSafe = resolveDesignFormat("yt-banner")!.safeArea;
    expect([2560 - ytSafe.left - ytSafe.right, 1440 - ytSafe.top - ytSafe.bottom]).toEqual([1546, 423]);
    expect(resolveDesignFormat("custom-1500x64")).toMatchObject({ width: 1500, height: 64, kind: "BOTH" });
    for (const bad of ["custom-63x100", "custom-100x4097", "custom-10x10", "tiktok2", "custom-100x100 "]) expect(designFormatRefSchema.safeParse(bad).success, bad).toBe(false);
    expect(resolveDesignFormat("nope")).toBeNull();
    expect(nearestDesignAspectRatio(1600, 900)).toBe("16:9");
    expect(nearestDesignAspectRatio(1080, 1350)).toBe("4:5");
    expect(nearestDesignAspectRatio(1584, 396)).toBe("21:9");
    expect(nearestDesignAspectRatio(1080, 1920)).toBe("9:16");
  });

  it("has Brand formats for logos and app icons (operator request 2026-10-19)", () => {
    expect(DESIGN_FORMATS.filter((format) => format.network === "BRAND").map((format) => [format.id, format.width, format.height])).toEqual([
      ["logo", 1024, 1024], ["logo-wide", 1600, 600], ["app-icon", 512, 512]]);
    expect(resolveDesignFormat("app-icon")?.safeArea).toEqual({ top: 52, right: 52, bottom: 52, left: 52 });
  });

  it("maps every Marketing channel to a preset or to no graphic", () => {
    expect(Object.keys(MARKETING_CHANNEL_DEFAULT_FORMAT).sort()).toEqual([...MARKETING_CHANNELS].sort());
    for (const format of Object.values(MARKETING_CHANNEL_DEFAULT_FORMAT)) if (format) expect(resolveDesignFormat(format)).not.toBeNull();
    expect(MARKETING_CHANNEL_DEFAULT_FORMAT.HACKER_NEWS).toBeNull();
  });

  it("reads unconfigured and old DESIGN panes as defaults and keeps the metadata strict", () => {
    const metadata = defaultDesignPaneMetadata();
    expect(metadata.settings).toEqual({
      defaultFormatId: "square", defaultEngine: "NANO_BANANA", defaultTemplateId: "photo-headline", requestAutonomy: "AUTO", paused: false,
      brandKitId: DESIGN_SPACEAPP_BRAND_KIT_ID, motion: { defaultDurationSec: 8, gif: false }, notifications: { needsYou: true, delivered: true, telegram: false }
    });
    expect(resolveDesignPaneMetadata(null)).toEqual(metadata);
    metadata.settings.motion.gif = true;
    expect(defaultDesignPaneMetadata().settings.motion.gif).toBe(false);
    expect(designPaneMetadataSchema.parse({ version: 1, settings: { requestAutonomy: "APPROVAL", defaultFormatId: "custom-800x800" }, view: { tab: "LIBRARY", updatedAt: "2026-10-18T10:00:00.000Z" } }))
      .toMatchObject({ settings: { requestAutonomy: "APPROVAL", defaultFormatId: "custom-800x800" }, view: { tab: "LIBRARY", requestId: null, assetId: null } });
    for (const bad of [{ version: 2, settings: {} }, { version: 1, settings: { canvas: true } }, { version: 1, settings: {}, agent: { runtimeId: "cli:claude" } },
      { version: 1, settings: { defaultEngine: "MOTION" } }, { version: 1, settings: { motion: { defaultDurationSec: 600 } } }]) {
      expect(designPaneMetadataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(paneSchema.shape.designMetadata.safeParse(defaultDesignPaneMetadata()).success).toBe(true);
    expect(paneSchema.shape.designMetadata.safeParse(null).success).toBe(true);
  });

  it("creates DESIGN panes with a CLI runtime and remembers the launch choice", () => {
    expect(createPaneInputSchema.parse({ roomId: "room:test-1", title: "Design", mode: "DESIGN", terminalRuntimeId: "cli:claude" }).terminalRuntimeId).toBe("cli:claude");
    expect(roomPaneBatchItemSchema.parse({ mode: "DESIGN", terminalRuntimeId: "cli:claude" })).toEqual({ mode: "DESIGN", terminalRuntimeId: "cli:claude" });
    expect(roomPaneBatchItemSchema.safeParse({ mode: "DESIGN", cwd: "/root" }).success).toBe(false);
    expect(userSettingsSchema.parse({ design: { runtimeId: "cli:claude" } }).design).toEqual({ runtimeId: "cli:claude", accountProfileId: null, askOnLaunch: false });
    expect(NOTIFICATION_SOURCES).toContain("DESIGN");
  });

  it("keeps the ready-made colour combinations valid and saves the operator's own in user settings", () => {
    for (const preset of DESIGN_COLOR_PRESETS) expect(designColorPresetSchema.parse(preset)).toEqual(preset);
    expect(new Set(DESIGN_COLOR_PRESETS.map((preset) => preset.name)).size).toBe(DESIGN_COLOR_PRESETS.length);
    const own = { name: "Launch week", background: "#F7F5F0", primary: "#1F4FD8", accent: "#E4572E", text: "#1A1A1A" };
    expect(updateUserSettingsInputSchema.parse({ designColorPresets: [own] }).designColorPresets).toEqual([own]);
    expect(userSettingsSchema.parse({ designColorPresets: [own] }).designColorPresets).toEqual([own]);
    expect(() => updateUserSettingsInputSchema.parse({ designColorPresets: [{ ...own, text: "red" }] })).toThrow();
    // Any number of saved colour combinations since 31/10 (were 30).
    expect(updateUserSettingsInputSchema.parse({ designColorPresets: Array(31).fill(own) }).designColorPresets).toHaveLength(31);
  });

  it("validates requests and brand kits", () => {
    expect(designRequestCreateSchema.parse({ brief: "LinkedIn banner for the 0.3 release" })).toEqual({ brief: "LinkedIn banner for the 0.3 release", formatIds: [], referenceArtifactIds: [] });
    expect(designRequestCreateSchema.parse({ brief: "x", formatIds: ["linkedin-banner", "x"], callback: { kind: "MARKETING_POST", postId: "mktpost:abc123" } }).callback)
      .toEqual({ kind: "MARKETING_POST", postId: "mktpost:abc123" });
    for (const bad of [{ brief: "" }, { brief: "x".repeat(4001) }, { brief: "x", referenceArtifactIds: ["artifact:aaaaaa", "artifact:bbbbbb", "artifact:cccccc", "artifact:dddddd"] },
      { brief: "x", callback: { kind: "MAIL", postId: "mktpost:abc123" } }, { brief: "x", requester: { kind: "PANE" } }]) {
      expect(designRequestCreateSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(designBrandKitSchema.parse(SPACEAPP_BRAND_KIT)).toMatchObject({ builtIn: true, colors: { background: "#0A0E24", primary: "#67D9F5" }, fonts: { heading: "Inter" } });
    expect(designBrandKitSchema.safeParse({ ...SPACEAPP_BRAND_KIT, colors: { ...SPACEAPP_BRAND_KIT.colors, text: "red" } }).success).toBe(false);
    expect(designBrandKitSchema.safeParse({ ...SPACEAPP_BRAND_KIT, logos: ["brand:../../etc/passwd.svg"] }).success).toBe(false);
    expect(designBrandKitSchema.safeParse({ ...SPACEAPP_BRAND_KIT, fonts: { heading: "Inter;}body{x", body: "Inter" } }).success).toBe(false);
  });

  it("gives every asset what it shows and who made it (2026-10-19), null only on older rows", () => {
    const at = "2026-10-19T00:00:00.000Z";
    const asset = { id: "dasset:abc123", ownerUserId: "user:operator", paneId: null, requestId: null, artifactId: "artifact:abc123", formatId: "x", width: 1600, height: 900,
      mimeType: "image/png", engine: "UPLOAD", model: null, label: null, prompt: null, templateId: null, params: null, brandKitId: null, parentAssetId: null,
      description: "6 AI models played chess. Zero checkmates.", madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" }, pinned: true, createdAt: at, updatedAt: at };
    expect(designAssetSchema.safeParse(asset).success).toBe(true);
    expect(designAssetSchema.safeParse({ ...asset, description: null, madeBy: null }).success).toBe(true);
    const { description: _description, ...withoutDescription } = asset;
    expect(designAssetSchema.safeParse(withoutDescription).success).toBe(false);
    expect(designAssetMadeBySchema.safeParse({ by: "NOUS", runtimeId: null, model: null }).success).toBe(false);
    expect(designAssetSchema.safeParse({ ...asset, description: "x".repeat(DESIGN_ASSET_DESCRIPTION_MAX + 1) }).success).toBe(false);
  });
});
