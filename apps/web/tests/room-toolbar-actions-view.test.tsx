import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { usePersistentIconToolbar, type IconToolbarAction } from "../src/icon-toolbar.js";
import { createPaneCompletionLifecycleState } from "../src/pane-completion-lifecycle.js";
import { useMinimizedPaneBar } from "../src/features/pane-float/useMinimizedPaneBar.js";
import { RoomToolbarActions, type RoomToolbarActionsProps } from "../src/features/room-toolbar/RoomToolbarActions.js";
import { useToolbarPopovers } from "../src/features/room-toolbar/useToolbarPopovers.js";
import { Palette } from "../src/features/ui-theme/app-icons.js";

type Popovers = ReturnType<typeof useToolbarPopovers>;
type Toolbar = ReturnType<typeof usePersistentIconToolbar>;

const panes = [
  { id: "pane:a", isMinimized: true, mode: "CHAT", title: "Chat 1" },
  { id: "pane:b", isMinimized: false, mode: "CHAT", title: "Chat 2" }
] as unknown as Pane[];
const lifecycle = createPaneCompletionLifecycleState();

function action(id: string, onClick = vi.fn()): IconToolbarAction {
  return { id, label: id, title: id, ariaLabel: `Action ${id}`, icon: Palette, onClick };
}

function Harness({ actions, overrides = {}, onState }: {
  actions: IconToolbarAction[];
  overrides?: Partial<RoomToolbarActionsProps>;
  onState?: (state: { popovers: Popovers; toolbar: Toolbar }) => void;
}) {
  const popovers = useToolbarPopovers();
  const toolbar = usePersistentIconToolbar({ actions, hiddenStorageKey: "test.hidden", orderStorageKey: "test.order" });
  const minimizedBar = useMinimizedPaneBar({ panes, shellMode: "desktop", paneCompletionLifecycle: lifecycle });
  onState?.({ popovers, toolbar });
  return (
    <RoomToolbarActions
      popovers={popovers}
      touchContext={{} as never}
      roomToolbar={toolbar}
      availableRoomActions={toolbar.orderedActions}
      navigation={{
        desktopToolbarActions: [], roomToolbarActions: [], workspaceNavigationActions: [], workspaceDetailActionIds: [], isAdminMode: false,
        canAdmin: false, onModeChange: vi.fn(), runDesktopAction: vi.fn(), renderDesktopCreateTools: () => null, renderWorkspaceAction: () => null,
        setWorkspaceNavigationDetail: vi.fn(), availablePanes: 14, emptySlots: undefined
      }}
      hiddenRailIds={[]}
      footer={<span data-testid="footer" />}
      metrics={<span data-testid="metrics" />}
      shellMode="desktop"
      uiTheme="modern"
      environment={null}
      minimizedBar={minimizedBar}
      preferences={{
        roomTheme: "default" as never, setRoomTheme: vi.fn(), terminalFontSize: 14, setTerminalFontSize: vi.fn(), maskSensitiveData: false,
        toggleMaskSensitiveData: vi.fn()
      }}
      onHideToolbar={vi.fn()}
      menus={<span data-testid="menus" />}
      {...overrides}
    />
  );
}

describe("RoomToolbarActions", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });
  afterEach(() => cleanup());

  it("renders metrics, the menus slot and the utility controls in order", () => {
    const onHideToolbar = vi.fn();
    const { container } = render(<Harness actions={[action("theme")]} overrides={{ onHideToolbar }} />);
    const root = container.querySelector(".toolbar-actions")!;
    const order = [...root.children].map((child) => child.getAttribute("data-testid") ?? child.className.split(" ")[0]);
    expect(order.slice(0, 4)).toEqual(["metrics", "toolbar-actions-scroll", "toolbar-actions-fixed", "menus"]);
    const toggle = screen.getByRole("button", { name: "Show minimized panes bar (1 minimized pane)" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide minimized panes bar (1 minimized pane)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide room toolbar" }));
    expect(onHideToolbar).toHaveBeenCalledTimes(1);
  });

  it("opens the theme menu from the shared popover state", () => {
    let state: { popovers: Popovers; toolbar: Toolbar } | null = null;
    render(<Harness actions={[action("theme")]} onState={(value) => { state = value; }} />);
    const themeMenu = () => document.querySelector('.room-theme-menu[role="menu"][aria-label="Room theme options"]');
    expect(themeMenu()).toBeNull();
    act(() => state!.popovers.setIsThemeMenuOpen(true));
    expect(themeMenu()).not.toBeNull();
  });

  it("offers Hide and the sensitive-data switch in the action menu", () => {
    let state: { popovers: Popovers; toolbar: Toolbar } | null = null;
    const toggleMaskSensitiveData = vi.fn();
    render(
      <Harness
        actions={[action("theme"), action("sensitive-data")]}
        overrides={{ preferences: { roomTheme: "default" as never, setRoomTheme: vi.fn(), terminalFontSize: 14, setTerminalFontSize: vi.fn(), maskSensitiveData: true, toggleMaskSensitiveData } }}
        onState={(value) => { state = value; }}
      />
    );
    act(() => state!.toolbar.setActionMenu({ actionId: "sensitive-data", actionLabel: "Sensitive data", x: 5, y: 6 }));
    const menu = screen.getByRole("menu", { name: "Action menu Sensitive data" });
    expect(menu.getAttribute("style")).toContain("left: 5px");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show sensitive data" }));
    expect(toggleMaskSensitiveData).toHaveBeenCalledTimes(1);
    expect(state!.toolbar.actionMenu).toBeNull();
    act(() => state!.toolbar.setActionMenu({ actionId: "theme", actionLabel: "Theme", x: 1, y: 2 }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide" }));
    expect(state!.toolbar.hiddenActionIds).toContain("theme");
  });

  it("closes the other popovers when the mobile sheet runs an action", () => {
    let state: { popovers: Popovers; toolbar: Toolbar } | null = null;
    const run = vi.fn();
    render(<Harness actions={[action("theme"), action("add-cli", run)]} overrides={{ shellMode: "mobile" }} onState={(value) => { state = value; }} />);
    act(() => {
      state!.popovers.setIsThemeMenuOpen(true);
      state!.popovers.setIsCliLauncherOpen(true);
      state!.popovers.setIsWorkspaceTextSizePickerOpen(true);
      state!.toolbar.setIsOverflowOpen(true);
    });
    expect(screen.getByRole("dialog", { name: "Room actions" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Action add-cli" })[0]!);
    expect(run).toHaveBeenCalledTimes(1);
    expect(state!.popovers.isThemeMenuOpen).toBe(false);
    expect(state!.popovers.isWorkspaceTextSizePickerOpen).toBe(false);
    expect(state!.popovers.isCliLauncherOpen).toBe(true);
    expect(state!.toolbar.isOverflowOpen).toBe(false);
  });
});
