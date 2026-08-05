import { Check, Loader2 } from "../ui-theme/app-icons.js";
import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import type { Room } from "@space/contracts";

export const PANE_LAYOUT_MENU_ID = "pane-layout-presets";

type PaneLayoutColumns = Room["paneLayoutColumns"];

interface PaneLayoutMenuProps {
  automaticColumns: number;
  currentColumns: PaneLayoutColumns;
  error: string | null;
  maximumColumns: number;
  onClose: () => void;
  onSelect: (columns: PaneLayoutColumns) => void;
  pending: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  visiblePaneCount: number;
}

const paneLayoutOptions: Array<{ label: string; value: PaneLayoutColumns }> = [
  { label: "Automatic", value: null },
  { label: "1 column", value: 1 },
  { label: "2 columns", value: 2 },
  { label: "3 columns", value: 3 },
  { label: "4 columns", value: 4 }
];

function previewMetrics(
  value: PaneLayoutColumns,
  automaticColumns: number,
  maximumColumns: number,
  visiblePaneCount: number
) {
  const requestedColumns = value ?? automaticColumns;
  const columns = Math.max(1, Math.min(requestedColumns, maximumColumns, Math.max(visiblePaneCount, 1)));
  return {
    columns,
    rows: visiblePaneCount === 0 ? 0 : Math.ceil(visiblePaneCount / columns)
  };
}

function visiblePaneLayoutOptions(
  automaticColumns: number,
  currentColumns: PaneLayoutColumns,
  maximumColumns: number,
  visiblePaneCount: number
) {
  const options = paneLayoutOptions.map((option) => ({
    ...option,
    metrics: previewMetrics(option.value, automaticColumns, maximumColumns, visiblePaneCount)
  }));
  const signature = (option: (typeof options)[number]) => `${option.metrics.columns}x${option.metrics.rows}`;
  const currentSignature = signature(options.find((option) => option.value === currentColumns) ?? options[0]!);

  return options.filter((option, index) => {
    const optionSignature = signature(option);
    if (optionSignature === currentSignature) return option.value === currentColumns;
    return options.findIndex((candidate) => signature(candidate) === optionSignature) === index;
  });
}

function optionAccessibleName(label: string, visiblePaneCount: number, rows: number) {
  return `${label}, ${visiblePaneCount} visible pane${visiblePaneCount === 1 ? "" : "s"}, ${rows} row${rows === 1 ? "" : "s"}`;
}

export function PaneLayoutMenu({
  automaticColumns,
  currentColumns,
  error,
  maximumColumns,
  onClose,
  onSelect,
  pending,
  triggerRef,
  visiblePaneCount
}: PaneLayoutMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const visibleOptions = useMemo(
    () => visiblePaneLayoutOptions(automaticColumns, currentColumns, maximumColumns, visiblePaneCount),
    [automaticColumns, currentColumns, maximumColumns, visiblePaneCount]
  );

  useEffect(() => {
    const options = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    const selectedIndex = visibleOptions.findIndex((option) => option.value === currentColumns);
    options?.[Math.max(0, selectedIndex)]?.focus();
  }, [currentColumns, visibleOptions]);

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
      onSelect(visibleOptions[currentIndex]?.value ?? null);
    }
  }

  return (
    <div
      ref={menuRef}
      id={PANE_LAYOUT_MENU_ID}
      className="pane-layout-menu toolbar-floating-menu"
      role="menu"
      aria-label="Pane layout presets"
      aria-busy={pending}
      onKeyDown={handleKeyDown}
    >
      <header>
        <strong>Pane layout</strong>
        <span>{visiblePaneCount} visible pane{visiblePaneCount === 1 ? "" : "s"}</span>
      </header>
      <div className="pane-layout-options">
        {visibleOptions.map((option) => {
          const isCurrent = option.value === currentColumns;
          const metrics = option.metrics;
          const previewStyle = { "--pane-layout-preview-columns": metrics.columns } as CSSProperties;
          return (
            <button
              key={option.value ?? "automatic"}
              type="button"
              role="menuitemradio"
              aria-checked={isCurrent}
              aria-label={optionAccessibleName(option.label, visiblePaneCount, metrics.rows)}
              className={isCurrent ? "selected" : undefined}
              data-preview-columns={metrics.columns}
              data-preview-rows={metrics.rows}
              disabled={pending}
              onClick={() => onSelect(option.value)}
            >
              <span className="pane-layout-preview" style={previewStyle} aria-hidden="true">
                {Array.from({ length: visiblePaneCount }, (_, index) => (
                  <span key={index} data-testid="pane-layout-preview-pane" />
                ))}
              </span>
              <span className="pane-layout-option-copy">
                <strong>{option.label}</strong>
                <small>{metrics.columns} × {metrics.rows || 0}</small>
              </span>
              <Check className="pane-layout-check" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {pending ? (
        <p className="pane-layout-status" role="status" aria-live="polite">
          <Loader2 aria-hidden="true" /> Applying layout…
        </p>
      ) : null}
      {error ? <p className="pane-layout-error" role="alert">{error}</p> : null}
    </div>
  );
}
