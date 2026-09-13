import { useEffect, useLayoutEffect, type RefObject } from "react";

/** Every rail popup shares the rail's left edge and bottom inset. */
export function railPopoverPosition(trigger: HTMLElement | null, width: number) {
  const rail = trigger?.closest<HTMLElement>(".room-toolbar-floating-controls");
  if (!rail) return null;
  const rect = rail.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = (viewport?.offsetTop ?? 0) + 8;
  const bottom = Math.min(rect.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8);
  return { left: Math.max(8, rect.left - width - 8), bottom: Math.max(8, window.innerHeight - bottom), maxHeight: Math.max(100, bottom - top) };
}

export function useRailPopover(panel: RefObject<HTMLElement | null>, trigger: RefObject<HTMLButtonElement | null>) {
  useLayoutEffect(() => {
    const node = panel.current;
    if (!node) return;
    const update = () => {
      const position = railPopoverPosition(trigger.current, node.getBoundingClientRect().width);
      if (position) Object.assign(node.style, { position: "fixed", top: "auto", right: "auto", left: `${position.left}px`, bottom: `${position.bottom}px`, maxHeight: `${position.maxHeight}px` });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    if (trigger.current) observer?.observe(trigger.current);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [panel, trigger]);
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
      if (event.ctrlKey || event.altKey || !event.deltaY || event.target instanceof Element && event.target.closest('select, input[type="range"], [role="slider"]')) return;
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
