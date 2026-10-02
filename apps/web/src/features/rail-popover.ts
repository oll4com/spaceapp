import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

export const RAIL_MENU_CHANGE_EVENT = "space:rail-menu:change";

export function dispatchRailMenuChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(RAIL_MENU_CHANGE_EVENT));
  }
}

export const RAIL_POPOVER_SELECTORS = [
  ".desktop-navigation-menu",
  ".toolbar-floating-menu",
  ".quick-links-popover",
  ".vibe-music-popover",
  ".osk-popover",
  ".workspace-text-size-picker",
  ".resources-drawer",
  ".health-resources",
  ".health-window",
  ".toolbar-metric-panel",
  ".theme-menu",
  ".room-theme-menu",
  ".server-actions-menu",
  ".desktop-action-manager",
  '[data-rail-popover="true"]',
  '[data-menu-dodge="true"]'
].join(", ");

/** Calculates how many pixels to the left a floating window needs to dodge an overlapping rail menu. */
export function calculateRailDodgeShift(
  winRect: { left: number; top: number; width: number; height: number },
  margin = 12
): number {
  if (typeof document === "undefined") return 0;

  const winLeft = winRect.left;
  const winTop = winRect.top;
  const winWidth = winRect.width || 290;
  const winHeight = winRect.height || 220;
  const winRight = winLeft + winWidth;
  const winBottom = winTop + winHeight;

  let maxShift = 0;
  const menuElements = document.querySelectorAll<HTMLElement>(RAIL_POPOVER_SELECTORS);

  for (let i = 0; i < menuElements.length; i++) {
    const el = menuElements[i];
    if (!el) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    // Check 2D bounding box overlap
    const isOverlappingY = winTop < rect.bottom && winBottom > rect.top;
    const isOverlappingX = winLeft < rect.right && winRight > rect.left;

    if (isOverlappingY && isOverlappingX) {
      const desiredShift = (winRight - rect.left) + margin;
      const maxAllowedShift = Math.max(0, winLeft - 16);
      const shift = Math.min(desiredShift, maxAllowedShift);
      if (shift > maxShift) {
        maxShift = shift;
      }
    }
  }

  return maxShift;
}

export interface UseRailMenuDodgeOptions {
  x: number;
  y: number;
  isDragging?: boolean;
  active?: boolean;
  margin?: number;
}

/** Hook that returns horizontal displacement (translateX) so a float window dodges any open rail menu. */
export function useRailMenuDodge(
  elementRef: RefObject<HTMLElement | null>,
  options: UseRailMenuDodgeOptions
): number {
  const { x, y, isDragging = false, active = true, margin = 12 } = options;
  const [shiftX, setShiftX] = useState(0);

  const check = useCallback(() => {
    if (!active || isDragging) {
      setShiftX(0);
      return;
    }
    const el = elementRef.current;
    const rect = el ? el.getBoundingClientRect() : null;
    const width = rect?.width || 290;
    const height = rect?.height || 220;

    const nextShift = calculateRailDodgeShift(
      { left: x, top: y, width, height },
      margin
    );
    setShiftX((prev) => (prev !== nextShift ? nextShift : prev));
  }, [x, y, isDragging, active, margin, elementRef]);

  useLayoutEffect(() => {
    if (!active) {
      setShiftX(0);
      return;
    }

    check();

    const onMenuChange = () => {
      check();
    };

    window.addEventListener(RAIL_MENU_CHANGE_EVENT, onMenuChange);
    window.addEventListener("space:navigation-open", onMenuChange);
    window.addEventListener("resize", onMenuChange);

    let pointerFrame: number | null = null;
    const onPointer = () => {
      if (pointerFrame !== null) return;
      if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        pointerFrame = window.requestAnimationFrame(() => {
          pointerFrame = null;
          check();
        });
      } else {
        check();
      }
    };
    window.addEventListener("pointerdown", onPointer, true);

    const bodyObserver = typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          check();
        })
      : null;

    if (bodyObserver && typeof document !== "undefined") {
      bodyObserver.observe(document.body, { childList: true, subtree: false });
    }

    return () => {
      if (pointerFrame !== null) {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(pointerFrame);
        }
      }
      window.removeEventListener(RAIL_MENU_CHANGE_EVENT, onMenuChange);
      window.removeEventListener("space:navigation-open", onMenuChange);
      window.removeEventListener("resize", onMenuChange);
      window.removeEventListener("pointerdown", onPointer, true);
      bodyObserver?.disconnect();
    };
  }, [check, active]);

  return active && !isDragging ? shiftX : 0;
}

/** Every rail popup shares the rail's left edge and bottom inset. */
export function railPopoverPosition(trigger: HTMLElement | null, width: number) {
  const rail = trigger?.closest<HTMLElement>(".room-toolbar-floating-controls")
    ?? (trigger?.closest(".desktop-navigation, .icon-overflow-menu, .server-actions-menu") ? document.querySelector<HTMLElement>(".room-toolbar-floating-controls") : null)
    ?? (document.querySelector<HTMLElement>(".room-toolbar-floating-controls")?.offsetParent ? document.querySelector<HTMLElement>(".room-toolbar-floating-controls") : null)
    ?? document.querySelector<HTMLElement>(".room-toolbar-floating-controls");
  if (!rail) return null;
  const rect = rail.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const viewport = window.visualViewport;
  const top = (viewport?.offsetTop ?? 0) + 8;
  const bottom = Math.min(rect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8);
  return { left: Math.max(8, rect.left - width - 8), bottom: Math.max(8, window.innerHeight - bottom), maxHeight: Math.max(100, bottom - top) };
}

export function useRailPopover(panel: RefObject<HTMLElement | null>, trigger?: RefObject<HTMLButtonElement | null> | null, active = true) {
  useLayoutEffect(() => {
    const node = panel.current;
    if (!active || !node) return;
    const update = () => {
      const position = railPopoverPosition(trigger?.current ?? null, node.getBoundingClientRect().width);
      if (position) {
        Object.assign(node.style, { position: "fixed", top: "auto", right: "auto", left: `${position.left}px`, bottom: `${position.bottom}px`, maxHeight: `${position.maxHeight}px` });
        dispatchRailMenuChange();
      }
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    if (trigger?.current) observer?.observe(trigger.current);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      dispatchRailMenuChange();
    };
  }, [panel, trigger, active]);
}

const wheelMenuStack: HTMLElement[] = [];

/** Wheel selects visibly; Enter/click performs the action. */
export function useMenuWheel(panel: RefObject<HTMLElement | null>, selector: string, active = true, trigger?: RefObject<HTMLElement | null>, anywhere = false) {
  useEffect(() => {
    const node = panel.current;
    if (!active || !node) return;
    let last = -Infinity;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(item => !item.hasAttribute("disabled") && item.getClientRects().length > 0);
    const mark = (item?: HTMLElement) => {
      node.querySelectorAll('[data-wheel-selected]').forEach(previous => previous.removeAttribute('data-wheel-selected'));
      item?.setAttribute('data-wheel-selected', 'true');
    };
    if (anywhere) {
      wheelMenuStack.push(node);
      const options = items();
      mark(options.find(item => item.getAttribute('aria-checked') === 'true') ?? options[0]);
    }
    const focused = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(selector)) mark(event.target);
    };
    const wheel = (event: WheelEvent) => {
      if (anywhere && wheelMenuStack.filter(menu => menu.isConnected).at(-1) !== node) return;
      if (event.ctrlKey || event.altKey || !event.deltaY || event.target instanceof Element && event.target.closest('select, input[type="range"], [role="slider"], [role="spinbutton"], .cli-launcher-count-stepper')) return;
      const options = items();
      if (!options.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.timeStamp - last < 100) return;
      last = event.timeStamp;
      const focusedIndex = options.indexOf(document.activeElement as HTMLElement);
      const current = focusedIndex >= 0 ? focusedIndex : options.findIndex(item => item.dataset.wheelSelected === 'true');
      const next = current < 0 ? (event.deltaY > 0 ? 0 : options.length - 1) : Math.max(0, Math.min(options.length - 1, current + Math.sign(event.deltaY)));
      mark(options[next]);
      options[next]?.focus({ preventScroll: true });
      options[next]?.scrollIntoView({ block: "nearest" });
    };
    let lastAuxTrigger = 0;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 1) {
        if (anywhere && wheelMenuStack.filter(menu => menu.isConnected).at(-1) !== node) return;
        event.preventDefault();
      }
    };
    const triggerSelected = (event: MouseEvent) => {
      if (event.button !== 1) return;
      if (anywhere && wheelMenuStack.filter(menu => menu.isConnected).at(-1) !== node) return;
      if (Date.now() - lastAuxTrigger < 250) return;
      lastAuxTrigger = Date.now();
      event.preventDefault();
      event.stopPropagation();
      const options = items();
      if (!options.length) return;
      const clicked = event.target instanceof Element && node.contains(event.target)
        ? (event.target.closest<HTMLElement>(selector) ?? event.target.closest<HTMLElement>('button:not(:disabled)'))
        : null;
      const selected = clicked ??
        node.querySelector<HTMLElement>('[data-wheel-selected="true"]') ??
        (document.activeElement instanceof HTMLElement && node.contains(document.activeElement) ? (document.activeElement.closest<HTMLElement>(selector) ?? (document.activeElement as HTMLElement)) : null) ??
        options[0];
      if (selected && !selected.hasAttribute("disabled")) {
        selected.click();
      }
    };
    const button = trigger?.current;
    const target = anywhere ? document : node;
    target.addEventListener("wheel", wheel as EventListener, { passive: false, capture: anywhere });
    target.addEventListener("mousedown", onMouseDown as EventListener, { capture: anywhere });
    target.addEventListener("mouseup", triggerSelected as EventListener, { capture: anywhere });
    target.addEventListener("auxclick", triggerSelected as EventListener, { capture: anywhere });
    if (!anywhere) {
      button?.addEventListener("wheel", wheel, { passive: false });
      button?.addEventListener("mousedown", onMouseDown as EventListener);
      button?.addEventListener("mouseup", triggerSelected as EventListener);
      button?.addEventListener("auxclick", triggerSelected as EventListener);
    }
    node.addEventListener('focusin', focused);
    return () => {
      target.removeEventListener("wheel", wheel as EventListener, { capture: anywhere });
      target.removeEventListener("mousedown", onMouseDown as EventListener, { capture: anywhere });
      target.removeEventListener("mouseup", triggerSelected as EventListener, { capture: anywhere });
      target.removeEventListener("auxclick", triggerSelected as EventListener, { capture: anywhere });
      if (!anywhere) {
        button?.removeEventListener("wheel", wheel);
        button?.removeEventListener("mousedown", onMouseDown as EventListener);
        button?.removeEventListener("mouseup", triggerSelected as EventListener);
        button?.removeEventListener("auxclick", triggerSelected as EventListener);
      }
      node.removeEventListener('focusin', focused);
      const index = wheelMenuStack.indexOf(node);
      if (index >= 0) wheelMenuStack.splice(index, 1);
      mark();
    };
  }, [panel, selector, active, trigger, anywhere]);
}
