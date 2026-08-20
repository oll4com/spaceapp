import { Keyboard, X } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import "./osk-keyboard.css";

export const OSK_PANEL_ID = "space-osk-keyboard";
export const OSK_POSITION_STORAGE_KEY = "space.osk.position";
export const OSK_SCALE_STORAGE_KEY = "space.osk.scale";
export const OSK_LANG_STORAGE_KEY = "space.osk.lang";

const VIEWPORT_MARGIN_PX = 8;
const DEFAULT_PANEL_WIDTH_PX = 620;
const DEFAULT_PANEL_HEIGHT_PX = 300;
const MAX_DRAG_DISTANCE_PX = 12;
const OSK_SCALE_MIN = 0.7;
const OSK_SCALE_MAX = 1.6;
const OSK_SCALE_STEP = 0.1;
const OSK_SCALE_DEFAULT = 1;

type OskLanguage = "en" | "el";
type OskKeyKind = "char" | "space" | "backspace" | "enter" | "tab" | "shift" | "escape" | "arrow";

type OskKey = {
  id: string;
  kind: OskKeyKind;
  label: string;
  value: string;
  code: string;
  className?: string;
  wide?: boolean;
};

export type OnScreenKeyboardInput = {
  key: string;
  code: string;
  shiftKey: boolean;
  text: string | null;
  terminalData: string;
};

const LETTER_ROWS: OskKey[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((value) => ({ id: value, kind: "char", label: value, value, code: `Digit${value}` })),
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map((value) => ({ id: value, kind: "char", label: value, value, code: `Key${value.toUpperCase()}` })),
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"].map((value) => ({ id: value, kind: "char", label: value, value, code: `Key${value.toUpperCase()}` })),
  ["z", "x", "c", "v", "b", "n", "m"].map((value) => ({ id: value, kind: "char", label: value, value, code: `Key${value.toUpperCase()}` }))
];

const GREEK_LETTER_ROWS: { char: string; code: string }[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((char) => ({ char, code: `Digit${char}` })),
  [
    { char: ";", code: "Semicolon" },
    { char: "ς", code: "KeyQ" },
    { char: "ε", code: "KeyW" },
    { char: "ρ", code: "KeyE" },
    { char: "τ", code: "KeyR" },
    { char: "υ", code: "KeyT" },
    { char: "θ", code: "KeyY" },
    { char: "ι", code: "KeyU" },
    { char: "ο", code: "KeyI" },
    { char: "π", code: "KeyP" }
  ],
  [
    { char: "α", code: "KeyA" },
    { char: "σ", code: "KeyS" },
    { char: "δ", code: "KeyD" },
    { char: "φ", code: "KeyF" },
    { char: "γ", code: "KeyG" },
    { char: "η", code: "KeyH" },
    { char: "ξ", code: "KeyJ" },
    { char: "κ", code: "KeyK" },
    { char: "λ", code: "KeyL" }
  ],
  [
    { char: "ζ", code: "KeyZ" },
    { char: "χ", code: "KeyX" },
    { char: "ψ", code: "KeyC" },
    { char: "ω", code: "KeyV" },
    { char: "β", code: "KeyB" },
    { char: "ν", code: "KeyN" },
    { char: "μ", code: "KeyM" }
  ]
];

function getLetterRows(lang: OskLanguage): OskKey[][] {
  if (lang === "el") {
    return GREEK_LETTER_ROWS.map((row) =>
      row.map(({ char, code }) => ({ id: char, kind: "char" as const, label: char, value: char, code }))
    );
  }
  return LETTER_ROWS;
}

const SHIFTED_SYMBOLS: Record<string, string> = {
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  ";": ":"
};

const SPECIAL_KEYS: Record<string, OskKey> = {
  escape: { id: "escape", kind: "escape", label: "Esc", value: "Escape", code: "Escape" },
  backspace: { id: "backspace", kind: "backspace", label: "⌫", value: "Backspace", code: "Backspace", wide: true },
  enter: { id: "enter", kind: "enter", label: "Enter", value: "Enter", code: "Enter", wide: true },
  tab: { id: "tab", kind: "tab", label: "Tab", value: "Tab", code: "Tab" },
  shift: { id: "shift", kind: "shift", label: "Shift", value: "Shift", code: "ShiftLeft", wide: true },
  space: { id: "space", kind: "space", label: "Space", value: " ", code: "Space", wide: true },
  arrowUp: { id: "arrow-up", kind: "arrow", label: "↑", value: "ArrowUp", code: "ArrowUp" },
  arrowDown: { id: "arrow-down", kind: "arrow", label: "↓", value: "ArrowDown", code: "ArrowDown" },
  arrowLeft: { id: "arrow-left", kind: "arrow", label: "←", value: "ArrowLeft", code: "ArrowLeft" },
  arrowRight: { id: "arrow-right", kind: "arrow", label: "→", value: "ArrowRight", code: "ArrowRight" }
};

type PanelPosition = {
  left: number;
  top: number;
  ready: boolean;
};

function readStoredPosition(): PanelPosition | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(OSK_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelPosition>;
    if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
    return { left: parsed.left as number, top: parsed.top as number, ready: true };
  } catch {
    return null;
  }
}

function persistPosition(position: { left: number; top: number }) {
  try {
    getSpaceRuntime().platform.localStorage.setItem(OSK_POSITION_STORAGE_KEY, JSON.stringify({ left: position.left, top: position.top }));
  } catch {
    // Position persistence is best effort only.
  }
}

function readStoredScale(): number {
  if (typeof window === "undefined") return OSK_SCALE_DEFAULT;
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(OSK_SCALE_STORAGE_KEY);
    if (!raw) return OSK_SCALE_DEFAULT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return OSK_SCALE_DEFAULT;
    return Math.min(OSK_SCALE_MAX, Math.max(OSK_SCALE_MIN, parsed));
  } catch {
    return OSK_SCALE_DEFAULT;
  }
}

function persistScale(scale: number) {
  try {
    getSpaceRuntime().platform.localStorage.setItem(OSK_SCALE_STORAGE_KEY, String(scale));
  } catch {
    // Scale persistence is best effort only.
  }
}

function readStoredLang(): OskLanguage {
  if (typeof window === "undefined") return "en";
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(OSK_LANG_STORAGE_KEY);
    return raw === "el" ? "el" : "en";
  } catch {
    return "en";
  }
}

function persistLang(lang: OskLanguage) {
  try {
    getSpaceRuntime().platform.localStorage.setItem(OSK_LANG_STORAGE_KEY, lang);
  } catch {
    // Language persistence is best effort only.
  }
}

function isEditableElement(element: Element | null): boolean {
  return Boolean(
    element &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable))
  );
}

function dispatchKeyEvent(target: Element, type: "keydown" | "keyup" | "keypress", init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }));
}

function resolveKeyboardInput(oskKey: OskKey, shiftHeld: boolean): OnScreenKeyboardInput {
  let key = oskKey.value;
  if (oskKey.id === "space") key = " ";
  if (shiftHeld && oskKey.kind === "char" && oskKey.id.length === 1) {
    key = SHIFTED_SYMBOLS[oskKey.id] ?? key.toUpperCase();
  }

  const terminalData = (() => {
    switch (oskKey.id) {
      case "escape": return "\u001b";
      case "backspace": return "\u007f";
      case "enter": return "\r";
      case "tab": return "\t";
      case "arrow-up": return "\u001b[A";
      case "arrow-down": return "\u001b[B";
      case "arrow-left": return "\u001b[D";
      case "arrow-right": return "\u001b[C";
      default: return key;
    }
  })();

  return {
    key,
    code: oskKey.code,
    shiftKey: shiftHeld,
    text: oskKey.kind === "char" || oskKey.kind === "space" ? key : null,
    terminalData
  };
}

function sendKeyToFocusedElement(oskKey: OskKey, input: OnScreenKeyboardInput) {
  const target = document.activeElement;
  if (!target || !(target instanceof HTMLElement)) return;

  const isEditable = isEditableElement(target);
  if (isEditable && (oskKey.id === "space" || oskKey.kind === "char")) {
    const beforeInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      composed: true,
      inputType: "insertText",
      data: input.key
    });
    const handled = target.dispatchEvent(beforeInput);
    if (!handled || !beforeInput.defaultPrevented) {
      if (typeof document.execCommand === "function") {
        document.execCommand("insertText", false, input.key);
      }
    }
    return;
  }

  const eventInit = { key: input.key, code: input.code, shiftKey: input.shiftKey };
  dispatchKeyEvent(target, "keydown", eventInit);
  dispatchKeyEvent(target, "keypress", eventInit);
  dispatchKeyEvent(target, "keyup", eventInit);
}

export function OnScreenKeyboard({
  mobile,
  open,
  onInput,
  onOpenChange,
  roomTheme
}: {
  mobile: boolean;
  open: boolean;
  onInput?: (input: OnScreenKeyboardInput) => boolean;
  onOpenChange: (open: boolean) => void;
  roomTheme: "graphite" | "forest" | "copper" | "steel" | "contrast";
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; originLeft: number; originTop: number; moved: boolean } | null>(null);
  const latestPositionRef = useRef<{ left: number; top: number } | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [scale, setScale] = useState<number>(() => readStoredScale());
  const [lang, setLang] = useState<OskLanguage>(() => readStoredLang());
  const [position, setPosition] = useState<PanelPosition>(() => readStoredPosition() ?? { left: VIEWPORT_MARGIN_PX, top: VIEWPORT_MARGIN_PX, ready: false });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setPosition((current) => {
      if (current.ready) return current;
      const width = rect.width || DEFAULT_PANEL_WIDTH_PX;
      const height = rect.height || DEFAULT_PANEL_HEIGHT_PX;
      const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerWidth - width - VIEWPORT_MARGIN_PX, (window.innerWidth - width) / 2));
      const top = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerHeight - height - VIEWPORT_MARGIN_PX, window.innerHeight - height - 96));
      return { left, top, ready: true };
    });
  }, [open]);

  useEffect(() => {
    persistScale(scale);
  }, [scale]);

  useEffect(() => {
    persistLang(lang);
  }, [lang]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const nextLeft = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerWidth - rect.width - VIEWPORT_MARGIN_PX, position.left));
    const nextTop = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerHeight - rect.height - VIEWPORT_MARGIN_PX, position.top));
    if (nextLeft !== position.left || nextTop !== position.top) {
      setPosition({ left: nextLeft, top: nextTop, ready: true });
      persistPosition({ left: nextLeft, top: nextTop });
    }
  }, [open, scale, position.left, position.top]);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || !panel) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) > MAX_DRAG_DISTANCE_PX) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    const rect = panel.getBoundingClientRect();
    const nextLeft = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerWidth - rect.width - VIEWPORT_MARGIN_PX, drag.originLeft + deltaX));
    const nextTop = Math.max(VIEWPORT_MARGIN_PX, Math.min(window.innerHeight - rect.height - VIEWPORT_MARGIN_PX, drag.originTop + deltaY));
    latestPositionRef.current = { left: nextLeft, top: nextTop };
    setPosition({ left: nextLeft, top: nextTop, ready: true });
  }, []);

  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.moved && latestPositionRef.current) {
      persistPosition(latestPositionRef.current);
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const handleKeyPress = useCallback((oskKey: OskKey) => {
    if (oskKey.id === "shift") {
      setShiftHeld((current) => !current);
      return;
    }
    const input = resolveKeyboardInput(oskKey, shiftHeld);
    if (onInput?.(input)) return;
    sendKeyToFocusedElement(oskKey, input);
  }, [onInput, shiftHeld]);

  const changeScale = useCallback((delta: number) => {
    setScale((current) => Math.round((Math.min(OSK_SCALE_MAX, Math.max(OSK_SCALE_MIN, current + delta))) * 100) / 100);
  }, []);

  const toggleLang = useCallback(() => {
    setLang((current) => (current === "en" ? "el" : "en"));
  }, []);

  const panelStyle: CSSProperties | undefined = mobile
    ? undefined
    : {
        left: `${position.left}px`,
        top: `${position.top}px`,
        visibility: position.ready ? "visible" : "hidden",
        transform: `scale(${scale})`,
        transformOrigin: "top left"
      };

  const letterRows = getLetterRows(lang);

  const rows: OskKey[][] = [
    [SPECIAL_KEYS.escape!, ...letterRows[0]!, SPECIAL_KEYS.backspace!],
    [...letterRows[1]!, SPECIAL_KEYS.enter!],
    [SPECIAL_KEYS.shift!, ...letterRows[2]!, SPECIAL_KEYS.tab!],
    [...letterRows[3]!, SPECIAL_KEYS.space!, SPECIAL_KEYS.arrowLeft!, SPECIAL_KEYS.arrowUp!, SPECIAL_KEYS.arrowDown!, SPECIAL_KEYS.arrowRight!]
  ];

  const panel = open ? (
    <section
      ref={panelRef}
      id={OSK_PANEL_ID}
      className={mobile ? "osk-panel osk-sheet osk-theme" : "osk-panel osk-popover osk-theme"}
      data-room-theme={roomTheme}
      role="dialog"
      aria-modal={mobile ? "true" : undefined}
      aria-label="On-screen keyboard"
      style={panelStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="osk-header">
        <div
          className="osk-drag-handle"
          role="button"
          tabIndex={0}
          aria-label="Move on-screen keyboard"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <Keyboard aria-hidden="true" />
          <span>On-screen keyboard</span>
        </div>
        <div className="osk-controls">
          <div className="osk-size-controls" role="group" aria-label="Keyboard size">
            <button
              type="button"
              className="osk-size-btn"
              aria-label="Smaller keyboard"
              onClick={() => changeScale(-OSK_SCALE_STEP)}
            >
              −
            </button>
            <button
              type="button"
              className="osk-size-btn"
              aria-label="Larger keyboard"
              onClick={() => changeScale(OSK_SCALE_STEP)}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="osk-lang-btn"
            aria-label="Switch keyboard language"
            onClick={toggleLang}
          >
            {lang === "en" ? "ΕΛ" : "EN"}
          </button>
        </div>
        <button
          type="button"
          className="osk-close"
          aria-label="Close on-screen keyboard"
          onClick={() => onOpenChange(false)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="osk-keys" aria-label="Keyboard keys">
        {rows.map((row, rowIndex) => (
          <div className="osk-row" role="row" aria-label={`Keyboard row ${rowIndex + 1}`} key={rowIndex}>
            {row.map((oskKey) => {
              const label = shiftHeld && oskKey.kind === "char" && oskKey.id.length === 1
                ? SHIFTED_SYMBOLS[oskKey.id] ?? oskKey.label.toUpperCase()
                : oskKey.label;
              return (
                <button
                  key={oskKey.id}
                  type="button"
                  className={`osk-key${oskKey.wide ? " is-wide" : ""}${oskKey.id === "shift" && shiftHeld ? " is-active" : ""}`}
                  data-key={oskKey.id}
                  aria-label={oskKey.id === "space" ? "Space" : oskKey.kind === "char" && label !== oskKey.id ? `${label} (${oskKey.id})` : label}
                  onClick={() => handleKeyPress(oskKey)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  ) : null;

  return panel
    ? createPortal(
        mobile ? <div className="osk-sheet-backdrop">{panel}</div> : panel,
        document.body
      )
    : null;
}
