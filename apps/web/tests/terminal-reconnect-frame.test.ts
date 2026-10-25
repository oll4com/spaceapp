import { afterEach, expect, it, vi } from "vitest";
import { holdTerminalReconnectFrame } from "../src/features/terminal-pane/terminal-reconnect-frame.js";

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const viewport = document.createElement("div");
  const host = document.createElement("div");
  host.innerHTML = '<div class="xterm xterm-dom-renderer-owner-1"><textarea>private draft</textarea><div class="xterm-scrollable-element"><div class="xterm-screen"><style>.xterm-dom-renderer-owner-1 .xterm-rows { color: white; }</style><div class="xterm-rows"><div>visible output</div></div></div></div></div>';
  viewport.append(host); document.body.append(viewport);
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 400, height: 200 } as DOMRect);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 30, top: 40, width: 400, height: 200 } as DOMRect);
  vi.spyOn(host.querySelector(".xterm-screen")!, "getBoundingClientRect").mockReturnValue({ left: 42, top: 52, width: 370, height: 176 } as DOMRect);
  return { viewport, host };
}

it("retains only painted output after disposing the original renderer", () => {
  const { viewport, host } = fixture();
  const held = holdTerminalReconnectFrame(host);
  expect(held).not.toBeNull();
  host.replaceChildren();
  const frame = viewport.querySelector<HTMLElement>("[data-terminal-reconnect-frame]")!;
  expect(frame.textContent).toContain("visible output");
  expect(frame.textContent).not.toContain("private draft");
  expect(frame.querySelector("textarea")).toBeNull();
  expect(frame.getAttribute("aria-hidden")).toBe("true");
  expect(frame.inert).toBe(true);
  expect(frame.querySelector("style")).not.toBeNull();
  const surface = frame.querySelector<HTMLElement>(".xterm-dom-renderer-owner-1")!;
  expect(surface).not.toBeNull();
  expect(surface.style.left).toBe("12px");
  expect(surface.style.top).toBe("12px");
  expect(host.querySelector("[data-terminal-reconnect-frame]")).toBeNull();
  held!.dispose(); held!.dispose();
  expect(viewport.querySelector("[data-terminal-reconnect-frame]")).toBeNull();
});

it("does not capture detached, empty, or minimized zero-size surfaces", () => {
  const { viewport, host } = fixture();
  vi.mocked(host.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect);
  expect(holdTerminalReconnectFrame(host)).toBeNull();
  vi.mocked(host.getBoundingClientRect).mockReturnValue({ width: 400, height: 200 } as DOMRect);
  host.querySelector(".xterm-rows")!.replaceChildren();
  expect(holdTerminalReconnectFrame(host)).toBeNull();
  viewport.remove();
  expect(holdTerminalReconnectFrame(host)).toBeNull();
});

it("keeps the image until the new renderer paints and disposes its listener", () => {
  const { viewport, host } = fixture();
  const held = holdTerminalReconnectFrame(host)!;
  let painted = () => {};
  const dispose = vi.fn();
  const refresh = vi.fn();
  held.releaseAfterPaint({ rows: 20, onRender: (listener: () => void) => {
    painted = listener; return { dispose };
  }, refresh } as never, { replay: true, geometry: true });
  expect(refresh).toHaveBeenCalledWith(0, 19);
  expect(viewport.querySelector("[data-terminal-reconnect-frame]")).not.toBeNull();
  painted();
  expect(viewport.querySelector("[data-terminal-reconnect-frame]")).toBeNull();
  expect(dispose).toHaveBeenCalledTimes(1);
});

it("removes a failed reconnect image within the bounded hold", () => {
  vi.useFakeTimers();
  const { viewport, host } = fixture();
  holdTerminalReconnectFrame(host);
  vi.advanceTimersByTime(10_000);
  expect(viewport.querySelector("[data-terminal-reconnect-frame]")).toBeNull();
});

for (const first of ["replay", "geometry"] as const) {
  it(`waits for both readiness signals when ${first} arrives first`, () => {
    const { viewport, host } = fixture();
    const held = holdTerminalReconnectFrame(host)!;
    let painted: (() => void) | undefined;
    const terminal = { rows: 20, onRender: (listener: () => void) => {
      painted = listener; return { dispose() {} };
    }, refresh() {} } as never;
    held.releaseAfterPaint(terminal, { replay: first === "replay", geometry: first === "geometry" });
    expect(painted).toBeUndefined();
    const frame = viewport.querySelector<HTMLElement>("[data-terminal-reconnect-frame]")!;
    expect(frame.isConnected).toBe(true);
    held.releaseAfterPaint(terminal, { replay: true, geometry: true });
    painted!();
    expect(frame.isConnected).toBe(false);
    expect(frame.dataset.releaseReason).toBe("paint");
  });
}
