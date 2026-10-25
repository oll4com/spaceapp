import { memo, useCallback } from "react";
import { usePaneWorkingTime } from "./usePaneWorkingTime.js";
import "./pane-working-time.css";

export interface PaneWorkingTimeBadgeProps {
  paneId: string;
  paneCreatedAt?: string;
  categoryColor?: string | null;
  isWorking: boolean;
  screenWorkingMs?: number | null;
}

export const PaneWorkingTimeBadge = memo(function PaneWorkingTimeBadge({
  paneId,
  paneCreatedAt,
  categoryColor,
  isWorking,
  screenWorkingMs
}: PaneWorkingTimeBadgeProps) {
  const { isWorking: active, formattedTime } = usePaneWorkingTime({
    paneId,
    paneCreatedAt,
    isWorking,
    screenWorkingMs
  });

  const statusLabel = active ? "Actively working" : "Waiting for command";
  const tooltip = `Active working time: ${formattedTime} (${statusLabel})\nOnly counts execution time; idle wait time is excluded.`;
  const ariaLabel = `Active working time: ${formattedTime}, ${statusLabel.toLowerCase()}`;

  const handleBadgeClick = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(formattedTime);
      }
    } catch {}
  }, [formattedTime]);

  return (
    <div
      className={`pane-working-time-badge ${active ? "is-active" : "is-idle"}`}
      data-category-color={categoryColor ?? undefined}
      role="status"
      aria-label={ariaLabel}
      title={tooltip}
      onClick={handleBadgeClick}
    >
      <span className="pane-working-time-icon" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="8" cy="8" r="6" />
          <polyline points="8 4.5 8 8 10.5 9.5" />
        </svg>
      </span>

      <span className="pane-working-time-digits">{formattedTime}</span>

      {active ? (
        <span className="pane-working-time-pulse" aria-hidden="true" />
      ) : null}
    </div>
  );
});

