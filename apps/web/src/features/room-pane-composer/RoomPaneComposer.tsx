import {
  PANE_TYPES,
  isAgentRuntimeReady,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type CreateRoomPanesRequest,
  type Room
} from "@space/contracts";
import {
  ArrowLeft,
  ChevronUp,
  Grid3X3,
  Loader2,
  MessageSquare,
  Minus,
  Plus,
  RefreshCw,
  X,
  type LucideIcon
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import {
  CLI_RUNTIME_PRESENTATIONS,
  HARNESS_MAINTENANCE_PRESENTATION
} from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";

const runtimeDefinitions = CLI_RUNTIME_PRESENTATIONS;
export const ROOM_PANE_COMPOSER_COLLAPSED_KEY = "space.roomPaneComposer.collapsed.v1";
const harnessId = "harness" as const;
const utilityDefinitions = PANE_TYPES.filter(
  (type): type is Extract<(typeof PANE_TYPES)[number], { mode: "CHAT" }> => type.typeId === "chat"
);
type UtilityTypeId = typeof utilityDefinitions[number]["typeId"];
const utilityIcons: Record<UtilityTypeId, LucideIcon> = {
  chat: MessageSquare
};
type ComposerRuntimeId = (typeof runtimeDefinitions)[number]["id"] | typeof harnessId | UtilityTypeId;
type PaneCounts = Record<ComposerRuntimeId, number>;

const emptyCounts = (): PaneCounts => Object.fromEntries([
  ...runtimeDefinitions.map(type => [type.id, 0]),
  [harnessId, 0],
  ...utilityDefinitions.map(type => [type.typeId, 0])
]) as PaneCounts;

function runtimeError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "CLI runtime availability could not be loaded.";
}

function loadDefaultRuntimes(): Promise<AgentRuntimeRegistry> {
  return api.cliRuntimes();
}

export interface RoomPaneComposerProps {
  activePaneCount: number;
  loadRuntimes?: () => Promise<AgentRuntimeRegistry>;
  onApply: (roomId: string, input: CreateRoomPanesRequest) => Promise<void>;
  onOpenSettings?: () => void;
  room: Room | null;
  isWorktreeEnabled?: boolean;
  defaultCollapsed?: boolean;
}

export function RoomPaneComposer({
  activePaneCount,
  loadRuntimes = loadDefaultRuntimes,
  onApply,
  onOpenSettings,
  room,
  isWorktreeEnabled = false,
  defaultCollapsed
}: RoomPaneComposerProps) {
  const requestSequenceRef = useRef(0);
  const [initialRuntimeSnapshot] = useState(() => api.cliRuntimesSnapshot());
  const runtimeSnapshotAvailableRef = useRef(initialRuntimeSnapshot !== null);
  const [counts, setCounts] = useState<PaneCounts>(emptyCounts);
  const [isHarnessEnabled, setIsHarnessEnabled] = useState(
    () => api.cliRuntimeSettingsSnapshot?.()?.harness?.enabled ?? true
  );
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>(
    () => (initialRuntimeSnapshot?.data ?? [])
      .filter((runtime) => runtime.id !== "cli:root" && runtime.capabilities.includes("CLI"))
  );
  const [loading, setLoading] = useState(initialRuntimeSnapshot === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    if (defaultCollapsed !== undefined) return defaultCollapsed;
    try { return getSpaceRuntime().platform.localStorage.getItem(ROOM_PANE_COMPOSER_COLLAPSED_KEY) !== "false"; }
    catch { return true; }
  });
  const availableSlots = Math.min(16, Math.max(0, (room?.paneCap ?? 0) - activePaneCount));
  const assigned = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const slotsAfterAdd = Math.max(0, availableSlots - assigned);

  useAutoDismiss(loadError, setLoadError);
  useAutoDismiss(applyError, setApplyError);
  useAutoDismiss(notice, setNotice);

  const previousRoomIdRef = useRef(room?.id);
  useEffect(() => {
    setApplyError(null);
    setNotice(null);
    if (previousRoomIdRef.current !== room?.id) {
      previousRoomIdRef.current = room?.id;
      if (defaultCollapsed !== undefined) {
        setCollapsed(defaultCollapsed);
        setCounts(emptyCounts());
      }
    }
  }, [room?.id, defaultCollapsed]);

  const refreshRuntimes = useCallback(async () => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    if (!runtimeSnapshotAvailableRef.current) setLoading(true);
    setLoadError(null);
    try {
      const registry = await loadRuntimes();
      if (requestSequenceRef.current !== sequence) return;
      const nextRuntimes = registry.data.filter((runtime) => runtime.id !== "cli:root" && runtime.capabilities.includes("CLI"));
      const nextRuntimeIds = new Set(nextRuntimes.map((runtime) => runtime.id));
      runtimeSnapshotAvailableRef.current = true;
      setRuntimes(nextRuntimes);
      setCounts((current) => Object.fromEntries(
        Object.entries(current).map(([id, count]) => [
          id,
          id === harnessId || utilityDefinitions.some(type => type.typeId === id) || nextRuntimeIds.has(id) ? count : 0
        ])
      ) as PaneCounts);
    } catch (error) {
      if (requestSequenceRef.current !== sequence) return;
      if (!runtimeSnapshotAvailableRef.current) {
        setRuntimes([]);
        setLoadError(runtimeError(error));
      }
    } finally {
      if (requestSequenceRef.current === sequence) setLoading(false);
    }
  }, [loadRuntimes]);

  useEffect(() => {
    void refreshRuntimes();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [refreshRuntimes]);

  const refreshHarness = useCallback(async () => {
    try {
      const settings = await api.cliRuntimeSettings();
      const enabled = settings.harness?.enabled ?? true;
      setIsHarnessEnabled(enabled);
      if (!enabled) {
        setCounts((current) => (current.harness === 0 ? current : { ...current, harness: 0 }));
      }
    } catch {
      // Keep the last known harness visibility when settings cannot be loaded.
    }
  }, []);

  useEffect(() => {
    void refreshHarness();
  }, [refreshHarness]);

  useEffect(() => {
    const handleVisibilityChange = (event: Event) => {
      const change = readCliRuntimeVisibilityChange(event);
      if (!change) return;
      api.invalidateCliRuntimes(change);
      api.invalidateCliRuntimeSettings?.();
      if (change.enabled === false && !change.runtimeId) {
        setCounts((current) => ({ ...current, harness: 0 }));
      }
      if (change.runtimeId && change.enabled === false) {
        setRuntimes((current) => current.filter((runtime) => runtime.id !== change.runtimeId));
        setCounts((current) => ({ ...current, [change.runtimeId!]: 0 }));
      }
      void refreshRuntimes();
      void refreshHarness();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [refreshRuntimes, refreshHarness]);

  const runtimeById = useMemo(() => new Map(runtimes.map((runtime) => [runtime.id, runtime])), [runtimes]);
  const visibleRuntimeDefinitions = useMemo(
    () => runtimeDefinitions.filter(({ id }) => runtimeById.has(id)),
    [runtimeById]
  );
  const selectedRuntimeUnavailable = runtimeDefinitions.some(({ id }) => {
    if (counts[id] === 0) return false;
    const runtime = runtimeById.get(id);
    return loading || !runtime || !isAgentRuntimeReady(runtime);
  });
  const canApply = Boolean(
    room &&
    !applying &&
    assigned > 0 &&
    assigned <= availableSlots &&
    !selectedRuntimeUnavailable
  );

  function adjustCount(id: ComposerRuntimeId, delta: -1 | 1) {
    setApplyError(null);
    setNotice(null);
    setCounts((current) => {
      const currentAssigned = Object.values(current).reduce((sum, count) => sum + count, 0);
      if (delta > 0 && currentAssigned >= availableSlots) return current;
      return { ...current, [id]: Math.max(0, current[id] + delta) };
    });
  }

  function fillRoomWithType(id: ComposerRuntimeId) {
    setApplyError(null);
    setNotice(null);
    setCounts((current) => {
      if (availableSlots <= 0) return current;
      return Object.fromEntries(
        Object.entries(current).map(([key]) => [key, key === id ? availableSlots : 0])
      ) as PaneCounts;
    });
  }

  function clearAllCounts() {
    setApplyError(null);
    setNotice(null);
    setCounts(emptyCounts());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room || !canApply) return;
    const targetRoom = room;
    const panes: CreateRoomPanesRequest["panes"] = [];
    for (const { id } of runtimeDefinitions) {
      for (let index = 0; index < counts[id]; index += 1) {
        panes.push({
          mode: "TERMINAL",
          terminalRuntimeId: id,
          ...(isWorktreeEnabled ? { useWorktree: true } : {})
        });
      }
    }
    for (let index = 0; index < counts.harness; index += 1) panes.push({ mode: "HARNESS" });
    for (const type of utilityDefinitions) {
      for (let index = 0; index < counts[type.typeId]; index += 1) panes.push({ mode: type.mode });
    }

    setApplying(true);
    setApplyError(null);
    setNotice(null);
    try {
      await onApply(targetRoom.id, { panes });
      setCounts(emptyCounts());
      setNotice(`Added ${panes.length} ${panes.length === 1 ? "pane" : "panes"} to ${targetRoom.name}.`);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "The pane batch could not be added.");
    } finally {
      setApplying(false);
    }
  }

  let applyLabel = "Select a room first";
  if (room && assigned === 0) {
    applyLabel = "Choose panes to add";
  } else if (assigned > 0) {
    applyLabel = `Add ${assigned} ${assigned === 1 ? "pane" : "panes"}`;
  }

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    // Like the CLI launcher on open: a list kept since mount can miss runtimes enabled meanwhile.
    if (!next) void refreshRuntimes();
    if (defaultCollapsed === undefined) {
      try {
        getSpaceRuntime().platform.localStorage.setItem(ROOM_PANE_COMPOSER_COLLAPSED_KEY, String(next));
      } catch {
        /* Keep usable */
      }
    }
  };

  const renderRow = (id: ComposerRuntimeId, label: string, icon: ReactNode, available = true, reason?: string) => {
    const reasonId = `room-pane-runtime-reason-${id.replace(/[^a-z0-9]+/gi, "-")}`;
    return (
      <div className={`room-pane-mix-row${available ? "" : " is-unavailable"}${counts[id] > 0 ? " is-selected" : ""}`} key={id}>
        <div className="room-pane-runtime-label">
          {icon}
          <span>{label}</span>
          {!available ? <small id={reasonId} title={reason}>{reason}</small> : null}
        </div>
        <div className="room-pane-controls" aria-describedby={!available ? reasonId : undefined}>
          <button
            type="button"
            className="room-pane-quick-action"
            aria-label={`Fill all with ${label}`}
            title={`Fill the room with ${label} panes`}
            onClick={() => fillRoomWithType(id)}
            disabled={applying || !available || availableSlots === 0}
          >
            <Grid3X3 aria-hidden="true" />
          </button>
          <div className="room-pane-counter">
            <button
              type="button"
              aria-label={`Decrease ${label} panes`}
              onClick={() => adjustCount(id, -1)}
              disabled={applying || counts[id] === 0}
            >
              <Minus aria-hidden="true" />
            </button>
            <output aria-label={`${label} pane count`}>{counts[id]}</output>
            <button
              type="button"
              aria-label={`Increase ${label} panes`}
              onClick={() => adjustCount(id, 1)}
              disabled={applying || !available || assigned >= availableSlots}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <form
      className="room-pane-composer"
      data-collapsed={collapsed ? "true" : "false"}
      onSubmit={submit}
      aria-labelledby="room-pane-composer-title"
    >
      <button
        type="button"
        className="room-pane-composer-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? "Choose CLI and other panes to add to this room" : "Back to rooms"}
        onClick={toggleCollapsed}
      >
        {collapsed ? <Plus aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
        <strong id="room-pane-composer-title">{room ? `Add panes to ${room.name}` : "Add panes"}</strong>
        {room ? <small className="room-pane-composer-free" aria-live="polite">{slotsAfterAdd} free</small> : null}
        {collapsed ? <ChevronUp className="room-pane-composer-chevron" aria-hidden="true" /> : null}
      </button>

      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            className="room-pane-composer-body"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="room-pane-mix" aria-label="Pane mix">
              {visibleRuntimeDefinitions.map(({ brand, iconSrc, id, shortLabel: label }) => {
                const runtime = runtimeById.get(id);
                const available = !loading && !loadError && Boolean(runtime && isAgentRuntimeReady(runtime));
                const reason = loading
                  ? "Checking availability…"
                  : loadError
                    ? "Availability could not be checked."
                    : runtime?.statusReason || `${label} is not available on this host.`;
                return renderRow(id, label, <img src={iconSrc} alt="" aria-hidden="true" data-terminal-runtime-brand={brand} draggable={false} />, available, reason);
              })}
              {!loading && !loadError && visibleRuntimeDefinitions.length === 0 ? (
                <div className="room-pane-runtime-empty" role="status">
                  <span>All CLI runtimes are disabled. Other pane types are listed below.</span>
                  {onOpenSettings ? <button type="button" onClick={onOpenSettings}>Open Settings</button> : null}
                </div>
              ) : null}
              {isHarnessEnabled ? renderRow(
                harnessId,
                HARNESS_MAINTENANCE_PRESENTATION.shortLabel,
                <img
                  src={HARNESS_MAINTENANCE_PRESENTATION.iconSrc}
                  alt=""
                  aria-hidden="true"
                  data-terminal-runtime-brand={HARNESS_MAINTENANCE_PRESENTATION.brand}
                  draggable={false}
                />
              ) : null}
              {utilityDefinitions.map(type => {
                const Icon = utilityIcons[type.typeId];
                return renderRow(type.typeId, type.label, Icon ? <Icon className="room-pane-utility-icon" aria-hidden="true" data-pane-utility-icon={type.typeId} /> : null);
              })}
            </div>
            <div className="room-pane-composer-footer">
              {loading ? <p className="room-pane-runtime-state" role="status"><Loader2 className="spin" aria-hidden="true" />Loading CLI runtimes…</p> : null}
              {loadError ? (
                <div className="room-pane-runtime-error" role="alert">
                  <span>{loadError}</span>
                  <button type="button" onClick={() => void refreshRuntimes()} disabled={loading} aria-label="Retry CLI runtimes">
                    <RefreshCw aria-hidden="true" /> Retry
                  </button>
                  <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setLoadError(null)}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {room && (availableSlots === 0 || assigned > availableSlots) ? (
                <p className="room-pane-capacity-warning">
                  {availableSlots === 0
                    ? "This room has no available pane slots."
                    : `This room has only ${availableSlots} available pane ${availableSlots === 1 ? "slot" : "slots"}.`}
                </p>
              ) : null}
              {applyError ? (
                <div className="room-pane-apply-message is-error">
                  <span role="alert">{applyError}</span>
                  <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setApplyError(null)}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              {notice ? (
                <div className="room-pane-apply-message">
                  <span role="status">{notice}</span>
                  <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>
                    <X aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <div className="room-pane-composer-actions">
                <button
                  type="button"
                  className="room-pane-clear-all"
                  title="Clear all pane selections"
                  onClick={clearAllCounts}
                  disabled={applying || assigned === 0}
                >
                  Clear all
                </button>
                <button type="submit" className="room-pane-apply" disabled={!canApply}>
                  {applying ? <Loader2 className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                  {applyLabel}
                </button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </form>
  );
}
