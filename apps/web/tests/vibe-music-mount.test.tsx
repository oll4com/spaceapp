import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectPlaybackTargets,
  registerRoomPlaybackTarget,
  runRoomPlaybackCommand
} from "../src/features/room-agent/room-playback-control.js";
import {
  VIBE_MUSIC_PLAYBACK_STORAGE_KEY,
  VIBE_MUSIC_PLAYBACK_TARGET_ID,
  useVibeMusicMount
} from "../src/features/vibe-music/vibe-music-session.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const run = vi.fn(async () => true);

function FakePlayer({ roomId }: { roomId: string }) {
  useEffect(() => registerRoomPlaybackTarget(VIBE_MUSIC_PLAYBACK_TARGET_ID, { roomId, kind: "MUSIC", playing: false, run }), [roomId]);
  return <output>player mounted</output>;
}

function Harness({ roomId, requested }: { roomId?: string; requested: boolean }) {
  const mounted = useVibeMusicMount(roomId, requested);
  return mounted && roomId ? <FakePlayer roomId={roomId} /> : null;
}

describe("useVibeMusicMount", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.sessionStorage.clear();
    run.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not mount the player until it is first opened, then keeps it mounted", () => {
    const view = render(<Harness roomId="room:music" requested={false} />);
    expect(view.queryByText("player mounted")).toBeNull();

    view.rerender(<Harness roomId="room:music" requested />);
    expect(view.getByText("player mounted")).toBeTruthy();

    view.rerender(<Harness roomId="room:music" requested={false} />);
    expect(view.getByText("player mounted")).toBeTruthy();
  });

  it("keeps the Room Agent music target available before first open and forwards commands to the loaded player", async () => {
    const view = render(<Harness roomId="room:agent" requested={false} />);
    expect(inspectPlaybackTargets("room:agent")).toEqual([{ id: VIBE_MUSIC_PLAYBACK_TARGET_ID, kind: "MUSIC", playing: false }]);

    const result = runRoomPlaybackCommand("room:agent", "request:play", { type: "MUSIC", action: "PLAY", target: "AUTO" });
    expect(await view.findByText("player mounted")).toBeTruthy();

    expect(await result).toBe(true);
    expect(run).toHaveBeenCalledWith({ type: "MUSIC", action: "PLAY", target: "AUTO" });
    expect(inspectPlaybackTargets("room:agent")).toHaveLength(1);
  });

  it("mounts immediately after a reload with a recent music session to restore", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" }] as PerformanceNavigationTiming[]);
    window.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source: "radio", playing: true, linkId: null, savedAt: Date.now() }));

    const view = render(<Harness roomId="room:reload" requested={false} />);

    expect(view.getByText("player mounted")).toBeTruthy();
  });

  it("stays unmounted on a fresh navigation even if an old session record exists", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "navigate" }] as PerformanceNavigationTiming[]);
    window.sessionStorage.setItem(VIBE_MUSIC_PLAYBACK_STORAGE_KEY, JSON.stringify({ source: "radio", playing: true, linkId: null, savedAt: Date.now() }));

    const view = render(<Harness roomId="room:fresh" requested={false} />);

    expect(view.queryByText("player mounted")).toBeNull();
  });
});
