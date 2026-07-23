import { createPortal } from "react-dom";
import { X, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

export const SERVER_ACTIONS_MENU_ID = "server-actions-popup";

export interface ServerActionCommand {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
}

interface ServerActionsMenuProps {
  actions: ServerActionCommand[];
  mobile: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const FALLBACK_WIDTH = 336;
const FALLBACK_HEIGHT = 272;

function enabledButtons(container: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

export function ServerActionsMenu({ actions, mobile, onClose, triggerRef }: ServerActionsMenuProps) {
  const popupRef = useRef<HTMLElement | null>(null);
  const closeIntentRef = useRef<"dismissal" | "activation">("dismissal");
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, ready: false });

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
        ready: true,
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [mobile, triggerRef]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => enabledButtons(popupRef.current)[0]?.focus());
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (closeIntentRef.current === "dismissal") triggerRef.current?.focus();
    };
  }, [triggerRef]);

  useEffect(() => {
    if (mobile) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeIntentRef.current = "dismissal";
      onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [mobile, onClose, triggerRef]);

  function dismiss() {
    closeIntentRef.current = "dismissal";
    onClose();
  }

  function runAction(action: ServerActionCommand) {
    closeIntentRef.current = "activation";
    onClose();
    window.requestAnimationFrame(action.onSelect);
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
      if (!first || !last) return;
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

  const actionButtons = actions.map((action) => {
    const ActionIcon = action.icon;
    return (
      <button
        key={action.id}
        type="button"
        role={mobile ? undefined : "menuitem"}
        className={mobile ? "mobile-action-sheet-main" : undefined}
        aria-label={action.label}
        disabled={action.disabled}
        onClick={() => runAction(action)}
      >
        <ActionIcon aria-hidden="true" />
        <span>
          <strong>{action.label}</strong>
          <small>{action.description}</small>
        </span>
      </button>
    );
  });

  if (mobile) {
    return createPortal(
      <div className="mobile-action-sheet-backdrop" onClick={dismiss}>
        <section
          ref={popupRef}
          id={SERVER_ACTIONS_MENU_ID}
          className="mobile-action-sheet server-actions-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Server actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <header>
            <strong>Server actions</strong>
            <button type="button" className="mobile-action-sheet-close" aria-label="Close Server actions" onClick={dismiss}>
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="mobile-action-sheet-list">
            <div className="mobile-action-sheet-section server-actions-sheet-list">{actionButtons}</div>
          </div>
        </section>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <section
      ref={popupRef}
      id={SERVER_ACTIONS_MENU_ID}
      className="icon-overflow-menu server-actions-menu"
      role="menu"
      aria-label="Server actions"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onKeyDown={handleKeyDown}
    >
      <span className="server-actions-menu-label">Server actions</span>
      {actionButtons}
    </section>,
    document.body,
  );
}
