import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent
} from "react";

export interface BrowserViewportSize {
  width: number;
  height: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type BrowserCanvasInput =
  | {
      type: "KEY";
      eventType: "keyDown" | "keyUp" | "char";
      key: string;
      code?: string;
      text?: string;
      modifiers: number;
    }
  | {
      type: "POINTER";
      eventType: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right" | "back" | "forward";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers: number;
    }
  | {
      type: "TOUCH";
      eventType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      touchPoints: Array<{ x: number; y: number; id: number; force?: number }>;
      modifiers: number;
    };

export interface BrowserCanvasHandle {
  present(source: string | Blob, capturedAt?: string): void;
  showHistory(index: number | null): void;
  historyLength(): number;
  focus(): void;
}

interface BrowserCanvasProps {
  ariaLabel: string;
  viewportSize: BrowserViewportSize;
  interactive: boolean;
  source?: string | null;
  capturedAt?: string | null;
  onInput(input: BrowserCanvasInput): void;
}

interface DecodedFrame {
  capturedAt: string;
  image: CanvasImageSource;
  dispose(): void;
}

interface PendingFrame {
  source: string | Blob;
  capturedAt: string;
}

const MAX_FRAME_HISTORY = 48;

export function quantizeCanvasDrawSize(bounds: Pick<RectLike, "width" | "height">, density: number) {
  const normalizedDensity = Math.min(2, Math.max(1, density || 1));
  const pixelWidth = Math.max(1, Math.round(bounds.width * normalizedDensity));
  const pixelHeight = Math.max(1, Math.round(bounds.height * normalizedDensity));
  return {
    density: normalizedDensity,
    pixelWidth,
    pixelHeight,
    width: pixelWidth / normalizedDensity,
    height: pixelHeight / normalizedDensity
  };
}

export function fitViewportIntoRect(bounds: RectLike, viewport: BrowserViewportSize): RectLike {
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { left: bounds.left, top: bounds.top, width: 0, height: 0 };
  }
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height
  };
}

export function mapClientPointToViewport(
  clientX: number,
  clientY: number,
  bounds: RectLike,
  viewport: BrowserViewportSize
): { x: number; y: number } | null {
  const fitted = fitViewportIntoRect(bounds, viewport);
  if (
    fitted.width <= 0 ||
    fitted.height <= 0 ||
    clientX < fitted.left ||
    clientY < fitted.top ||
    clientX > fitted.left + fitted.width ||
    clientY > fitted.top + fitted.height
  ) return null;
  return {
    x: ((clientX - fitted.left) / fitted.width) * viewport.width,
    y: ((clientY - fitted.top) / fitted.height) * viewport.height
  };
}

export function modifierMaskFromEvent(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function pointerButton(button: number): "none" | "left" | "middle" | "right" | "back" | "forward" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  if (button === 3) return "back";
  if (button === 4) return "forward";
  return "none";
}

function pressedButton(buttons: number): "none" | "left" | "middle" | "right" | "back" | "forward" {
  if (buttons & 1) return "left";
  if (buttons & 4) return "middle";
  if (buttons & 2) return "right";
  if (buttons & 8) return "back";
  if (buttons & 16) return "forward";
  return "none";
}

async function decodeFrame(source: string | Blob): Promise<DecodedFrame> {
  if (source instanceof Blob && typeof createImageBitmap === "function") {
    const image = await createImageBitmap(source);
    return { capturedAt: "", image, dispose: () => image.close() };
  }
  let objectUrl: string | null = null;
  const imageUrl = typeof source === "string" ? source : (objectUrl = URL.createObjectURL(source));
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Browser frame could not be decoded."));
  });
  image.src = imageUrl;
  await loaded.finally(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
  return { capturedAt: "", image, dispose: () => undefined };
}

export const BrowserCanvas = forwardRef<BrowserCanvasHandle, BrowserCanvasProps>(function BrowserCanvas(
  { ariaLabel, viewportSize, interactive, source, capturedAt, onInput },
  forwardedRef
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef(viewportSize);
  const inputRef = useRef(onInput);
  const historyRef = useRef<DecodedFrame[]>([]);
  const pendingRef = useRef<PendingFrame | null>(null);
  const decodingRef = useRef(false);
  const disposedRef = useRef(false);
  const selectedIndexRef = useRef<number | null>(null);
  const lastPropFrameRef = useRef<string | null>(null);
  const lastPointerPointRef = useRef(new Map<number, { x: number; y: number; button: ReturnType<typeof pointerButton> }>());
  const hasFrameRef = useRef(false);
  const [hasFrame, setHasFrame] = useState(false);

  viewportRef.current = viewportSize;
  inputRef.current = onInput;

  function draw(frame: DecodedFrame | undefined) {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const { density, pixelWidth, pixelHeight, width, height } = quantizeCanvasDrawSize(bounds, window.devicePixelRatio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    context.setTransform(density, 0, 0, density, 0, 0);
    context.fillStyle = "#070909";
    context.fillRect(0, 0, width, height);
    const fitted = fitViewportIntoRect({ left: 0, top: 0, width, height }, viewportRef.current);
    context.drawImage(frame.image, fitted.left, fitted.top, fitted.width, fitted.height);
  }

  async function pumpFrames() {
    if (decodingRef.current) return;
    decodingRef.current = true;
    try {
      while (!disposedRef.current && pendingRef.current) {
        const pending = pendingRef.current;
        pendingRef.current = null;
        let decoded: DecodedFrame;
        try {
          decoded = await decodeFrame(pending.source);
        } catch {
          continue;
        }
        decoded.capturedAt = pending.capturedAt;
        if (disposedRef.current) {
          decoded.dispose();
          continue;
        }
        historyRef.current.push(decoded);
        while (historyRef.current.length > MAX_FRAME_HISTORY) historyRef.current.shift()?.dispose();
        if (selectedIndexRef.current === null) draw(decoded);
        if (!hasFrameRef.current) {
          hasFrameRef.current = true;
          setHasFrame(true);
        }
      }
    } finally {
      decodingRef.current = false;
      if (!disposedRef.current && pendingRef.current) void pumpFrames();
    }
  }

  function present(nextSource: string | Blob, nextCapturedAt = new Date().toISOString()) {
    pendingRef.current = { source: nextSource, capturedAt: nextCapturedAt };
    void pumpFrames();
  }

  useImperativeHandle(forwardedRef, () => ({
    present,
    showHistory(index) {
      selectedIndexRef.current = index;
      draw(index === null ? historyRef.current.at(-1) : historyRef.current[index]);
    },
    historyLength: () => historyRef.current.length,
    focus: () => canvasRef.current?.focus()
  }));

  useEffect(() => {
    const identity = source ? `${capturedAt ?? ""}:${source}` : null;
    if (!source || identity === lastPropFrameRef.current) return;
    lastPropFrameRef.current = identity;
    present(source, capturedAt ?? undefined);
  }, [capturedAt, source]);

  useEffect(() => {
    draw(selectedIndexRef.current === null ? historyRef.current.at(-1) : historyRef.current[selectedIndexRef.current]);
  }, [viewportSize.height, viewportSize.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const redraw = () => draw(selectedIndexRef.current === null ? historyRef.current.at(-1) : historyRef.current[selectedIndexRef.current]);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    observer?.observe(canvas);
    window.addEventListener("resize", redraw);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", redraw);
    };
  }, []);

  useEffect(() => () => {
    disposedRef.current = true;
    pendingRef.current = null;
    for (const frame of historyRef.current) frame.dispose();
    historyRef.current = [];
  }, []);

  function point(event: PointerEvent | WheelEvent) {
    const canvas = canvasRef.current;
    return canvas ? mapClientPointToViewport(event.clientX, event.clientY, canvas.getBoundingClientRect(), viewportRef.current) : null;
  }

  function pointerInput(event: PointerEvent, eventType: "mouseMoved" | "mousePressed" | "mouseReleased") {
    if (!interactive) return;
    const previousPointer = lastPointerPointRef.current.get(event.pointerId);
    const mapped = point(event) ?? (eventType === "mouseReleased" ? previousPointer : undefined);
    if (!mapped) {
      if (eventType === "mouseReleased") lastPointerPointRef.current.delete(event.pointerId);
      return;
    }
    event.preventDefault();
    if (event.pointerType === "touch") {
      if (eventType !== "mouseReleased") lastPointerPointRef.current.set(event.pointerId, { ...mapped, button: "left" });
      inputRef.current({
        type: "TOUCH",
        eventType: eventType === "mousePressed" ? "touchStart" : eventType === "mouseReleased" ? "touchEnd" : "touchMove",
        touchPoints: eventType === "mouseReleased" ? [] : [{ x: mapped.x, y: mapped.y, id: Math.max(0, event.pointerId), force: event.pressure }],
        modifiers: modifierMaskFromEvent(event)
      });
      if (eventType === "mouseReleased") lastPointerPointRef.current.delete(event.pointerId);
      return;
    }
    const reportedButton = eventType === "mouseMoved" ? pressedButton(event.buttons) : pointerButton(event.button);
    const button = eventType === "mouseReleased" && reportedButton === "none"
      ? previousPointer?.button ?? "none"
      : reportedButton;
    if (eventType !== "mouseReleased") lastPointerPointRef.current.set(event.pointerId, { ...mapped, button });
    inputRef.current({
      type: "POINTER",
      eventType,
      ...mapped,
      button,
      ...(eventType === "mouseMoved" ? {} : { clickCount: Math.max(1, Math.min(4, event.detail || 1)) }),
      modifiers: modifierMaskFromEvent(event)
    });
    if (eventType === "mouseReleased") lastPointerPointRef.current.delete(event.pointerId);
  }

  return (
    <div className={`browser-canvas-surface${interactive ? " interactive" : ""}`}>
      <canvas
        ref={canvasRef}
        className="browser-canvas"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          pointerInput(event, "mousePressed");
        }}
        onPointerMove={(event) => pointerInput(event, "mouseMoved")}
        onPointerUp={(event) => {
          pointerInput(event, "mouseReleased");
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (interactive && event.pointerType === "touch") {
            inputRef.current({ type: "TOUCH", eventType: "touchCancel", touchPoints: [], modifiers: modifierMaskFromEvent(event) });
          } else if (interactive) {
            const previousPointer = lastPointerPointRef.current.get(event.pointerId);
            const mapped = point(event) ?? previousPointer;
            if (mapped) {
              const reportedButton = pointerButton(event.button);
              inputRef.current({
                type: "POINTER",
                eventType: "mouseReleased",
                ...mapped,
                button: reportedButton === "none" ? previousPointer?.button ?? "none" : reportedButton,
                clickCount: Math.max(1, Math.min(4, event.detail || 1)),
                modifiers: modifierMaskFromEvent(event)
              });
            }
          }
          lastPointerPointRef.current.delete(event.pointerId);
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onWheel={(event) => {
          if (!interactive) return;
          const mapped = point(event);
          if (!mapped) return;
          event.preventDefault();
          inputRef.current({
            type: "POINTER",
            eventType: "mouseWheel",
            ...mapped,
            button: "none",
            deltaX: Math.round(event.deltaX),
            deltaY: Math.round(event.deltaY),
            modifiers: modifierMaskFromEvent(event)
          });
        }}
        onKeyDown={(event) => {
          if (!interactive || event.nativeEvent.isComposing) return;
          const isPasteShortcut =
            (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "v";
          if (isPasteShortcut) return;
          event.preventDefault();
          inputRef.current({
            type: "KEY",
            eventType: "keyDown",
            key: event.key,
            code: event.code || undefined,
            ...(event.key.length === 1 ? { text: event.key } : {}),
            modifiers: modifierMaskFromEvent(event)
          });
        }}
        onPaste={(event) => {
          if (!interactive) return;
          const text = event.clipboardData?.getData("text");
          if (!text) return;
          event.preventDefault();
          const native = event.nativeEvent as { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
          inputRef.current({
            type: "KEY",
            eventType: "char",
            key: "Unidentified",
            text,
            modifiers: modifierMaskFromEvent(native)
          });
        }}
        onKeyUp={(event) => {
          if (!interactive || event.nativeEvent.isComposing) return;
          event.preventDefault();
          inputRef.current({
            type: "KEY",
            eventType: "keyUp",
            key: event.key,
            code: event.code || undefined,
            modifiers: modifierMaskFromEvent(event)
          });
        }}
      />
      {!hasFrame ? <span className="browser-canvas-empty" aria-hidden="true" /> : null}
    </div>
  );
});
