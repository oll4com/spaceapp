import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

export const RAIL_ORDER_KEY = 'space:room-rail-order:v1';
export const RAIL_IDS = ['previous', 'next', 'create', 'layout', 'keyboard', 'music', 'docks', 'tools', 'expand', 'more'];

export const UPPER_RAIL_ORDER_KEY = 'space:upper-rail-order:v1';
export const UPPER_RAIL_IDS = ['minimized-bar', 'accounts', 'codex-reset', 'cli', 'memory', 'cpu', 'rtt'];

export const LOWER_RAIL_ORDER_KEY = RAIL_ORDER_KEY;
export const LOWER_RAIL_IDS = RAIL_IDS;

export function normalizeRailOrder(value: unknown, allowedIds: string[] = RAIL_IDS): string[] {
  return [...new Set([...(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && allowedIds.includes(id)) : []), ...allowedIds])];
}
export function moveRailIcon(order: string[], from: string, to: string, after: boolean): string[] {
  if (from === to || !order.includes(from) || !order.includes(to)) return order;
  const next = order.filter(id => id !== from);
  next.splice(next.indexOf(to) + Number(after), 0, from);
  return next;
}

export type RailOrderOptions = {
  storageKey?: string;
  allowedIds?: string[];
  group?: string;
};

export function useRailOrder(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options?: RailOrderOptions,
) {
  const storageKey = options?.storageKey ?? RAIL_ORDER_KEY;
  const allowedIds = options?.allowedIds ?? RAIL_IDS;
  const group = options?.group ?? 'lower';

  const [order, setOrder] = useState(() => {
    try {
      return normalizeRailOrder(
        JSON.parse(getSpaceRuntime().platform.localStorage.getItem(storageKey) ?? 'null'),
        allowedIds,
      );
    } catch {
      return [...allowedIds];
    }
  });
  const dragged = useRef<string | null>(null);
  const suppressClickUntil = useRef(0);
  useLayoutEffect(() => {
    const rail = ref.current;
    if (!active || !rail) return;
    const icons = Array.from(rail.querySelectorAll<HTMLButtonElement>('button[data-rail-id]')).filter(
      (icon) => allowedIds.includes(icon.dataset.railId!),
    );
    for (const icon of icons) {
      icon.style.order = String(order.indexOf(icon.dataset.railId!));
      icon.draggable = true;
      icon.setAttribute('aria-description', 'Drag to reorder. Alt+ArrowUp or Alt+ArrowDown moves this icon.');
    }
    const iconAt = (target: EventTarget | null) => {
      const btn = target instanceof Element ? target.closest<HTMLButtonElement>('button[data-rail-id]') : null;
      return btn && allowedIds.includes(btn.dataset.railId!) ? btn : null;
    };
    const clear = () => icons.forEach(icon => icon.removeAttribute('data-drop-position'));
    const save = (next: string[]) => {
      setOrder(next);
      try { getSpaceRuntime().platform.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Session order still works. */ }
    };
    const start = (event: DragEvent) => {
      const icon = iconAt(event.target);
      if (!icon || !event.dataTransfer || !icon.dataset.railId) return;
      dragged.current = icon.dataset.railId;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragged.current);
      event.dataTransfer.setData('application/x-space-rail-group', group);
      icon.setAttribute('data-dragging', 'true');
    };
    const over = (event: DragEvent) => {
      const icon = iconAt(event.target);
      if (!dragged.current || !icon || !allowedIds.includes(dragged.current)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      clear();
      const rect = icon.getBoundingClientRect();
      icon.dataset.dropPosition = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
    };
    const end = () => {
      if (dragged.current) suppressClickUntil.current = Date.now() + 400;
      dragged.current = null;
      clear();
      icons.forEach(icon => icon.removeAttribute('data-dragging'));
    };
    const drop = (event: DragEvent) => {
      const icon = iconAt(event.target);
      if (!dragged.current || !icon || !allowedIds.includes(dragged.current)) return;
      event.preventDefault();
      event.stopPropagation();
      save(moveRailIcon(order, dragged.current, icon.dataset.railId!, icon.dataset.dropPosition === 'after'));
      end();
    };
    const click = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); }
    };
    const key = (event: KeyboardEvent) => {
      const icon = iconAt(event.target);
      if (!icon || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const visible = icons.filter(item => item.getClientRects().length > 0).sort((a, b) => order.indexOf(a.dataset.railId!) - order.indexOf(b.dataset.railId!));
      const target = visible[visible.indexOf(icon) + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) save(moveRailIcon(order, icon.dataset.railId!, target.dataset.railId!, event.key === 'ArrowDown'));
    };
    rail.addEventListener('dragstart', start); rail.addEventListener('dragover', over);
    rail.addEventListener('drop', drop); rail.addEventListener('dragend', end);
    rail.addEventListener('click', click, true); rail.addEventListener('keydown', key, true);
    return () => {
      rail.removeEventListener('dragstart', start); rail.removeEventListener('dragover', over);
      rail.removeEventListener('drop', drop); rail.removeEventListener('dragend', end);
      rail.removeEventListener('click', click, true); rail.removeEventListener('keydown', key, true);
      dragged.current = null;
    };
  }, [active, allowedIds, group, order, ref, storageKey]);
}
