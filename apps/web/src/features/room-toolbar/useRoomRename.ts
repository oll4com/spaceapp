import { useEffect, useRef, useState, type Dispatch, type FormEvent, type MutableRefObject, type SetStateAction } from "react";
import type { Room } from "@space/contracts";
import { api } from "../../api.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";

// Renaming the active room from the toolbar title or the Workspace menu, and the
// mobile long-press preview of a truncated room name.

export interface RoomRenameContext {
  activeRoom: Room | null;
  setRooms: Dispatch<SetStateAction<Room[]>>;
  /** Closes the toolbar menus that would cover the rename form. */
  onBeginRename: () => void;
}

export interface RoomRename {
  isRoomRenameOpen: boolean;
  setIsRoomRenameOpen: Dispatch<SetStateAction<boolean>>;
  roomNameDraft: string;
  setRoomNameDraft: Dispatch<SetStateAction<string>>;
  roomRenamePending: boolean;
  setRoomRenamePending: Dispatch<SetStateAction<boolean>>;
  roomRenameError: string | null;
  setRoomRenameError: Dispatch<SetStateAction<string | null>>;
  beginRoomRename: () => void;
  cancelRoomRename: () => void;
  /** Saves the draft name; `onComplete` runs after a save or an unchanged name. */
  submitRoomRename: (event: FormEvent<HTMLFormElement>, onComplete?: () => void) => Promise<void>;
  /** Full room name shown after a long press on mobile. */
  roomNamePreview: string | null;
  setRoomNamePreview: Dispatch<SetStateAction<string | null>>;
  roomNameHoldTimerRef: MutableRefObject<number | null>;
}

export function useRoomRename({ activeRoom, setRooms, onBeginRename }: RoomRenameContext): RoomRename {
  const [roomNamePreview, setRoomNamePreview] = useState<string | null>(null);
  const roomNameHoldTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (roomNameHoldTimerRef.current !== null) window.clearTimeout(roomNameHoldTimerRef.current);
  }, []);
  const [isRoomRenameOpen, setIsRoomRenameOpen] = useState(false);
  const [roomNameDraft, setRoomNameDraft] = useState("");
  const [, setRoomProjectPathDraft] = useState("");
  const [roomRenamePending, setRoomRenamePending] = useState(false);
  const [roomRenameError, setRoomRenameError] = useState<string | null>(null);
  useAutoDismiss(roomRenameError, setRoomRenameError);

  function beginRoomRename() {
    if (!activeRoom || roomRenamePending) return;
    setRoomNameDraft(activeRoom.name);
    setRoomProjectPathDraft(activeRoom.projectPath ?? "");
    setRoomRenameError(null);
    onBeginRename();
    setIsRoomRenameOpen(true);
  }

  function cancelRoomRename() {
    setIsRoomRenameOpen(false);
    setRoomRenamePending(false);
    setRoomRenameError(null);
    setRoomNameDraft(activeRoom?.name ?? "");
    setRoomProjectPathDraft(activeRoom?.projectPath ?? "");
  }

  async function submitRoomRename(event: FormEvent<HTMLFormElement>, onComplete?: () => void) {
    event.preventDefault();
    if (!activeRoom || roomRenamePending) return;
    const nextName = roomNameDraft.trim();
    if (!nextName) {
      setRoomRenameError("Room name is required.");
      return;
    }
    if (nextName === activeRoom.name) {
      cancelRoomRename();
      onComplete?.();
      return;
    }
    setRoomRenamePending(true);
    setRoomRenameError(null);
    try {
      const updated = await api.updateRoom(activeRoom.id, {
        name: nextName
      });
      setRooms((current) => current.map((room) => (room.id === updated.id ? updated : room)));
      setRoomNameDraft(updated.name);
      setIsRoomRenameOpen(false);
      onComplete?.();
    } catch (err) {
      setRoomRenameError(err instanceof Error ? err.message : "Room rename failed");
    } finally {
      setRoomRenamePending(false);
    }
  }

  return {
    isRoomRenameOpen, setIsRoomRenameOpen,
    roomNameDraft, setRoomNameDraft,
    roomRenamePending, setRoomRenamePending,
    roomRenameError, setRoomRenameError,
    beginRoomRename, cancelRoomRename, submitRoomRename,
    roomNamePreview, setRoomNamePreview, roomNameHoldTimerRef
  };
}
