import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserCanvas,
  type BrowserCanvasHandle,
  fitViewportIntoRect,
  mapClientPointToViewport,
  modifierMaskFromEvent,
  quantizeCanvasDrawSize
} from "../src/features/browser-pane/BrowserCanvas.js";

describe("BrowserCanvas geometry", () => {
  it("maps only the aspect-fitted browser pixels and rejects letterbox clicks", () => {
    const bounds = { left: 100, top: 50, width: 1_000, height: 1_000 };
    const fitted = fitViewportIntoRect(bounds, { width: 1_440, height: 900 });

    expect(fitted).toEqual({ left: 100, top: 237.5, width: 1_000, height: 625 });
    expect(mapClientPointToViewport(600, 550, bounds, { width: 1_440, height: 900 })).toEqual({ x: 720, y: 450 });
    expect(mapClientPointToViewport(600, 100, bounds, { width: 1_440, height: 900 })).toBeNull();
  });

  it("keeps mobile coordinates accurate when the canvas is much wider than the page", () => {
    const bounds = { left: 0, top: 0, width: 1_000, height: 500 };
    const fitted = fitViewportIntoRect(bounds, { width: 390, height: 844 });

    expect(fitted.width).toBeCloseTo(231.04, 2);
    expect(fitted.left).toBeCloseTo(384.48, 2);
    const center = mapClientPointToViewport(500, 250, bounds, { width: 390, height: 844 });
    expect(center?.x).toBeCloseTo(195, 6);
    expect(center?.y).toBeCloseTo(422, 6);
    expect(mapClientPointToViewport(100, 250, bounds, { width: 390, height: 844 })).toBeNull();
  });

  it("uses the Chrome DevTools modifier bit mask", () => {
    expect(modifierMaskFromEvent({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(11);
    expect(modifierMaskFromEvent({ altKey: false, ctrlKey: false, metaKey: true, shiftKey: false })).toBe(4);
  });

  it("quantizes fractional CSS bounds to the actual canvas pixel buffer", () => {
    expect(quantizeCanvasDrawSize({ width: 144.49, height: 90.51 }, 1)).toEqual({
      density: 1,
      pixelWidth: 144,
      pixelHeight: 91,
      width: 144,
      height: 91
    });
    expect(quantizeCanvasDrawSize({ width: 144.49, height: 90.51 }, 1.5)).toEqual({
      density: 1.5,
      pixelWidth: 217,
      pixelHeight: 136,
      width: 217 / 1.5,
      height: 136 / 1.5
    });
  });
});

describe("BrowserCanvas input surface", () => {
  it.each([["touch", 0], ["mouse", 0], ["touch", 140], ["mouse", 140]] as const)("keeps a bottom %s on its target when focus closes the keyboard (client shift %i)", async (pointerType, clientShift) => {
    const ref = createRef<BrowserCanvasHandle>();
    const onInput = vi.fn();
    const visualViewport = { width: 411, height: 480, offsetTop: 140, offsetLeft: 0, scale: 1 };
    vi.stubGlobal("devicePixelRatio", 3.5);
    vi.stubGlobal("innerWidth", 411);
    vi.stubGlobal("innerHeight", 891);
    vi.stubGlobal("visualViewport", visualViewport);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 780, height: 1688, close: vi.fn() })));
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const view = render(<BrowserCanvas ref={ref} ariaLabel="Keyboard resize target" interactive viewportSize={{ width: 390, height: 844 }} onInput={onInput} />);
    const canvas = screen.getByRole("img", { name: "Keyboard resize target" }) as HTMLCanvasElement;
    const focus = vi.spyOn(canvas, "focus");
    const rect = (height: number) => ({ left: 12, top: 280, width: 387, height, right: 399, bottom: 280 + height, x: 12, y: 280, toJSON: () => null });
    const bounds = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(180));
    // Focusing the non-editable canvas can blur the keyboard's input and restore the larger pane.
    canvas.addEventListener("focus", () => {
      visualViewport.height = 891;
      visualViewport.offsetTop = 0;
      bounds.mockReturnValue(rect(420));
    });
    try {
      await act(async () => ref.current?.present(new Blob(["remote mobile frame"])));
      // Client coordinates and bounds share the layout-viewport origin. Neither DPR nor offsetTop is added.
      const clientY = 280 + 180 * 820 / 844;
      fireEvent.pointerDown(canvas, { pointerType, pointerId: 7, clientX: 205.5, clientY, button: 0, buttons: 1 });
      fireEvent.pointerMove(canvas, { pointerType, pointerId: 7, clientX: 205.5, clientY: clientY - clientShift, button: 0, buttons: 1 });
      fireEvent.pointerUp(canvas, { pointerType, pointerId: 7, clientX: 205.5, clientY: clientY - clientShift, button: 0, buttons: 0 });
      expect(document.activeElement).toBe(canvas);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(visualViewport).toMatchObject({ height: 891, offsetTop: 0 });
      const points = onInput.mock.calls.flatMap(([input]) => input.type === "TOUCH" ? input.touchPoints : [input]);
      expect(points).toHaveLength(pointerType === "touch" ? 2 : 3);
      for (const point of points) {
        expect(point.x).toBeCloseTo(195, 6);
        expect(point.y).toBeCloseTo(820, 6);
      }
    } finally { view.unmount(); context.mockRestore(); vi.unstubAllGlobals(); }
  });

  it.each(["touch", "mouse"])("maps a bottom %s on a DPR 2 mobile frame to CSS coordinates", async (pointerType) => {
    const ref = createRef<BrowserCanvasHandle>();
    const onInput = vi.fn();
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 780, height: 1688, close: vi.fn() })));
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const view = render(<BrowserCanvas ref={ref} ariaLabel="Mobile bottom target" interactive viewportSize={{ width: 390, height: 844 }} onInput={onInput} />);
    const canvas = screen.getByRole("img", { name: "Mobile bottom target" }) as HTMLCanvasElement;
    // The portrait frame is letterboxed inside a wider canvas, as in the copilot rail.
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 20, top: 270, width: 600, height: 422, right: 620, bottom: 692, x: 20, y: 270, toJSON: () => null });
    try {
      await act(async () => ref.current?.present(new Blob(["DPR 2 frame"])));
      fireEvent.pointerDown(canvas, { pointerType, pointerId: 7, clientX: 320, clientY: 680, button: 0, buttons: 1 });
      fireEvent.pointerUp(canvas, { pointerType, pointerId: 7, clientX: 320, clientY: 680, button: 0, buttons: 0 });
      expect(canvas.width).toBe(1200);
      expect(canvas.height).toBe(844);
      if (pointerType === "touch") {
        expect(onInput.mock.calls.map(([input]) => input)).toEqual([
          expect.objectContaining({ type: "TOUCH", eventType: "touchStart", touchPoints: [expect.objectContaining({ x: 195, y: 820 })] }),
          expect.objectContaining({ type: "TOUCH", eventType: "touchEnd", touchPoints: [] })
        ]);
      } else {
        expect(onInput.mock.calls.map(([input]) => input)).toEqual([
          expect.objectContaining({ type: "POINTER", eventType: "mousePressed", x: 195, y: 820 }),
          expect.objectContaining({ type: "POINTER", eventType: "mouseReleased", x: 195, y: 820 })
        ]);
      }
    } finally { view.unmount(); context.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("sends the Enter character needed to submit remote password forms", () => {
    const onInput = vi.fn();
    render(<BrowserCanvas ariaLabel="Password form" interactive viewportSize={{ width: 800, height: 600 }} onInput={onInput} />);
    const canvas = screen.getByRole("img", { name: "Password form" });
    fireEvent.keyDown(canvas, { key: "Enter", code: "Enter" });
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ type: "KEY", eventType: "keyDown", key: "Enter", text: "\r" }));
  });
  it("leaves Ctrl+V on a Greek layout and Shift+Insert to the browser's paste", () => {
    const onInput = vi.fn();
    render(<BrowserCanvas ariaLabel="Paste" interactive viewportSize={{ width: 800, height: 600 }} onInput={onInput} />);
    const canvas = screen.getByRole("img", { name: "Paste" });
    expect(fireEvent.keyDown(canvas, { key: "ω", code: "KeyV", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(canvas, { key: "Insert", code: "Insert", shiftKey: true })).toBe(true);
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.paste(canvas, { clipboardData: { getData: () => "κωδικός" } });
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({ type: "KEY", eventType: "char", text: "κωδικός" }));
  });
  it("is keyboard focusable and emits normalized pointer, wheel and key input", () => {
    const inputs: Array<Record<string, unknown>> = [];
    const canvasRef = createRef<BrowserCanvasHandle>();
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();

    render(
      <BrowserCanvas
        ref={canvasRef}
        ariaLabel="Research Browser browser frame"
        interactive
        viewportSize={{ width: 1_440, height: 900 }}
        onInput={(input) => inputs.push(input)}
      />
    );

    const canvas = screen.getByRole("img", { name: "Research Browser browser frame" }) as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 144,
      height: 90,
      right: 144,
      bottom: 90,
      x: 0,
      y: 0,
      toJSON: () => undefined
    });
    Object.assign(canvas, { setPointerCapture, releasePointerCapture });

    expect(canvas.tabIndex).toBe(0);
    fireEvent.pointerDown(canvas, { clientX: 72, clientY: 45, button: 0, buttons: 1, detail: 1, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerMove(canvas, { clientX: 80, clientY: 50, button: 0, buttons: 1, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerUp(canvas, { clientX: 80, clientY: 50, button: 0, buttons: 0, detail: 1, pointerId: 7, pointerType: "mouse" });
    fireEvent.wheel(canvas, { clientX: 72, clientY: 45, deltaX: 3, deltaY: 120 });
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA", ctrlKey: true });
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA", ctrlKey: true });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(inputs).toEqual([
      expect.objectContaining({ type: "POINTER", eventType: "mousePressed", x: 720, y: 450, button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "POINTER", eventType: "mouseMoved", button: "left" }),
      expect.objectContaining({ type: "POINTER", eventType: "mouseReleased", button: "left", clickCount: 1 }),
      expect.objectContaining({ type: "POINTER", eventType: "mouseWheel", x: 720, y: 450, deltaX: 3, deltaY: 120 }),
      expect.objectContaining({ type: "KEY", eventType: "keyDown", key: "a", code: "KeyA", text: "a", modifiers: 2 }),
      expect.objectContaining({ type: "KEY", eventType: "keyUp", key: "a", code: "KeyA", modifiers: 2 })
    ]);
  });

  it("retains fractional trackpad deltas, normalizes wheel units and prevents outer scrolling", () => {
    const onInput = vi.fn();
    render(<BrowserCanvas ariaLabel="Scroll" interactive viewportSize={{ width: 1440, height: 900 }} onInput={onInput} />);
    const canvas = screen.getByRole("img", { name: "Scroll" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ x:0,y:0,left:0,top:0,right:1440,bottom:900,width:1440,height:900,toJSON:()=>({}) });
    for (const [deltaMode, deltaY, expected] of [[0, 0.25, 0.25], [1, 3, 48], [2, 1, 900]]) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 100, clientY: 100, deltaMode, deltaY });
      fireEvent(canvas, event);
      expect(event.defaultPrevented).toBe(true);
      expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({ eventType: "mouseWheel", deltaY: expected }));
    }
  });

  it("releases captured mouse input when the pointer is cancelled", () => {
    const inputs: Array<Record<string, unknown>> = [];
    const releasePointerCapture = vi.fn();

    render(
      <BrowserCanvas
        ariaLabel="Cancelled pointer browser frame"
        interactive
        viewportSize={{ width: 1_440, height: 900 }}
        onInput={(input) => inputs.push(input)}
      />
    );

    const canvas = screen.getByRole("img", { name: "Cancelled pointer browser frame" }) as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 144,
      height: 90,
      right: 144,
      bottom: 90,
      x: 0,
      y: 0,
      toJSON: () => undefined
    });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture });

    fireEvent.pointerDown(canvas, {
      clientX: 72,
      clientY: 45,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 9,
      pointerType: "mouse"
    });
    fireEvent.pointerCancel(canvas, {
      clientX: 72,
      clientY: 45,
      button: -1,
      buttons: 0,
      detail: 1,
      pointerId: 9,
      pointerType: "mouse"
    });

    expect(inputs.map((input) => input.eventType)).toEqual(["mousePressed", "mouseReleased"]);
    expect(inputs[1]).toMatchObject({ button: "left" });
    expect(releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it("releases captured mouse input at the last valid point after entering the letterbox", () => {
    const inputs: Array<Record<string, unknown>> = [];

    render(
      <BrowserCanvas
        ariaLabel="Letterbox release browser frame"
        interactive
        viewportSize={{ width: 1_440, height: 900 }}
        onInput={(input) => inputs.push(input)}
      />
    );

    const canvas = screen.getByRole("img", { name: "Letterbox release browser frame" }) as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => undefined
    });
    Object.assign(canvas, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });

    fireEvent.pointerDown(canvas, {
      clientX: 50,
      clientY: 50,
      button: 0,
      buttons: 1,
      detail: 1,
      pointerId: 10,
      pointerType: "mouse"
    });
    fireEvent.pointerUp(canvas, {
      clientX: 50,
      clientY: 5,
      button: 0,
      buttons: 0,
      detail: 1,
      pointerId: 10,
      pointerType: "mouse"
    });

    expect(inputs).toEqual([
      expect.objectContaining({ eventType: "mousePressed", x: 720, y: 450 }),
      expect.objectContaining({ eventType: "mouseReleased", x: 720, y: 450 })
    ]);
  });

  it("maps input to the displayed frame while a resized frame is still decoding", async () => {
    const ref = createRef<BrowserCanvasHandle>();
    const inputs: Array<Record<string, unknown>> = [];
    const decoded: Array<(image: ImageBitmap) => void> = [];
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => decoded.push(resolve))));
    const view = render(<BrowserCanvas ref={ref} ariaLabel="Resize mapping" interactive viewportSize={{ width: 1440, height: 900 }} onInput={(input) => inputs.push(input)} />);
    const canvas = screen.getByRole("img", { name: "Resize mapping" }) as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => null });
    try {
      act(() => ref.current?.present(new Blob(["old"]), undefined, { width: 1440, height: 900 }));
      await act(async () => decoded.shift()!({ close: vi.fn() } as unknown as ImageBitmap));
      act(() => ref.current?.present(new Blob(["new"]), undefined, { width: 800, height: 600 }));
      fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0, pointerId: 1 });
      expect(inputs.at(-1)).toMatchObject({ x: 720, y: 450 });
      await act(async () => decoded.shift()!({ close: vi.fn() } as unknown as ImageBitmap));
      fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300, button: 0, pointerId: 1 });
      expect(inputs.at(-1)).toMatchObject({ x: 400, y: 300 });
    } finally { view.unmount(); context.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("reuses the observed draw size across streamed frames while input reads fresh bounds", async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { observers.push(callback); }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    const ref = createRef<BrowserCanvasHandle>();
    const inputs: Array<Record<string, unknown>> = [];
    const view = render(<BrowserCanvas ref={ref} ariaLabel="Cached size" interactive viewportSize={{ width: 1440, height: 900 }} onInput={(input) => inputs.push(input)} />);
    const canvas = screen.getByRole("img", { name: "Cached size" }) as HTMLCanvasElement;
    const rect = (left: number, width: number, height: number) => ({ left, top: 0, width, height, right: left + width, bottom: height, x: left, y: 0, toJSON: () => null });
    const bounds = vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(rect(0, 144, 90));
    try {
      for (let i = 0; i < 3; i++) await act(async () => { ref.current?.present(new Blob([String(i)])); });
      expect(bounds).toHaveBeenCalledTimes(1);
      expect(canvas.width).toBe(144);

      bounds.mockReturnValue(rect(0, 288, 180));
      act(() => observers.forEach((callback) => callback()));
      expect(bounds).toHaveBeenCalledTimes(2);
      expect(canvas.width).toBe(288);
      await act(async () => { ref.current?.present(new Blob(["after resize"])); });
      expect(bounds).toHaveBeenCalledTimes(2);

      // A moved canvas keeps its size, so input must not rely on the cached draw size.
      bounds.mockReturnValue(rect(100, 288, 180));
      fireEvent.pointerDown(canvas, { clientX: 244, clientY: 90, button: 0, pointerId: 1 });
      expect(inputs.at(-1)).toMatchObject({ eventType: "mousePressed", x: 720, y: 450 });
    } finally { view.unmount(); context.mockRestore(); vi.unstubAllGlobals(); }
  });

  it("releases decoded timeline history as soon as live-only rendering resumes", async () => {
    const ref = createRef<BrowserCanvasHandle>();
    const images = Array.from({ length: 3 }, () => ({ close: vi.fn() }));
    let next = 0;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => images[next++]));
    const props = { ariaLabel: "History memory", interactive: false, viewportSize: { width: 1440, height: 900 }, onInput: () => {} };
    const view = render(<BrowserCanvas ref={ref} {...props} historyLimit={48} />);
    try {
      for (let i = 0; i < 3; i++) await act(async () => { ref.current?.present(new Blob([String(i)])); });
      expect(ref.current?.historyLength()).toBe(3);
      view.rerender(<BrowserCanvas ref={ref} {...props} historyLimit={1} />);
      expect(ref.current?.historyLength()).toBe(1);
      expect(images[0]!.close).toHaveBeenCalledOnce();
      expect(images[1]!.close).toHaveBeenCalledOnce();
      expect(images[2]!.close).not.toHaveBeenCalled();
      view.unmount();
      expect(images[2]!.close).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("draws a decoded frame even when a newer frame arrives during decoding", async () => {
    const canvasRef = createRef<BrowserCanvasHandle>();
    const drawImage = vi.fn();
    const decodedFrames: Array<(image: ImageBitmap) => void> = [];
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      drawImage,
      fillStyle: ""
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => decodedFrames.push(resolve))));

    render(
      <BrowserCanvas
        ref={canvasRef}
        ariaLabel="Slow decode browser frame"
        interactive
        viewportSize={{ width: 1_440, height: 900 }}
        onInput={() => undefined}
      />
    );
    const canvas = screen.getByRole("img", { name: "Slow decode browser frame" }) as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 144,
      height: 90,
      right: 144,
      bottom: 90,
      x: 0,
      y: 0,
      toJSON: () => undefined
    });

    act(() => {
      canvasRef.current?.present(new Blob(["first"], { type: "image/jpeg" }), "2026-07-18T00:00:00.000Z");
      canvasRef.current?.present(new Blob(["second"], { type: "image/jpeg" }), "2026-07-18T00:00:00.050Z");
    });
    expect(decodedFrames).toHaveLength(1);

    await act(async () => {
      decodedFrames[0]!({ close: vi.fn() } as unknown as ImageBitmap);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(drawImage).toHaveBeenCalledOnce();
    getContext.mockRestore();
    vi.unstubAllGlobals();
  });
});
