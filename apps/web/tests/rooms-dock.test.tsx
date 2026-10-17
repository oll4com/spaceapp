import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";

const api = vi.hoisted(() => ({
  listAdminUsers: vi.fn(),
  updateRoom: vi.fn(),
  reorderRooms: vi.fn(),
  ensureProject: vi.fn(),
  rooms: vi.fn(),
  cliRuntimes: vi.fn(async () => ({ data: [] })),
  cliRuntimesSnapshot: vi.fn(() => null),
  cliRuntimeSettings: vi.fn(async () => ({ settings: [] })),
  cliRuntimeSettingsSnapshot: vi.fn(() => null),
  invalidateCliRuntimes: vi.fn(),
  invalidateCliRuntimeSettings: vi.fn()
}));
vi.mock("../src/api.js", () => ({ api }));

import { useAdminUsers } from "../src/features/rooms-dock/useAdminUsers.js";
import { useRoomsDock, type RoomsDock } from "../src/features/rooms-dock/useRoomsDock.js";
import { RoomsDockPanel, selectRoomEntries, type RoomsDockPanelProps } from "../src/features/rooms-dock/RoomsDockPanel.js";
import { loadBoundedRoomCatalog, reorderRoomsById, sortRoomsByOrder } from "../src/features/rooms-dock/room-catalog.js";

function room(id: string, order: number, extra: Partial<Room> = {}): Room {
  return { id, name: `Room ${id}`, order, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ownerUserId: "user:me", projectPath: null, ...extra } as Room;
}

describe("room catalog helpers", () => {
  beforeEach(() => api.rooms.mockReset());

  it("orders rooms by order, creation time and id", () => {
    const rooms = [room("c", 1), room("b", 0, { createdAt: "2026-10-02T00:00:00.000Z" }), room("a", 0)];
    expect(sortRoomsByOrder(rooms).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("moves a dragged room before the target and renumbers the order", () => {
    const rooms = [room("a", 0), room("b", 1), room("c", 2)];
    expect(reorderRoomsById(rooms, "c", "a").map((r) => [r.id, r.order])).toEqual([["c", 0], ["a", 1], ["b", 2]]);
    expect(reorderRoomsById(rooms, "a", "a")).toBe(rooms);
  });

  it("reads at most 20 catalog pages", async () => {
    api.rooms.mockImplementation(async (query?: { page?: number }) => ({ data: [room(`p${query?.page}`, query?.page ?? 0)], pagination: { totalPages: 50 } }));
    const rooms = await loadBoundedRoomCatalog();
    expect(rooms).toHaveLength(20);
    expect(api.rooms).toHaveBeenCalledTimes(20);
  });
});

describe("useAdminUsers", () => {
  afterEach(() => cleanup());

  it("loads accounts for admins and counts rooms from the live catalog", async () => {
    api.listAdminUsers.mockResolvedValue({ users: [{ id: "user:me", email: "me@example.test", role: "ADMIN", roomCount: 9 }, { id: "user:two", email: "", role: "USER", roomCount: 4 }] });
    const rooms = [room("a", 0), room("b", 1, { ownerUserId: "user:two" }), room("c", 2, { ownerUserId: "user:two" })];
    const { result, rerender } = renderHook(({ role }: { role: string | undefined }) => useAdminUsers(role, rooms), { initialProps: { role: "USER" as string | undefined } });
    expect(api.listAdminUsers).not.toHaveBeenCalled();
    rerender({ role: "ADMIN" });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.userEmailById.get("user:two")).toBe("user:two");
    expect(result.current.adminUsersListWithLiveCounts.map((user) => user.roomCount)).toEqual([1, 2]);
  });
});

function useDockHarness(initialRooms: Room[], reportError = vi.fn(), addNamedProjectPreset = vi.fn()) {
  const [rooms, setRooms] = useState(initialRooms);
  const dock = useRoomsDock({ rooms, setRooms, reportError, addNamedProjectPreset });
  return { rooms, dock };
}

describe("useRoomsDock", () => {
  beforeEach(() => {
    for (const fn of [api.listAdminUsers, api.updateRoom, api.reorderRooms, api.ensureProject, api.rooms]) fn.mockReset();
    api.ensureProject.mockResolvedValue({});
  });
  afterEach(() => cleanup());

  it("saves a project draft for a room", async () => {
    api.updateRoom.mockImplementation(async (id: string, input: { name: string; projectPath: string | null }) => room(id, 0, { projectPath: input.projectPath }));
    const { result } = renderHook(() => useDockHarness([room("a", 0)]));
    act(() => result.current.dock.setDockProjectPathDrafts({ a: " /opt/spaceapp/projects/demo " }));
    await act(async () => { await result.current.dock.saveDockProject("a"); });
    expect(api.ensureProject).toHaveBeenCalledWith({ path: "/opt/spaceapp/projects/demo" });
    expect(api.updateRoom).toHaveBeenCalledWith("a", { name: "Room a", projectPath: "/opt/spaceapp/projects/demo" });
    expect(result.current.rooms[0]!.projectPath).toBe("/opt/spaceapp/projects/demo");
    expect(result.current.dock.dockProjectSavingRoomId).toBeNull();
  });

  it("creates a named preset folder and points the room at it", async () => {
    const addNamedProjectPreset = vi.fn();
    api.updateRoom.mockImplementation(async (id: string, input: { projectPath: string }) => room(id, 0, { projectPath: input.projectPath }));
    const { result } = renderHook(() => useDockHarness([room("a", 0)], vi.fn(), addNamedProjectPreset));
    act(() => { result.current.dock.setIsAddingPresetRoomId("a"); result.current.dock.setNewPresetDraft("space3"); });
    await act(async () => { await result.current.dock.handleAddNewPreset("a"); });
    expect(addNamedProjectPreset).toHaveBeenCalledWith("space3", "/opt/spaceapp/projects/space3");
    expect(result.current.dock.dockProjectPathDrafts).toEqual({ a: "/opt/spaceapp/projects/space3" });
    expect(result.current.dock.isAddingPresetRoomId).toBeNull();
    expect(result.current.rooms[0]!.projectPath).toBe("/opt/spaceapp/projects/space3");
  });

  it("reorders rooms with a right-button drag and restores them when the server refuses", async () => {
    const reportError = vi.fn();
    api.reorderRooms.mockRejectedValue(new Error("Reorder refused"));
    const rooms = [room("a", 0), room("b", 1)];
    const { result } = renderHook(() => useDockHarness(rooms, reportError));
    const target = document.createElement("div");
    target.className = "room-item";
    target.dataset.roomId = "a";
    document.body.append(target);
    act(() => result.current.dock.handleRoomRightPointerDown({ button: 2, pointerId: 7, preventDefault: () => undefined } as never, "b"));
    expect(result.current.dock.draggedRoomId).toBe("b");
    await act(async () => {
      const up = new MouseEvent("pointerup", { button: 2 }) as PointerEvent;
      Object.defineProperty(up, "pointerId", { value: 7 });
      Object.defineProperty(up, "target", { value: target });
      window.dispatchEvent(up);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.reorderRooms).toHaveBeenCalledWith(["b", "a"]);
    expect(result.current.rooms.map((r) => r.id)).toEqual(["a", "b"]);
    expect(reportError).toHaveBeenLastCalledWith("Reorder refused");
    expect(result.current.dock.draggedRoomId).toBeNull();
    target.remove();
  });
});

describe("RoomsDockPanel", () => {
  afterEach(() => cleanup());

  function Panel({ overrides, initialRooms, selectedRoomId = "a" }: { overrides?: Partial<RoomsDockPanelProps["actions"]>; initialRooms?: Room[]; selectedRoomId?: string }) {
    const [rooms, setRooms] = useState(initialRooms ?? [room("a", 0), room("b", 1, { ownerUserId: "user:other", name: "Other" })]);
    const dock: RoomsDock = useRoomsDock({ rooms, setRooms, reportError: () => undefined, addNamedProjectPreset: () => undefined });
    const { entries, isRoomListFiltered } = selectRoomEntries({
      rooms, selectedRoomId, panes: [] as Pane[], roomRuntimes: {}, completions: {}, roomCliActivityCounts: {},
      isAdminMode: false, userId: "user:me", dock, userEmailById: new Map()
    });
    return (
      <RoomsDockPanel
        dock={dock}
        adminUsers={{ adminUsersList: [], userEmailById: new Map(), adminUsersListWithLiveCounts: [] }}
        entries={entries}
        isRoomListFiltered={isRoomListFiltered}
        catalog={{ rooms, setRooms, selectedRoomId, panes: [], roomRuntimes: {}, roomPaneLoadStates: {}, warmRoomIds: [], warmRoomEnabled: true, roomPaneCounts: { a: 3 }, roomCliRuntimeIds: {} }}
        access={{ auth: null, isAdminMode: false, runtimeKind: "demo" }}
        actions={{
          createRoom: vi.fn(async () => undefined), roomCreationPending: false, selectRoom: vi.fn(async () => undefined), requestRoomDelete: vi.fn(async () => undefined),
          requestTestRoomsDelete: vi.fn(async () => undefined), deletePendingRoomId: null, setSelectedPaneId: vi.fn(), addFilesPane: vi.fn(async () => undefined), addRootAdminPane: vi.fn(async () => undefined),
          isRoomWorktreeEnabled: () => true, setRoomWorktreeEnabled: vi.fn(), projectPresets: [{ label: "space", path: "/opt/spaceapp" }],
          reportError: vi.fn(), roomDeleteConfirmDialog: null, movePaneToRoom: vi.fn(async () => undefined),
          ...overrides
        }}
        composer={{ preparingRoomId: null, presentationPanes: [], presentationRoom: null, addRoomPanes: vi.fn(async () => undefined), openSettingsSurface: vi.fn() }}
      />
    );
  }

  it("lists own rooms, filters by search and opens a room", { timeout: 30_000 }, () => {
    const selectRoom = vi.fn(async () => undefined);
    const { container } = render(<Panel overrides={{ selectRoom }} />);
    expect(Array.from(container.querySelectorAll(".room-item")).map((item) => item.getAttribute("data-room-id"))).toEqual(["a"]);
    expect(container.querySelector(".room-cli-badge")?.textContent).toBe("Panes 3");
    fireEvent.click(screen.getByRole("button", { name: "Open Room a" }));
    expect(selectRoom).toHaveBeenCalledWith("a", { keepCompactSurfaceOpen: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a room" }), { target: { value: "zzz" } });
    expect(screen.getByText("No rooms match these filters.").getAttribute("role")).toBe("status");
    expect(container.querySelector(".rooms-filter-summary [role=\"status\"]")?.textContent).toBe("0 of 2 rooms");
  });

  it("moves a pane dropped on another room and never targets the active room", () => {
    const movePaneToRoom = vi.fn(async () => undefined);
    const rooms = [room("a", 0), room("b", 1)];
    const { container } = render(<Panel initialRooms={rooms} overrides={{ movePaneToRoom }} />);
    const payload = JSON.stringify({ id: "pane:1", title: "Dana", mode: "TERMINAL", roomId: "a", roomName: "Room a" });
    const dataTransfer = { types: ["text/plain", "application/x-space-pane-context"], dropEffect: "none", getData: (type: string) => type === "application/x-space-pane-context" ? payload : "pane:1" };
    const target = container.querySelector<HTMLElement>('.room-item[data-room-id="b"]')!;
    const active = container.querySelector<HTMLElement>('.room-item[data-room-id="a"]')!;
    expect(fireEvent.dragOver(active, { dataTransfer })).toBe(true);
    expect(fireEvent.dragOver(target, { dataTransfer })).toBe(false);
    expect(target.classList.contains("is-drop-target")).toBe(true);
    fireEvent.drop(target, { dataTransfer });
    expect(movePaneToRoom).toHaveBeenCalledWith("pane:1", "b");
    expect(target.classList.contains("is-drop-target")).toBe(false);
  });

  it("expands the project settings of a room", () => {
    const setRoomWorktreeEnabled = vi.fn();
    render(<Panel overrides={{ setRoomWorktreeEnabled }} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure project for Room a" }));
    expect((screen.getByPlaceholderText("e.g. /opt/spaceapp") as HTMLInputElement).value).toBe("/opt/spaceapp");
    expect(screen.getByRole("button", { name: "space" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Room a" }));
    expect(screen.queryByPlaceholderText("e.g. /opt/spaceapp")).toBeNull();
  });

  it("deletes a room from its settings and renders the confirmation at the end of the dock", () => {
    const requestRoomDelete = vi.fn(async () => undefined);
    const { container } = render(<Panel overrides={{ requestRoomDelete, roomDeleteConfirmDialog: <div data-testid="room-delete-confirm" /> }} />);
    expect(screen.queryByRole("button", { name: "Delete Room a" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Configure project for Room a" }));
    expect(screen.getByRole("button", { name: "Add a project preset" }).getAttribute("title")).toBe("Add a project preset");
    fireEvent.click(screen.getByRole("button", { name: "Delete Room a" }));
    expect(requestRoomDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(container.querySelector(".side-surface-room-panel")?.lastElementChild?.getAttribute("data-testid")).toBe("room-delete-confirm");
  });

  it("keeps Agent Proof and CLI Recovery rooms in a collapsed Test rooms group", () => {
    const rooms = [room("a", 0), room("p", 1, { kind: "AGENT_PROOF", name: "Agent Proof 1" }), room("r", 2, { kind: "CLI_RECOVERY", name: "Recovery" })];
    const { container, unmount } = render(<Panel initialRooms={rooms} />);
    const listed = () => Array.from(container.querySelectorAll(".room-item"))
      .filter((item) => !item.closest("[hidden]"))
      .map((item) => item.getAttribute("data-room-id"));
    // Collapsed test rooms stay mounted for proof scripts that select rooms by data-room-id.
    expect(container.querySelector('.room-select[data-room-id="p"]')).toBeTruthy();
    const group = screen.getByRole("button", { name: /Test rooms/ });
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(group.textContent).toContain("2");
    expect(listed()).toEqual(["a"]);
    fireEvent.click(group);
    expect(listed()).toEqual(["a", "p", "r"]);
    fireEvent.click(group);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a room" }), { target: { value: "proof" } });
    expect(listed()).toEqual(["p"]);
    unmount();
    render(<Panel initialRooms={rooms} selectedRoomId="p" />);
    expect(screen.getByRole("button", { name: /Test rooms/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Open Agent Proof 1" }).getAttribute("aria-current")).toBe("true");
  });

  it("deletes every listed test room with one button", () => {
    const requestTestRoomsDelete = vi.fn(async () => undefined);
    const rooms = [room("a", 0), room("p", 1, { kind: "AGENT_PROOF", name: "Agent Proof 1" }), room("r", 2, { kind: "CLI_RECOVERY", name: "Recovery" })];
    render(<Panel initialRooms={rooms} overrides={{ requestTestRoomsDelete }} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(requestTestRoomsDelete).toHaveBeenCalledWith([expect.objectContaining({ id: "p" }), expect.objectContaining({ id: "r" })]);
  });

  it("reports a failed project clear instead of failing silently", async () => {
    const reportError = vi.fn();
    api.updateRoom.mockRejectedValueOnce(new Error("offline"));
    render(<Panel overrides={{ reportError }} initialRooms={[room("a", 0, { projectPath: "/opt/spaceapp/projects/a" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure project for Room a" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear project directory" })); });
    expect(reportError).toHaveBeenCalledWith("The project directory could not be cleared: offline");
  });
});
