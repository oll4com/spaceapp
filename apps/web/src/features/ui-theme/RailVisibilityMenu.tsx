import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { RailVisibilityItem } from "./use-rail-visibility.js";
import { dispatchRailMenuChange } from "../rail-popover.js";

export type RailVisibilityMenuProps = {
  items: RailVisibilityItem[];
  hiddenIds: string[];
  label: string;
  x: number;
  y: number;
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onHide: (id: string) => void;
  onShow: (id: string) => void;
  onShowAll: () => void;
};

export function RailVisibilityMenu({
  items,
  hiddenIds,
  label,
  x,
  y,
  anchorRef,
  onClose,
  onHide,
  onShow,
  onShowAll,
}: RailVisibilityMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const hiddenSet = new Set(hiddenIds);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight?: number;
    ready: boolean;
  }>({ left: x, top: y, ready: false });
  const menuItems = items.filter((item) => item.hideable !== false);
  const hasHidden = menuItems.some((item) => hiddenSet.has(item.id));

  useEffect(() => {
    dispatchRailMenuChange();
    return () => {
      dispatchRailMenuChange();
    };
  }, []);

  useLayoutEffect(() => {
    function updatePosition() {
      const menu = menuRef.current;
      if (!menu) return;
      const margin = 8;
      const width = menu.offsetWidth || 220;
      const section = menu.querySelector<HTMLElement>(".icon-action-manager-section");
      const sectionHeight = section ? (section.offsetHeight || section.scrollHeight) : 0;
      const contentHeight = Math.max(menu.scrollHeight, menu.offsetHeight, sectionHeight + 16, 240);
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 600;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 800;
      const maxViewportHeight = Math.max(120, viewportHeight - margin * 2);
      const boundedHeight = Math.min(contentHeight, maxViewportHeight);

      let left: number;
      let top: number;

      const railSelector = label === "Resource icons"
        ? ".health-indicator-rail"
        : ".room-toolbar-collapsed, .room-toolbar-floating-controls";
      const rail = anchorRef?.current ?? document.querySelector<HTMLElement>(railSelector);
      const railRect = rail?.getBoundingClientRect();

      if (railRect && railRect.width > 0 && railRect.height > 0) {
        left = Math.max(margin, Math.min(railRect.left - width - 8, viewportWidth - width - margin));
        const maxTop = Math.max(margin, viewportHeight - boundedHeight - margin);
        top = Math.max(margin, Math.min(railRect.top, maxTop));
      } else {
        const opensFromRightRail = x > viewportWidth / 2;
        const preferredLeft = opensFromRightRail ? x - width - 8 : x + 8;
        left = Math.max(margin, Math.min(preferredLeft, viewportWidth - width - margin));

        const maxTop = Math.max(margin, viewportHeight - boundedHeight - margin);
        top = Math.max(margin, Math.min(y, maxTop));
      }

      const maxHeight = Math.max(120, viewportHeight - top - margin);

      setPosition({ left, top, maxHeight, ready: true });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [x, y, items.length, hiddenIds.length, hasHidden]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      first?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (event.button === 1) return;
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (event.button === 2) {
        const railSelector = label === "Resource icons"
          ? ".health-indicator-rail"
          : ".room-toolbar-collapsed, .room-toolbar-floating-controls";
        if (anchorRef?.current?.contains(target) || (target instanceof Element && target.closest(railSelector))) {
          return;
        }
      }
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const menu = menuRef.current;
      if (!menu) return;
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      event.preventDefault();
      const activeIndex = buttons.findIndex((item) => item === document.activeElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowUp"
            ? activeIndex <= 0 ? buttons.length - 1 : activeIndex - 1
            : activeIndex < 0 || activeIndex === buttons.length - 1 ? 0 : activeIndex + 1;
      buttons[nextIndex]?.focus();
      buttons[nextIndex]?.scrollIntoView({ block: "nearest" });
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, anchorRef, label]);

  return createPortal(
    <div
      ref={menuRef}
      data-rail-popover="true"
      className="icon-overflow-menu icon-action-manager icon-context-menu rail-visibility-menu"
      role="menu"
      aria-label={label}
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        maxHeight: position.maxHeight ? `${position.maxHeight}px` : undefined,
        visibility: position.ready ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="icon-action-manager-section" role="group" aria-label={label}>
        <span className="icon-action-manager-section-label">{label}</span>
        {menuItems.map((item) => {
          const shown = !hiddenSet.has(item.id);
          const canHide = item.hideable !== false;
          const stateLabel = shown ? (canHide ? "Hide" : "Shown") : "Show";
          return (
            <button
              key={item.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={shown}
              aria-label={`${stateLabel} ${item.label}`}
              disabled={shown && !canHide}
              onClick={() => (shown ? onHide(item.id) : onShow(item.id))}
            >
              <span>{item.label}</span>
              <span className="icon-action-manager-state">{stateLabel}</span>
            </button>
          );
        })}
        {hasHidden ? (
          <button type="button" role="menuitem" aria-label="Show all hidden icons" onClick={onShowAll}>
          <span>Show all hidden icons</span>
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
