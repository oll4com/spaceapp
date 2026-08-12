import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { MoreHorizontal, type LucideIcon } from "../ui-theme/app-icons.js";
import "./flat-settings.css";

export interface SettingsActionMenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;

function readPortalTheme(trigger: HTMLButtonElement | null) {
  const source = trigger?.closest<HTMLElement>("[data-room-theme], [data-ui-theme]");
  const body = document.body;
  return {
    uiTheme: source?.dataset.uiTheme ?? body.dataset.uiTheme,
    colorMode: source?.dataset.colorMode ?? body.dataset.colorMode,
    roomTheme: source?.dataset.roomTheme ?? body.dataset.roomTheme
  };
}

function enabledItems(container: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
}

export function SettingsActionMenu({
  actions,
  disabled = false,
  label
}: {
  actions: SettingsActionMenuItem[];
  disabled?: boolean;
  label: string;
}) {
  const popupId = `settings-actions-${useId().replaceAll(":", "")}`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, ready: false });

  useLayoutEffect(() => {
    if (!open) return;
    function updatePosition() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const width = menuRect.width;
      const height = menuRect.height;
      const fitsBelow = triggerRect.bottom + MENU_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
      const desiredTop = fitsBelow
        ? triggerRect.bottom + MENU_GAP
        : triggerRect.top - MENU_GAP - height;
      setPosition({
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(triggerRect.right - width, window.innerWidth - width - VIEWPORT_MARGIN)
        ),
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
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => enabledItems(menuRef.current)[0]?.focus());
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    };
  }, [open]);

  if (!actions.length) return null;

  function closeAndRestoreFocus() {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = enabledItems(menuRef.current);
    if (!items.length) return;
    event.preventDefault();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? activeIndex <= 0 ? items.length - 1 : activeIndex - 1
          : activeIndex < 0 || activeIndex === items.length - 1 ? 0 : activeIndex + 1;
    items[nextIndex]?.focus();
  }

  const portalTheme = open ? readPortalTheme(triggerRef.current) : null;

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-action settings-action-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          id={popupId}
          className="settings-action-menu"
          data-ui-theme={portalTheme?.uiTheme}
          data-color-mode={portalTheme?.colorMode}
          data-room-theme={portalTheme?.roomTheme}
          role="menu"
          aria-label={label}
          style={{
            left: `${position.left}px`,
            top: `${position.top}px`,
            visibility: position.ready ? "visible" : "hidden"
          }}
          onKeyDown={handleMenuKeyDown}
        >
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                className={action.danger ? "is-danger" : undefined}
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
              >
                <Icon aria-hidden="true" />
                <span>{action.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      ) : null}
    </>
  );
}
