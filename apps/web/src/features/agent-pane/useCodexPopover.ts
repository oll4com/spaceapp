import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const menuItemSelector = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function enabledMenuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(menuItemSelector)).filter(
    (item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true"
  );
}

export function useCodexPopover(open: boolean, onOpenChange: (open: boolean) => void): {
  triggerRef: RefObject<HTMLButtonElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  close: (returnFocus?: boolean) => void;
  onMenuKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(
    (returnFocus = true) => {
      onOpenChange(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [onOpenChange]
  );

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (activeElement && popoverRef.current?.contains(activeElement)) return;
      enabledMenuItems(popoverRef.current ?? document.body)[0]?.focus();
    });
    function handlePointerDown(event: PointerEvent) {
      if (triggerRef.current?.contains(event.target as Node) || popoverRef.current?.contains(event.target as Node)) return;
      close();
    }
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, open]);

  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      const focusedMenuItem = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(menuItemSelector);
      if (!focusedMenuItem || !event.currentTarget.contains(focusedMenuItem)) return;
      const items = enabledMenuItems(event.currentTarget);
      if (!items.length) return;
      const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex !== null) {
        event.preventDefault();
        items[nextIndex]?.focus();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        (document.activeElement as HTMLElement | null)?.click();
      }
    },
    [close]
  );

  return { triggerRef, popoverRef, close, onMenuKeyDown };
}
