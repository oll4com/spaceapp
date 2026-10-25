import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

type ContextTarget = { target: HTMLElement; x: number; y: number };
type ActivePress = ContextTarget & { pointerId: number; opened: boolean; timer: number };

/** Lets touch use an existing desktop context menu without intercepting scroll or mouse input. */
export function useTouchContextMenu(
  findTarget: (source: EventTarget | null) => HTMLElement | null,
  openMenu: (context: ContextTarget) => void
) {
  const targetRef = useRef(findTarget);
  const openRef = useRef(openMenu);
  const activeRef = useRef<ActivePress | null>(null);
  const suppressTargetRef = useRef<HTMLElement | null>(null);
  const suppressTimerRef = useRef<number | null>(null);
  targetRef.current = findTarget;
  openRef.current = openMenu;

  useEffect(() => () => {
    if (activeRef.current) window.clearTimeout(activeRef.current.timer);
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
  }, []);

  const dismissTimer = () => {
    if (!activeRef.current) return;
    window.clearTimeout(activeRef.current.timer);
    if (!activeRef.current.opened) activeRef.current = null;
  };
  const suppressNextClick = (target: HTMLElement) => {
    suppressTargetRef.current = target;
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    suppressTimerRef.current = window.setTimeout(() => {
      suppressTargetRef.current = null;
      suppressTimerRef.current = null;
    }, 1200);
  };

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const target = targetRef.current(event.target);
      if (!target || target.matches(":disabled, [aria-disabled='true']")) return;
      if (activeRef.current) window.clearTimeout(activeRef.current.timer);
      const press: ActivePress = {
        target,
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        opened: false,
        timer: 0
      };
      press.timer = window.setTimeout(() => {
        if (activeRef.current !== press) return;
        press.opened = true;
        openRef.current({ target: press.target, x: press.x, y: press.y });
        suppressNextClick(press.target);
      }, 500);
      activeRef.current = press;
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const press = activeRef.current;
      if (!press || press.pointerId !== event.pointerId || press.opened) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) dismissTimer();
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      const press = activeRef.current;
      if (press && press.pointerId === event.pointerId && !press.opened) dismissTimer();
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const press = activeRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      window.clearTimeout(press.timer);
      if (press.opened) suppressNextClick(press.target);
      activeRef.current = null;
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (activeRef.current?.pointerId !== event.pointerId) return;
      window.clearTimeout(activeRef.current.timer);
      activeRef.current = null;
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      const target = suppressTargetRef.current;
      if (!target || !(event.target instanceof Node) || !target.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      suppressTargetRef.current = null;
    },
    onContextMenuCapture: (event: MouseEvent<HTMLElement>) => {
      const press = activeRef.current;
      if (!press || !(event.target instanceof Node) || !press.target.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      window.clearTimeout(press.timer);
      if (press.opened) {
        suppressNextClick(press.target);
      }
    }
  };
}
