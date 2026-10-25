import type { ReactNode } from "react";
import type { CodexEnvironment } from "@space/contracts";
import type { IconToolbarAction, usePersistentIconToolbar } from "../../icon-toolbar.js";
import type { UiTheme } from "../../ui-theme.js";
import { DesktopActionManager } from "../action-surfaces/DesktopActionManager.js";
import { MobileActionSheet } from "../action-surfaces/MobileActionSheet.js";
import { MinimizedPaneBarToggle } from "../pane-float/MinimizedPaneBarToggle.js";
import type { MinimizedPaneBar } from "../pane-float/useMinimizedPaneBar.js";
import type { ShellMode } from "../pane-grid/pane-grid-layout.js";
import { RoomThemeMenu } from "../room-theme/RoomThemeMenu.js";
import { ToolbarMetricsSummary } from "../toolbar-metrics/ToolbarMetrics.js";
import { DesktopNavigation } from "../ui-theme/DesktopNavigation.js";
import { Minus } from "../ui-theme/app-icons.js";
import { groupModernRoomActions } from "../ui-theme/modern-toolbar.js";
import type { useTouchContextMenu } from "../ui-theme/use-touch-context-menu.js";
import type { UserPreferences } from "../user-settings/useUserPreferences.js";
import { WorkspaceTextSizePicker } from "../workspace-text-size-picker/WorkspaceTextSizePicker.js";
import type { WorkspaceNavigationBinding } from "./CollapsedRoomRail.js";
import type { ToolbarPopovers } from "./useToolbarPopovers.js";

type DesktopNavigationProps = Parameters<typeof DesktopNavigation>[0];

export interface RoomToolbarActionsProps {
  popovers: ToolbarPopovers;
  touchContext: ReturnType<typeof useTouchContextMenu>;
  roomToolbar: ReturnType<typeof usePersistentIconToolbar>;
  /** Room actions offered by the overflow sheet or manager. */
  availableRoomActions: IconToolbarAction[];
  navigation: WorkspaceNavigationBinding;
  hiddenRailIds: DesktopNavigationProps["hiddenRailIds"];
  /** Version line at the end of the Workspace menu. */
  footer: ReactNode;
  /** Toolbar metrics of the presented room, or nothing. */
  metrics: ReactNode;
  shellMode: ShellMode;
  uiTheme: UiTheme;
  environment: CodexEnvironment | null;
  minimizedBar: MinimizedPaneBar;
  preferences: Pick<UserPreferences, "roomTheme" | "setRoomTheme" | "terminalFontSize" | "setTerminalFontSize" | "maskSensitiveData" | "toggleMaskSensitiveData">;
  onHideToolbar: () => void;
  /** The pane layout, span-all, CLI launcher and Chat launcher popovers (App keeps their lazy declarations). */
  menus: ReactNode;
}

/** The action area of the room toolbar: metrics, Workspace navigation, overflow, utility controls and popovers. */
export function RoomToolbarActions({
  popovers, touchContext, roomToolbar, availableRoomActions, navigation, hiddenRailIds, footer, metrics, shellMode, uiTheme, environment,
  minimizedBar, preferences, onHideToolbar, menus
}: RoomToolbarActionsProps) {
  const {
    roomToolbarActionsRef, roomToolbarScrollRef, roomOverflowTriggerRef, roomThemeButtonRef, workspaceTextSizeButtonRef,
    isThemeMenuOpen, setIsThemeMenuOpen, setIsPaneLayoutMenuOpen, setIsPaneSpanAllMenuOpen, isWorkspaceTextSizePickerOpen,
    setIsWorkspaceTextSizePickerOpen, setIsCliLauncherOpen
  } = popovers;
  const {
    workspaceNavigationActions, renderWorkspaceAction, setWorkspaceNavigationDetail, workspaceDetailActionIds, isAdminMode, canAdmin,
    availablePanes, onModeChange, runDesktopAction, renderDesktopCreateTools, emptySlots
  } = navigation;
  const { minimizedCount, minimizedPaneRunningCount, showMinimizedBar, showMinimizedBarToggle, setMinimizedBarExpanded } = minimizedBar;
  const { roomTheme, setRoomTheme, terminalFontSize, setTerminalFontSize, maskSensitiveData, toggleMaskSensitiveData } = preferences;
  return (
    <div className="toolbar-actions" ref={roomToolbarActionsRef} {...touchContext}>
      {metrics}
      <div ref={roomToolbarScrollRef} className="toolbar-actions-scroll">
        <DesktopNavigation
          actions={workspaceNavigationActions}
          renderWorkspaceAction={renderWorkspaceAction} onWorkspaceDetailChange={setWorkspaceNavigationDetail} workspaceDetailActionIds={workspaceDetailActionIds}
          hiddenRailIds={hiddenRailIds}
          adminMode={isAdminMode}
          canAdmin={canAdmin}
          availablePanes={availablePanes}
          onModeChange={onModeChange}
          onAction={runDesktopAction}
          renderCreateTools={renderDesktopCreateTools}
          emptySlots={emptySlots}
          footer={footer}
        />
      </div>
      {roomToolbar.isOverflowOpen ? (
        shellMode === "mobile" ? (
          <MobileActionSheet
            actionSections={uiTheme !== "classic" ? groupModernRoomActions(availableRoomActions) : undefined}
            actions={availableRoomActions}
            hiddenActionIds={roomToolbar.hiddenActionIds}
            label="Room actions"
            onClose={roomToolbar.closeMenus}
            onHideAction={roomToolbar.hideAction}
            onShowAction={roomToolbar.showAction}
            onRunAction={(action) => {
              roomToolbar.closeMenus();
              if (action.id !== "theme") setIsThemeMenuOpen(false);
              if (action.id !== "pane-layout") setIsPaneLayoutMenuOpen(false);
              if (action.id !== "pane-span-all") setIsPaneSpanAllMenuOpen(false);
              if (action.id !== "font-down") setIsWorkspaceTextSizePickerOpen(false);
              if (action.id !== "add-cli") setIsCliLauncherOpen(false);
              action.onClick();
            }}
            popupId="room-actions-popup"
            summary={<ToolbarMetricsSummary environment={environment} />}
            triggerRef={roomOverflowTriggerRef}
          />
        ) : (
          <DesktopActionManager
            actions={availableRoomActions}
            hiddenActionIds={roomToolbar.hiddenActionIds}
            label="Room actions"
            onClose={roomToolbar.closeMenus}
            onHideAction={roomToolbar.hideAction}
            onReorderAction={roomToolbar.moveAction}
            onShowAction={roomToolbar.showAction}
            popupId="room-actions-popup"
            triggerRef={roomOverflowTriggerRef}
          />
        )
      ) : null}
      <div className="toolbar-actions-fixed" role="group" aria-label="Room utility controls">
        {showMinimizedBarToggle ? (
          <MinimizedPaneBarToggle
            count={minimizedCount}
            runningCount={minimizedPaneRunningCount}
            expanded={showMinimizedBar}
            onToggle={() => setMinimizedBarExpanded((value) => !value)}
          />
        ) : null}
        <button
          type="button"
          className="room-toolbar-visibility-button"
          title="Hide room toolbar"
          aria-label="Hide room toolbar"
          onClick={onHideToolbar}
        >
          <Minus aria-hidden="true" />
        </button>
      </div>
      {menus}
      {isThemeMenuOpen ? (
        <RoomThemeMenu
          currentTheme={roomTheme}
          mobile={shellMode === "mobile"}
          onClose={() => setIsThemeMenuOpen(false)}
          onSelect={setRoomTheme}
          triggerRef={roomThemeButtonRef}
        />
      ) : null}
      <WorkspaceTextSizePicker
        anchorRef={workspaceTextSizeButtonRef}
        open={isWorkspaceTextSizePickerOpen}
        value={terminalFontSize}
        onChange={setTerminalFontSize}
        onClose={() => setIsWorkspaceTextSizePickerOpen(false)}
      />
      {roomToolbar.actionMenu ? (
        <div
          className="icon-context-menu"
          role="menu"
          aria-label={`Action menu ${roomToolbar.actionMenu.actionLabel}`}
          style={{ left: `${roomToolbar.actionMenu.x}px`, top: `${roomToolbar.actionMenu.y}px` }}
        >
          {roomToolbar.actionMenu.actionId === "sensitive-data" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (roomToolbar.actionMenu) {
                  roomToolbar.closeMenus();
                  toggleMaskSensitiveData();
                }
              }}
            >
              {maskSensitiveData ? "Show sensitive data" : "Hide sensitive data"}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (roomToolbar.actionMenu) {
                  roomToolbar.hideAction(roomToolbar.actionMenu.actionId);
                }
              }}
            >
              Hide
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
