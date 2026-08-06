import { canStartAgentRuntimeLogin, type AgentRuntime, type AgentRuntimeRegistry } from "@space/contracts";
import { Loader2, RefreshCw, Terminal, X } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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

export const CLI_LAUNCHER_MENU_ID = "cli-launcher-menu";

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
  atPaneCap?: boolean;
  isCodexEnabled?: boolean;
  loadRuntimes?: () => Promise<AgentRuntimeRegistry>;
  mobile: boolean;
  onClose: () => void;
  onCreate: (runtime: AgentRuntime) => Promise<void>;
  onLogin: (runtime: AgentRuntime) => Promise<void>;
  onOpenSettings?: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
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
  atPaneCap = false,
  isCodexEnabled = true,
  loadRuntimes = loadDefaultCliRuntimes,
  mobile,
  onClose,
  onCreate,
  onLogin,
  onOpenSettings,
  triggerRef
}: CliLauncherMenuProps) {
  const popupRef = useRef<HTMLElement | null>(null);
  const closeIntentRef = useRef<"dismissal" | "activation">("dismissal");
  const requestSequenceRef = useRef(0);
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
      }
      void refreshRuntimes();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [refreshRuntimes]);

  useLayoutEffect(() => {
    if (mobile) return;

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
  }, [loadError, loading, mobile, runtimes.length, triggerRef]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      const popup = popupRef.current;
      const firstRuntime = popup?.querySelector<HTMLButtonElement>(".cli-launcher-option:not(:disabled)");
      const retry = popup?.querySelector<HTMLButtonElement>(".cli-launcher-retry:not(:disabled)");
      const settings = popup?.querySelector<HTMLButtonElement>(".cli-launcher-settings-link:not(:disabled)");
      const close = popup?.querySelector<HTMLButtonElement>(".mobile-action-sheet-close:not(:disabled)");
      (firstRuntime ?? retry ?? settings ?? close ?? popup)?.focus();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [loadError, loading, runtimes.length]);

  useEffect(() => {
    return () => {
      if (closeIntentRef.current === "dismissal" && triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
    };
  }, [triggerRef]);

  useEffect(() => {
    if (mobile) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      if (creatingRuntimeId) return;
      closeIntentRef.current = "dismissal";
      onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [creatingRuntimeId, mobile, onClose, triggerRef]);

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
      creatingRuntimeId
      || (runtime.id === "cli:codex" && !isCodexEnabled)
      || (!authAction && !isCliRuntimeTerminalLaunchable(runtime))
    ) return;
    setCreatingRuntimeId(runtime.id);
    setPendingAction(authAction ? "LOGIN" : "CREATE");
    setCreationError(null);
    try {
      await (authAction ? onLogin(runtime) : onCreate(runtime));
      setCreatingRuntimeId(null);
      setPendingAction(null);
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
      {runtimes.map((runtime) => {
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
          ? "Available"
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
        return (
          <button
            key={runtime.id}
            type="button"
            role={mobile ? undefined : "menuitem"}
            className="cli-launcher-option"
            data-runtime-id={runtime.id}
            aria-label={`${authAction ? runtime.authState === "SETUP_REQUIRED" ? "Setup" : "Login" : "Add"} ${runtime.displayName}`}
            aria-describedby={statusReasonId}
            disabled={Boolean(creatingRuntimeId) || unavailable}
            title={codexBlocked ? "Enable Codex in Settings" : undefined}
            onClick={() => void createRuntime(runtime)}
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
            <span className={runtime.authState === "READY" ? "cli-launcher-status" : "cli-launcher-status is-unavailable"}>
              {isCreating ? pendingAction === "LOGIN" ? "Opening…" : "Creating…" : statusLabel}
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
