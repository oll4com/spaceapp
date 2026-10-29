import { describe, expect, it } from "vitest";
import {
  createPaneInputSchema, defaultVideoPaneMetadata, DESIGN_FORMATS, MARKETING_CHANNEL_DEFAULT_VIDEO_FORMAT, MARKETING_CHANNELS, NOTIFICATION_SOURCES, nousCopilotSchema,
  PANE_TYPES, paneSchema, resolveDesignFormat, resolveVideoFormat, resolveVideoPaneMetadata, roomPaneBatchItemSchema, VIDEO_FORMATS, VIDEO_TTS_LANGUAGES, videoAssetSchema,
  videoFormatRefSchema, videoPaneMetadataSchema, videoRequestCreateSchema, videoSourceSchema, videoTimelineSchema, artifactKindSchema, updateUserSettingsInputSchema, userSettingsSchema
} from "../src/index.js";

describe("Video pane contracts", () => {
  it("offers every Design format that takes motion, the video-only presets, and custom sizes", () => {
    expect(VIDEO_FORMATS.map((format) => format.id)).toEqual(DESIGN_FORMATS.filter((format) => format.kind !== "IMAGE").map((format) => format.id));
    for (const format of VIDEO_FORMATS) expect(format.maxDurationSec, format.id).not.toBeNull();
    expect(resolveVideoFormat("youtube")).toMatchObject({ width: 1920, height: 1080, kind: "VIDEO", maxDurationSec: 3600 });
    expect(resolveVideoFormat("youtube-short")).toMatchObject({ width: 1080, height: 1920, maxDurationSec: 180 });
    expect(resolveVideoFormat("ig-reel")).toMatchObject({ width: 1080, height: 1920, maxDurationSec: 90 });
    expect(resolveVideoFormat("story")).toMatchObject({ width: 1080, height: 1920, maxDurationSec: 90 });
    expect(resolveVideoFormat("custom-640x360")).toMatchObject({ width: 640, height: 360, kind: "BOTH" });
    // Image-only presets are not video outputs; the Design side still knows them.
    expect(resolveVideoFormat("yt-thumb")).toBeNull();
    expect(resolveDesignFormat("yt-thumb")).not.toBeNull();
    for (const bad of ["yt-thumb", "logo", "custom-10x10", "nope"]) expect(videoFormatRefSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("maps every Marketing channel to a video preset or to no video", () => {
    expect(Object.keys(MARKETING_CHANNEL_DEFAULT_VIDEO_FORMAT).sort()).toEqual([...MARKETING_CHANNELS].sort());
    for (const format of Object.values(MARKETING_CHANNEL_DEFAULT_VIDEO_FORMAT)) if (format) expect(resolveVideoFormat(format)).not.toBeNull();
    expect(MARKETING_CHANNEL_DEFAULT_VIDEO_FORMAT.YOUTUBE).toBe("youtube");
  });

  it("reads unconfigured panes as defaults and keeps the metadata strict", () => {
    const metadata = defaultVideoPaneMetadata();
    expect(metadata.settings).toEqual({
      defaultFormatIds: ["youtube-short"], technique: "highlights", reframe: "FACE", transition: "auto", filter: "none", captions: "karaoke",
      narration: { engine: "kokoro", voice: "af_heart", language: "en" }, music: { volumeDb: -18, duckDb: -12 }, requestAutonomy: "AUTO", paused: false,
      notifications: { needsYou: true, delivered: true, telegram: false }
    });
    expect(resolveVideoPaneMetadata(null)).toEqual(metadata);
    expect(videoPaneMetadataSchema.parse({ version: 1, settings: { requestAutonomy: "APPROVAL", defaultFormatIds: ["x", "square"] }, view: { tab: "MUSIC", updatedAt: "2026-10-21T10:00:00.000Z" } }))
      .toMatchObject({ settings: { requestAutonomy: "APPROVAL", defaultFormatIds: ["x", "square"] }, view: { tab: "MUSIC", requestId: null, assetId: null, sourceArtifactId: null } });
    for (const bad of [{ version: 2, settings: {} }, { version: 1, settings: { canvas: true } }, { version: 1, settings: { defaultFormatIds: [] } },
      { version: 1, settings: { defaultFormatIds: ["yt-thumb"] } }, { version: 1, settings: { narration: { language: "English" } } }, { version: 1, settings: { technique: "magic" } }]) {
      expect(videoPaneMetadataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(paneSchema.shape.videoMetadata.safeParse(defaultVideoPaneMetadata()).success).toBe(true);
    expect(paneSchema.shape.videoMetadata.safeParse(null).success).toBe(true);
  });

  it("takes sources from the owner's artifacts or an https page whose rights the requester confirms", () => {
    expect(videoSourceSchema.safeParse({ artifactId: "artifact:abc12345" }).success).toBe(true);
    expect(videoSourceSchema.safeParse({ url: "https://www.youtube.com/watch?v=abcdefghijk", rightsConfirmed: true }).success).toBe(true);
    for (const bad of [{ url: "https://example.com/v.mp4" }, { url: "http://example.com/v.mp4", rightsConfirmed: true }, { artifactId: "pane:abc12345" }, { path: "/tmp/x.mp4" }]) {
      expect(videoSourceSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const request = videoRequestCreateSchema.parse({ brief: "A 30-second highlight reel", sources: [{ artifactId: "artifact:abc12345" }], formatIds: ["youtube-short"], options: { technique: "silence", narration: { text: "Hello", language: "el" } } });
    expect(request).toMatchObject({ sources: [{ artifactId: "artifact:abc12345" }], formatIds: ["youtube-short"], options: { technique: "silence", narration: { text: "Hello", language: "el" } } });
    expect(videoRequestCreateSchema.parse({ brief: "x" })).toMatchObject({ sources: [], formatIds: [], options: {} });
    expect(videoRequestCreateSchema.safeParse({ brief: "x", formatIds: Array(9).fill("x") }).success).toBe(false);
  });

  it("checks a timeline: clips in order, bounded layers, defaults for every layer", () => {
    const timeline = videoTimelineSchema.parse({ version: 1, clips: [{ sourceIndex: 0, inSec: 2, outSec: 9.5 }, { sourceIndex: 1, inSec: 0, outSec: 4, speed: 1.5 }], outputs: [{ formatId: "square" }] });
    expect(timeline).toMatchObject({ transition: "auto", transitionSec: 0.4, filter: "none", reframe: "FACE", captions: { style: "none", language: null, position: "BOTTOM" }, overlays: [], narration: null, music: null });
    expect(timeline.clips[1]).toMatchObject({ speed: 1.5 });
    const narrated = videoTimelineSchema.parse({ ...timeline, narration: { segments: [{ atSec: 0, text: "Welcome" }], language: "el", engine: "chatterbox" }, music: { artifactId: "artifact:music123" } });
    expect(narrated.narration).toMatchObject({ engine: "chatterbox", voice: null, volumeDb: 0 });
    expect(narrated.music).toMatchObject({ artifactId: "artifact:music123", volumeDb: -18, duckDb: -12, fadeOutSec: 2 });
    for (const bad of [{ ...timeline, clips: [] }, { ...timeline, clips: [{ sourceIndex: 0, inSec: 5, outSec: 5 }] }, { ...timeline, outputs: [] }, { ...timeline, outputs: [{ formatId: "yt-thumb" }] },
      { ...timeline, transition: "explode" }, { ...timeline, overlays: [{ artifactId: "artifact:ov123456", fromSec: 3, toSec: 1 }] }, { ...timeline, version: 2 }]) {
      expect(videoTimelineSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(VIDEO_TTS_LANGUAGES.el).toEqual(["chatterbox"]);
    expect(VIDEO_TTS_LANGUAGES.en).toContain("kokoro");
  });

  it("keeps every asset described and attributed, with the timeline an output came from", () => {
    const asset = videoAssetSchema.parse({ id: "vasset:abc12345", ownerUserId: "user:1", paneId: "pane:abc12345", requestId: null, artifactId: "artifact:abc12345", thumbnailArtifactId: "artifact:thumb123",
      formatId: "square", width: 1080, height: 1080, durationSec: 31.5, mimeType: "video/mp4", kind: "OUTPUT", label: "Reel", description: "A 30 s reel of the launch, captions in English",
      madeBy: { by: "AGENT", runtimeId: "cli:claude", model: "claude-opus-5-5" }, credits: "Track by X (ccMixter, CC BY)", timeline: null, parentAssetId: null, pinned: true,
      createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z" });
    expect(asset.kind).toBe("OUTPUT");
    expect(videoAssetSchema.safeParse({ ...asset, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(videoAssetSchema.safeParse({ ...asset, kind: "PHOTO" }).success).toBe(false);
    expect(artifactKindSchema.parse("AUDIO")).toBe("AUDIO");
  });

  it("creates VIDEO panes with a CLI runtime, remembers the launch choice and registers the pane everywhere", () => {
    expect(createPaneInputSchema.parse({ roomId: "room:test-1", title: "Video", mode: "VIDEO", terminalRuntimeId: "cli:claude" }).terminalRuntimeId).toBe("cli:claude");
    expect(roomPaneBatchItemSchema.parse({ mode: "VIDEO", terminalRuntimeId: "cli:claude" })).toEqual({ mode: "VIDEO", terminalRuntimeId: "cli:claude" });
    expect(userSettingsSchema.parse({ video: { runtimeId: "cli:claude" } }).video).toMatchObject({ runtimeId: "cli:claude" });
    expect(updateUserSettingsInputSchema.parse({ video: null }).video).toBeNull();
    expect(NOTIFICATION_SOURCES).toContain("VIDEO");
    expect(nousCopilotSchema.parse("VIDEO")).toBe("VIDEO");
    expect(PANE_TYPES.find((type) => type.typeId === "video")).toMatchObject({ mode: "VIDEO", adapter: "video", readiness: "TERMINAL_INPUT" });
  });
});
