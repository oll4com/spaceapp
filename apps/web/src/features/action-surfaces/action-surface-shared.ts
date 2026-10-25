import type { LucideIcon } from "../ui-theme/app-icons.js";

export type PaneOverflowCommand = {
  id: string;
  label: string;
  description: string;
  title?: string;
  ariaLabel: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  /** Window controls render as a compact tile row at the top of the desktop menu. */
  placement?: "quick";
};

export function enabledButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
}

export type PopupCloseIntent = "auto" | "dismissal" | "activation";

export function restorePopupTriggerFocus(
  popup: HTMLElement | null,
  trigger: HTMLButtonElement | null,
  closeIntent: PopupCloseIntent
) {
  if (!trigger?.isConnected) return;
  const activeElement = document.activeElement;
  const focusInPopup = Boolean(activeElement && popup?.contains(activeElement));
  const focusMovedToDestination =
    activeElement instanceof HTMLElement &&
    activeElement.isConnected &&
    activeElement !== document.body &&
    activeElement !== trigger &&
    !focusInPopup;
  if (focusMovedToDestination) return;
  if (closeIntent !== "auto" || focusInPopup || !activeElement || activeElement === document.body) trigger.focus();
}
