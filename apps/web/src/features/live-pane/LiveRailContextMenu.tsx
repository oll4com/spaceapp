import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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

  return createPortal(
    <div ref={ref} className="live-rail-context-menu" role="menu" style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}>
      <button type="button" role="menuitem" onClick={() => {
        window.dispatchEvent(new Event("space-live-rail-conversation-toggle"));
        onClose();
      }}>
        {`Show Live conversation window`}
      </button>
      <button type="button" role="menuitem" onClick={() => {
        window.dispatchEvent(new Event("space-live-rail-stats-toggle"));
        onClose();
      }}>
        {`Show Live statistics`}
      </button>
      <button type="button" role="menuitem" onClick={() => {
        window.dispatchEvent(new Event("space-live-rail-clear-conversation"));
        onClose();
      }}>
        {`Clear conversation`}
      </button>
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
        {disabled ? `Enable` : `Disable`}
      </button>
    </div>,
    document.body
  );
}
