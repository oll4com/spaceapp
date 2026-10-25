// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { SnipToolOverlay } from "../src/features/snip-tool/SnipToolOverlay.js";
import { WorkspaceSurface } from "../src/features/ui-theme/WorkspaceSurface.js";
import { captureSnipFrame } from "../src/features/snip-tool/snip-capture.js";
import { exportSnip, frameFromBlob } from "../src/features/snip-tool/snip-image.js";
import { captureDomFrame, SnipDomUnsupportedError } from "../src/features/snip-tool/snip-dom-capture.js";
vi.mock("../src/features/snip-tool/snip-capture.js", async () => {
  const actual = await vi.importActual<any>("../src/features/snip-tool/snip-capture.js");
  return { ...actual, captureSnipFrame: vi.fn() };
});
vi.mock("../src/features/snip-tool/snip-dom-capture.js", async () => {
  const actual = await vi.importActual<any>("../src/features/snip-tool/snip-dom-capture.js");
  return { ...actual, captureDomFrame: vi.fn(), prepareDomCapture: vi.fn() };
});
vi.mock("../src/features/snip-tool/snip-image.js", async () => {
  const actual = await vi.importActual<any>("../src/features/snip-tool/snip-image.js");
  return { ...actual, exportSnip: vi.fn(), frameFromBlob: vi.fn() };
});

const panes = [{ id: "pane:1", title: "First", mode: "TERMINAL" }, { id: "pane:2", title: "Second", mode: "CHAT" }];
const cliPanes = [
  { id: "pane:finn", title: "CLI 1 - /opt/spaceapp", mode: "TERMINAL", paneName: "Finn" },
  { id: "pane:hugo", title: "CLI 2 - /opt/spaceapp", mode: "TERMINAL", paneName: "Hugo" }
];
const frame = (width = 800, height = 600) => ({ source: {} as CanvasImageSource, width, height, close: vi.fn() });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(captureSnipFrame).mockImplementation(async (_el, _signal, options) => { options?.onSource?.(true); return frame(); });
  // The permission-free page capture returns just the selected region at device pixels.
  vi.mocked(captureDomFrame).mockImplementation(async ({ region }) => frame(region.width, region.height));
  vi.mocked(exportSnip).mockResolvedValue(new Blob(["edited"], { type: "image/png" }));
  vi.mocked(frameFromBlob).mockImplementation(async () => frame());
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.hasPointerCapture = vi.fn(() => false); HTMLElement.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal("ClipboardItem", class { constructor(public items: unknown) {} });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: vi.fn().mockResolvedValue(undefined) } });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:snip") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    fillText: vi.fn(), strokeText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), closePath: vi.fn(), fill: vi.fn()
  } as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const layer = () => screen.getByRole("dialog", { name: "Snip selection" });
function dragRegion(from: [number, number], to: [number, number]) {
  const el = layer();
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], button: 0 });
  fireEvent.pointerMove(el, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(el, { clientX: to[0], clientY: to[1], button: 0 });
}
async function openEditor(props: Partial<React.ComponentProps<typeof SnipToolOverlay>> = {}) {
  const utils = render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn().mockResolvedValue(undefined)} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit before send" }));
  fireEvent.click(screen.getByRole("button", { name: /^Capture full screen/ }));
  await screen.findByRole("dialog", { name: "Edit snip" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy image" })).toHaveProperty("disabled", false));
  return utils;
}

describe("Snip Tool capsule", () => {
  it("is the only toolbar: no expanded HUD, even for the legacy toolbar mode", () => {
    render(<SnipToolOverlay initialMode="toolbar" isOpen onClose={vi.fn()} activePaneId="pane:1" activePaneName="Finn" onCapture={vi.fn()} />);
    const capsule = screen.getByRole("region", { name: "Snip Tool" });
    expect(capsule.classList.contains("snip-capsule")).toBe(true);
    expect(screen.getByRole("button", { name: "Snip: Finn" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show full toolbar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Full Screen" })).toBeNull();
    expect(screen.queryByText(/captured/)).toBeNull();
  });

  it("closes from its close button", () => {
    const onClose = vi.fn();
    render(<SnipToolOverlay isOpen onClose={onClose} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Snip Tool" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("drags to a new position, persists it, and double-click resets it", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    const capsule = screen.getByRole("region", { name: "Snip Tool" });
    fireEvent.pointerDown(capsule, { clientX: 200, clientY: 200, button: 0 });
    fireEvent.pointerMove(capsule, { clientX: 150, clientY: 300 });
    fireEvent.pointerUp(capsule, { clientX: 150, clientY: 300, button: 0 });
    const saved = JSON.parse(localStorage.getItem("space.snip-tool.positions.v1") || "{}");
    expect(saved.float.y).toBeGreaterThan(72);
    fireEvent.doubleClick(capsule.querySelector(".snip-capsule-grip")!);
    expect(JSON.parse(localStorage.getItem("space.snip-tool.positions.v1") || "{}").float).toBeUndefined();
  });

  it("keeps dragging when the pointer leaves the capsule at once, and lets go on release", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    const capsule = screen.getByRole("region", { name: "Snip Tool" });
    const position = () => ({ x: parseFloat(capsule.style.left), y: parseFloat(capsule.style.top) });
    const start = position();
    fireEvent.pointerDown(capsule.querySelector(".snip-capsule-grip")!, { clientX: 600, clientY: 90, button: 0 });
    // Every move and the release land outside the capsule, as with an ordinary flick of the mouse.
    fireEvent.pointerMove(document.body, { clientX: 400, clientY: 290 });
    fireEvent.pointerUp(document.body, { clientX: 400, clientY: 290, button: 0 });
    expect(position()).toEqual({ x: start.x - 200, y: start.y + 200 });
    expect(JSON.parse(localStorage.getItem("space.snip-tool.positions.v1") || "{}").float).toEqual(position());
    fireEvent.pointerMove(capsule, { clientX: 100, clientY: 100 });
    expect(position()).toEqual({ x: start.x - 200, y: start.y + 200 });
  });

  it("never steals Tab or Escape from the rest of the app while idle", () => {
    const onClose = vi.fn();
    const outside = document.createElement("textarea"); document.body.append(outside); outside.focus();
    render(<SnipToolOverlay isOpen onClose={onClose} onCapture={vi.fn()} />);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    outside.dispatchEvent(tab);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    outside.dispatchEvent(escape);
    expect(tab.defaultPrevented).toBe(false); expect(escape.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(outside); expect(onClose).not.toHaveBeenCalled();
    outside.remove();
  });

  it("closes on Escape when the capsule itself has focus", () => {
    const onClose = vi.fn();
    render(<SnipToolOverlay isOpen onClose={onClose} onCapture={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Snip:/ }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not move keyboard focus away from the pane when a capsule button is pressed", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    screen.getByRole("button", { name: "Enable clipboard mode" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("Snip Tool capture", () => {
  it("snips a region of the page without screen sharing and offers Edit afterwards", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:1" activePaneName="Finn" availablePanes={[{ ...panes[0]!, paneName: "Finn" }]} roomId="room:one" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Snip: Finn" }));
    expect(layer().textContent).toContain("Finn");
    dragRegion([350, 280], [50, 40]);
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(vi.mocked(captureDomFrame).mock.calls[0]![0].region).toEqual({ x: 50, y: 40, width: 300, height: 240 });
    expect(captureSnipFrame).not.toHaveBeenCalled();
    expect(vi.mocked(exportSnip).mock.calls[0]![1]).toEqual({ x: 0, y: 0, width: 300, height: 240 });
    expect(onCapture.mock.calls[0]!.slice(1, 3)).toEqual(["pane:1", "room:one"]);
    expect(await screen.findByText("Sent to Finn.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("dialog", { name: "Edit snip" });
    expect((within(editor).getByLabelText("Crop x") as HTMLInputElement).value).toBe("0");
    expect((within(editor).getByLabelText("Crop width") as HTMLInputElement).value).toBe("300");
    expect((within(editor).getByLabelText("Crop height") as HTMLInputElement).value).toBe("240");
  });

  it("shows no hint bar or buttons while selecting, only the selection surface", () => {
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(within(layer()).queryAllByRole("button")).toEqual([]);
    expect(layer().querySelector(".snip-layer-hint")).toBeNull();
  });

  it("falls back to screen sharing only for areas the page cannot redraw, scaled to native pixels", async () => {
    vi.mocked(captureDomFrame).mockRejectedValue(new SnipDomUnsupportedError("an embedded page"));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} onCapture={vi.fn().mockResolvedValue(undefined)} />);
    dragRegion([20, 100], [120, 200]);
    await waitFor(() => expect(exportSnip).toHaveBeenCalledOnce());
    expect(captureSnipFrame).toHaveBeenCalledOnce();
    expect(vi.mocked(exportSnip).mock.calls[0]![1]).toEqual({ x: 40, y: 200, width: 200, height: 200 });
    expect(await screen.findByText("Saved to Media Dock. Screen sharing was used for an embedded page.")).toBeTruthy();
  });

  it("uses screen sharing for every snip when chosen in the menu, and remembers it", async () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    const option = screen.getByRole("menuitemcheckbox", { name: "Use screen sharing" });
    expect(option.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(option);
    expect(localStorage.getItem("space.snip-tool.screen-share.v1")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Capture full screen/ }));
    await waitFor(() => expect(captureSnipFrame).toHaveBeenCalledOnce());
    expect(captureDomFrame).not.toHaveBeenCalled();
  });

  it("saves to Media Dock when no CLI pane is focused", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} availablePanes={panes} onCapture={onCapture} />);
    dragRegion([10, 100], [210, 250]);
    await screen.findByText("Saved to Media Dock.");
    expect(onCapture.mock.calls[0]![1]).toBeNull();
  });

  it("does not capture tiny or cancelled gestures", () => {
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    fireEvent.pointerDown(layer(), { clientX: 10, clientY: 100, button: 0 });
    fireEvent.pointerCancel(layer(), { clientX: 210, clientY: 250 });
    fireEvent.click(screen.getByRole("button", { name: /^Snip:/ }));
    dragRegion([10, 100], [20, 110]);
    expect(captureDomFrame).not.toHaveBeenCalled(); expect(captureSnipFrame).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Snip Tool" })).toBeTruthy();
  });

  it("previews another shared source rather than applying unrelated viewport coordinates", async () => {
    localStorage.setItem("space.snip-tool.screen-share.v1", "true");
    vi.mocked(captureSnipFrame).mockImplementation(async (_el, _signal, options) => { options?.onSource?.(false); return frame(); });
    const onCapture = vi.fn();
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} onCapture={onCapture} />);
    dragRegion([10, 100], [210, 250]);
    await screen.findByText("A different source was selected. Drag to choose your area in this preview.");
    expect(onCapture).not.toHaveBeenCalled(); expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("800");
  });

  it("Enter captures the full screen and Escape cancels back to the capsule", async () => {
    const onClose = vi.fn(), onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen onClose={onClose} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: /^Snip:/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Snip Tool" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Snip:/ }));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(vi.mocked(captureDomFrame).mock.calls[0]![0].region).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(vi.mocked(exportSnip).mock.calls[0]![1]).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("toggles selection from the forwarded PrintScreen trigger", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    act(() => { window.dispatchEvent(new CustomEvent("space:snip-tool:trigger")); });
    expect(layer()).toBeTruthy();
  });

  it("marks the selection surface busy on release and cancels a pending capture on Escape", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(captureDomFrame).mockImplementation(() => new Promise(r => { resolve = r; }));
    const onCapture = vi.fn();
    render(<SnipToolOverlay initialMode="capturing" isOpen onClose={vi.fn()} onCapture={onCapture} />);
    dragRegion([10, 100], [210, 250]);
    expect(layer().getAttribute("aria-busy")).toBe("true");
    expect(layer().classList.contains("is-capturing")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(vi.mocked(captureDomFrame).mock.calls[0]![0].signal!.aborted).toBe(true);
    await act(async () => resolve(frame()));
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Snip Tool" })).toBeTruthy();
  });

  it("does not abort capture when the parent passes a new onClose callback", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(captureDomFrame).mockImplementation(() => new Promise(r => { resolve = r; }));
    const { rerender } = render(<SnipToolOverlay isOpen onClose={() => {}} onCapture={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: /^Capture full screen/ }));
    rerender(<SnipToolOverlay isOpen onClose={() => {}} onCapture={vi.fn().mockResolvedValue(undefined)} />);
    expect(vi.mocked(captureDomFrame).mock.calls[0]![0].signal!.aborted).toBe(false);
    await act(async () => resolve(frame()));
    await screen.findByText("Saved to Media Dock.");
  });

  it("shows a failed send in the toast and keeps the snip for a retry from the editor", async () => {
    const onCapture = vi.fn().mockRejectedValueOnce(new Error("Upload failed")).mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: /^Capture full screen/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Upload failed");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save to Media Dock" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(2));
  });

  it("captures to the clipboard without sending when clipboard mode is on", async () => {
    const onCapture = vi.fn();
    render(<SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode activePaneId="pane:finn" activePaneName="Finn" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Snip: Clipboard" }));
    dragRegion([20, 20], [200, 200]);
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledOnce());
    expect(onCapture).not.toHaveBeenCalled();
    expect(await screen.findByText("Copied to clipboard. Paste with Ctrl+V.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledTimes(2));
  });

  it("captures the full screen 3 seconds after the timer is pressed, and a second press cancels", async () => {
    vi.useFakeTimers();
    try {
      render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn().mockResolvedValue(undefined)} />);
      fireEvent.click(screen.getByRole("button", { name: "Capture in 3 seconds" }));
      act(() => { vi.advanceTimersByTime(1000); });
      fireEvent.click(screen.getByRole("button", { name: "Cancel delayed capture (2)" }));
      act(() => { vi.advanceTimersByTime(5000); });
      expect(captureDomFrame).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Capture in 3 seconds" }));
      act(() => { vi.advanceTimersByTime(2000); });
      expect(captureDomFrame).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(vi.mocked(captureDomFrame).mock.calls[0]![0].region).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-closes after a capture only when autoCloseOnCapture is set", async () => {
    const onClose = vi.fn(), onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen autoCloseOnCapture onClose={onClose} activePaneId="pane:1" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: /^Snip:/ }));
    dragRegion([50, 50], [150, 150]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

describe("Snip Tool destination", () => {
  it("follows the focused CLI pane until locked, and unlock resynchronises", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    const props = { isOpen: true, onClose: vi.fn(), availablePanes: cliPanes, onCapture };
    const { rerender } = render(<SnipToolOverlay {...props} activePaneId="pane:finn" activePaneMode="TERMINAL" />);
    expect(screen.getByRole("button", { name: "Snip: Finn" })).toBeTruthy();
    rerender(<SnipToolOverlay {...props} activePaneId="pane:hugo" activePaneMode="TERMINAL" />);
    expect(screen.getByRole("button", { name: "Snip: Hugo" })).toBeTruthy();
    rerender(<SnipToolOverlay {...props} activePaneId="pane:browser" activePaneMode="BROWSER" />);
    expect(screen.getByRole("button", { name: "Snip: Hugo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lock target pane to Hugo" }));
    rerender(<SnipToolOverlay {...props} activePaneId="pane:finn" activePaneMode="TERMINAL" />);
    expect(screen.getByRole("button", { name: "Snip: Hugo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen for Hugo" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(onCapture.mock.calls[0]![1]).toBe("pane:hugo");
    fireEvent.click(screen.getByRole("button", { name: "Unlock target pane (locked to Hugo)" }));
    expect(screen.getByRole("button", { name: "Snip: Finn" })).toBeTruthy();
  });

  it("releases the lock when the locked pane closes", () => {
    const { rerender } = render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:finn" activePaneMode="TERMINAL" availablePanes={cliPanes} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Lock target pane to Finn" }));
    rerender(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:hugo" activePaneMode="TERMINAL" availablePanes={[cliPanes[1]!]} onCapture={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Snip: Hugo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lock target pane to Hugo" })).toBeTruthy();
  });

  it("picks a destination from the menu, which locks it, and lists pane names", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:finn" activePaneMode="TERMINAL" availablePanes={[...cliPanes, { id: "pane:andy", title: "Browser", mode: "BROWSER" }]} onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    const menu = screen.getByRole("menu", { name: "Snip destination" });
    expect(within(menu).getAllByRole("menuitemradio").map(item => item.querySelector(".snip-menu-text")!.textContent))
      .toEqual(["Clipboard", "Media Dock", "Finn", "Hugo", "Browser"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Hugo/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Snip: Hugo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlock target pane (locked to Hugo)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Clipboard/ }));
    expect(screen.getByRole("button", { name: "Snip: Clipboard" })).toBeTruthy();
    expect(localStorage.getItem("space.snip-tool.clipboard-mode.v1")).toBe("true");
  });

  it("toggles clipboard mode and persists it", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:finn" activePaneName="Finn" onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable clipboard mode" }));
    expect(screen.getByRole("button", { name: "Snip: Clipboard" })).toBeTruthy();
    expect(localStorage.getItem("space.snip-tool.clipboard-mode.v1")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Disable clipboard mode" }));
    expect(screen.getByRole("button", { name: "Snip: Finn" })).toBeTruthy();
    expect(localStorage.getItem("space.snip-tool.clipboard-mode.v1")).toBe("false");
  });

  it("opens an image file in the editor from the menu", async () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    const input = screen.getByRole("region", { name: "Snip Tool" }).querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "photo.png", { type: "image/png" })] } });
    await screen.findByText("Image opened. Edit, then send or save.");
    expect(frameFromBlob).toHaveBeenCalledOnce();
  });
});

describe("Snip Tool editor", () => {
  it("opens with the selected region when Edit before send is on, and sends only on confirmation", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:1" activePaneName="Finn" availablePanes={[{ ...panes[0]!, paneName: "Finn" }]} roomId="room:one" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit before send" }));
    expect(localStorage.getItem("space.snip-tool.edit-first.v1")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Snip: Finn" }));
    dragRegion([10, 100], [210, 250]);
    await screen.findByRole("dialog", { name: "Edit snip" });
    expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("200");
    expect(onCapture).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to Finn" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(onCapture.mock.calls[0]!.slice(1, 3)).toEqual(["pane:1", "room:one"]);
    expect(vi.mocked(exportSnip).mock.calls[0]![1].width).toBe(200);
    expect(await screen.findByText("Sent to Finn.")).toBeTruthy();
  });

  it("supports keyboard crop, resize, undo and redo", async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText("Crop width"), { target: { value: "300" } });
    const stage = screen.getByRole("group");
    fireEvent.keyDown(stage, { key: "ArrowRight" });
    expect((screen.getByLabelText("Crop x") as HTMLInputElement).value).toBe("1");
    fireEvent.keyDown(stage, { key: "ArrowRight", shiftKey: true });
    expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("301");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("300");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect((screen.getByLabelText("Crop x") as HTMLInputElement).value).toBe("0");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect((screen.getByLabelText("Crop x") as HTMLInputElement).value).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("301");
  });

  it("drags a new crop over a full-image crop instead of moving it", async () => {
    await openEditor();
    const stage = screen.getByRole("group");
    const inner = stage.querySelector(".snip-crop-inner")!;
    expect(inner.hasAttribute("data-move")).toBe(false);
    fireEvent.pointerDown(inner, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 250, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 250, pointerId: 1 });
    expect((screen.getByLabelText("Crop width") as HTMLInputElement).value).toBe("200");
    expect((screen.getByLabelText("Crop height") as HTMLInputElement).value).toBe("150");
  });

  it("draws annotations with the chosen color and size and exports them", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    await openEditor({ onCapture });
    fireEvent.click(screen.getByRole("button", { name: "Arrow" }));
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));
    fireEvent.click(screen.getByRole("radio", { name: "Thick" }));
    const stage = screen.getByRole("group");
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByRole("button", { name: "Pen" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(stage, { clientX: 10, clientY: 10, button: 0, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 40, clientY: 30, pointerId: 2 });
    fireEvent.pointerUp(stage, { clientX: 60, clientY: 50, pointerId: 2 });
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    const marks = vi.mocked(exportSnip).mock.calls[0]![2];
    expect(marks[0]).toEqual({ kind: "arrow", start: { x: 100, y: 100 }, end: { x: 300, y: 200 }, color: "#38bdf8", size: 1.8 });
    expect(marks[1]).toMatchObject({ kind: "pen", color: "#38bdf8" });
    expect((marks[1] as any).points.length).toBeGreaterThan(1);
    expect(JSON.parse(localStorage.getItem("space.snip-tool.editor-style.v1")!)).toEqual({ color: "#38bdf8", size: 1.8 });
  });

  it("places inline text by clicking the image, and includes pending text on send", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    await openEditor({ onCapture });
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    const stage = screen.getByRole("group");
    fireEvent.pointerDown(stage, { clientX: 200, clientY: 150, button: 0 });
    const input = await screen.findByPlaceholderText("Type text & press Enter");
    fireEvent.change(input, { target: { value: "Important" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByPlaceholderText("Type text & press Enter")).toBeNull();
    fireEvent.pointerDown(stage, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.change(await screen.findByPlaceholderText("Type text & press Enter"), { target: { value: "Pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to Media Dock" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(vi.mocked(exportSnip).mock.calls[0]![2].map((m: any) => m.text)).toEqual(["Important", "Pending"]);
  });

  it("keeps a failed send open for retry", async () => {
    await openEditor({ onCapture: vi.fn().mockRejectedValue(new Error("Upload failed")) });
    fireEvent.click(screen.getByRole("button", { name: "Save to Media Dock" }));
    await screen.findByText("Upload failed");
    expect((screen.getByRole("button", { name: "Save to Media Dock" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("copies the edited PNG without sending it", async () => {
    const onCapture = vi.fn();
    await openEditor({ onCapture });
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await screen.findByText("Copied to clipboard. Paste with Ctrl+V.");
    expect(navigator.clipboard.write).toHaveBeenCalledOnce(); expect(onCapture).not.toHaveBeenCalled();
  });

  it("falls back when ClipboardItem requires a resolved blob", async () => {
    let constructed = 0;
    vi.stubGlobal("ClipboardItem", class {
      constructor(public items: any) {
        constructed++;
        if (constructed === 1 && items["image/png"] instanceof Promise) throw new TypeError("Invalid type: argument is not a Blob");
      }
    });
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await screen.findByText("Copied to clipboard. Paste with Ctrl+V.");
    expect(navigator.clipboard.write).toHaveBeenCalledOnce();
  });

  it("blocks sending to a removed pane and lets the user pick another destination", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined), onClose = vi.fn();
    const { rerender } = await openEditor({ onClose, activePaneId: "pane:1", availablePanes: panes, onCapture });
    rerender(<SnipToolOverlay isOpen onClose={onClose} activePaneId="pane:2" availablePanes={[panes[1]!]} onCapture={onCapture} />);
    expect((screen.getByRole("button", { name: "Send to Unavailable pane" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("no longer available");
    fireEvent.change(screen.getByLabelText("Capture destination"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to Media Dock" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(onCapture.mock.calls[0]![1]).toBeNull();
  });

  it("Change source re-captures into the editor through screen sharing and Retake returns to selection", async () => {
    await openEditor();
    expect(captureDomFrame).toHaveBeenCalledTimes(1);
    expect(captureSnipFrame).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change source" }));
    await waitFor(() => expect(captureSnipFrame).toHaveBeenCalledTimes(1));
    await screen.findByRole("dialog", { name: "Edit snip" });
    fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
    expect(layer()).toBeTruthy();
  });

  it("Escape discards the edit and returns to the capsule, restoring focus to the pane", async () => {
    const pane = document.createElement("textarea"); document.body.append(pane); pane.focus();
    await openEditor();
    expect(document.activeElement).not.toBe(pane);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Edit snip" })).toBeNull();
    expect(screen.getByRole("region", { name: "Snip Tool" })).toBeTruthy();
    expect(document.activeElement).toBe(pane);
    pane.remove();
  });

  it("allows clearing a coordinate field without reverting", async () => {
    await openEditor();
    const width = screen.getByLabelText("Crop width") as HTMLInputElement;
    fireEvent.change(width, { target: { value: "" } });
    expect(width.value).toBe("");
    fireEvent.change(width, { target: { value: "450" } });
    expect(width.value).toBe("450");
  });
});

describe("Snip Tool on the right rail", () => {
  const railCard = () => screen.getByRole("region", { name: "Snip Tool" });
  function dockOnRail() {
    const capsule = railCard();
    fireEvent.pointerDown(capsule.querySelector(".snip-capsule-grip")!, { clientX: 600, clientY: 90, button: 0 });
    fireEvent.pointerMove(document.body, { clientX: 790, clientY: 300 });
    expect(capsule.classList.contains("is-dock-preview")).toBe(true);
    fireEvent.pointerUp(document.body, { clientX: 790, clientY: 300, button: 0 });
  }

  it("docks like a widget, snips straight to the clipboard, and pulls off the rail to float again", async () => {
    const onCapture = vi.fn();
    render(<SnipToolOverlay isOpen onClose={vi.fn()} activePaneId="pane:1" availablePanes={panes} onCapture={onCapture} />);
    dockOnRail();
    expect(railCard().classList.contains("snip-rail-card")).toBe(true);
    expect(JSON.parse(localStorage.getItem("space.snip-tool.rail-dock.v1")!).open).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Snip: Clipboard" }));
    dragRegion([20, 20], [200, 200]);
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledOnce());
    expect(onCapture).not.toHaveBeenCalled();
    expect(railCard().classList.contains("snip-rail-card")).toBe(true);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Snip: Clipboard" }), { clientX: 776, clientY: 320, button: 0 });
    fireEvent.pointerMove(document.body, { clientX: 300, clientY: 300 });
    fireEvent.pointerUp(document.body, { clientX: 300, clientY: 300, button: 0 });
    expect(railCard().classList.contains("snip-capsule")).toBe(true);
    expect(localStorage.getItem("space.snip-tool.rail-dock.v1")).toBeNull();
  });

  it("moves along the rail without starting a snip", () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    dockOnRail();
    const button = screen.getByRole("button", { name: "Snip: Clipboard" });
    const before = parseFloat(railCard().style.top);
    fireEvent.pointerDown(button, { clientX: 776, clientY: before + 20, button: 0 });
    fireEvent.pointerMove(document.body, { clientX: 776, clientY: before + 120 });
    fireEvent.pointerUp(document.body, { clientX: 776, clientY: before + 120, button: 0 });
    fireEvent.click(button);
    expect(parseFloat(railCard().style.top)).toBe(before + 100);
    expect(screen.queryByRole("dialog", { name: "Snip selection" })).toBeNull();
  });

  it("stays a floating capsule on mobile", () => {
    localStorage.setItem("space.snip-tool.rail-dock.v1", JSON.stringify({ y: 120, open: true }));
    render(<SnipToolOverlay isOpen isMobile onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(railCard().classList.contains("snip-capsule")).toBe(true);
  });
});

describe("Snip Tool in the Workspace surface", () => {
  it("renders the capsule inline rather than floating", () => {
    render(<WorkspaceSurface><SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} /></WorkspaceSurface>);
    const capsule = screen.getByRole("region", { name: "Snip Tool" });
    expect(capsule.classList.contains("is-inline")).toBe(true);
    expect(capsule.style.left).toBe("");
    expect(screen.getByText(/PrtScn works anywhere/)).toBeTruthy();
  });
});
