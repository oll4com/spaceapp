import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sourceControl = vi.hoisted(() => ({ connections: vi.fn() }));
vi.mock("../src/features/source-control/client.js", () => ({
  SOURCE_CONTROL_CONNECTION_EVENT: "space:source-control-connection",
  sourceControlClient: sourceControl
}));

import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import type { SideSurface } from "../src/features/docks/dock-types.js";
import { useSideSurfaceEffects, useSideSurfaces, type SideSurfacesContext } from "../src/features/docks/useSideSurfaces.js";
import { CompactSideSurfaceDrawer, InlineSideSurface } from "../src/features/docks/SideSurfaceFrame.js";
import { WORKSPACE_DOCK_SESSION_KEY } from "../src/features/workspace-session.js";

type Props = Omit<SideSurfacesContext, "isDesktopSideSurfaceOpen" | "setIsDesktopSideSurfaceOpen"> & { initialDesktopOpen?: boolean };

function useHarness({ initialDesktopOpen = true, ...context }: Props) {
  const [isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen] = useState(initialDesktopOpen);
  const sideSurfaces = useSideSurfaces({ ...context, isDesktopSideSurfaceOpen, setIsDesktopSideSurfaceOpen });
  useSideSurfaceEffects(sideSurfaces, {
    runtimeKind: context.runtimeKind,
    isAuthenticated: context.isAuthenticated,
    role: context.role,
    userId: "user:one"
  });
  return sideSurfaces;
}

const base: Props = {
  shellMode: "desktop",
  restoredDock: null,
  runtimeKind: "demo",
  isAuthenticated: true,
  role: "USER",
  isDockHidden: () => false
};

describe("useSideSurfaces", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.sessionStorage.clear();
    sourceControl.connections.mockReset().mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("restores the dock session and persists every change", () => {
    const { result } = renderHook((props: Props) => useHarness(props), {
      initialProps: { ...base, restoredDock: { surface: "clipboard", desktopOpen: false, compactOpen: true }, initialDesktopOpen: false }
    });
    expect(result.current.activeSideSurface).toBe("clipboard");
    expect(result.current.isCompactSideSurfaceOpen).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(WORKSPACE_DOCK_SESSION_KEY)!)).toEqual({ surface: "clipboard", desktopOpen: false, compactOpen: true });
    act(() => result.current.toggleSideSurface("tasks"));
    expect(JSON.parse(window.sessionStorage.getItem(WORKSPACE_DOCK_SESSION_KEY)!)).toEqual({ surface: "tasks", desktopOpen: true, compactOpen: true });
  });

  it("toggles the inline desktop dock and keeps it mounted once opened", () => {
    const { result } = renderHook((props: Props) => useHarness(props), { initialProps: { ...base, initialDesktopOpen: false } });
    expect(result.current.activeSideSurface).toBe("rooms");
    expect(result.current.mountInlineSideSurface).toBe(false);
    expect(result.current.sideSurfaceToggleLabel("rooms")).toBe("Show rooms");
    expect(result.current.sideSurfaceToggleLabel("agent-files")).toBe("Open Agent Files");
    act(() => result.current.toggleSideSurface("rooms"));
    expect(result.current.showInlineSideSurface).toBe(true);
    expect(result.current.sideSurfaceToggleLabel("rooms")).toBe("Hide rooms");
    act(() => result.current.toggleSideSurface("media"));
    expect(result.current.activeSideSurface).toBe("media");
    expect(result.current.isDesktopSideSurfaceOpen).toBe(true);
    act(() => result.current.toggleSideSurface("media"));
    expect(result.current.isDesktopSideSurfaceOpen).toBe(false);
    expect(result.current.mountInlineSideSurface).toBe(true);
    // The title is the dock's short name, as on its button and in Docks settings.
    expect(result.current.activeSideSurfaceDockTitle).toBe("Media");
    expect(result.current.activeSideSurfaceCloseLabel).toBe("Close media dock");
  });

  it("uses the drawer on compact shells and remembers the trigger", () => {
    const { result } = renderHook((props: Props) => useHarness(props), { initialProps: { ...base, shellMode: "mobile" } });
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    act(() => result.current.toggleSideSurface("links"));
    expect(result.current.showOverlaySideSurface).toBe(true);
    expect(result.current.showInlineSideSurface).toBe(false);
    expect(result.current.compactSideSurfaceTriggerRef.current).toBe(trigger);
    expect(result.current.sideSurfaceToggleLabel("links")).toBe("Close links");
    act(() => result.current.toggleSideSurface("links"));
    expect(result.current.showOverlaySideSurface).toBe(false);
    trigger.remove();
  });

  it("navigates the visible docks in order and wraps around", () => {
    const hidden = new Set<SideSurface>(["media"]);
    const { result, rerender } = renderHook((props: Props) => useHarness(props), {
      initialProps: { ...base, isDockHidden: (surface) => hidden.has(surface) }
    });
    expect(result.current.availableDocks).toEqual(["rooms", "nous",
      "notifications", "room-agent", "shared-chat", "agent-files", "clipboard", "tasks", "vault", "links", "settings", "cli", "agent-sessions"]);
    act(() => result.current.navigateDock("prev"));
    expect(result.current.activeSideSurface).toBe("agent-sessions");
    act(() => result.current.navigateDock("next"));
    expect(result.current.activeSideSurface).toBe("rooms");
    // With the room toolbar's dock buttons, Previous/Next follow their order first.
    const launcherActions = [{ id: "surface-tasks" }, { id: "add-cli" }, { id: "surface-media" }, { id: "surface-rooms" }];
    act(() => result.current.navigateDock("prev", launcherActions));
    expect(result.current.activeSideSurface).toBe("tasks");
    act(() => result.current.navigateDock("next", launcherActions));
    expect(result.current.activeSideSurface).toBe("rooms");
    act(() => result.current.navigateDock("next", launcherActions));
    expect(result.current.activeSideSurface).toBe("nous");

    rerender({ ...base, role: "ADMIN", runtimeKind: "live", isDockHidden: (surface) => hidden.has(surface) });
    expect(result.current.sourceControlAvailable).toBe(true);
    expect(result.current.availableDocks).toEqual(["rooms", "nous", "notifications", "room-agent", "shared-chat", "streaming", "agent-files", "clipboard", "tasks", "vault", "links", "source-control", "settings", "cli", "agent-sessions"]);
  });

  it("sends admins from the Health dock to System Health", () => {
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("space:system-health", listener);
    const { result } = renderHook((props: Props) => useHarness(props), { initialProps: { ...base, role: "ADMIN" } });
    act(() => result.current.toggleSideSurface("health"));
    expect(result.current.activeSideSurface).toBe("rooms");
    act(() => result.current.setActiveSideSurface("health"));
    expect(result.current.isDesktopSideSurfaceOpen).toBe(false);
    window.removeEventListener("space:system-health", listener);
    expect(opened).toEqual([
      { section: "overview", metric: undefined, resources: false },
      { section: "overview", metric: undefined, resources: false }
    ]);
  });

  it("tracks source-control connections and opens the dock on request", async () => {
    sourceControl.connections.mockResolvedValue([{ status: "CONNECTED" }]);
    const { result } = renderHook((props: Props) => useHarness(props), { initialProps: { ...base, runtimeKind: "live", initialDesktopOpen: false } });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.sourceControlEnabled).toBe(true);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("space:source-control-connection", { detail: { openDock: true } }));
      await Promise.resolve();
    });
    expect(result.current.activeSideSurface).toBe("source-control");
    expect(result.current.isDesktopSideSurfaceOpen).toBe(true);
  });

  it("traps focus in the compact drawer and closes it on Escape", () => {
    function Drawer() {
      const sideSurfaces = useHarness({ ...base, shellMode: "tablet", restoredDock: { surface: "tasks", desktopOpen: false, compactOpen: true } });
      return <CompactSideSurfaceDrawer sideSurfaces={sideSurfaces} launcherActions={[]} renderSurface={(surface) => <button type="button">{surface} content</button>} fallback={null} />;
    }
    render(<Drawer />);
    const drawer = screen.getByRole("dialog", { name: "Tasks" });
    expect(drawer.getAttribute("data-surface-mode")).toBe("drawer");
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tasks" })).toBeNull();
  });

  it("renders the inline dock hidden but mounted after it closes", () => {
    function Inline() {
      const sideSurfaces = useHarness({ ...base, restoredDock: { surface: "links", desktopOpen: true, compactOpen: false } });
      return <InlineSideSurface sideSurfaces={sideSurfaces} launcherActions={[]} renderSurface={(surface) => <p>{surface} content</p>} fallback={null} />;
    }
    const { container } = render(<Inline />);
    const aside = container.querySelector("aside.side-surface-inline")!;
    expect(aside.getAttribute("aria-label")).toBe("Links");
    fireEvent.click(screen.getByRole("button", { name: "Close links" }));
    expect(container.querySelector("aside.side-surface-inline")).toBe(aside);
    expect(aside.getAttribute("aria-hidden")).toBe("true");
    expect((aside as HTMLElement).style.display).toBe("none");
  });
});
