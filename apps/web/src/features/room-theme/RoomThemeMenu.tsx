import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

export const ROOM_THEME_MENU_ID = "room-theme-menu";

export const roomThemes = [
  { id: "graphite", label: "Graphite" },
  { id: "forest", label: "Forest" },
  { id: "copper", label: "Copper" },
  { id: "steel", label: "Steel" },
  { id: "contrast", label: "Contrast" }
] as const;

export type RoomTheme = (typeof roomThemes)[number]["id"];

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type Viewport = {
  height: number;
  width: number;
};

type RoomThemeMenuPosition = {
  left: number;
  placement: "above" | "below";
  top: number;
};

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 8;

export function computeRoomThemeMenuPosition(
  trigger: Rect,
  menu: Pick<Rect, "height" | "width">,
  viewport: Viewport
): RoomThemeMenuPosition {
  const centeredLeft = trigger.left + (trigger.width - menu.width) / 2;
  const maximumLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(centeredLeft, VIEWPORT_MARGIN), maximumLeft);
  const belowTop = trigger.bottom + TRIGGER_GAP;
  const aboveTop = trigger.top - TRIGGER_GAP - menu.height;

  if (belowTop + menu.height <= viewport.height - VIEWPORT_MARGIN) {
    return { left, placement: "below", top: belowTop };
  }
  if (aboveTop >= VIEWPORT_MARGIN) {
    return { left, placement: "above", top: aboveTop };
  }

  const top = Math.min(
    Math.max(belowTop, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN)
  );
  return { left, placement: "below", top };
}

export function RoomThemeMenu({
  currentTheme,
  mobile,
  onClose,
  onSelect,
  triggerRef
}: {
  currentTheme: RoomTheme;
  mobile: boolean;
  onClose: () => void;
  onSelect: (theme: RoomTheme) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState<RoomThemeMenuPosition | null>(null);

  useLayoutEffect(() => {
    itemRefs.current[roomThemes.findIndex((theme) => theme.id === currentTheme)]?.focus();
  }, [currentTheme]);

  useLayoutEffect(() => {
    if (mobile) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      setPosition(
        computeRoomThemeMenuPosition(
          trigger.getBoundingClientRect(),
          menu.getBoundingClientRect(),
          { height: window.innerHeight, width: window.innerWidth }
        )
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [mobile, triggerRef]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose, triggerRef]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
      return;
    }

    const activeIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    const selectedIndex = roomThemes.findIndex((theme) => theme.id === currentTheme);
    let nextIndex: number | null = null;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = roomThemes.length - 1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = ((activeIndex >= 0 ? activeIndex : selectedIndex) + 1) % roomThemes.length;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = ((activeIndex >= 0 ? activeIndex : selectedIndex) - 1 + roomThemes.length) % roomThemes.length;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    itemRefs.current[nextIndex]?.focus();
  }

  const desktopStyle: CSSProperties | undefined = mobile
    ? undefined
    : position
      ? { left: position.left, top: position.top }
      : { left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN, visibility: "hidden" };

  const menu = (
    <div
      ref={menuRef}
      id={ROOM_THEME_MENU_ID}
      className={`theme-menu room-theme-menu${mobile ? " is-mobile" : ""}`}
      role="menu"
      aria-label="Room theme options"
      data-placement={position?.placement}
      style={desktopStyle}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {roomThemes.map((theme, index) => (
        <button
          key={theme.id}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          className={theme.id === currentTheme ? "selected" : ""}
          role="menuitemradio"
          aria-checked={theme.id === currentTheme}
          onClick={() => {
            onSelect(theme.id);
            onClose();
          }}
        >
          <span className={`theme-swatch ${theme.id}`} aria-hidden="true" />
          <span>{theme.label}</span>
        </button>
      ))}
    </div>
  );

  return createPortal(
    mobile ? (
      <div className="room-theme-menu-backdrop">{menu}</div>
    ) : menu,
    document.body
  );
}
