import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@space/contracts";

const api = vi.hoisted(() => ({ updateRoom: vi.fn() }));
vi.mock("../src/api.js", () => ({ api }));

import { useRoomRename } from "../src/features/room-toolbar/useRoomRename.js";
import { RoomTitleBar } from "../src/features/room-toolbar/RoomTitleBar.js";

const roomA = { id: "room:a", name: "Alpha", projectPath: "/opt/spaceapp/projects/alpha" } as Room;

function useHarness(onBeginRename = vi.fn()) {
  const [rooms, setRooms] = useState([roomA]);
  const rename = useRoomRename({ activeRoom: rooms[0] ?? null, setRooms, onBeginRename });
  return { rooms, rename };
}

function submitEvent() {
  return { preventDefault: vi.fn() } as never;
}

describe("useRoomRename", () => {
  beforeEach(() => api.updateRoom.mockReset());
  afterEach(() => cleanup());

  it("opens with the current name and saves a new one", async () => {
    api.updateRoom.mockResolvedValue({ ...roomA, name: "Beta" });
    const onBeginRename = vi.fn();
    const { result } = renderHook(() => useHarness(onBeginRename));
    act(() => result.current.rename.beginRoomRename());
    expect(onBeginRename).toHaveBeenCalledTimes(1);
    expect(result.current.rename.isRoomRenameOpen).toBe(true);
    expect(result.current.rename.roomNameDraft).toBe("Alpha");
    act(() => result.current.rename.setRoomNameDraft("  Beta "));
    const onComplete = vi.fn();
    await act(async () => { await result.current.rename.submitRoomRename(submitEvent(), onComplete); });
    expect(api.updateRoom).toHaveBeenCalledWith("room:a", { name: "Beta" });
    expect(result.current.rooms[0]!.name).toBe("Beta");
    expect(result.current.rename.isRoomRenameOpen).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("requires a name, closes on an unchanged name and reports failures", async () => {
    const { result } = renderHook(() => useHarness());
    act(() => result.current.rename.beginRoomRename());
    act(() => result.current.rename.setRoomNameDraft("   "));
    await act(async () => { await result.current.rename.submitRoomRename(submitEvent()); });
    expect(result.current.rename.roomRenameError).toBe("Room name is required.");
    act(() => result.current.rename.setRoomNameDraft("Alpha"));
    await act(async () => { await result.current.rename.submitRoomRename(submitEvent()); });
    expect(result.current.rename.isRoomRenameOpen).toBe(false);
    expect(api.updateRoom).not.toHaveBeenCalled();
    api.updateRoom.mockRejectedValueOnce(new Error("Name taken"));
    act(() => result.current.rename.beginRoomRename());
    act(() => result.current.rename.setRoomNameDraft("Gamma"));
    await act(async () => { await result.current.rename.submitRoomRename(submitEvent()); });
    expect(result.current.rename.roomRenameError).toBe("Name taken");
    expect(result.current.rename.roomRenamePending).toBe(false);
  });
});

describe("RoomTitleBar", () => {
  afterEach(() => cleanup());

  function Bar({ overrides = {} }: { overrides?: Partial<Parameters<typeof RoomTitleBar>[0]> }) {
    const { rename } = useHarness();
    return (
      <RoomTitleBar
        room={roomA}
        rename={rename}
        shellMode="desktop"
        docks={{ sideSurfaceToggleLabel: () => "Show rooms", isSideSurfaceOpen: false, activeSideSurface: "rooms", toggleSideSurface: vi.fn() }}
        onMinimizeAllPanes={vi.fn()}
        onOpenProjectFiles={vi.fn(async () => undefined)}
        canNavigateRooms
        previousRoom={null}
        nextRoom={{ id: "room:b", name: "Bravo" } as Room}
        selectRoom={vi.fn(async () => undefined)}
        paneMoveNotice={null}
        setPaneMoveNotice={vi.fn()}
        {...overrides}
      />
    );
  }

  it("shows the room, its project and room navigation", () => {
    const onOpenProjectFiles = vi.fn(async () => undefined);
    const selectRoom = vi.fn(async () => undefined);
    render(<Bar overrides={{ onOpenProjectFiles, selectRoom }} />);
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Project: /opt/spaceapp/projects/alpha" }));
    expect(onOpenProjectFiles).toHaveBeenCalledWith(roomA, "/opt/spaceapp/projects/alpha");
    expect((screen.getByRole("button", { name: "Previous room" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next room" }));
    expect(selectRoom).toHaveBeenCalledWith("room:b");
  });

  it("switches to the rename form and cancels it with Escape", () => {
    render(<Bar />);
    fireEvent.click(screen.getByRole("button", { name: "Rename Alpha" }));
    const input = screen.getByRole("textbox", { name: "Room name" }) as HTMLInputElement;
    expect(input.value).toBe("Alpha");
    expect(screen.getByRole("button", { name: "Save room name" }).className).toBe("room-title-save");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Room name" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  });
});
