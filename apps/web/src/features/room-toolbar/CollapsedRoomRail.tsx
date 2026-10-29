import type { ReactNode, RefObject } from "react";
import type { Room } from "@space/contracts";
import type { IconToolbarAction } from "../../icon-toolbar.js";
import { toggleBrowserFullscreen } from "../desktop-titlebar/fullscreen.js";
import type { SideSurfaces } from "../docks/useSideSurfaces.js";
import { LiveRailButton, LiveRailMenu, type LiveRail } from "../live-pane/useLiveRail.js";
import { MinimizedPaneBarToggle } from "../pane-float/MinimizedPaneBarToggle.js";
import type { SnipTool } from "../snip-tool/useSnipTool.js";
import { DesktopNavigation } from "../ui-theme/DesktopNavigation.js";
import { RailVisibilityMenu } from "../ui-theme/RailVisibilityMenu.js";
import {
  DEFAULT_LOWER_RAIL_ITEMS,
  LOWER_RAIL_LABELS,
  LOWER_RAIL_NON_HIDEABLE,
  railVisibilityItems,
  type useRailVisibility
} from "../ui-theme/use-rail-visibility.js";
import type { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";
import { ChevronLeft, ChevronRight, Crop, Keyboard, Maximize2, Minimize2, Music2, Nous, PanelLeft, PanelTopOpen, PanelsTopLeft, Star, StickyNote } from "../ui-theme/app-icons.js";
import { VIBE_MUSIC_PANEL_ID } from "../vibe-music/vibe-music-session.js";
import { OSK_PANEL_ID } from "./room-toolbar-actions.js";
import type { ToolbarPopovers } from "./useToolbarPopovers.js";

type DesktopNavigationProps = Parameters<typeof DesktopNavigation>[0];

/** The Workspace navigation shared by the room toolbar and the collapsed rail. */
export interface WorkspaceNavigationBinding {
  /** Create and tool actions of the toolbar (with the Workspace-only extras). */
  desktopToolbarActions: IconToolbarAction[];
  /** The persistent room toolbar catalog (docks). */
  roomToolbarActions: IconToolbarAction[];
  workspaceNavigationActions: IconToolbarAction[];
  workspaceDetailActionIds: string[];
  isAdminMode: boolean;
  canAdmin: boolean;
  /** Switches between User and Admin mode. */
  onModeChange: () => void;
  runDesktopAction: (action: IconToolbarAction, anchor: HTMLButtonElement, count?: number) => void;
  renderDesktopCreateTools: DesktopNavigationProps["renderCreateTools"];
  renderWorkspaceAction: DesktopNavigationProps["renderWorkspaceAction"];
  setWorkspaceNavigationDetail: (id: string | null) => void;
  availablePanes: number;
  emptySlots: DesktopNavigationProps["emptySlots"];
}

export interface CollapsedRoomRailProps {
  popovers: ToolbarPopovers;
  railVisibility: ReturnType<typeof useRailVisibility>;
  touchContext: ReturnType<typeof useTouchContextMenu>;
  navigation: WorkspaceNavigationBinding;
  roomNavigation: { previousRoom: Room | null; nextRoom: Room | null; selectRoom: (roomId: string) => Promise<void> };
  docks: Pick<SideSurfaces, "isSideSurfaceOpen" | "activeSideSurface" | "sideSurfaceToggleLabel" | "toggleSideSurface">;
  liveRail: LiveRail;
  onActivateLive: () => void;
  liveDisabled: boolean;
  hasActiveRoom: boolean;
  paneLayoutPending: boolean;
  stickyWindowCount: number;
  openStickyNote: () => void;
  snip: Pick<SnipTool, "isSnipToolOpen" | "setIsSnipToolOpen">;
  isBrowserFullscreen: boolean;
  minimized: {
    /** Non-admins keep the minimized-pane toggle on this rail; admins have it on the upper rail. */
    showInRail: boolean;
    count: number;
    runningCount: number;
    expanded: boolean;
    onToggle: () => void;
  };
  onShowToolbar: () => void;
  /** The rail's pane layout, "span all panes" and text size popovers. */
  paneMenus: ReactNode;
}

/** The floating lower rail shown while the room toolbar is hidden. */
export function CollapsedRoomRail({
  popovers, railVisibility, touchContext, navigation, roomNavigation, docks, liveRail, onActivateLive, liveDisabled, hasActiveRoom,
  paneLayoutPending, stickyWindowCount, openStickyNote, snip, isBrowserFullscreen, minimized, onShowToolbar, paneMenus
}: CollapsedRoomRailProps) {
  const {
    collapsedToolbarRef, setIsCollapsedPaneLayoutMenuOpen, setIsPaneSpanAllMenuOpen, setIsWorkspaceTextSizePickerOpen, setIsVibeMusicOpen,
    setLowerRailVisibilityMenu, setIsThemeMenuOpen, setIsPaneLayoutMenuOpen, paneLayoutCollapsedButtonRef, isCollapsedPaneLayoutMenuOpen,
    isOskKeyboardOpen, setIsOskKeyboardOpen, vibeMusicButtonRef, isVibeMusicOpen, quickLinksButtonRef, isQuickLinksOpen, setIsQuickLinksOpen,
    lowerRailVisibilityMenu
  } = popovers;
  const {
    desktopToolbarActions, roomToolbarActions, workspaceNavigationActions, workspaceDetailActionIds, isAdminMode, canAdmin, onModeChange,
    runDesktopAction, renderDesktopCreateTools, renderWorkspaceAction, setWorkspaceNavigationDetail, availablePanes, emptySlots
  } = navigation;
  const { previousRoom, nextRoom, selectRoom } = roomNavigation;
  const { isSideSurfaceOpen, activeSideSurface, sideSurfaceToggleLabel, toggleSideSurface } = docks;
  const { isSnipToolOpen, setIsSnipToolOpen } = snip;
  return (
    <div
      ref={collapsedToolbarRef}
      className="room-toolbar-collapsed room-toolbar-floating-controls"
      role="region"
      aria-label="Room toolbar hidden"
      {...touchContext}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsCollapsedPaneLayoutMenuOpen(false);
        setIsPaneSpanAllMenuOpen(false);
        setIsWorkspaceTextSizePickerOpen(false);
        setIsVibeMusicOpen(false);
        setLowerRailVisibilityMenu((current) => current ? null : { x: event.clientX, y: event.clientY });
      }}
    >
      {previousRoom && railVisibility.isVisible("previous") ? (
        <button
          type="button"
          className="room-toolbar-visibility-button room-rail-secondary"
          title={`Previous room: ${previousRoom.name}`}
          data-rail-id="previous"
          aria-label="Previous room"
          onClick={() => { void selectRoom(previousRoom.id); }}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      ) : null}
      {nextRoom && railVisibility.isVisible("next") ? (
        <button
          type="button"
          className="room-toolbar-visibility-button room-rail-secondary"
          title={`Next room: ${nextRoom.name}`}
          data-rail-id="next"
          aria-label="Next room"
          onClick={() => { void selectRoom(nextRoom.id); }}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("rooms") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button${isSideSurfaceOpen && activeSideSurface === "rooms" ? " is-active" : ""}`}
          title={sideSurfaceToggleLabel("rooms")}
          data-rail-id="rooms"
          aria-label={sideSurfaceToggleLabel("rooms")}
          aria-pressed={isSideSurfaceOpen && activeSideSurface === "rooms"}
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            toggleSideSurface("rooms");
          }}
        >
          <PanelLeft aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("nous") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button${isSideSurfaceOpen && activeSideSurface === "nous" ? " is-active" : ""}`}
          title={sideSurfaceToggleLabel("nous")}
          data-rail-id="nous"
          aria-label={sideSurfaceToggleLabel("nous")}
          aria-pressed={isSideSurfaceOpen && activeSideSurface === "nous"}
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            toggleSideSurface("nous");
          }}
        >
          <Nous aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("live-model") ? (
        <LiveRailButton liveRail={liveRail} onActivate={onActivateLive} disabled={liveDisabled} />
      ) : null}
      <LiveRailMenu liveRail={liveRail} />
      {railVisibility.isVisible("create") ? (
        <DesktopNavigation createOnly actions={desktopToolbarActions}
          adminMode={isAdminMode} canAdmin={canAdmin}
          onModeChange={() => undefined} onAction={runDesktopAction}
          renderCreateTools={renderDesktopCreateTools}
          availablePanes={availablePanes}
          emptySlots={emptySlots} />
      ) : null}
      {railVisibility.isVisible("layout") ? (
        <button
          ref={paneLayoutCollapsedButtonRef}
          type="button"
          className={`room-toolbar-visibility-button${isCollapsedPaneLayoutMenuOpen ? " is-active" : ""}`}
          title="Pane layout"
          data-rail-id="layout"
          aria-label="Pane layout"
          aria-controls="pane-layout-presets-collapsed"
          aria-expanded={isCollapsedPaneLayoutMenuOpen}
          aria-pressed={isCollapsedPaneLayoutMenuOpen}
          aria-haspopup="menu"
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setLowerRailVisibilityMenu(null);
            setIsCollapsedPaneLayoutMenuOpen((current) => !current);
          }}
          disabled={!hasActiveRoom || paneLayoutPending}
        >
          <PanelsTopLeft aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("sticky") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary${stickyWindowCount > 0 ? " is-active" : ""}`}
          title="Sticky note"
          data-rail-id="sticky"
          aria-label="Sticky note"
          aria-pressed={stickyWindowCount > 0}
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            openStickyNote();
          }}
        >
          <StickyNote aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("keyboard") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary${isOskKeyboardOpen ? " is-active" : ""}`}
          title="On-screen keyboard"
          data-rail-id="keyboard"
          aria-label="On-screen keyboard"
          aria-controls={OSK_PANEL_ID}
          aria-expanded={isOskKeyboardOpen}
          aria-pressed={isOskKeyboardOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            setIsOskKeyboardOpen((current) => !current);
          }}
        >
          <Keyboard aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("music") ? (
        <button
          ref={vibeMusicButtonRef}
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary${isVibeMusicOpen ? " is-active" : ""}`}
          title="Vibe music with freeCodeCamp Code Radio"
          data-rail-id="music"
          aria-label="Music"
          aria-controls={VIBE_MUSIC_PANEL_ID}
          aria-expanded={isVibeMusicOpen}
          aria-pressed={isVibeMusicOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setLowerRailVisibilityMenu(null);
            setIsVibeMusicOpen((current) => !current);
          }}
        >
          <Music2 aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("snip-tool") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary${isSnipToolOpen ? " is-active" : ""}`}
          title={isSnipToolOpen ? "Close Snip Tool" : "Snip Tool (Capture, edit and share)"}
          data-rail-id="snip-tool"
          aria-label="Snip Tool"
          aria-pressed={isSnipToolOpen}
          onClick={() => {
            setIsSnipToolOpen((current) => !current);
          }}
          disabled={!hasActiveRoom}
        >
          <Crop aria-hidden="true" />
        </button>
      ) : null}
      {railVisibility.isVisible("quick-links") ? (
        <button
          ref={quickLinksButtonRef}
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary${isQuickLinksOpen ? " is-active" : ""}`}
          title="Quick Links"
          data-rail-id="quick-links"
          aria-label="Quick Links"
          aria-controls="quick-links-popover"
          aria-haspopup="dialog"
          aria-expanded={isQuickLinksOpen}
          aria-pressed={isQuickLinksOpen}
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            setIsQuickLinksOpen((current) => !current);
          }}
        >
          <Star aria-hidden="true" fill={isQuickLinksOpen ? "currentColor" : "none"} />
        </button>
      ) : null}
      {railVisibility.isVisible("docks") ? (
        <DesktopNavigation docksOnly actions={roomToolbarActions}
          adminMode={isAdminMode} canAdmin={canAdmin}
          onModeChange={() => undefined}
          onAction={(action, anchor) => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            runDesktopAction(action, anchor);
          }} />
      ) : null}
      {railVisibility.isVisible("tools") ? (
        <DesktopNavigation toolsOnly actions={workspaceNavigationActions}
          adminMode={isAdminMode} canAdmin={canAdmin}
          onModeChange={onModeChange}
          onAction={(action, anchor) => {
            setIsThemeMenuOpen(false);
            if (action.id !== "pane-layout") {
              setIsPaneLayoutMenuOpen(false);
              setIsCollapsedPaneLayoutMenuOpen(false);
            }
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            if (action.id !== "vibe-music") setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            runDesktopAction(action, anchor);
          }}
          hiddenRailIds={railVisibility.hiddenIds} />
      ) : null}
      {railVisibility.isVisible("fullscreen") ? (
        <button
          type="button"
          className={`room-toolbar-visibility-button room-rail-secondary dock-fullscreen-toggle${isBrowserFullscreen ? " is-active" : ""}`}
          title={isBrowserFullscreen ? "Exit full screen (F11)" : "Full screen browser (F11)"}
          data-rail-id="fullscreen"
          aria-label={isBrowserFullscreen ? "Exit full screen" : "Full screen browser"}
          aria-pressed={isBrowserFullscreen}
          onClick={() => {
            setIsThemeMenuOpen(false);
            setIsPaneLayoutMenuOpen(false);
            setIsCollapsedPaneLayoutMenuOpen(false);
            setIsPaneSpanAllMenuOpen(false);
            setIsWorkspaceTextSizePickerOpen(false);
            setIsVibeMusicOpen(false);
            setLowerRailVisibilityMenu(null);
            void toggleBrowserFullscreen();
          }}
        >
          {isBrowserFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      ) : null}
      {minimized.showInRail && railVisibility.isVisible("minimized-bar") ? (
        <MinimizedPaneBarToggle
          count={minimized.count}
          runningCount={minimized.runningCount}
          expanded={minimized.expanded}
          onToggle={minimized.onToggle}
        />
      ) : null}
      <button
        type="button"
        className="room-toolbar-visibility-button"
        title="Show room toolbar"
        data-rail-id="expand"
        aria-label="Show room toolbar"
        onClick={() => onShowToolbar()}
      >
        <PanelTopOpen aria-hidden="true" />
      </button>
      {railVisibility.isVisible("more") ? (
        <div className="room-rail-more">
          <DesktopNavigation workspaceOnly actions={workspaceNavigationActions}
            renderWorkspaceAction={renderWorkspaceAction} onWorkspaceDetailChange={setWorkspaceNavigationDetail} workspaceDetailActionIds={workspaceDetailActionIds}
            renderCreateTools={renderDesktopCreateTools} hiddenRailIds={railVisibility.hiddenIds}
            adminMode={isAdminMode} canAdmin={canAdmin}
            availablePanes={availablePanes}
            onModeChange={onModeChange} onAction={runDesktopAction} />
        </div>
      ) : null}
      {paneMenus}
      {lowerRailVisibilityMenu ? (
        <RailVisibilityMenu
          anchorRef={collapsedToolbarRef}
          items={
            minimized.showInRail
              ? [
                  ...DEFAULT_LOWER_RAIL_ITEMS.filter((item) => item.id !== "expand" && item.id !== "more"),
                  ...railVisibilityItems(["minimized-bar"], LOWER_RAIL_LABELS, LOWER_RAIL_NON_HIDEABLE),
                ]
              : DEFAULT_LOWER_RAIL_ITEMS.filter((item) => item.id !== "expand" && item.id !== "more")
          }
          hiddenIds={railVisibility.hiddenIds}
          label="Rail icons"
          x={lowerRailVisibilityMenu.x}
          y={lowerRailVisibilityMenu.y}
          onClose={() => setLowerRailVisibilityMenu(null)}
          onHide={railVisibility.hide}
          onShow={railVisibility.show}
          onShowAll={railVisibility.showAll}
        />
      ) : null}
    </div>
  );
}
