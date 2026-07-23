import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export function MetricPopover({
  anchor,
  children,
  id,
  label,
  onCancelClose,
  onRequestClose,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
  id: string;
  label: string;
  onCancelClose: () => void;
  onRequestClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return;
    const update = () => {
      if (!panelRef.current) return;
      const anchorRect = anchor.getBoundingClientRect();
      const panelRect = panelRef.current.getBoundingClientRect();
      const margin = 8;
      const width = panelRect.width || Math.min(352, window.innerWidth - margin * 2);
      const height = panelRect.height || 240;
      const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - width - margin));
      const below = anchorRect.bottom + margin;
      const top = below + height <= window.innerHeight - margin
        ? below
        : Math.max(margin, anchorRect.top - height - margin);
      setPosition((current) => current?.left === left && current.top === top ? current : { left, top });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  });

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    anchor?.focus();
    onRequestClose();
  }

  return createPortal(
    <div
      ref={panelRef}
      id={id}
      className="toolbar-metric-panel"
      role="region"
      aria-label={label}
      style={{ left: position?.left ?? 8, top: position?.top ?? 8, visibility: position ? "visible" : "hidden" }}
      onMouseEnter={onCancelClose}
      onMouseLeave={onRequestClose}
      onFocusCapture={onCancelClose}
      onBlurCapture={onRequestClose}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

export function ConfirmationDialog({
  busy,
  children,
  confirmLabel,
  label,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  children: ReactNode;
  confirmLabel: string;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [cancelRef.current, confirmRef.current].filter((item): item is HTMLButtonElement => Boolean(item && !item.disabled));
    if (controls.length < 2) return;
    const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? controls.length - 1 : currentIndex - 1)
      : (currentIndex + 1) % controls.length;
    event.preventDefault();
    controls[nextIndex]?.focus();
  }

  return createPortal(
    <div
      className="toolbar-metric-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="toolbar-metric-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={handleKeyDown}
      >
        <header>
          <strong>{label}</strong>
        </header>
        <div className="toolbar-metric-dialog-copy">{children}</div>
        <div className="toolbar-metric-dialog-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} type="button" className="danger" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
