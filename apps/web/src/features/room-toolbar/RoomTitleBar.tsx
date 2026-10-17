import { useRef } from "react";
import type { Room } from "@space/contracts";
import type { SideSurfaces } from "../docks/useSideSurfaces.js";
import { SpaceBrand } from "../../SpaceBrand.js";
import { ChevronLeft, ChevronRight, Folder, PanelLeft, Pencil, Save, Undo2, X } from "../ui-theme/app-icons.js";
import type { ShellMode } from "../pane-grid/pane-grid-layout.js";
import type { RoomRename } from "./useRoomRename.js";

export interface RoomTitleBarProps {
  /** The room on screen (the outgoing one while the next room prepares). */
  room: Room | null;
  rename: RoomRename;
  shellMode: ShellMode;
  docks: Pick<SideSurfaces, "sideSurfaceToggleLabel" | "isSideSurfaceOpen" | "activeSideSurface" | "toggleSideSurface">;
  /** The brand mark minimizes every pane. */
  onMinimizeAllPanes: () => void;
  /** Focuses (or opens) a File Manager pane on the room's project. */
  onOpenProjectFiles: (room: Room, projectPath: string) => Promise<void>;
  canNavigateRooms: boolean;
  previousRoom: Room | null;
  nextRoom: Room | null;
  selectRoom: (roomId: string) => Promise<void>;
  paneMoveNotice: string | null;
  setPaneMoveNotice: (notice: string | null) => void;
}

/** The room toolbar's title row: rooms toggle, brand, name or rename form, project, room navigation and notices. */
export function RoomTitleBar({
  room, rename, shellMode, docks, onMinimizeAllPanes, onOpenProjectFiles, canNavigateRooms, previousRoom, nextRoom, selectRoom,
  paneMoveNotice, setPaneMoveNotice
}: RoomTitleBarProps) {
  const presentationRoom = room;
  const {
    isRoomRenameOpen, roomNameDraft, setRoomNameDraft, roomRenamePending, roomRenameError, setRoomRenameError, beginRoomRename,
    cancelRoomRename, submitRoomRename, roomNamePreview, setRoomNamePreview, roomNameHoldTimerRef
  } = rename;
  const { sideSurfaceToggleLabel, isSideSurfaceOpen, activeSideSurface, toggleSideSurface } = docks;
  const titleSwipeRef = useRef<{ x: number; y: number; at: number } | null>(null);
  return (
    <div className="board-toolbar-main">
      <div className="board-title-row">
        <button type="button" className="desktop-rooms-toggle"
          aria-label={sideSurfaceToggleLabel("rooms")} title={sideSurfaceToggleLabel("rooms")}
          aria-pressed={isSideSurfaceOpen && activeSideSurface === "rooms"}
          onClick={() => toggleSideSurface("rooms")}><PanelLeft aria-hidden="true" /></button>
        <SpaceBrand onActivate={onMinimizeAllPanes} />
        <div className="board-title-heading">
          {isRoomRenameOpen && presentationRoom ? (
            <form className="room-title-form" onSubmit={submitRoomRename}>
              <input
                aria-label="Room name"
                placeholder="Room name"
                value={roomNameDraft}
                disabled={roomRenamePending}
                onChange={(event) => setRoomNameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRoomRename();
                  }
                }}
                autoFocus
              />
              <button
                type="submit"
                className="room-title-save"
                title="Save room name"
                aria-label="Save room name"
                disabled={roomRenamePending}
              >
                <Save aria-hidden="true" />
              </button>
              <button
                type="button"
                className="room-title-cancel"
                title="Cancel room rename"
                aria-label="Cancel room rename"
                onClick={cancelRoomRename}
                disabled={roomRenamePending}
              >
                <Undo2 aria-hidden="true" />
              </button>
            </form>
          ) : (
            <>
              <h2 title={presentationRoom?.name ?? "No room"} onContextMenu={(event) => {
                if (shellMode !== "mobile") return;
                event.preventDefault();
                setRoomNamePreview(presentationRoom?.name ?? "No room");
              }} onTouchStart={shellMode === "mobile" ? (event) => {
                const name = presentationRoom?.name ?? "No room";
                const touch = event.touches[0];
                titleSwipeRef.current = touch ? { x: touch.clientX, y: touch.clientY, at: Date.now() } : null;
                roomNameHoldTimerRef.current = window.setTimeout(() => setRoomNamePreview(name), 500);
              } : undefined} onTouchEnd={(event) => {
                if (roomNameHoldTimerRef.current !== null) window.clearTimeout(roomNameHoldTimerRef.current);
                // A horizontal swipe on the room title moves between rooms, like the pane title swipe moves between panes.
                const start = titleSwipeRef.current;
                const touch = event.changedTouches[0];
                titleSwipeRef.current = null;
                if (!start || !touch || !canNavigateRooms || Date.now() - start.at > 800) return;
                const dx = touch.clientX - start.x;
                if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(touch.clientY - start.y) * 1.5) return;
                const target = dx < 0 ? nextRoom : previousRoom;
                if (target) void selectRoom(target.id);
              }} onTouchMove={() => {
                if (roomNameHoldTimerRef.current !== null) window.clearTimeout(roomNameHoldTimerRef.current);
              }}>{presentationRoom?.name ?? "No room"}</h2>
              {presentationRoom ? (() => {
                const effectiveProj = presentationRoom.projectPath || "/opt/spaceapp";
                return (
                  <button
                    type="button"
                    className="room-project-pill"
                    title={`Project: ${effectiveProj} • Click to open/focus File Manager`}
                    aria-label={`Project: ${effectiveProj}`}
                    onClick={() => onOpenProjectFiles(presentationRoom, effectiveProj)}
                  >
                    <Folder aria-hidden="true" />
                    <span>{effectiveProj.split("/").filter(Boolean).pop() || effectiveProj}</span>
                  </button>
                );
              })() : null}
            </>
          )}
          {roomNamePreview && shellMode === "mobile" ? (
            <button type="button" className="mobile-room-name-preview" role="tooltip" aria-label={`Full room name: ${roomNamePreview}. Tap to dismiss`} onClick={() => setRoomNamePreview(null)}>{roomNamePreview}</button>
          ) : null}
          {presentationRoom ? (
            <div className="board-title-controls">
              {!isRoomRenameOpen ? (
                <button
                  type="button"
                  className="room-title-edit"
                  title={`Rename ${presentationRoom.name}`}
                  aria-label={`Rename ${presentationRoom.name}`}
                  onClick={beginRoomRename}
                >
                  <Pencil aria-hidden="true" />
                </button>
              ) : null}
              {canNavigateRooms ? (
                <div className="room-title-nav" role="group" aria-label="Room navigation">
                  <button
                    type="button"
                    title="Previous room"
                    aria-label="Previous room"
                    disabled={!previousRoom}
                    onClick={() => {
                      if (previousRoom) {
                        void selectRoom(previousRoom.id);
                      }
                    }}
                  >
                    <ChevronLeft aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Next room"
                    aria-label="Next room"
                    disabled={!nextRoom}
                    onClick={() => {
                      if (nextRoom) {
                        void selectRoom(nextRoom.id);
                      }
                    }}
                  >
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {roomRenameError ? <p className="room-title-error" role="alert"><span>{roomRenameError}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setRoomRenameError(null)}><X aria-hidden="true" /></button></p> : null}
      {paneMoveNotice ? (
        <div className="validation-result" role="status" aria-live="polite">
          <div className="notice-row"><span>{paneMoveNotice}</span><button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setPaneMoveNotice(null)}><X aria-hidden="true" /></button></div>
        </div>
      ) : null}
    </div>
  );
}
