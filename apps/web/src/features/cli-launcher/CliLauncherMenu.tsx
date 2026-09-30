import { canStartAgentRuntimeLogin, type AgentRuntime, type AgentRuntimeRegistry } from "@space/contracts";
import { GripVertical, Loader2, Minus, Plus, RefreshCw, Terminal, X } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";
import { api } from "../../api.js";
import {
  cliRuntimePresentation,
  compareCliRuntimes,
  isCliRuntimeTerminalLaunchable
} from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";
import { CLI_LAUNCHER_MENU_ID } from "../toolbar-menu-ids.js";
export { CLI_LAUNCHER_MENU_ID } from "../toolbar-menu-ids.js";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const FALLBACK_WIDTH = 360;
const FALLBACK_HEIGHT = 360;

export function selectCliLauncherRuntimes(runtimes: AgentRuntime[]): AgentRuntime[] {
  return runtimes
    .filter((runtime) => runtime.id !== "cli:root" && runtime.capabilities.includes("CLI"))
    .sort(compareCliRuntimes);
}

interface CliLauncherMenuProps {
  embedded?: boolean;
  query?: string;
  atPaneCap?: boolean;
  isCodexEnabled?: boolean;
  loadRuntimes?: () => Promise<AgentRuntimeRegistry>;
  mobile: boolean;
  onClose: () => void;
  onCreate: (runtime: AgentRuntime, count?: number) => Promise<void>;
  onLogin: (runtime: AgentRuntime) => Promise<void>;
  onOpenSettings?: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  refreshOnOpen?: boolean;
  paneCount?: number;
  onPaneCountChange?: (count: number | ((prev: number) => number)) => void;
}

function enabledButtons(container: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function loadDefaultCliRuntimes(): Promise<AgentRuntimeRegistry> {
  return api.cliRuntimes();
}

export function CliLauncherMenu({
  embedded = false,
  query = "",
  atPaneCap = false,
  isCodexEnabled = true,
  loadRuntimes = loadDefaultCliRuntimes,
  mobile,
  onClose,
  onCreate,
  onLogin,
  onOpenSettings,
  triggerRef,
  refreshOnOpen,
  paneCount,
  onPaneCountChange
}: CliLauncherMenuProps) {
  const shouldRefreshOnOpen = refreshOnOpen ?? !embedded;
  const popupRef = useRef<HTMLElement | null>(null);
  const closeIntentRef = useRef<"dismissal" | "activation">("dismissal");
  const requestSequenceRef = useRef(0);
  const [internalCount, setInternalCount] = useState(1);
  const currentCount = paneCount ?? internalCount;
  const setCount = onPaneCountChange ?? setInternalCount;
  const stepperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = stepperRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) {
        setCount((c) => Math.min(6, (typeof c === "number" ? c : 1) + 1));
      } else if (e.deltaY > 0) {
        setCount((c) => Math.max(1, (typeof c === "number" ? c : 1) - 1));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [setCount]);

  const [initialRuntimeSnapshot] = useState(() => api.cliRuntimesSnapshot());
  const runtimeSnapshotAvailableRef = useRef(initialRuntimeSnapshot !== null);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>(
    () => selectCliLauncherRuntimes(initialRuntimeSnapshot?.data ?? [])
  );
  const [loading, setLoading] = useState(initialRuntimeSnapshot === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);
  const [creatingRuntimeId, setCreatingRuntimeId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"CREATE" | "LOGIN" | null>(null);
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, ready: false });
  const CLI_LAUNCHER_ORDER_KEY = "space:create-menu-cli-order";
  const [cliOrder, setCliOrder] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = window.localStorage.getItem(CLI_LAUNCHER_ORDER_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  });
  const [draggedRuntimeId, setDraggedRuntimeId] = useState<string | null>(null);
  const [dragOverRuntimeId, setDragOverRuntimeId] = useState<string | null>(null);
  const isDraggingCliRef = useRef(false);

  const refreshRuntimes = useCallback(async () => {
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    if (!runtimeSnapshotAvailableRef.current) setLoading(true);
    setLoadError(null);
    try {
      const registry = await loadRuntimes();
      if (requestSequenceRef.current !== requestSequence) return;
      runtimeSnapshotAvailableRef.current = true;
      setRuntimes(selectCliLauncherRuntimes(registry.data));
    } catch (error) {
      if (requestSequenceRef.current !== requestSequence) return;
      if (!runtimeSnapshotAvailableRef.current) {
        setRuntimes([]);
        setLoadError(errorMessage(error, "CLI runtimes could not be loaded."));
      }
    } finally {
      if (requestSequenceRef.current === requestSequence) setLoading(false);
    }
  }, [loadRuntimes]);

  useEffect(() => {
    if (!shouldRefreshOnOpen && runtimeSnapshotAvailableRef.current && runtimes.length > 0) {
      return;
    }
    void refreshRuntimes();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [shouldRefreshOnOpen, refreshRuntimes]);

  useEffect(() => {
    const handleVisibilityChange = (event: Event) => {
      const change = readCliRuntimeVisibilityChange(event);
      if (!change) return;
      api.invalidateCliRuntimes(change);
      if (change.runtimeId && change.enabled === false) {
        setRuntimes((current) => current.filter((runtime) => runtime.id !== change.runtimeId));
      }
      void refreshRuntimes();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [refreshRuntimes]);

  useLayoutEffect(() => {
    if (mobile || embedded) return;

    function updatePosition() {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (!trigger || !popup) return;
      const triggerRect = trigger.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const width = popupRect.width || FALLBACK_WIDTH;
      const height = popupRect.height || FALLBACK_HEIGHT;
      const fitsBelow = triggerRect.bottom + ANCHOR_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
      const desiredTop = fitsBelow
        ? triggerRect.bottom + ANCHOR_GAP
        : triggerRect.top - ANCHOR_GAP - height;
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, Math.min(triggerRect.left, window.innerWidth - width - VIEWPORT_MARGIN)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(desiredTop, window.innerHeight - height - VIEWPORT_MARGIN)),
        ready: true
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [embedded, loadError, loading, mobile, runtimes.length, triggerRef]);

  useEffect(() => {
    if (embedded) return;
    const focusFrame = window.requestAnimationFrame(() => {
      const popup = popupRef.current;
      const firstRuntime = popup?.querySelector<HTMLButtonElement>(".cli-launcher-option:not(:disabled)");
      const retry = popup?.querySelector<HTMLButtonElement>(".cli-launcher-retry:not(:disabled)");
      const settings = popup?.querySelector<HTMLButtonElement>(".cli-launcher-settings-link:not(:disabled)");
      const close = popup?.querySelector<HTMLButtonElement>(".mobile-action-sheet-close:not(:disabled)");
      (firstRuntime ?? retry ?? settings ?? close ?? popup)?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [embedded, loadError, loading, runtimes.length]);

  useEffect(() => {
    return () => {
      if (!embedded && closeIntentRef.current === "dismissal" && triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [embedded, triggerRef]);

  useEffect(() => {
    if (mobile || embedded) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (creatingRuntimeId || isDraggingCliRef.current) return;
      closeIntentRef.current = "dismissal";
      onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [creatingRuntimeId, embedded, mobile, onClose, triggerRef]);

  function dismiss() {
    if (creatingRuntimeId) return;
    closeIntentRef.current = "dismissal";
    onClose();
  }

  function openSettings() {
    if (!onOpenSettings || creatingRuntimeId) return;
    closeIntentRef.current = "activation";
    onClose();
    onOpenSettings();
  }

  async function createRuntime(runtime: AgentRuntime) {
    const authAction = canStartAgentRuntimeLogin(runtime);
    if (
      isDraggingCliRef.current
      || creatingRuntimeId
      || (runtime.id === "cli:codex" && !isCodexEnabled)
      || (!authAction && !isCliRuntimeTerminalLaunchable(runtime))
    ) return;
    setCreatingRuntimeId(runtime.id);
    setPendingAction(authAction ? "LOGIN" : "CREATE");
    setCreationError(null);
    try {
      await (authAction ? onLogin(runtime) : currentCount > 1 ? onCreate(runtime, currentCount) : onCreate(runtime));
      setCreatingRuntimeId(null);
      setPendingAction(null);
      setCount(1);
      closeIntentRef.current = "activation";
      onClose();
    } catch (error) {
      setCreationError(errorMessage(error, authAction
        ? `${runtime.displayName} ${runtime.authState === "SETUP_REQUIRED" ? "setup" : "login"} could not be opened.`
        : `${runtime.displayName} pane could not be created.`));
      setCreatingRuntimeId(null);
      setPendingAction(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }

    const buttons = enabledButtons(popupRef.current);
    if (mobile && event.key === "Tab") {
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || !popupRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !popupRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (mobile || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !buttons.length) return;
    event.preventDefault();
    const activeIndex = buttons.findIndex((button) => button === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1
          : activeIndex < 0 || activeIndex === buttons.length - 1 ? 0 : activeIndex + 1;
    buttons[nextIndex]?.focus();
  }

  const orderedRuntimes = useMemo(() => {
    const matching = runtimes.filter(
      (runtime) =>
        !query.trim() ||
        `${runtime.displayName} CLI terminal ${runtime.statusReason}`.toLowerCase().includes(query.trim().toLowerCase())
    );
    if (!cliOrder.length || query.trim()) return matching;
    return [...matching].sort((a, b) => {
      const ai = cliOrder.indexOf(a.id);
      const bi = cliOrder.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    });
  }, [runtimes, query, cliOrder]);

  const dragOverRuntimeIdRef = useRef<string | null>(null);

  const handleRuntimePointerDown = (event: React.PointerEvent<HTMLElement>, runtimeId: string) => {
    if (event.button !== 0 || creatingRuntimeId || query.trim()) return;

    const isHandle = (event.target as HTMLElement)?.closest(".cli-launcher-drag-handle") !== null;
    if ((event.pointerType === "touch" || mobile) && !isHandle) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dragStarted = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const isTouch = moveEvent.pointerType === "touch" || event.pointerType === "touch";
      if (isTouch && !isHandle) return;
      const dist = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!dragStarted && (isHandle ? (isTouch ? dist > 8 : dist > 2) : dist > 6)) {
        dragStarted = true;
        isDraggingCliRef.current = true;
        setDraggedRuntimeId(runtimeId);
      }

      if (dragStarted) {
        moveEvent.preventDefault();
        const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
        const targetOption = element?.closest<HTMLElement>(".cli-launcher-option");
        const targetId = targetOption?.dataset.runtimeId;
        if (targetId && targetId !== runtimeId) {
          dragOverRuntimeIdRef.current = targetId;
          setDragOverRuntimeId(targetId);
        } else {
          dragOverRuntimeIdRef.current = null;
          setDragOverRuntimeId(null);
        }
      }
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp, { capture: true });
      window.removeEventListener("pointercancel", onPointerUp, { capture: true });

      if (dragStarted) {
        upEvent.preventDefault();
        upEvent.stopPropagation();
        const targetId = dragOverRuntimeIdRef.current;
        if (targetId && targetId !== runtimeId) {
          const currentOrder = orderedRuntimes.map((r) => r.id);
          const sourceIndex = currentOrder.indexOf(runtimeId);
          const targetIndex = currentOrder.indexOf(targetId);
          if (sourceIndex !== -1 && targetIndex !== -1) {
            const nextOrder = [...currentOrder];
            nextOrder.splice(sourceIndex, 1);
            nextOrder.splice(targetIndex, 0, runtimeId);
            setCliOrder(nextOrder);
            try {
              window.localStorage.setItem(CLI_LAUNCHER_ORDER_KEY, JSON.stringify(nextOrder));
            } catch {}
          }
        }
        dragOverRuntimeIdRef.current = null;
        setDraggedRuntimeId(null);
        setDragOverRuntimeId(null);
        window.setTimeout(() => {
          isDraggingCliRef.current = false;
        }, 120);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { capture: true });
    window.addEventListener("pointercancel", onPointerUp, { capture: true });
  };

  const content = loading ? (
    <p className="cli-launcher-state" role="status" aria-live="polite">
      <Loader2 className="cli-launcher-spinner" aria-hidden="true" />
      Loading CLI runtimes…
    </p>
  ) : loadError ? (
    <div className="cli-launcher-error" role="alert">
      <p>{loadError}</p>
      <button type="button" className="cli-launcher-retry" aria-label="Retry CLI runtimes" onClick={() => void refreshRuntimes()}>
        <RefreshCw aria-hidden="true" />
        Retry
      </button>
    </div>
  ) : runtimes.length === 0 ? (
    <div className="cli-launcher-empty" role="status">
      <p className="cli-launcher-state">All CLI runtimes are disabled.</p>
      {onOpenSettings ? (
        <button type="button" className="cli-launcher-settings-link" onClick={openSettings}>
          Open Settings
        </button>
      ) : null}
    </div>
  ) : (
    <div className="cli-launcher-options">
      {orderedRuntimes.map((runtime) => {
        const presentation = cliRuntimePresentation(runtime.id);
        const isCreating = creatingRuntimeId === runtime.id;
        const launchable = isCliRuntimeTerminalLaunchable(runtime);
        const authAction = canStartAgentRuntimeLogin(runtime);
        const codexBlocked = runtime.id === "cli:codex" && !isCodexEnabled;
        const paneCapBlocked = atPaneCap && !authAction;
        const unavailable = codexBlocked || paneCapBlocked || (!launchable && !authAction);
        const statusLabel = codexBlocked
          ? "OFF"
          : paneCapBlocked
          ? "Full"
          : runtime.authState === "READY"
          ? null
          : runtime.authState === "LOGIN_REQUIRED"
            ? "Login"
            : runtime.authState === "SETUP_REQUIRED"
              ? "Setup"
              : runtime.adapterStatus === "ERROR"
                ? "Error"
                : runtime.adapterStatus === "DISABLED"
                  ? "Disabled"
                  : "Unavailable";
        const statusReasonId = `cli-launcher-runtime-${runtime.id.replace(/[^a-z0-9_-]+/gi, "-")}-reason`;
        const statusReason = codexBlocked
          ? "Enable Codex in Settings"
          : paneCapBlocked
          ? "This room already has the maximum of 16 panes. Login retry remains available for an existing login pane."
          : runtime.statusReason;
        const isCliDraggable = !query.trim() && !creatingRuntimeId;
        const isDragging = draggedRuntimeId === runtime.id;
        const isDragOver = dragOverRuntimeId === runtime.id;
        return (
          <button
            key={runtime.id}
            type="button"
            role={mobile || embedded ? undefined : "menuitem"}
            className={`cli-launcher-option${isDragging ? " is-dragging" : ""}${isDragOver ? " is-drag-over" : ""}`}
            data-runtime-id={runtime.id}
            aria-label={`${authAction ? runtime.authState === "SETUP_REQUIRED" ? "Setup" : "Login" : "Add"} ${runtime.displayName}`}
            aria-describedby={statusReasonId}
            disabled={Boolean(creatingRuntimeId) || unavailable}
            title={codexBlocked ? "Enable Codex in Settings" : undefined}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            onPointerDown={isCliDraggable ? (e) => handleRuntimePointerDown(e, runtime.id) : undefined}
            onClick={() => {
              if (isDraggingCliRef.current) return;
              void createRuntime(runtime);
            }}
          >
            {presentation ? (
              <img
                src={presentation.iconSrc}
                alt=""
                aria-hidden="true"
                data-terminal-runtime-brand={presentation.brand}
                draggable={false}
              />
            ) : (
              <Terminal aria-hidden="true" />
            )}
            <span className="cli-launcher-option-copy">
              <strong>{runtime.displayName}</strong>
              <small id={statusReasonId}>{statusReason}</small>
            </span>
            <span className="cli-launcher-trailing">
              {isCreating ? (
                <span className={runtime.authState === "READY" ? "cli-launcher-status" : "cli-launcher-status is-unavailable"}>
                  {pendingAction === "LOGIN" ? "Opening…" : "Creating…"}
                </span>
              ) : statusLabel ? (
                <span className="cli-launcher-status is-unavailable">
                  {statusLabel}
                </span>
              ) : null}
              {isCliDraggable ? (
                <GripVertical className="cli-launcher-drag-handle" aria-hidden="true" />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );

  const creatingRuntime = runtimes.find((runtime) => runtime.id === creatingRuntimeId);
  const pendingAuthLabel = creatingRuntime?.authState === "SETUP_REQUIRED" ? " setup" : " login";
  const feedback = (
    <>
      {creatingRuntimeId ? (
        <p className="cli-launcher-pending" role="status" aria-live="polite">
          <Loader2 className="cli-launcher-spinner" aria-hidden="true" />
          {pendingAction === "LOGIN" ? "Opening" : "Creating"} {creatingRuntime?.displayName ?? "CLI pane"}{pendingAction === "LOGIN" ? pendingAuthLabel : ""}…
        </p>
      ) : null}
      {creationError ? <p className="cli-launcher-error-message" role="alert">{creationError}</p> : null}
    </>
  );

  if (embedded) {
    return (
      <section ref={popupRef} className="cli-launcher-embedded" aria-label="CLI tools" aria-busy={Boolean(creatingRuntimeId)}>
        <div className="cli-launcher-embedded-header">
          <h3 className="desktop-menu-section-label">CLI tools</h3>
          <div
            ref={stepperRef}
            className="cli-launcher-count-stepper"
            role="spinbutton"
            aria-valuenow={currentCount}
            aria-valuemin={1}
            aria-valuemax={6}
            aria-label="Panes count to open"
          >
            <button
              type="button"
              className="cli-count-btn cli-count-btn-minus"
              aria-label="Decrease pane count"
              title="Decrease pane count"
              disabled={currentCount <= 1 || Boolean(creatingRuntimeId)}
              onClick={(e) => {
                e.stopPropagation();
                setCount((c) => Math.max(1, (typeof c === "number" ? c : 1) - 1));
              }}
            >
              <Minus aria-hidden="true" />
            </button>
            <span
              className="cli-count-value"
              title="Panes to open (1-6, scroll wheel to adjust)"
            >
              {currentCount}
            </span>
            <button
              type="button"
              className="cli-count-btn cli-count-btn-plus"
              aria-label="Increase pane count"
              title="Increase pane count"
              disabled={currentCount >= 6 || Boolean(creatingRuntimeId)}
              onClick={(e) => {
                e.stopPropagation();
                setCount((c) => Math.min(6, (typeof c === "number" ? c : 1) + 1));
              }}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
        {content}{feedback}
      </section>
    );
  }

  if (mobile) {
    return createPortal(
      <div className="mobile-action-sheet-backdrop cli-launcher-backdrop" onClick={dismiss}>
        <section
          ref={popupRef}
          id={CLI_LAUNCHER_MENU_ID}
          className="mobile-action-sheet cli-launcher-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Add CLI pane"
          aria-busy={Boolean(creatingRuntimeId)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <header>
            <strong>Add CLI pane</strong>
            <button
              type="button"
              className="mobile-action-sheet-close"
              aria-label="Close Add CLI pane"
              disabled={Boolean(creatingRuntimeId)}
              onClick={dismiss}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="mobile-action-sheet-list cli-launcher-sheet-list">
            {content}
            {feedback}
          </div>
        </section>
      </div>,
      document.body
    );
  }

  return createPortal(
    <section
      ref={popupRef}
      id={CLI_LAUNCHER_MENU_ID}
      className="icon-overflow-menu cli-launcher-menu"
      role="menu"
      aria-label="Add CLI pane"
      aria-busy={Boolean(creatingRuntimeId)}
      tabIndex={-1}
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        visibility: position.ready ? "visible" : "hidden"
      }}
      onKeyDown={handleKeyDown}
    >
      <span className="cli-launcher-label">Choose CLI runtime</span>
      {content}
      {feedback}
    </section>,
    document.body
  );
}
