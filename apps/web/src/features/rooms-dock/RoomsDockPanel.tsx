import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { MAX_ROOMS, type AuthMe, type Pane, type Room } from "@space/contracts";
import { api } from "../../api.js";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import type { SpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { classifyRoomWarmPresentation } from "../../warm-room-startup.js";
import type { PaneCompletionLifecycleState } from "../../pane-completion-lifecycle.js";
import { lazyWithPreload } from "../../lazy-with-preload.js";
import { RoomPaneComposer } from "../room-pane-composer/RoomPaneComposer.js";
import { SPACE_PANE_CONTEXT_MIME, readPaneContextDragPayload } from "../pane-drag/pane-drag.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { DockButton, DockChips, DockSearch } from "../dock-kit/DockKit.js";
import { ChevronRight, Folder, FolderOpen, GitBranch, LayoutGrid, MoreHorizontal, Plus, Rocket, Save, Terminal, Trash2, X } from "../ui-theme/app-icons.js";
import { workspaceRoomActivity } from "../ui-theme/workspace-room-filter.js";
import type { AdminUsers } from "./useAdminUsers.js";
import { ensureProjectFolder } from "./room-catalog.js";
import { RoomSharing } from "./RoomSharing.js";
import { isViewOnlyRoom } from "./room-share-view.js";
import type { AdminRoomFilterMode, RoomsDock } from "./useRoomsDock.js";
import "./rooms-dock.css";

const LazyProjectSourcePicker = lazyWithPreload(() => import("../source-control/ProjectSourcePicker.js").then(module => ({ default: module.ProjectSourcePicker })));

export interface RoomEntry { room: Room; activity: ReturnType<typeof workspaceRoomActivity> }

/** Rooms shown in the dock: own rooms, or the admin's account filter, then the search. */
export function selectRoomEntries({ rooms, selectedRoomId, panes, roomRuntimes, completions, roomCliActivityCounts, isAdminMode, userId, dock, userEmailById, notificationRooms, listsEveryRoom = false }: {
  rooms: Room[];
  selectedRoomId: string | null;
  /** Panes of the active room. */
  panes: Pane[];
  roomRuntimes: Record<string, { panes: Pane[] }>;
  completions: PaneCompletionLifecycleState["panes"];
  roomCliActivityCounts: Record<string, number>;
  isAdminMode: boolean;
  userId: string | undefined;
  dock: Pick<RoomsDock, "roomSearch" | "adminRoomFilterMode" | "adminSelectedUserId">;
  userEmailById: Map<string, string>;
  /** Open notifications per room, from the notification store. */
  notificationRooms?: Record<string, number>;
  /** A USER's room list already holds only their own and shared rooms (multi-user, operator-approved 2026-10-17). */
  listsEveryRoom?: boolean;
}): { entries: RoomEntry[]; isRoomListFiltered: boolean } {
  const { roomSearch, adminRoomFilterMode, adminSelectedUserId } = dock;
  const entries = rooms.map(room => ({
    room,
    activity: workspaceRoomActivity(room.id === selectedRoomId ? panes : roomRuntimes[room.id]?.panes ?? [], completions, roomCliActivityCounts[room.id], notificationRooms?.[room.id] ?? 0)
  })).filter(({ room }) => {
    if (!isAdminMode) {
      if (!listsEveryRoom && room.ownerUserId && room.ownerUserId !== userId) return false;
    } else {
      if (adminRoomFilterMode === "mine") {
        if (room.ownerUserId && room.ownerUserId !== userId) return false;
      } else if (adminRoomFilterMode === "user") {
        if (adminSelectedUserId && room.ownerUserId !== adminSelectedUserId) return false;
      }
    }
    if (roomSearch.trim()) {
      const q = roomSearch.trim().toLowerCase();
      const nameMatch = room.name.toLowerCase().includes(q);
      const ownerEmail = room.ownerUserId ? userEmailById.get(room.ownerUserId) ?? "" : "";
      return nameMatch || ownerEmail.toLowerCase().includes(q);
    }
    return true;
  });
  const isRoomListFiltered = Boolean(roomSearch.trim()) || (isAdminMode && adminRoomFilterMode !== "mine");
  return { entries, isRoomListFiltered };
}

export interface RoomsDockPanelProps {
  dock: RoomsDock;
  adminUsers: AdminUsers;
  entries: RoomEntry[];
  isRoomListFiltered: boolean;
  catalog: {
    rooms: Room[];
    setRooms: Dispatch<SetStateAction<Room[]>>;
    selectedRoomId: string | null;
    /** Panes of the active room. */
    panes: Pane[];
    roomRuntimes: Record<string, { panes: Pane[]; bootstrappedPaneIds: string[] }>;
    roomPaneLoadStates: Record<string, "loading" | "loaded" | "error">;
    warmRoomIds: string[];
    warmRoomEnabled: boolean;
    roomPaneCounts: Record<string, number>;
    roomCliRuntimeIds: Record<string, string[]>;
  };
  access: {
    auth: AuthMe | null;
    isAdminMode: boolean;
    runtimeKind: SpaceRuntime["kind"] | null;
  };
  actions: {
    createRoom: () => Promise<void>;
    roomCreationPending: boolean;
    selectRoom: (roomId: string, options?: { keepCompactSurfaceOpen?: boolean }) => Promise<void>;
    /** Asks in the app before deleting; running CLI sessions are named in the question. */
    requestRoomDelete: (room: Room) => Promise<void>;
    /** Deletes the listed test rooms behind one confirmation. */
    requestTestRoomsDelete: (rooms: Room[]) => Promise<void>;
    deletePendingRoomId: string | null;
    setSelectedPaneId: (paneId: string | null) => void;
    addFilesPane: (count?: number, targetRoomId?: string) => Promise<void>;
    addRootAdminPane: (targetRoomId?: string) => Promise<void>;
    isRoomWorktreeEnabled: (roomId: string) => boolean;
    setRoomWorktreeEnabled: (roomId: string, enabled: boolean) => void;
    projectPresets: { label: string; path: string }[];
    reportError: (message: string) => void;
    /** The delete confirmation, rendered at the end of the dock. */
    roomDeleteConfirmDialog: ReactNode;
    /** A pane (header or minimized chip) dropped on a room moves there; its running CLI keeps running. */
    movePaneToRoom: (paneId: string, roomId: string) => Promise<void>;
  };
  composer: {
    preparingRoomId: string | null;
    /** Panes of the room on screen (the outgoing room while the next one prepares). */
    presentationPanes: Pane[];
    presentationRoom: Room | null;
    addRoomPanes: Parameters<typeof RoomPaneComposer>[0]["onApply"];
    openSettingsSurface: () => void;
  };
}

const adminRoomFilterOptions: { id: AdminRoomFilterMode; label: string }[] = [
  { id: "mine", label: "My rooms" },
  { id: "all", label: "All accounts" },
  { id: "user", label: "Selected account" }
];
const MAX_ROOM_CLI_ICONS = 3;

/** Agent Proof and CLI Recovery rooms are listed apart from the operator's own rooms. */
const isTestRoom = (room: Room) => room.kind === "AGENT_PROOF" || room.kind === "CLI_RECOVERY";

/** The Rooms dock: room list with filters, per-room project settings and the pane composer. */
export function RoomsDockPanel({ dock, adminUsers, entries, isRoomListFiltered, catalog, access, actions, composer }: RoomsDockPanelProps) {
  const {
    roomSearch, setRoomSearch, adminRoomFilterMode, setAdminRoomFilterMode, adminSelectedUserId, setAdminSelectedUserId,
    dockExpandedRoomId, setDockExpandedRoomId, dockProjectPathDrafts,
    setDockProjectPathDrafts, dockProjectSavingRoomId, setDockProjectSavingRoomId, isAddingPresetRoomId, setIsAddingPresetRoomId,
    newPresetDraft, setNewPresetDraft, projectPickerRoom, setProjectPickerRoom, roomProjectSources, assignPickedProjectToRoom,
    handleAddNewPreset, saveDockProject, roomReorderPending, draggedRoomId, dragOverRoomId, handleRoomRightPointerDown,
    testRoomsOpen, setTestRoomsOpen
  } = dock;
  const { adminUsersList, adminUsersListWithLiveCounts, userEmailById } = adminUsers;
  const { rooms, setRooms, selectedRoomId, panes, roomRuntimes, roomPaneLoadStates, warmRoomIds, warmRoomEnabled, roomPaneCounts, roomCliRuntimeIds } = catalog;
  const { auth, isAdminMode, runtimeKind } = access;
  const {
    createRoom, roomCreationPending, selectRoom, requestRoomDelete, requestTestRoomsDelete, deletePendingRoomId, setSelectedPaneId, addFilesPane, addRootAdminPane,
    isRoomWorktreeEnabled, setRoomWorktreeEnabled, projectPresets, reportError: setError, roomDeleteConfirmDialog, movePaneToRoom
  } = actions;
  const [paneDropRoomId, setPaneDropRoomId] = useState<string | null>(null);
  const { preparingRoomId, presentationPanes, presentationRoom, addRoomPanes, openSettingsSurface } = composer;
  const filteredRoomEntries = entries;
  const workspaceEntries = filteredRoomEntries.filter(({ room }) => !isTestRoom(room));
  const testEntries = filteredRoomEntries.filter(({ room }) => isTestRoom(room));
  // The group opens itself for a search and for an active test room, so a match is never hidden.
  const testRoomsShown = testRoomsOpen || Boolean(roomSearch.trim()) || testEntries.some(({ room }) => room.id === selectedRoomId);

  const toggleRoomSettings = (room: Room) => {
    setDockExpandedRoomId(current => current === room.id ? null : room.id);
    if (!dockProjectPathDrafts[room.id]) {
      setDockProjectPathDrafts(prev => ({ ...prev, [room.id]: room.projectPath || "/opt/spaceapp" }));
    }
  };

  const renderRoom = ({ room, activity }: RoomEntry) => {
    const isExpanded = dockExpandedRoomId === room.id;
    // "Warm" must mean truly ready: pane data loaded AND every visible
    // terminal pane bootstrapped (socket attached). Rooms whose data is
    // loaded but whose terminals are still attaching show "Warming".
    // User-approved 2026-08-14 (dock showed warm before it was true).
    const roomTerminalsBootstrapped = (roomId: string): boolean => {
      const runtime = roomRuntimes[roomId];
      if (!runtime) return false;
      const terminals = runtime.panes.filter(
        (pane) => pane.mode === "TERMINAL" && !pane.isMinimized
      );
      if (terminals.length === 0) return true;
      const bootstrapped = new Set(runtime.bootstrappedPaneIds ?? []);
      return terminals.every((pane) => bootstrapped.has(pane.id));
    };
    const warmPresentation = classifyRoomWarmPresentation({
      roomId: room.id,
      activeRoomId: selectedRoomId,
      warmRoomIds,
      hydratingRoomIds: new Set(
        Object.entries(roomPaneLoadStates)
          .filter(([roomId, state]) => (
            state === "loading" ||
            (state === "loaded" && !roomTerminalsBootstrapped(roomId))
          ))
          .map(([roomId]) => roomId)
      ),
      loadedRoomIds: new Set(
        Object.entries(roomPaneLoadStates)
          .filter(([roomId, state]) => (
            state === "loaded" && roomTerminalsBootstrapped(roomId)
          ))
          .map(([roomId]) => roomId)
      )
    });
    const roomCliPresentations = [...new Set(roomCliRuntimeIds[room.id] ?? [])].flatMap((runtimeId) => {
      const presentation = cliRuntimePresentation(runtimeId);
      return presentation ? [presentation] : [];
    });
    const effectivePath = room.projectPath || "/opt/spaceapp";
    const folderName = effectivePath.split("/").filter(Boolean).pop() || effectivePath;
    const isActive = room.id === selectedRoomId;
    return (
      <div
        key={room.id}
        className={[
          "room-item",
          isActive ? "selected" : "",
          isExpanded ? "is-expanded" : "",
          activity.attention ? "has-attention" : "",
          draggedRoomId === room.id ? "is-dragging" : "",
          (dragOverRoomId === room.id && draggedRoomId !== room.id) || paneDropRoomId === room.id ? "is-drop-target" : ""
        ].filter(Boolean).join(" ")}
        data-room-id={room.id}
        data-warm-presentation={warmRoomEnabled ? warmPresentation : undefined}
        title={isRoomListFiltered ? room.name : `Hold the right mouse button to reorder ${room.name}`}
        onPointerDown={(event) => { if (!isRoomListFiltered) handleRoomRightPointerDown(event, room.id); }}
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => {
          // Panes are dragged from the active room, so it is never a target.
          if (isActive || !event.dataTransfer.types.includes(SPACE_PANE_CONTEXT_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setPaneDropRoomId(room.id);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaneDropRoomId((current) => current === room.id ? null : current);
        }}
        onDrop={(event) => {
          setPaneDropRoomId(null);
          const payload = readPaneContextDragPayload(event.dataTransfer);
          if (!payload || payload.roomId === room.id) return;
          event.preventDefault();
          void movePaneToRoom(payload.id, room.id).catch((err: unknown) => setError(err instanceof Error ? err.message : "Pane move failed"));
        }}
        onAnimationEnd={(event) => {
          if (event.animationName.includes("room-card-press-pop") || event.animationName.includes("shockwave")) {
            event.currentTarget.classList.remove("is-clicked");
          }
        }}
      >
        <div className="room-item-row">
          <button
            className="room-select"
            data-room-id={room.id}
            onClick={(event) => {
              const item = event.currentTarget.closest<HTMLElement>(".room-item");
              if (item) {
                item.classList.remove("is-clicked");
                void item.offsetWidth;
                item.classList.add("is-clicked");
              }
              void selectRoom(room.id, { keepCompactSurfaceOpen: true });
            }}
            disabled={deletePendingRoomId === room.id || roomReorderPending}
            aria-label={`Open ${room.name}`}
            aria-current={isActive ? "true" : undefined}
          >
            <span className="room-status-dot" aria-hidden="true" />
            <span className="room-select-text">
              <span className="room-name">{room.name}</span>
              <span className="room-meta">
                {activity.attention ? <span className="room-attention">Needs attention</span> : null}
                <span className="room-folder" title={`Project: ${effectivePath}`}>{folderName}</span>
                {roomCliPresentations.length ? (
                  <span
                    className="room-cli-runtime-icons"
                    aria-label={`Active CLI types: ${roomCliPresentations.map((presentation) => presentation.shortLabel).join(", ")}`}
                  >
                    {roomCliPresentations.slice(0, MAX_ROOM_CLI_ICONS).map((presentation) => (
                      <img
                        key={presentation.id}
                        className="room-cli-runtime-icon"
                        src={presentation.iconSrc}
                        alt=""
                        aria-hidden="true"
                        title={presentation.shortLabel}
                        data-terminal-runtime-brand={presentation.brand}
                        draggable={false}
                      />
                    ))}
                    {roomCliPresentations.length > MAX_ROOM_CLI_ICONS ? (
                      <span className="room-cli-runtime-more" aria-hidden="true">+{roomCliPresentations.length - MAX_ROOM_CLI_ICONS}</span>
                    ) : null}
                  </span>
                ) : null}
                {isAdminMode && adminRoomFilterMode !== "mine" ? (
                  <span
                    className={`room-owner-badge${room.ownerUserId === auth?.user?.id ? " is-mine" : ""}`}
                    title={`Owner: ${room.ownerUserId ? userEmailById.get(room.ownerUserId) ?? room.ownerUserId : "System"}`}
                  >
                    {room.ownerUserId === auth?.user?.id
                      ? "You"
                      : (room.ownerUserId ? userEmailById.get(room.ownerUserId) ?? room.ownerUserId : "System")}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="room-cli-badge" title="Panes in this room">
              <LayoutGrid aria-hidden="true" />
              <span className="sr-only">Panes </span>
              {roomPaneCounts[room.id] ?? (isActive && roomPaneLoadStates[room.id] === "loaded"
                ? panes.filter((pane) => !pane.isClosed).length
                : roomRuntimes[room.id]?.panes.filter((pane) => !pane.isClosed).length ?? "—")}
            </span>
          </button>
          {room.sharePermission ? null : <button
            type="button"
            className="room-dock-expand-btn"
            aria-expanded={isExpanded}
            title={isExpanded ? "Close room settings" : "Room settings: project folder, worktrees, delete"}
            aria-label={isExpanded ? `Collapse ${room.name}` : `Configure project for ${room.name}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleRoomSettings(room);
            }}
          >
            <MoreHorizontal aria-hidden="true" />
          </button>}
        </div>
        {isExpanded && (
          <div className="room-dock-expansion" onClick={(e) => e.stopPropagation()}>
            <div className="room-dock-field-header">
              <span className="room-dock-field-title">
                <Folder aria-hidden="true" /> Project folder
              </span>
              {runtimeKind === "live" && auth?.isAuthenticated ? (
                <DockButton
                  tone="ghost"
                  icon={FolderOpen}
                  className="room-dock-choose-project-btn"
                  disabled={dockProjectSavingRoomId === room.id}
                  title="Choose a new project, local folder, Git URL or repository"
                  aria-label={`Choose project for ${room.name}`}
                  onClick={() => setProjectPickerRoom({ id: room.id, name: room.name })}
                >
                  Browse
                </DockButton>
              ) : null}
              {room.projectPath ? (
                <DockButton
                  tone="ghost"
                  icon={X}
                  className="room-dock-clear-btn"
                  disabled={dockProjectSavingRoomId === room.id}
                  title="Clear project directory"
                  aria-label="Clear project directory"
                  onClick={async () => {
                    setDockProjectSavingRoomId(room.id);
                    try {
                      const updated = await api.updateRoom(room.id, { name: room.name, projectPath: null });
                      setRooms((current) => current.map((r) => (r.id === room.id ? updated : r)));
                      setDockProjectPathDrafts((prev) => ({ ...prev, [room.id]: "" }));
                    } catch (err) {
                      setError(err instanceof Error ? `The project directory could not be cleared: ${err.message}` : "The project directory could not be cleared.");
                    } finally {
                      setDockProjectSavingRoomId(null);
                    }
                  }}
                >
                  Clear
                </DockButton>
              ) : null}
            </div>
            <div className="room-dock-input-row">
              <input
                type="text"
                className="room-dock-project-input dock-kit-field"
                aria-label={`Project folder of ${room.name}`}
                placeholder="e.g. /opt/spaceapp"
                value={dockProjectPathDrafts[room.id] ?? effectivePath}
                disabled={dockProjectSavingRoomId === room.id}
                onChange={(e) => {
                  const val = e.target.value;
                  setDockProjectPathDrafts((prev) => ({ ...prev, [room.id]: val }));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveDockProject(room.id);
                  }
                }}
              />
              <button
                type="button"
                className="room-dock-save-btn dock-kit-icon-button is-primary"
                disabled={dockProjectSavingRoomId === room.id}
                title="Save project directory"
                aria-label="Save project directory"
                onClick={() => void saveDockProject(room.id)}
              >
                <Save aria-hidden="true" />
              </button>
            </div>
            {roomProjectSources[room.id] && room.projectPath ? (
              <p className="room-dock-project-source" title={room.projectPath}>Source: {roomProjectSources[room.id]}</p>
            ) : null}
            <div className="room-dock-presets-row" role="group" aria-label="Project presets">
              {projectPresets.map((preset) => {
                const currentVal = dockProjectPathDrafts[room.id] ?? effectivePath;
                const isActivePreset = currentVal === preset.path || (preset.label === "olla" && currentVal === "/srv/olla");
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`room-dock-preset-chip${isActivePreset ? " active" : ""}`}
                    aria-pressed={isActivePreset}
                    title={preset.path}
                    onClick={async () => {
                      setDockProjectPathDrafts((prev) => ({ ...prev, [room.id]: preset.path }));
                      await ensureProjectFolder(preset.path);
                      try {
                        const updated = await api.updateRoom(room.id, { name: room.name, projectPath: preset.path });
                        setRooms((current) => current.map((r) => (r.id === room.id ? updated : r)));
                      } catch (err) {
                        setError(err instanceof Error ? `The project preset could not be saved: ${err.message}` : "The project preset could not be saved.");
                      }
                    }}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <button
                type="button"
                className="room-dock-preset-chip room-dock-preset-add-btn"
                title="Add a project preset"
                aria-label="Add a project preset"
                onClick={() => {
                  setIsAddingPresetRoomId(isAddingPresetRoomId === room.id ? null : room.id);
                  setNewPresetDraft("");
                }}
              >
                <Plus aria-hidden="true" /> New
              </button>
            </div>
            {isAddingPresetRoomId === room.id ? (
              <div className="room-dock-new-preset-box">
                <input
                  type="text"
                  className="room-dock-new-preset-input dock-kit-field"
                  aria-label="New preset name"
                  placeholder="preset name (e.g. space3)"
                  value={newPresetDraft}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^a-zA-Z0-9_-]/g, "");
                    setNewPresetDraft(cleaned);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddNewPreset(room.id);
                    } else if (e.key === "Escape") {
                      setIsAddingPresetRoomId(null);
                      setNewPresetDraft("");
                    }
                  }}
                  autoFocus
                />
                <DockButton
                  tone="primary"
                  className="room-dock-new-preset-confirm-btn"
                  disabled={!newPresetDraft.trim()}
                  onClick={() => void handleAddNewPreset(room.id)}
                >
                  Add & Create
                </DockButton>
                <DockButton
                  tone="ghost"
                  className="room-dock-new-preset-cancel-btn"
                  onClick={() => {
                    setIsAddingPresetRoomId(null);
                    setNewPresetDraft("");
                  }}
                >
                  Cancel
                </DockButton>
              </div>
            ) : null}
            <SpaceToggle
              className="room-dock-worktree-toggle"
              label={<span className="room-dock-worktree-label"><GitBranch aria-hidden="true" /> Isolated Git worktrees</span>}
              detail="New CLI panes in this room each get their own Git branch."
              checked={isRoomWorktreeEnabled(room.id)}
              onChange={(enabled) => setRoomWorktreeEnabled(room.id, enabled)}
            />
            {room.projectPath || dockProjectPathDrafts[room.id] ? (
              <div className="room-dock-actions-row">
                <DockButton
                  icon={FolderOpen}
                  className="room-dock-action-btn"
                  onClick={async () => {
                    await selectRoom(room.id);
                    const effective = room.projectPath || dockProjectPathDrafts[room.id];
                    if (effective) {
                      await ensureProjectFolder(effective);
                    }
                    const existingFiles = (room.id === selectedRoomId ? panes : roomRuntimes[room.id]?.panes ?? []).find((p) => !p.isClosed && p.mode === "FILES");
                    if (existingFiles) {
                      setSelectedPaneId(existingFiles.id);
                      if (effective) {
                        window.dispatchEvent(new CustomEvent("space:files:navigate", { detail: { path: effective } }));
                      }
                    } else {
                      await addFilesPane(1, room.id);
                    }
                  }}
                >
                  Open files
                </DockButton>
                <DockButton
                  icon={Terminal}
                  className="room-dock-action-btn"
                  onClick={async () => {
                    await selectRoom(room.id);
                    const effective = room.projectPath || dockProjectPathDrafts[room.id];
                    if (effective) {
                      await ensureProjectFolder(effective);
                    }
                    await addRootAdminPane(room.id);
                  }}
                >
                  Open terminal
                </DockButton>
              </div>
            ) : null}
            <RoomSharing roomId={room.id} />
            <DockButton
              tone="ghost"
              icon={Trash2}
              className="room-delete"
              onClick={() => void requestRoomDelete(room)}
              disabled={deletePendingRoomId === room.id || roomReorderPending}
              title={`Delete ${room.name}`}
              aria-label={`Delete ${room.name}`}
            >
              Delete room
            </DockButton>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="side-surface-panel side-surface-room-panel">
      <div className="rooms-controls">
        <div className="rooms-toolbar">
          <DockSearch className="rooms-search" name="room-search" label="Find a room" placeholder="Find a room…" value={roomSearch} onChange={setRoomSearch} />
          <DockButton
            tone="primary"
            icon={Plus}
            className="rooms-new"
            onClick={() => void createRoom()}
            disabled={roomCreationPending || rooms.length >= MAX_ROOMS}
            busy={roomCreationPending}
            title={rooms.length >= MAX_ROOMS ? `Maximum room limit (${MAX_ROOMS}) reached` : "Create empty room"}
          >
            New room
          </DockButton>
        </div>
        {isAdminMode ? (
          <div className="rooms-admin-account-filter">
            <DockChips
              className="rooms-filter"
              label="Filter rooms by account"
              options={adminRoomFilterOptions}
              value={adminRoomFilterMode}
              onChange={(mode) => {
                setAdminRoomFilterMode(mode);
                if (mode === "user" && !adminSelectedUserId && adminUsersList.length > 0) {
                  const otherUser = adminUsersList.find((u) => u.id !== auth?.user?.id) ?? adminUsersList[0];
                  if (otherUser) setAdminSelectedUserId(otherUser.id);
                }
              }}
            />
            {adminRoomFilterMode === "user" ? (
              <select
                className="rooms-account-select dock-kit-select"
                aria-label="Select account to view rooms"
                value={adminSelectedUserId}
                onChange={(e) => setAdminSelectedUserId(e.target.value)}
              >
                <option value="" disabled>Choose account…</option>
                {adminUsersListWithLiveCounts.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email || u.id} ({u.role}) — {u.roomCount ?? 0} {u.roomCount === 1 ? "room" : "rooms"}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : null}
        {isRoomListFiltered ? <div className="rooms-filter-summary"><span role="status">{filteredRoomEntries.length} of {rooms.length} rooms</span>
          <button type="button" onClick={() => { setRoomSearch(""); if (isAdminMode) setAdminRoomFilterMode("mine"); }}>Clear filters</button></div> : null}
      </div>
      <div className={`room-list${draggedRoomId ? " is-room-dragging" : ""}`}>
        {filteredRoomEntries.length === 0 ? <p className="rooms-empty" role="status">{rooms.length === 0 ? "Create a room to get started." : "No rooms match these filters."}</p> : null}
        {workspaceEntries.map(renderRoom)}
        {testEntries.length ? (
          <div className="room-group">
            <div className="room-group-header">
              <button
                type="button"
                className="room-group-toggle"
                aria-expanded={testRoomsShown}
                title="Agent Proof and CLI Recovery rooms"
                onClick={() => setTestRoomsOpen(!testRoomsShown)}
              >
                <ChevronRight aria-hidden="true" />
                <span>Test rooms</span>
                <span className="room-group-count">{testEntries.length}</span>
              </button>
              <DockButton
                tone="ghost"
                icon={Trash2}
                className="room-group-delete"
                onClick={() => void requestTestRoomsDelete(testEntries.map(({ room }) => room))}
                disabled={Boolean(deletePendingRoomId) || roomReorderPending}
                title={`Delete all ${testEntries.length} test rooms`}
              >
                Delete all
              </DockButton>
            </div>
            {/* Collapsed rooms stay mounted: proof scripts select them by data-room-id. */}
            <div className="room-group-items" hidden={!testRoomsShown}>
              {testEntries.map(renderRoom)}
            </div>
          </div>
        ) : null}
        <a
          className="spaceapp-download-banner"
          href="https://spaceapp.dev"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download SpaceApp from SpaceApp.dev"
        >
          <span className="spaceapp-download-card">
            <Rocket aria-hidden="true" />
            <span className="spaceapp-download-title"><strong>SpaceApp</strong> is open source (MIT)</span>
            <span>and <strong>free</strong> to self-host.</span>
          </span>
        </a>
      </div>
      {projectPickerRoom ? (
        <RecoverableSurface fallback={null}>
          <LazyProjectSourcePicker
            context={{ kind: "room", roomId: projectPickerRoom.id, roomName: projectPickerRoom.name }}
            isAdmin={auth?.user?.role === "ADMIN" || auth?.user?.role === "OPERATOR"}
            defaultParent="/opt/spaceapp/projects"
            onOpened={(result) => assignPickedProjectToRoom(projectPickerRoom.id, result)}
            onClose={() => setProjectPickerRoom(null)}
          />
        </RecoverableSurface>
      ) : null}
      {isViewOnlyRoom(presentationRoom) ? null : <div className="room-pane-composer-slot" inert={preparingRoomId ? true : undefined}>
        <RoomPaneComposer
          activePaneCount={presentationPanes.length}
          onApply={addRoomPanes}
          onOpenSettings={openSettingsSurface}
          room={presentationRoom}
          isWorktreeEnabled={presentationRoom ? isRoomWorktreeEnabled(presentationRoom.id) : false}
          defaultCollapsed={true}
        />
      </div>}
      {roomDeleteConfirmDialog}
    </div>
  );
}
