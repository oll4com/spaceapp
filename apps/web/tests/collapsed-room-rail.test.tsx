import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { CollapsedRoomRail, type CollapsedRoomRailProps } from "../src/features/room-toolbar/CollapsedRoomRail.js";
import { useToolbarPopovers } from "../src/features/room-toolbar/useToolbarPopovers.js";
import { useLiveRail } from "../src/features/live-pane/useLiveRail.js";

function Rail({ overrides, onPopovers }: { overrides: Partial<CollapsedRoomRailProps>; onPopovers?: (popovers: ReturnType<typeof useToolbarPopovers>) => void }) {
  const popovers = useToolbarPopovers();
  onPopovers?.(popovers);
  const liveRail = useLiveRail([]);
  const hidden = new Set<string>();
  return (
    <CollapsedRoomRail
      popovers={popovers}
      railVisibility={{ isVisible: (id: string) => !hidden.has(id), hiddenIds: [], hide: vi.fn(), show: vi.fn(), showAll: vi.fn() } as never}
      touchContext={{} as never}
      navigation={{
        desktopToolbarActions: [], roomToolbarActions: [], workspaceNavigationActions: [], workspaceDetailActionIds: [], isAdminMode: false,
        canAdmin: false, onModeChange: vi.fn(), runDesktopAction: vi.fn(), renderDesktopCreateTools: () => null, renderWorkspaceAction: () => null,
        setWorkspaceNavigationDetail: vi.fn(), availablePanes: 16, emptySlots: undefined
      }}
      roomNavigation={{ previousRoom: { id: "room:prev", name: "Earlier" } as Room, nextRoom: null, selectRoom: vi.fn(async () => undefined) }}
      docks={{ isSideSurfaceOpen: false, activeSideSurface: "rooms", sideSurfaceToggleLabel: () => "Show rooms", toggleSideSurface: vi.fn() }}
      liveRail={liveRail}
      onActivateLive={vi.fn()}
      liveDisabled={false}
      hasActiveRoom
      paneLayoutPending={false}
      stickyWindowCount={0}
      openStickyNote={vi.fn()}
      snip={{ isSnipToolOpen: false, setIsSnipToolOpen: vi.fn() }}
      isBrowserFullscreen={false}
      minimized={{ showInRail: true, count: 2, runningCount: 1, expanded: false, onToggle: vi.fn() }}
      onShowToolbar={vi.fn()}
      paneMenus={<span data-testid="pane-menus" />}
      {...overrides}
    />
  );
}

describe("CollapsedRoomRail", () => {
  beforeEach(() => installSpaceRuntime(liveRuntime));
  afterEach(() => cleanup());

  it("renders the rail controls and the pane menus slot", () => {
    const { container } = render(<Rail overrides={{}} />);
    const rail = screen.getByRole("region", { name: "Room toolbar hidden" });
    expect(rail.className).toBe("room-toolbar-collapsed room-toolbar-floating-controls");
    expect(screen.getByRole("button", { name: "Previous room" }).getAttribute("title")).toBe("Previous room: Earlier");
    expect(screen.queryByRole("button", { name: "Next room" })).toBeNull();
    expect(container.querySelector('[data-rail-id="live-model"]')).not.toBeNull();
    expect(container.querySelector('[data-rail-id="minimized-bar"], .minimized-pane-bar-toggle')).not.toBeNull();
    expect(screen.getByTestId("pane-menus")).toBeTruthy();
  });

  it("closes the rail popovers before acting", () => {
    let popovers: ReturnType<typeof useToolbarPopovers> | null = null;
    const openStickyNote = vi.fn();
    const onShowToolbar = vi.fn();
    render(<Rail overrides={{ openStickyNote, onShowToolbar }} onPopovers={(value) => { popovers = value; }} />);
    fireEvent.click(screen.getByRole("button", { name: "Music" }));
    expect(popovers!.isVibeMusicOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sticky note" }));
    expect(popovers!.isVibeMusicOpen).toBe(false);
    expect(openStickyNote).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Pane layout" }));
    expect(popovers!.isCollapsedPaneLayoutMenuOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show room toolbar" }));
    expect(onShowToolbar).toHaveBeenCalledTimes(1);
  });

  it("opens the rail icon menu on right click", () => {
    let popovers: ReturnType<typeof useToolbarPopovers> | null = null;
    render(<Rail overrides={{}} onPopovers={(value) => { popovers = value; }} />);
    fireEvent.contextMenu(screen.getByRole("region", { name: "Room toolbar hidden" }), { clientX: 12, clientY: 34 });
    expect(popovers!.lowerRailVisibilityMenu).toEqual({ x: 12, y: 34 });
    expect(screen.getByRole("menu", { name: "Rail icons" })).toBeTruthy();
  });
});

