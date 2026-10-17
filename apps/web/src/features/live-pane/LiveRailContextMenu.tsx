import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Captions, CaptionsOff, ChartColumn, Eye, EyeOff, MessageSquareText, Trash2 } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import { shouldPreserveForSnipTool } from "../snip-tool/snip-guard.js";

export const LIVE_RAIL_CAPTIONS_DISABLED_STORAGE_KEY = "space.liveRail.captionsDisabled.v1";

export function LiveRailContextMenu({
  x,
  y,
  onClose,
  isGraphicDisabled,
  onToggleGraphic
}: {
  x: number;
  y: number;
  onClose: () => void;
  isGraphicDisabled?: boolean;
  onToggleGraphic?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const width = menu.offsetWidth || 240;
    const height = menu.offsetHeight || 56;
    setPosition({
      left: Math.max(8, Math.min(x > window.innerWidth / 2 ? x - width - 8 : x + 8, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
      ready: true
    });
  }, [x, y]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (shouldPreserveForSnipTool(event)) return;
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const disabled = typeof isGraphicDisabled === "boolean"
    ? isGraphicDisabled
    : (typeof window !== "undefined" && window.localStorage?.getItem("space.liveRail.graphicDisabled.v1") === "true");

  const captionsDisabled = typeof window !== "undefined" && window.localStorage?.getItem(LIVE_RAIL_CAPTIONS_DISABLED_STORAGE_KEY) === "true";
  const item = (event: string, label: string, icon: ReactNode, className?: string) => (
    <button type="button" role="menuitem" className={className} onClick={() => {
      window.dispatchEvent(new Event(event));
      onClose();
    }}>
      {icon}<span>{label}</span>
    </button>
  );

  return createPortal(
    <div ref={ref} className="live-rail-context-menu" role="menu" style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}>
      {item("space-live-rail-conversation-toggle", "Show Live conversation window", <MessageSquareText aria-hidden="true" />)}
      {item("space-live-rail-stats-toggle", "Show Live statistics", <ChartColumn aria-hidden="true" />)}
      {item("space-live-rail-captions-toggle", captionsDisabled ? "Show live captions" : "Hide live captions", captionsDisabled ? <Captions aria-hidden="true" /> : <CaptionsOff aria-hidden="true" />)}
      <div className="live-rail-context-menu-separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        data-action="toggle-graphic"
        onClick={() => {
          if (onToggleGraphic) {
            onToggleGraphic();
          } else {
            window.dispatchEvent(new Event("space-live-rail-graphic-toggle"));
          }
          onClose();
        }}
      >
        {disabled ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}<span>{disabled ? `Enable` : `Disable`}</span>
      </button>
      {item("space-live-rail-clear-conversation", "Clear conversation", <Trash2 aria-hidden="true" />, "is-danger")}
    </div>,
    document.body
  );
}
