// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { clipboardPasteRoute, NOUS_PASTE_TARGET, SnipToolOverlay } from "../src/features/snip-tool/SnipToolOverlay.js";
import { WorkspaceSurface } from "../src/features/ui-theme/WorkspaceSurface.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { captureSnipFrame } from "../src/features/snip-tool/snip-capture.js";
import { exportSnip, frameFromBlob } from "../src/features/snip-tool/snip-image.js";
import { captureDomFrame, SnipDomUnsupportedError } from "../src/features/snip-tool/snip-dom-capture.js";
import { clipboardFiles, NousPendingFiles, usePendingFiles } from "../src/features/nous/NousFiles.js";
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

  it("captures to the clipboard and saves every snip to Media Dock, never to a pane, when clipboard mode is on", async () => {
    const onCapture = vi.fn();
    render(<SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode activePaneId="pane:finn" activePaneName="Finn" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Snip: Clipboard" }));
    dragRegion([20, 20], [200, 200]);
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledOnce());
    expect(await screen.findByText("Copied to clipboard. Paste with Ctrl+V.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    await waitFor(() => expect(navigator.clipboard.write).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(2));
    expect(onCapture.mock.calls.map(call => [call[0].type, call[1]])).toEqual([["image/png", null], ["image/png", null]]);
  });

  it("says a clipboard snip was kept when saving it to Media Dock fails", async () => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode onCapture={vi.fn().mockRejectedValue(new Error("offline"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    expect(await screen.findByText(/Copied to clipboard, but saving it to Media Dock failed: offline/)).toBeTruthy();
    expect(navigator.clipboard.write).toHaveBeenCalledOnce();
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

  it("Ctrl+V pastes a clipboard image into the target pane and clipboard text through the CLI's own paste", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue([{ types: ["image/png"], getType: vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" })) }]);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });
    render(<SnipToolOverlay isOpen onClose={vi.fn()} availablePanes={cliPanes} activePaneId="pane:finn" activePaneMode="TERMINAL" onCapture={onCapture} />);
    const paste = screen.getByRole("button", { name: "Paste the clipboard into Finn" });
    fireEvent.click(paste);
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(onCapture.mock.calls[0]![0].type).toBe("image/png");
    expect(onCapture.mock.calls[0]![1]).toBe("pane:finn");
    expect(await screen.findByText("Pasted into Finn.")).toBeTruthy();
    read.mockResolvedValue([{ types: ["text/plain"], getType: vi.fn() }]);
    const action = vi.fn();
    window.addEventListener("space:terminal-pane-action", action);
    fireEvent.click(paste);
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    window.removeEventListener("space:terminal-pane-action", action);
    expect((action.mock.calls[0]![0] as CustomEvent).detail).toEqual({ paneId: "pane:finn", action: "paste" });
    expect(onCapture).toHaveBeenCalledOnce();
  });

  it("holds snips only in clipboard mode, and one Ctrl+V in a CLI pane pastes them all and empties the memory", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<>
      <article data-space-pane-id="pane:hugo"><textarea aria-label="Hugo input" /></article>
      <SnipToolOverlay isOpen onClose={vi.fn()} availablePanes={cliPanes} activePaneId="pane:finn" activePaneMode="TERMINAL" onCapture={onCapture} />
    </>);
    expect(screen.queryByRole("button", { name: "Hold snips" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable clipboard mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Hold snips" }));
    fireEvent.click(screen.getByRole("button", { name: "Snip: Clipboard" }));
    dragRegion([20, 20], [200, 200]);
    expect(await screen.findByText("Held 1 snip. Ctrl+V pastes them all.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    await screen.findByRole("button", { name: "Hold snips (2 held)" });
    expect(screen.getByRole("button", { name: /^Paste 2 held snips into Nous when it is open, else the focused CLI pane/ })).toBeTruthy();
    expect(navigator.clipboard.write).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Hugo input");
    // Greek layout: key is "ω", code is still KeyV.
    expect(fireEvent.keyDown(input, { key: "ω", code: "KeyV", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(4));
    // Each snip went to Media Dock when it was taken, then to the pane on paste.
    expect(onCapture.mock.calls.map(call => [call[0].type, call[1]])).toEqual([["image/png", null], ["image/png", null], ["image/png", "pane:hugo"], ["image/png", "pane:hugo"]]);
    expect(await screen.findByText("Pasted 2 snips into Hugo.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hold snips" }).getAttribute("aria-pressed")).toBe("true");
    expect(fireEvent.keyDown(input, { key: "v", code: "KeyV", ctrlKey: true })).toBe(true);
    expect(onCapture).toHaveBeenCalledTimes(4);
  });

  it("Ctrl+V with focus outside the panes pastes held snips into the focused CLI pane, but never from a text field", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<>
      <button type="button">Plans</button><input aria-label="Composer" />
      <SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode availablePanes={cliPanes} activePaneId="pane:finn" activePaneMode="TERMINAL" onCapture={onCapture} />
    </>);
    fireEvent.click(screen.getByRole("button", { name: "Hold snips" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    await screen.findByRole("button", { name: "Hold snips (1 held)" });
    expect(fireEvent.keyDown(screen.getByLabelText("Composer"), { key: "v", code: "KeyV", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(screen.getByRole("button", { name: "Plans" }), { key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(2));
    expect(onCapture.mock.calls.map(call => call[1])).toEqual([null, "pane:finn"]);
    expect(await screen.findByText("Pasted 1 snip into Finn.")).toBeTruthy();
  });

  it("a paste asked for while a timed snip counts down waits for it, so the last snip is never left out", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode availablePanes={cliPanes} activePaneId="pane:finn" activePaneMode="TERMINAL" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Hold snips" }));
    fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
    await screen.findByText("Held 1 snip. Ctrl+V pastes them all.");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Capture in 3 seconds" }));
      expect(fireEvent.keyDown(document.body, { key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
      expect(onCapture).toHaveBeenCalledOnce();
      await act(async () => { vi.advanceTimersByTime(3000); });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(4));
    expect(onCapture.mock.calls.map(call => call[1])).toEqual([null, null, "pane:finn", "pane:finn"]);
    expect(await screen.findByText("Pasted 2 snips into Finn.")).toBeTruthy();
  });

  it("routes a clipboard-mode paste to the focused pane, else the open Nous composer, else the active CLI pane, else Media Dock", () => {
    render(<><article data-space-pane-id="pane:hugo"><textarea aria-label="Hugo input" /></article><button type="button">Plans</button></>);
    const hugo = screen.getByLabelText("Hugo input"), plans = screen.getByRole("button", { name: "Plans" });
    expect(clipboardPasteRoute(hugo, "pane:finn")).toBe("pane:hugo");
    expect(clipboardPasteRoute(plans, "pane:finn")).toBe("pane:finn");
    expect(clipboardPasteRoute(plans, null)).toBeNull();
    render(<textarea data-nous-composer aria-label="Message Nous" />);
    expect(clipboardPasteRoute(plans, "pane:finn")).toBe(NOUS_PASTE_TARGET);
    expect(clipboardPasteRoute(null, "pane:finn")).toBe(NOUS_PASTE_TARGET);
    expect(clipboardPasteRoute(hugo, "pane:finn")).toBe("pane:hugo");
  });

  it("Ctrl+V in Nous attaches every held snip there, and with no Nous or CLI pane they stay in Media Dock, never a remembered pane", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined), attached = vi.fn();
    window.addEventListener("space:nous-attach-files", attached);
    const ui = (nous: boolean, activePaneId: string | null) => <>
      {nous && <textarea data-nous-composer aria-label="Message Nous" />}
      <SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode availablePanes={cliPanes} activePaneId={activePaneId} activePaneMode="TERMINAL" onCapture={onCapture} />
    </>;
    try {
      const { rerender } = render(ui(true, "pane:finn"));
      fireEvent.click(screen.getByRole("button", { name: "Hold snips" }));
      for (const n of [1, 2, 3]) {
        fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
        await screen.findByText(`Held ${n} snip${n === 1 ? "" : "s"}. Ctrl+V pastes them all.`);
      }
      expect(onCapture.mock.calls.map(call => call[1])).toEqual([null, null, null]);
      expect(fireEvent.keyDown(screen.getByLabelText("Message Nous"), { key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
      expect(attached).toHaveBeenCalledOnce();
      expect((attached.mock.calls[0]![0] as CustomEvent<File[]>).detail.map(file => file.type)).toEqual(["image/png", "image/png", "image/png"]);
      expect(await screen.findByText("Attached 3 snips to Nous.")).toBeTruthy();
      expect(onCapture).toHaveBeenCalledTimes(3);
      // Nous closed and no CLI pane focused: Finn is still the remembered snip target, yet the paste goes nowhere but Media Dock.
      rerender(ui(false, null));
      fireEvent.click(screen.getByRole("button", { name: "Capture full screen to clipboard" }));
      await screen.findByText("Held 1 snip. Ctrl+V pastes them all.");
      expect(fireEvent.keyDown(document.body, { key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
      expect(await screen.findByText("Saved 1 snip to Media Dock.")).toBeTruthy();
      expect(onCapture.mock.calls.map(call => call[1])).toEqual([null, null, null, null]);
    } finally {
      window.removeEventListener("space:nous-attach-files", attached);
    }
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
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    expect(onCapture.mock.calls[0]![1]).toBeNull();
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

describe("Snip Tool video recording", () => {
  afterEach(() => {
    delete (navigator as any).mediaDevices; delete (window as any).devicePixelRatio;
    delete (HTMLVideoElement.prototype as any).requestVideoFrameCallback; delete (HTMLCanvasElement.prototype as any).captureStream;
  });
  /** A browser sharing this tab (its capture handle matches) at twice the 800x600 viewport, unless `thisTab` is false. */
  function fakeRecording({ thisTab = true, frame = [1600, 1200] } = {}) {
    let handle = "";
    const track = { stop: vi.fn(), addEventListener: vi.fn(), getCaptureHandle: () => (thisTab ? { handle } : null) };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    installSpaceRuntime({ kind: "browser", platform: { displayMediaSupported: true, getDisplayMedia } } as any);
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, setCaptureHandleConfig: (config: { handle: string }) => { handle = config.handle; } } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(frame[0]!);
    vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(frame[1]!);
    (HTMLVideoElement.prototype as any).requestVideoFrameCallback = vi.fn();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as any);
    const cropTrack = { stop: vi.fn() };
    const cropStream = { getTracks: () => [cropTrack], getVideoTracks: () => [cropTrack] };
    (HTMLCanvasElement.prototype as any).captureStream = () => cropStream;
    const recorded: unknown[] = [];
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported = () => true;
      state = "inactive"; ondataavailable: any; onstop: any;
      constructor(source: unknown) { recorded.push(source); }
      start() { this.state = "recording"; }
      stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["webm"]) }); this.onstop?.(); }
    });
    return { track, stream, cropTrack, cropStream, getDisplayMedia, getUserMedia, drawImage, recorded };
  }
  const record = (props: Partial<React.ComponentProps<typeof SnipToolOverlay>> = {}) => {
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn().mockResolvedValue(undefined)} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Record video" }));
  };

  it("opens the Snip selection, and Escape cancels with nothing recorded", () => {
    const { getDisplayMedia } = fakeRecording();
    const onCapture = vi.fn();
    record({ onCapture });
    expect(within(layer()).getByRole("status").textContent).toMatch(/^Record an area\. Drag to select it/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Snip selection" })).toBeNull();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(onCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record video" })).toBeTruthy();
  });

  it("records the selected area of this tab, framed, until the second click and saves the WebM to Media Dock", async () => {
    const { track, cropTrack, cropStream, getDisplayMedia, drawImage, recorded } = fakeRecording();
    const onCapture = vi.fn().mockResolvedValue(undefined);
    record({ activePaneId: "pane:1", availablePanes: panes, onCapture });
    dragRegion([100, 50], [300, 200]);
    const stop = await screen.findByRole("button", { name: /^Stop recording \(0:00\)/ });
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ preferCurrentTab: true }));
    // The 200x150 area at (100, 50) of an 800x600 tab captured at 1600x1200.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 200, 100, 400, 300, 0, 0, 400, 300);
    expect(recorded).toEqual([cropStream]);
    const frame = document.querySelector<HTMLElement>(".snip-record-frame")!;
    expect([frame.style.left, frame.style.top, frame.style.width, frame.style.height]).toEqual(["98px", "48px", "204px", "154px"]);
    fireEvent.click(stop);
    await waitFor(() => expect(onCapture).toHaveBeenCalledOnce());
    const [file, paneId] = onCapture.mock.calls[0]!;
    expect([file.type, paneId]).toEqual(["video/webm", null]);
    expect(track.stop).toHaveBeenCalled();
    expect(cropTrack.stop).toHaveBeenCalled();
    expect(await screen.findByText("Recording saved to Media Dock.")).toBeTruthy();
    expect(document.querySelector(".snip-record-frame")).toBeNull();
  });

  it("records the desktop app's own window with no picker, past its title bar, at device pixels", async () => {
    const { getDisplayMedia, getUserMedia, drawImage } = fakeRecording({ frame: [1600, 1260] });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    vi.stubGlobal("spaceDesktop", { capturePage: vi.fn(), getWindowMediaSourceId: vi.fn().mockResolvedValue({ success: true, sourceId: "window:7:0" }) });
    record();
    dragRegion([100, 50], [300, 200]);
    await screen.findByRole("button", { name: /^Stop recording/ });
    expect(getUserMedia.mock.calls[0]![0].video.mandatory).toMatchObject({ chromeMediaSource: "desktop", chromeMediaSourceId: "window:7:0" });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    // A 30 px title bar above the 800x600 page.
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 200, 160, 400, 300, 0, 0, 400, 300);
  });

  it("records another source picked in the browser whole and says so", async () => {
    const { stream, drawImage, recorded } = fakeRecording({ thisTab: false });
    record();
    dragRegion([100, 50], [300, 200]);
    expect(await screen.findByText("Another source was chosen, so all of it is being recorded.")).toBeTruthy();
    expect(recorded).toEqual([stream]);
    expect(drawImage).not.toHaveBeenCalled();
    expect(document.querySelector(".snip-record-frame")).toBeNull();
  });

  it("hides Record video on Android, which captures stills only", () => {
    fakeRecording();
    vi.stubGlobal("SpaceNative", { requestPageCapture: vi.fn() });
    render(<SnipToolOverlay isOpen onClose={vi.fn()} onCapture={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Record video" })).toBeNull();
  });

  it("clipboard mode holds the finished recording, saved once: the Ctrl+V icon attaches the WebM to Nous, keyboard Ctrl+V pastes it into a CLI pane", async () => {
    fakeRecording();
    const onCapture = vi.fn().mockResolvedValue(undefined), attached = vi.fn();
    window.addEventListener("space:nous-attach-files", attached);
    try {
      render(<>
        <textarea data-nous-composer aria-label="Message Nous" />
        <article data-space-pane-id="pane:hugo"><textarea aria-label="Hugo input" /></article>
        <SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode availablePanes={cliPanes} activePaneId="pane:finn" activePaneMode="TERMINAL" onCapture={onCapture} />
      </>);
      const recordOnce = async () => {
        fireEvent.click(screen.getByRole("button", { name: "Record video" }));
        dragRegion([100, 50], [300, 200]);
        fireEvent.click(await screen.findByRole("button", { name: /^Stop recording/ }));
        expect(await screen.findByText("Recording saved to Media Dock. Ctrl+V pastes it.")).toBeTruthy();
      };
      await recordOnce();
      const [video, route] = onCapture.mock.calls[0]!;
      expect([video.type, /\.webm$/.test(video.name), route]).toEqual(["video/webm", true, null]);
      fireEvent.click(screen.getByRole("button", { name: /^Paste 1 held snips into/ }));
      expect((attached.mock.calls[0]![0] as CustomEvent<File[]>).detail).toEqual([video]);
      expect(await screen.findByText("Attached 1 snip to Nous.")).toBeTruthy();
      expect(onCapture).toHaveBeenCalledOnce();
      await recordOnce();
      expect(fireEvent.keyDown(screen.getByLabelText("Hugo input"), { key: "v", code: "KeyV", ctrlKey: true })).toBe(false);
      expect(await screen.findByText("Pasted 1 snip into Hugo.")).toBeTruthy();
      // Media Dock got each recording once, when it stopped; the pane gets its own copy.
      expect(onCapture.mock.calls.map(call => [call[0].type, call[1]])).toEqual([["video/webm", null], ["video/webm", null], ["video/webm", "pane:hugo"]]);
      expect(onCapture.mock.calls[2]![0]).toBe(onCapture.mock.calls[1]![0]);
    } finally {
      window.removeEventListener("space:nous-attach-files", attached);
    }
  });

  it("a video file pasted from the OS passes the Snip Tool and attaches in the Nous composer, as NousDock's paste does", async () => {
    const uploadNousAttachments = vi.fn().mockResolvedValue({ attachments: [{ id: "att:1", kind: "VIDEO", name: "clip.webm" }] });
    installSpaceRuntime({ kind: "browser", api: { uploadNousAttachments }, platform: {} } as unknown as Parameters<typeof installSpaceRuntime>[0]);
    const onError = vi.fn();
    function Composer() {
      const pending = usePendingFiles(onError);
      return <>
        <textarea data-nous-composer aria-label="Message Nous" onPaste={event => pending.add(clipboardFiles(event.clipboardData))} />
        <NousPendingFiles files={pending.files} onRemove={vi.fn()} />
      </>;
    }
    render(<><Composer /><SnipToolOverlay isOpen onClose={vi.fn()} defaultClipboardMode onCapture={vi.fn()} /></>);
    const clip = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "clip.webm", { type: "video/webm" });
    fireEvent.paste(screen.getByLabelText("Message Nous"), { clipboardData: { files: [clip], items: [], types: ["Files"], getData: () => "" } });
    await waitFor(() => expect(uploadNousAttachments).toHaveBeenCalledWith([clip]));
    expect(within(screen.getByRole("list", { name: "Attached files" })).getByText("clip.webm")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it("downloads the recording when the upload fails, so it is never lost", async () => {
    fakeRecording();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    record({ onCapture: vi.fn().mockRejectedValue(new Error("Too large.")) });
    dragRegion([100, 50], [300, 200]);
    fireEvent.click(await screen.findByRole("button", { name: /^Stop recording/ }));
    expect(await screen.findByText("Too large. The recording was downloaded instead.")).toBeTruthy();
    expect(click).toHaveBeenCalledOnce();
  });
});
