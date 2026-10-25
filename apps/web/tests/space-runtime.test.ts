import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { api, installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

describe("Space runtime API proxy", () => {
  it("keeps method identities stable while dispatching to the active runtime", async () => {
    const first = createDemoRuntime();
    const second = createDemoRuntime();

    const resourceUrl = "https://demo.invalid/favicon.ico";
    expect(liveRuntime.platform.resolveExternalResource(resourceUrl)).toBe(resourceUrl);
    expect(first.runtime.platform.resolveExternalResource(resourceUrl)).toBeNull();

    installSpaceRuntime(first.runtime);
    const rooms = api.rooms;
    expect(api.rooms).toBe(rooms);

    const firstRoomCount = (await rooms()).data.length;
    await first.store.api.createRoom("First runtime room", 0);
    expect((await rooms()).data).toHaveLength(firstRoomCount + 1);

    installSpaceRuntime(second.runtime);
    expect(api.rooms).toBe(rooms);
    expect((await rooms()).data).toHaveLength(firstRoomCount);
  });

  it("keeps demo presentation settings session-only and restores the canonical fixture on reset", () => {
    const previousNativeLocalTheme = window.localStorage.getItem("space.room.theme");
    const previousNativeSelectedRoom = window.sessionStorage.getItem("space.selectedRoomId");
    const nativeLocalSentinel = "native-local-sentinel";
    const nativeSessionSentinel = "native-session-sentinel";
    window.localStorage.setItem("space.room.theme", nativeLocalSentinel);
    window.sessionStorage.setItem("space.selectedRoomId", nativeSessionSentinel);

    try {
      const { runtime } = createDemoRuntime();
      expect(runtime.platform.localStorage.getItem("space.room.theme")).toBe("graphite");
      expect(runtime.platform.localStorage.getItem("space.roomFocusMode")).toBe("true");
      expect(runtime.platform.localStorage.getItem("space.roomsRailHidden")).toBe("false");
      expect(runtime.platform.sessionStorage.getItem("space.selectedRoomId")).toBeNull();

      runtime.platform.localStorage.setItem("space.room.theme", "paper");
      runtime.platform.sessionStorage.setItem("space.selectedRoomId", "room:changed-locally");
      runtime.platform.reloadPage();

      expect(runtime.platform.localStorage.getItem("space.room.theme")).toBe("graphite");
      expect(runtime.platform.sessionStorage.getItem("space.selectedRoomId")).toBeNull();
      expect(window.localStorage.getItem("space.room.theme")).toBe(nativeLocalSentinel);
      expect(window.sessionStorage.getItem("space.selectedRoomId")).toBe(nativeSessionSentinel);

      runtime.platform.localStorage.setItem("space.room.theme", "forest");
      runtime.reset();
      expect(runtime.platform.localStorage.getItem("space.room.theme")).toBe("graphite");
    } finally {
      if (previousNativeLocalTheme === null) window.localStorage.removeItem("space.room.theme");
      else window.localStorage.setItem("space.room.theme", previousNativeLocalTheme);
      if (previousNativeSelectedRoom === null) window.sessionStorage.removeItem("space.selectedRoomId");
      else window.sessionStorage.setItem("space.selectedRoomId", previousNativeSelectedRoom);
    }
  });

  it("keeps native browser transports exclusively in the live runtime", () => {
    const sharedSource = readFileSync("src/runtime/SpaceRuntime.tsx", "utf8");
    const liveSource = readFileSync("src/live/live-runtime.ts", "utf8");
    const demoSource = readFileSync("src/demo/demo-runtime.ts", "utf8");
    expect(sharedSource).not.toContain("window.location.reload");
    expect(liveSource).toContain("window.location.reload");

    for (const nativeConstructor of ["new window.EventSource", "new window.WebSocket"]) {
      expect(sharedSource).not.toContain(nativeConstructor);
      expect(demoSource).not.toContain(nativeConstructor);
      expect(liveSource).toContain(nativeConstructor);
    }
  });
});
