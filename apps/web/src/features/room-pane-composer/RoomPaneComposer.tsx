import {
  isAgentRuntimeReady,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type CreateRoomPanesRequest,
  type Room
} from "@space/contracts";
import { ChevronRight, Loader2, Minus, Plus, RefreshCw, X } from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../api.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { CLI_RUNTIME_PRESENTATIONS } from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";

const runtimeDefinitions = CLI_RUNTIME_PRESENTATIONS;
const chatId = "chat" as const;
type ComposerRuntimeId = (typeof runtimeDefinitions)[number]["id"] | typeof chatId;
type PaneCounts = Record<ComposerRuntimeId, number>;

const emptyCounts = (): PaneCounts => ({
  "cli:codex": 0,
  "cli:claude": 0,
  "cli:gemini": 0,
  "cli:opencode": 0,
  "cli:autohand": 0,
  "cli:qwen": 0,
  "cli:kimi": 0,
  "cli:grok": 0,
  "cli:deepseek": 0,
  "cli:cursor": 0,
  "cli:copilot": 0,
  chat: 0
});

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
}

export function RoomPaneComposer({
  activePaneCount,
  loadRuntimes = loadDefaultRuntimes,
  onApply,
  onOpenSettings,
  room
}: RoomPaneComposerProps) {
  const requestSequenceRef = useRef(0);
  const [initialRuntimeSnapshot] = useState(() => api.cliRuntimesSnapshot());
  const runtimeSnapshotAvailableRef = useRef(initialRuntimeSnapshot !== null);
  const [counts, setCounts] = useState<PaneCounts>(emptyCounts);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>(
    () => (initialRuntimeSnapshot?.data ?? [])
      .filter((runtime) => runtime.id !== "cli:root" && runtime.capabilities.includes("CLI"))
  );
  const [loading, setLoading] = useState(initialRuntimeSnapshot === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const availableSlots = Math.max(0, (room?.paneCap ?? 0) - activePaneCount);
  const assigned = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const slotsAfterAdd = Math.max(0, availableSlots - assigned);

  useAutoDismiss(loadError, setLoadError);
  useAutoDismiss(applyError, setApplyError);
  useAutoDismiss(notice, setNotice);

  useEffect(() => {
    setApplyError(null);
    setNotice(null);
  }, [room?.id]);

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
        Object.entries(current).map(([id, count]) => [id, id === chatId || nextRuntimeIds.has(id) ? count : 0])
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

  useEffect(() => {
    const handleVisibilityChange = (event: Event) => {
      const change = readCliRuntimeVisibilityChange(event);
      if (!change) return;
      api.invalidateCliRuntimes();
      if (change.runtimeId && change.enabled === false) {
        setRuntimes((current) => current.filter((runtime) => runtime.id !== change.runtimeId));
        setCounts((current) => ({ ...current, [change.runtimeId!]: 0 }));
      }
      void refreshRuntimes();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [refreshRuntimes]);

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room || !canApply) return;
    const targetRoom = room;
    const panes: CreateRoomPanesRequest["panes"] = [];
    for (const { id } of runtimeDefinitions) {
      for (let index = 0; index < counts[id]; index += 1) {
        panes.push({ mode: "TERMINAL", terminalRuntimeId: id });
      }
    }
    for (let index = 0; index < counts.chat; index += 1) panes.push({ mode: "CHAT" });

    setApplying(true);
    setApplyError(null);
    setNotice(null);
    try {
      await onApply(targetRoom.id, { panes });
      setNotice(`Added ${panes.length} ${panes.length === 1 ? "pane" : "panes"} to ${targetRoom.name}.`);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "The pane batch could not be added.");
    } finally {
      setApplying(false);
    }
  }

  let applyLabel = "Select a room and panes";
  if (room && assigned === 0) {
    applyLabel = `Select panes to add to ${room.name}`;
  } else if (assigned > 0) {
    applyLabel = `Add ${assigned} ${assigned === 1 ? "pane" : "panes"}${room ? ` to ${room.name}` : ""}`;
  }

  return (
    <form
      className="room-pane-composer"
      data-collapsed={collapsed ? "true" : "false"}
      onSubmit={submit}
      aria-labelledby="room-pane-composer-title"
    >
      <div className="room-pane-composer-heading">
        <div>
          <strong id="room-pane-composer-title">Add panes</strong>
          <small>{room ? `Pane target: ${room.name}` : "Select a room target"}</small>
        </div>
        <button
          type="button"
          className="room-pane-composer-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand Add panes" : "Collapse Add panes"}
          title={collapsed ? "Expand Add panes" : "Collapse Add panes"}
          onClick={() => setCollapsed((current) => !current)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>

      {!collapsed ? <div className="room-pane-mix" aria-label="Pane mix">
        {visibleRuntimeDefinitions.map(({ brand, iconSrc, id, shortLabel: label }) => {
          const runtime = runtimeById.get(id);
          const available = !loading && !loadError && Boolean(runtime && isAgentRuntimeReady(runtime));
          const reasonId = `room-pane-runtime-reason-${id.replace(/[^a-z0-9]+/gi, "-")}`;
          const reason = loading
            ? "Checking availability…"
            : loadError
              ? "Availability could not be checked."
              : runtime?.statusReason || `${label} is not available on this host.`;
          return (
            <div className={`room-pane-mix-row${available ? "" : " is-unavailable"}`} key={id}>
              <div className="room-pane-runtime-label">
                <img src={iconSrc} alt="" aria-hidden="true" data-terminal-runtime-brand={brand} draggable={false} />
                <span>{label}</span>
                {!available ? <small id={reasonId}>{reason}</small> : null}
              </div>
              <div className="room-pane-counter" aria-describedby={!available ? reasonId : undefined}>
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
          );
        })}
        {!loading && !loadError && visibleRuntimeDefinitions.length === 0 ? (
          <div className="room-pane-runtime-empty" role="status">
            <span>All CLI runtimes are disabled. Chat remains available.</span>
            {onOpenSettings ? <button type="button" onClick={onOpenSettings}>Open Settings</button> : null}
          </div>
        ) : null}
        <div className="room-pane-mix-row">
          <div className="room-pane-runtime-label"><span>Chat</span></div>
          <div className="room-pane-counter">
            <button type="button" aria-label="Decrease Chat panes" onClick={() => adjustCount(chatId, -1)} disabled={applying || counts.chat === 0}>
              <Minus aria-hidden="true" />
            </button>
            <output aria-label="Chat pane count">{counts.chat}</output>
            <button type="button" aria-label="Increase Chat panes" onClick={() => adjustCount(chatId, 1)} disabled={applying || assigned >= availableSlots}>
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
      </div> : null}

      {!collapsed && loading ? <p className="room-pane-runtime-state" role="status"><Loader2 className="spin" aria-hidden="true" />Loading CLI runtimes…</p> : null}
      {!collapsed && loadError ? (
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

      {!collapsed ? <p className="room-pane-assignment" aria-live="polite">
        {assigned === 0 ? (
          <><strong>0</strong> panes selected · <strong>{availableSlots}</strong> {availableSlots === 1 ? "room slot" : "room slots"} available</>
        ) : (
          <><strong>{assigned}</strong> {assigned === 1 ? "pane" : "panes"} selected · <strong>{slotsAfterAdd}</strong> {slotsAfterAdd === 1 ? "slot" : "slots"} left after add</>
        )}
      </p> : null}
      {!collapsed && room && (availableSlots === 0 || assigned > availableSlots) ? (
        <p className="room-pane-capacity-warning">
          {availableSlots === 0
            ? "This room has no available pane slots."
            : `This room has only ${availableSlots} available pane ${availableSlots === 1 ? "slot" : "slots"}.`}
        </p>
      ) : null}
      {!collapsed && applyError ? (
        <div className="room-pane-apply-message is-error">
          <span role="alert">{applyError}</span>
          <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setApplyError(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {!collapsed && notice ? (
        <div className="room-pane-apply-message">
          <span role="status">{notice}</span>
          <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {!collapsed ? <button type="submit" className="room-pane-apply" disabled={!canApply}>
        {applying ? <Loader2 className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
        {applyLabel}
      </button> : null}
    </form>
  );
}
