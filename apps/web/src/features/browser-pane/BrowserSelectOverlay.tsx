import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { browserSelectStateSchema, type BrowserFrame, type BrowserSelectState } from "@space/contracts";
import { api } from "../../api.js";
import { fitViewportIntoRect, type BrowserCanvasInput, type BrowserViewportSize } from "./BrowserCanvas.js";

/** The `select_state` answer: an open dropdown, or null (closed, nothing focused, or a Browser Host from before it). */
export function parseBrowserSelectState(text: string | null | undefined): BrowserSelectState | null {
  if (!text) return null;
  try {
    const parsed = browserSelectStateSchema.nullable().safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The live view's own list for an open native dropdown (option D, plan clipboard:gHaiX_8yanVA): Chrome draws the real one in
 * a popup no frame shows, and a click on the page under it closes it. After each click the view asks once whether a dropdown
 * opened; the pick goes to the page as keys (`select_choose`), Escape closes the real one. It asks after the release, never while
 * a button is held: Fiverr's Press & Hold reset half a second into every hold while the old host answered the press-time ask.
 */
export function useBrowserSelectOverlay(options: {
  paneId: string;
  sendInput(input: BrowserCanvasInput): void;
  onFrame(frame: BrowserFrame | null): void;
}) {
  const { paneId, sendInput, onFrame } = options;
  const generation = useRef(0);
  const [open, setOpen] = useState<(BrowserSelectState & { sessionId: string }) | null>(null);

  const afterRelease = useCallback((sessionId: string) => {
    const press = ++generation.current;
    setOpen(null);
    window.setTimeout(() => {
      void api.browserAction(paneId, { type: "select_state", sessionId }).then((result) => {
        const state = parseBrowserSelectState(result.text);
        if (press === generation.current) setOpen(state ? { ...state, sessionId } : null);
      }).catch(() => undefined);
    }, 150);
  }, [paneId]);

  function choose(index: number) {
    if (!open) return;
    generation.current += 1;
    setOpen(null);
    void api.browserAction(paneId, { type: "select_choose", index, sessionId: open.sessionId })
      .then((result) => onFrame(result.frame))
      .catch(() => undefined);
  }

  function dismiss() {
    generation.current += 1;
    setOpen(null);
    sendInput({ type: "KEY", eventType: "keyDown", key: "Escape", code: "Escape", modifiers: 0 });
    sendInput({ type: "KEY", eventType: "keyUp", key: "Escape", code: "Escape", modifiers: 0 });
  }

  const render = (viewport: BrowserViewportSize) =>
    open ? <BrowserSelectList state={open} viewport={viewport} onChoose={choose} onDismiss={dismiss} /> : null;
  return { afterRelease, render };
}

export function BrowserSelectList({ state, viewport, onChoose, onDismiss }: {
  state: BrowserSelectState;
  viewport: BrowserViewportSize;
  onChoose(index: number): void;
  onDismiss(): void;
}) {
  const idBase = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const enabled = state.labels.map((_, index) => index).filter((index) => !state.disabled.includes(index));
  const [active, setActive] = useState(() => (enabled.includes(state.selectedIndex) ? state.selectedIndex : enabled[0] ?? -1));
  const [place, setPlace] = useState<{ left: number; top: number; minWidth: number; maxHeight: number } | null>(null);

  // Under the dropdown's box, in the letterboxed frame the canvas draws inside its surface.
  useLayoutEffect(() => {
    const list = ref.current;
    const surface = list?.parentElement;
    const container = list?.offsetParent ?? surface;
    if (!list || !surface || !container) return;
    const bounds = surface.getBoundingClientRect();
    const origin = container.getBoundingClientRect();
    const fitted = fitViewportIntoRect({ left: bounds.left - origin.left, top: bounds.top - origin.top, width: bounds.width, height: bounds.height }, viewport);
    const scale = viewport.width > 0 ? fitted.width / viewport.width : 0;
    const top = fitted.top + (state.box.y + state.box.height) * scale;
    setPlace({ left: fitted.left + state.box.x * scale, top, minWidth: state.box.width * scale, maxHeight: Math.max(96, fitted.top + fitted.height - top) });
    list.focus();
  }, [state, viewport]);

  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = enabled.indexOf(active);
    const move: Record<string, number | undefined> = {
      ArrowDown: enabled[Math.min(enabled.length - 1, at + 1)],
      ArrowUp: enabled[Math.max(0, at - 1)],
      Home: enabled[0],
      End: enabled[enabled.length - 1]
    };
    if (event.key in move) {
      const next = move[event.key];
      if (next !== undefined) setActive(next);
    } else if (event.key === "Enter" || event.key === " ") {
      if (active >= 0) onChoose(active);
    } else if (event.key === "Escape" || event.key === "Tab") {
      onDismiss();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      ref={ref}
      className="browser-select-overlay"
      role="listbox"
      aria-label="Dropdown options"
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? `${idBase}-${active}` : undefined}
      style={place ?? { visibility: "hidden" }}
      onKeyDown={onKeyDown}
    >
      {state.labels.map((label, index) => {
        const disabled = state.disabled.includes(index);
        return (
          <div
            key={index}
            id={`${idBase}-${index}`}
            data-index={index}
            role="option"
            aria-selected={index === state.selectedIndex}
            aria-disabled={disabled || undefined}
            data-active={index === active || undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => { if (!disabled) onChoose(index); }}
          >
            {label || " "}
          </div>
        );
      })}
      {state.truncated ? <div className="browser-select-overlay-more">More options not shown: close this list and use the arrow keys.</div> : null}
    </div>
  );
}
