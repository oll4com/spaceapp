import { Check, Loader2 } from "../ui-theme/app-icons.js";
import { useEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";

export const PANE_SPAN_ALL_MENU_ID = "pane-span-all-options";

interface PaneSpanAllMenuProps {
  activeColumnCount: number;
  currentSpan: number | null;
  error: string | null;
  onClose: () => void;
  onSelect: (span: number) => void;
  pending: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  visiblePaneCount: number;
}

export function PaneSpanAllMenu({
  activeColumnCount,
  currentSpan,
  error,
  onClose,
  onSelect,
  pending,
  triggerRef,
  visiblePaneCount
}: PaneSpanAllMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const spans = useMemo(() => {
    const count = Math.max(1, Math.min(activeColumnCount, visiblePaneCount));
    return Array.from({ length: count }, (_, index) => index + 1);
  }, [activeColumnCount, visiblePaneCount]);

  useEffect(() => {
    const options = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const selectedIndex = currentSpan === null ? -1 : spans.indexOf(currentSpan);
    options?.[Math.max(0, selectedIndex)]?.focus();
  }, [currentSpan, spans]);

  function closeAndRestoreFocus() {
    onClose();
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }

    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (currentIndex + 1 + options.length) % options.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + options.length) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      options[nextIndex]?.focus();
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && currentIndex >= 0 && !pending) {
      event.preventDefault();
      onSelect(spans[currentIndex] ?? 1);
    }
  }

  return (
    <div
      ref={menuRef}
      id={PANE_SPAN_ALL_MENU_ID}
      className="pane-span-all-menu toolbar-floating-menu"
      role="menu"
      aria-label="Pane width for all panes"
      aria-busy={pending}
      onKeyDown={handleKeyDown}
    >
      <header>
        <strong>All panes width</strong>
        <span>{visiblePaneCount} visible pane{visiblePaneCount === 1 ? "" : "s"}</span>
      </header>
      <div className="pane-span-all-options">
        {spans.map((span) => {
          const isCurrent = currentSpan !== null && span === currentSpan;
          return (
            <button
              key={span}
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent}
              aria-label={`${span} column${span === 1 ? "" : "s"}`}
              className={isCurrent ? "selected" : undefined}
              data-columns={span}
              data-testid="pane-span-all-option"
              disabled={pending}
              onClick={() => onSelect(span)}
            >
              <span className="pane-span-all-option-copy">
                <strong>{span} column{span === 1 ? "" : "s"}</strong>
                <small>for all panes</small>
              </span>
              <Check className="pane-layout-check" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {pending ? (
        <p className="pane-layout-status" role="status" aria-live="polite">
          <Loader2 aria-hidden="true" /> Applying width…
        </p>
      ) : null}
      {error ? <p className="pane-layout-error" role="alert">{error}</p> : null}
    </div>
  );
}
