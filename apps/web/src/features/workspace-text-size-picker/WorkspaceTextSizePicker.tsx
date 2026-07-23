import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from "react";

export const WORKSPACE_TEXT_SIZE_PICKER_ID = "workspace-text-size-picker";
export const MIN_WORKSPACE_TEXT_SIZE = 10;
export const MAX_WORKSPACE_TEXT_SIZE = 20;

const VISIBLE_OPTION_COUNT = 5;
const WHEEL_STEP_THRESHOLD_PX = 40;
const WHEEL_RESET_DELAY_MS = 150;
const VIEWPORT_MARGIN_PX = 8;
const ANCHOR_GAP_PX = 8;
const FALLBACK_PICKER_WIDTH_PX = 112;
const FALLBACK_PICKER_HEIGHT_PX = 228;

type PickerPosition = {
  left: number;
  placement: "above" | "below";
  top: number;
};

type WorkspaceTextSizePickerProps = {
  anchorRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  value: number;
  onChange: (value: number) => void;
  onClose: () => void;
};

function clampTextSize(value: number): number {
  return Math.min(MAX_WORKSPACE_TEXT_SIZE, Math.max(MIN_WORKSPACE_TEXT_SIZE, Math.round(value)));
}

function visibleTextSizes(value: number): number[] {
  const centeredStart = clampTextSize(value) - Math.floor(VISIBLE_OPTION_COUNT / 2);
  const maxStart = MAX_WORKSPACE_TEXT_SIZE - VISIBLE_OPTION_COUNT + 1;
  const start = Math.min(maxStart, Math.max(MIN_WORKSPACE_TEXT_SIZE, centeredStart));
  return Array.from({ length: VISIBLE_OPTION_COUNT }, (_, index) => start + index);
}

function wheelDeltaPixels(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

export function WorkspaceTextSizePicker({
  anchorRef,
  open,
  value,
  onChange,
  onClose
}: WorkspaceTextSizePickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);
  const wheelDeltaRef = useRef(0);
  const wheelResetTimerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<PickerPosition>({ left: VIEWPORT_MARGIN_PX, placement: "below", top: VIEWPORT_MARGIN_PX });
  const normalizedValue = clampTextSize(value);
  const options = useMemo(() => visibleTextSizes(normalizedValue), [normalizedValue]);

  useLayoutEffect(() => {
    if (!open) return;

    function updatePosition() {
      const anchor = anchorRef.current;
      const picker = pickerRef.current;
      if (!anchor || !picker) return;
      const anchorRect = anchor.getBoundingClientRect();
      const pickerRect = picker.getBoundingClientRect();
      const pickerWidth = pickerRect.width || FALLBACK_PICKER_WIDTH_PX;
      const pickerHeight = pickerRect.height || FALLBACK_PICKER_HEIGHT_PX;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const fitsBelow = anchorRect.bottom + ANCHOR_GAP_PX + pickerHeight <= viewportHeight - VIEWPORT_MARGIN_PX;
      const placement = fitsBelow ? "below" : "above";
      const desiredTop = fitsBelow
        ? anchorRect.bottom + ANCHOR_GAP_PX
        : anchorRect.top - ANCHOR_GAP_PX - pickerHeight;
      const maxLeft = Math.max(VIEWPORT_MARGIN_PX, viewportWidth - pickerWidth - VIEWPORT_MARGIN_PX);
      const maxTop = Math.max(VIEWPORT_MARGIN_PX, viewportHeight - pickerHeight - VIEWPORT_MARGIN_PX);
      setPosition({
        left: Math.min(maxLeft, Math.max(VIEWPORT_MARGIN_PX, anchorRect.left + (anchorRect.width - pickerWidth) / 2)),
        placement,
        top: Math.min(maxTop, Math.max(VIEWPORT_MARGIN_PX, desiredTop))
      });
    }

    updatePosition();
    pickerRef.current?.focus();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return;
    function handleOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (pickerRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [anchorRef, onClose, open]);

  useEffect(
    () => () => {
      if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current);
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    const picker = pickerRef.current;
    if (!picker) return;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      wheelDeltaRef.current += wheelDeltaPixels(event);
      if (wheelResetTimerRef.current !== null) window.clearTimeout(wheelResetTimerRef.current);
      wheelResetTimerRef.current = window.setTimeout(() => {
        wheelDeltaRef.current = 0;
        wheelResetTimerRef.current = null;
      }, WHEEL_RESET_DELAY_MS);
      if (Math.abs(wheelDeltaRef.current) < WHEEL_STEP_THRESHOLD_PX) return;
      const direction = wheelDeltaRef.current > 0 ? 1 : -1;
      wheelDeltaRef.current = 0;
      onChange(clampTextSize(normalizedValue + direction));
    }
    picker.addEventListener("wheel", handleWheel, { passive: false });
    return () => picker.removeEventListener("wheel", handleWheel);
  }, [normalizedValue, onChange, open]);

  if (!open) return null;

  function select(nextValue: number) {
    onChange(clampTextSize(nextValue));
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextValue: number | null = null;
    if (event.key === "ArrowUp") nextValue = normalizedValue - 1;
    if (event.key === "ArrowDown") nextValue = normalizedValue + 1;
    if (event.key === "Home") nextValue = MIN_WORKSPACE_TEXT_SIZE;
    if (event.key === "End") nextValue = MAX_WORKSPACE_TEXT_SIZE;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      anchorRef.current?.focus();
      return;
    }
    if (nextValue === null) return;
    event.preventDefault();
    select(nextValue);
  }

  return createPortal(
    <div
      ref={pickerRef}
      id={WORKSPACE_TEXT_SIZE_PICKER_ID}
      className="workspace-text-size-picker"
      role="listbox"
      aria-label="Workspace text size"
      aria-activedescendant={`workspace-text-size-${normalizedValue}`}
      data-placement={position.placement}
      tabIndex={0}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      onBlur={(event) => {
        const nextFocus = event.relatedTarget as Node | null;
        if (nextFocus && (event.currentTarget.contains(nextFocus) || anchorRef.current?.contains(nextFocus))) return;
        onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => (
        <button
          key={option}
          id={`workspace-text-size-${option}`}
          type="button"
          role="option"
          aria-label={`${option} px`}
          aria-selected={option === normalizedValue}
          tabIndex={-1}
          onClick={() => select(option)}
        >
          <span>{option}</span>
          <small>px</small>
        </button>
      ))}
    </div>,
    document.body
  );
}
