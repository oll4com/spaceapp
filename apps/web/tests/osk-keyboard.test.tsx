import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OSK_PANEL_ID,
  OSK_POSITION_STORAGE_KEY,
  OSK_SCALE_STORAGE_KEY,
  OSK_LANG_STORAGE_KEY,
  OSK_CLI_COMMANDS,
  OnScreenKeyboard,
  getAutocompleteSuggestions,
  sendTextToInputOrFocused,
  type OnScreenKeyboardInput
} from "../src/features/osk-keyboard/OnScreenKeyboard.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

function KeyboardHarness({
  mobile = false,
  onInput,
  roomTheme = "graphite",
  defaultShowShortcuts = false,
  defaultAutocomplete = false
}: {
  mobile?: boolean;
  onInput?: (input: OnScreenKeyboardInput) => boolean;
  roomTheme?: "graphite" | "forest";
  defaultShowShortcuts?: boolean;
  defaultAutocomplete?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <div className="board-toolbar">
        <button
          ref={triggerRef}
          type="button"
          aria-label="On-screen keyboard"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          Keyboard
        </button>
      </div>
      <OnScreenKeyboard
        mobile={mobile}
        open={open}
        onInput={onInput}
        onOpenChange={setOpen}
        roomTheme={roomTheme}
        defaultShowShortcuts={defaultShowShortcuts}
        defaultAutocomplete={defaultAutocomplete}
      />
    </>
  );
}

function openKeyboard(container: HTMLElement) {
  fireEvent.click(container.querySelector('button[aria-label="On-screen keyboard"]') as HTMLButtonElement);
  return screen.getByRole("dialog", { name: "On-screen keyboard" });
}

describe("OnScreenKeyboard", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a floating dialog with letters, numbers, and special keys", () => {
    const { container } = render(<KeyboardHarness />);
    const panel = openKeyboard(container);

    expect(panel.id).toBe(OSK_PANEL_ID);
    expect(panel.classList.contains("osk-popover")).toBe(true);
    expect(screen.getByRole("button", { name: "q" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Space" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enter" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Shift" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close on-screen keyboard" })).toBeTruthy();
  });

  it("closes when the close button is pressed", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Close on-screen keyboard" }));
    expect(screen.queryByRole("dialog", { name: "On-screen keyboard" })).toBeNull();
  });

  it("does not let the draggable header capture the close button pointer", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);
    const handle = screen.getByRole("button", { name: "Move on-screen keyboard" });
    const closeButton = screen.getByRole("button", { name: "Close on-screen keyboard" });
    const setPointerCapture = vi.fn();
    Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: setPointerCapture });

    fireEvent.pointerDown(closeButton, { button: 0, pointerId: 7 });
    expect(setPointerCapture).not.toHaveBeenCalled();
    fireEvent.click(closeButton);

    expect(screen.queryByRole("dialog", { name: "On-screen keyboard" })).toBeNull();
  });

  it("does not close on a physical Escape keydown (terminal use)", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "On-screen keyboard" })).toBeTruthy();
  });

  it("sends Escape to the focused target without closing the keyboard", () => {
    const { container } = render(<KeyboardHarness />);
    const target = document.createElement("div");
    target.tabIndex = 0;
    target.setAttribute("aria-label", "target");
    document.body.appendChild(target);
    target.focus();

    const keydownSpy = vi.fn();
    target.addEventListener("keydown", keydownSpy);

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));

    expect(keydownSpy).toHaveBeenCalled();
    const event = keydownSpy.mock.calls[0]?.[0] as KeyboardEvent;
    expect(event.key).toBe("Escape");
    expect(screen.getByRole("dialog", { name: "On-screen keyboard" })).toBeTruthy();
    target.remove();
  });

  it("stays open and above app surfaces when clicking outside the panel", () => {
    const { container } = render(<KeyboardHarness />);
    const panel = openKeyboard(container);
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole("dialog", { name: "On-screen keyboard" })).toBe(panel);
  });

  it("inserts character keys into the focused textarea", () => {
    const { container } = render(<KeyboardHarness />);
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "target");
    document.body.appendChild(textarea);
    textarea.focus();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "q" }));
    fireEvent.click(screen.getByRole("button", { name: "Space" }));

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "q");
    expect(execCommand).toHaveBeenCalledWith("insertText", false, " ");
    textarea.remove();
  });

  it("toggles shift to uppercase letters", () => {
    const { container } = render(<KeyboardHarness />);
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "target");
    document.body.appendChild(textarea);
    textarea.focus();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Shift" }));
    expect(screen.getByRole("button", { name: "Q (q)" })).toBeTruthy();
    expect(document.body.querySelector('[data-key="1"]')?.textContent).toBe("!");
    fireEvent.click(screen.getByRole("button", { name: "Q (q)" }));
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "Q");
    textarea.remove();
  });

  it("dispatches key events for non-editable targets", () => {
    const { container } = render(<KeyboardHarness />);
    const target = document.createElement("div");
    target.tabIndex = 0;
    target.setAttribute("aria-label", "target");
    document.body.appendChild(target);
    target.focus();

    const keydownSpy = vi.fn();
    target.addEventListener("keydown", keydownSpy);

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));

    expect(keydownSpy).toHaveBeenCalled();
    const event = keydownSpy.mock.calls[0]?.[0] as KeyboardEvent;
    expect(event.key).toBe("Enter");
    target.remove();
  });

  it("routes characters and control sequences through the pane input handler", () => {
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness onInput={(input) => { inputs.push(input); return true; }} />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "q" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    fireEvent.click(screen.getByRole("button", { name: "⌫" }));
    fireEvent.click(screen.getByRole("button", { name: "←" }));

    expect(inputs.map((input) => input.terminalData)).toEqual(["q", "\r", "\u007f", "\u001b[D"]);
  });

  it("switches to the symbol layer and routes symbol characters", () => {
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness onInput={(input) => { inputs.push(input); return true; }} />);
    openKeyboard(container);

    expect(screen.queryByRole("button", { name: "/" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch to symbols" }));
    expect(screen.getByRole("button", { name: "/" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "q" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "/" }));
    fireEvent.click(screen.getByRole("button", { name: "-" }));
    fireEvent.click(screen.getByRole("button", { name: "." }));

    expect(inputs.map((input) => input.terminalData)).toEqual(["/", "-", "."]);
  });

  it("toggles back to letters from the symbol layer", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "Switch to symbols" }));
    expect(screen.getByRole("button", { name: "Switch to letters" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to letters" }));
    expect(screen.getByRole("button", { name: "q" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "/" })).toBeNull();
  });

  it("resets shift when switching to the symbol layer", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "Shift" }));
    expect(screen.getByRole("button", { name: "Q (q)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to symbols" }));
    expect(screen.queryByRole("button", { name: "Q (q)" })).toBeNull();
    expect(screen.getByRole("button", { name: "/" })).toBeTruthy();
  });

  it("routes one on-screen Escape click exactly once", () => {
    const onInput = vi.fn(() => true);
    const { container } = render(<KeyboardHarness onInput={onInput} />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "Esc" }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith(expect.objectContaining({
      key: "Escape",
      code: "Escape",
      terminalData: "\u001b"
    }));
  });

  it("sends an Escape keydown to the focused terminal element", () => {
    const { container } = render(<KeyboardHarness />);
    const target = document.createElement("div");
    target.tabIndex = 0;
    target.setAttribute("aria-label", "target");
    document.body.appendChild(target);
    target.focus();

    const keydownSpy = vi.fn();
    target.addEventListener("keydown", keydownSpy);

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));

    expect(keydownSpy).toHaveBeenCalled();
    const event = keydownSpy.mock.calls[0]?.[0] as KeyboardEvent;
    expect(event.key).toBe("Escape");
    expect(event.code).toBe("Escape");
    target.remove();
  });

  it("persists and restores the dragged position", () => {
    const { container } = render(<KeyboardHarness />);
    const panel = openKeyboard(container);

    const rectMock = vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 300,
      bottom: 98,
      width: 200,
      height: 48,
      x: 100,
      y: 50,
      toJSON: () => ({})
    } as DOMRect);

    const handle = screen.getByRole("button", { name: "Move on-screen keyboard" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { clientX: 300, clientY: 200 });
    fireEvent.pointerUp(handle, { clientX: 300, clientY: 200 });

    const stored = JSON.parse(window.localStorage.getItem(OSK_POSITION_STORAGE_KEY) ?? "null") as { left: number; top: number } | null;
    expect(stored).toBeTruthy();
    expect(stored?.left).toBeCloseTo(rectMock.mock.results[0]?.value.left + 200, 0);
    expect(stored?.top).toBeCloseTo(rectMock.mock.results[0]?.value.top + 100, 0);
  });

  it("renders a movable compact keyboard with size controls and no CLI shortcuts on mobile", () => {
    const { container } = render(<KeyboardHarness mobile />);
    const panel = openKeyboard(container);
    const backdrop = document.body.querySelector(".osk-sheet-backdrop") as HTMLElement;
    expect(panel.classList.contains("osk-sheet")).toBe(true);
    expect(backdrop).toBeTruthy();
    expect(screen.getByRole("button", { name: "Smaller keyboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Larger keyboard" })).toBeTruthy();
    expect(screen.queryByRole("toolbar", { name: "CLI shortcuts" })).toBeNull();
    const startingTop = panel.style.top;
    const handle = screen.getByRole("button", { name: "Move on-screen keyboard" });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 70 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 20, clientY: 70 });
    expect(panel.style.top).not.toBe(startingTop);
    fireEvent.click(backdrop);
    expect(screen.getByRole("dialog", { name: "On-screen keyboard" })).toBe(panel);
  });

  it("keeps desktop and mobile keyboard layers above every app surface", async () => {
    const css = await readFile(
      "src/features/osk-keyboard/osk-keyboard.css",
      "utf8"
    );
    expect(css).toMatch(/\.osk-panel\s*\{[\s\S]*?z-index:\s*1600;/);
    expect(css).toMatch(/\.osk-sheet-backdrop\s*\{[\s\S]*?z-index:\s*1600;/);
  });

  it("uses the demo runtime storage without crashing", () => {
    installSpaceRuntime(createDemoRuntime().runtime);
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);
    expect(screen.getByRole("button", { name: "q" })).toBeTruthy();
  });

  it("switches to the Greek layout and inserts Greek letters", () => {
    const { container } = render(<KeyboardHarness />);
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "target");
    document.body.appendChild(textarea);
    textarea.focus();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Switch keyboard language" }));

    expect(screen.getByRole("button", { name: "ε" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ς" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "μ" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ε" }));
    fireEvent.click(screen.getByRole("button", { name: "ς" }));

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "ε");
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "ς");
    textarea.remove();
  });

  it("uppercases Greek letters with shift", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Switch keyboard language" }));
    fireEvent.click(screen.getByRole("button", { name: "Shift" }));
    expect(screen.getByRole("button", { name: "Α (α)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Σ (ς)" })).toBeTruthy();
  });

  it("persists and restores the selected language", () => {
    const { container, unmount } = render(<KeyboardHarness />);
    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "Switch keyboard language" }));
    expect(window.localStorage.getItem(OSK_LANG_STORAGE_KEY)).toBe("el");
    unmount();

    const { container: secondContainer } = render(<KeyboardHarness />);
    openKeyboard(secondContainer);
    expect(screen.getByRole("button", { name: "ε" })).toBeTruthy();
  });

  it("resizes the keyboard with the size buttons and persists the scale", () => {
    const { container } = render(<KeyboardHarness />);
    const panel = openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "Larger keyboard" }));
    expect(panel.style.transform).toContain("scale(1.1)");

    fireEvent.click(screen.getByRole("button", { name: "Smaller keyboard" }));
    expect(panel.style.transform).toContain("scale(1)");
    expect(window.localStorage.getItem(OSK_SCALE_STORAGE_KEY)).toBe("1");
  });

  it("locks viewport scale and applies space-osk-open class while open, restoring on close", () => {
    const metaViewport = document.createElement("meta");
    metaViewport.setAttribute("name", "viewport");
    metaViewport.setAttribute("content", "width=device-width, initial-scale=1.0, viewport-fit=cover");
    document.head.appendChild(metaViewport);

    try {
      const { container } = render(<KeyboardHarness />);
      expect(document.documentElement.classList.contains("space-osk-open")).toBe(false);
      expect(metaViewport.getAttribute("content")).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover");

      openKeyboard(container);
      expect(document.documentElement.classList.contains("space-osk-open")).toBe(true);
      expect(metaViewport.getAttribute("content")).toBe(
        "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content"
      );

      fireEvent.click(screen.getByRole("button", { name: "Close on-screen keyboard" }));
      expect(document.documentElement.classList.contains("space-osk-open")).toBe(false);
      expect(metaViewport.getAttribute("content")).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover");
    } finally {
      metaViewport.remove();
    }
  });

  it("prevents gesturestart and rapid double-tap on non-buttons while open without suppressing button clicks", () => {
    const { container } = render(<KeyboardHarness mobile />);
    openKeyboard(container);

    const gestureEvent = new Event("gesturestart", { bubbles: true, cancelable: true });
    window.dispatchEvent(gestureEvent);
    expect(gestureEvent.defaultPrevented).toBe(true);

    const backdrop = document.body.querySelector(".osk-sheet-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);
    const tap1 = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    backdrop.dispatchEvent(tap1);
    expect(tap1.defaultPrevented).toBe(false);

    // Rapid second tap within 200ms on backdrop is suppressed to prevent double-tap zoom
    nowSpy.mockReturnValue(1200);
    const tap2 = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    backdrop.dispatchEvent(tap2);
    expect(tap2.defaultPrevented).toBe(true);

    // Rapid tap on button itself is NEVER suppressed, so typing works fast
    const keyButton = screen.getByRole("button", { name: "q" });
    nowSpy.mockReturnValue(1250);
    const keyTouch = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    keyButton.dispatchEvent(keyTouch);
    expect(keyTouch.defaultPrevented).toBe(false);

    nowSpy.mockRestore();
  });

  it("configures CSS touch-action manipulation and user-select none for keyboard keys and panels", async () => {
    const css = await readFile(
      "src/features/osk-keyboard/osk-keyboard.css",
      "utf8"
    );
    expect(css).toMatch(/\.osk-panel\s*\{[\s\S]*?touch-action:\s*manipulation;/);
    expect(css).toMatch(/\.osk-key\s*\{[\s\S]*?touch-action:\s*manipulation;/);
    expect(css).toMatch(/\.osk-sheet-backdrop\s*\{[\s\S]*?touch-action:\s*manipulation;/);
    expect(css).toMatch(/\.osk-key\s*\{[\s\S]*?user-select:\s*none;/);
    expect(css).toMatch(/\.osk-panel\s*\{[\s\S]*?-webkit-touch-callout:\s*none;/);
    expect(css).toMatch(/\.osk-sheet-backdrop\s*\{[\s\S]*?-webkit-touch-callout:\s*none;/);

    const mainCss = await readFile("src/styles.css", "utf8");
    expect(mainCss).toMatch(/html\.space-osk-open[\s\S]*?touch-action:\s*manipulation;/);
    expect(mainCss).toMatch(/html\.space-osk-open[\s\S]*?-webkit-touch-callout:\s*none;/);
    expect(mainCss).toMatch(/-webkit-text-size-adjust:\s*100%;/);
  });

  it("blocks the long-press menu only on the keyboard, so the terminal's Copy/Paste menu still opens", () => {
    const { container } = render(<KeyboardHarness mobile />);

    // Before opening: contextmenu is not prevented
    const initialContextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    window.dispatchEvent(initialContextEvent);
    expect(initialContextEvent.defaultPrevented).toBe(false);

    const panel = openKeyboard(container);
    const backdrop = document.body.querySelector(".osk-sheet-backdrop") as HTMLElement;
    expect(backdrop).toBeTruthy();

    // While open: a long-press outside the keyboard keeps its menu
    const openContextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    window.dispatchEvent(openContextEvent);
    expect(openContextEvent.defaultPrevented).toBe(false);

    // Panel and backdrop contextmenu events are also prevented
    const panelContextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    panel.dispatchEvent(panelContextEvent);
    expect(panelContextEvent.defaultPrevented).toBe(true);

    const backdropContextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    backdrop.dispatchEvent(backdropContextEvent);
    expect(backdropContextEvent.defaultPrevented).toBe(true);

    // After closing: normal contextmenu behavior is restored
    fireEvent.click(screen.getByRole("button", { name: "Close on-screen keyboard" }));
    const closedContextEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    window.dispatchEvent(closedContextEvent);
    expect(closedContextEvent.defaultPrevented).toBe(false);
  });

  it("keeps CLI shortcuts hidden by default and toggles them with the shortcuts icon button", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);

    expect(screen.queryByRole("toolbar", { name: "CLI shortcuts" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show CLI shortcuts" });
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByRole("toolbar", { name: "CLI shortcuts" })).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide CLI shortcuts");

    fireEvent.click(toggle);
    expect(screen.queryByRole("toolbar", { name: "CLI shortcuts" })).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show CLI shortcuts");
  });

  it("renders CLI shortcut chips toolbar with continue, memory, /model, /resume, /usage, /clear, /help, /status", () => {
    const { container } = render(<KeyboardHarness defaultShowShortcuts />);
    openKeyboard(container);

    const toolbar = screen.getByRole("toolbar", { name: "CLI shortcuts" });
    expect(toolbar).toBeTruthy();
    expect(toolbar.classList.contains("osk-shortcuts-bar")).toBe(true);

    for (const cmd of OSK_CLI_COMMANDS) {
      const chip = screen.getByRole("button", { name: cmd.label });
      expect(chip).toBeTruthy();
      expect(chip.getAttribute("data-shortcut")).toBe(cmd.id);
    }
  });

  it("inserts CLI command text into the focused textarea when a shortcut chip is clicked", () => {
    const { container } = render(<KeyboardHarness defaultShowShortcuts />);
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "target");
    document.body.appendChild(textarea);
    textarea.focus();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "/model" }));
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "/model");

    fireEvent.click(screen.getByRole("button", { name: "/usage" }));
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "/usage");

    textarea.remove();
  });

  it("routes CLI command text through the onInput pane handler", () => {
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness defaultShowShortcuts onInput={(input) => { inputs.push(input); return true; }} />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "/resume" }));
    fireEvent.click(screen.getByRole("button", { name: "/clear" }));

    expect(inputs.map((input) => input.terminalData)).toEqual(["/resume", "\r", "/clear", "\r"]);
    expect(inputs.map((input) => input.text)).toEqual(["/resume", null, "/clear", null]);
  });

  it("routes continue and memory shortcut chips with an automatic enter submit", () => {
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness defaultShowShortcuts onInput={(input) => { inputs.push(input); return true; }} />);
    openKeyboard(container);

    fireEvent.click(screen.getByRole("button", { name: "continue" }));
    expect(inputs.map((input) => input.terminalData)).toEqual(["continue", "\r"]);

    inputs.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    expect(inputs.map((input) => input.terminalData)).toEqual(["save to memory", "\r"]);
  });

  it("inserts continue into focused textarea and dispatches Enter keydown", () => {
    const { container } = render(<KeyboardHarness defaultShowShortcuts />);
    const textarea = document.createElement("textarea");
    textarea.setAttribute("aria-label", "target");
    document.body.appendChild(textarea);
    textarea.focus();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    const keydownSpy = vi.fn();
    textarea.addEventListener("keydown", keydownSpy);

    openKeyboard(container);
    fireEvent.click(screen.getByRole("button", { name: "continue" }));

    expect(execCommand).toHaveBeenCalledWith("insertText", false, "continue");
    expect(keydownSpy).toHaveBeenCalled();
    const enterCall = keydownSpy.mock.calls.find((call) => (call[0] as KeyboardEvent).key === "Enter");
    expect(enterCall).toBeTruthy();

    textarea.remove();
  });

  it("renders the VoiceInputButton in the header controls", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);

    const micButton = screen.getByRole("button", { name: /voice input on-screen keyboard/i });
    expect(micButton).toBeTruthy();
    expect(micButton.classList.contains("voice-input-control")).toBe(true);
    expect(micButton.hasAttribute("disabled")).toBe(true);
  });

  it("enables VoiceInputButton when VoiceInputProvider is present", () => {
    const { container } = render(
      <VoiceInputProvider>
        <KeyboardHarness />
      </VoiceInputProvider>
    );
    openKeyboard(container);

    const micButton = screen.getByRole("button", { name: /voice input on-screen keyboard/i });
    expect(micButton).toBeTruthy();
    expect(micButton.hasAttribute("disabled")).toBe(false);
  });

  it("supports sendTextToInputOrFocused with range text fallback", () => {
    const originalExecCommand = (document as unknown as { execCommand?: unknown }).execCommand;
    delete (document as unknown as { execCommand?: unknown }).execCommand;
    try {
      const textarea = document.createElement("textarea");
      textarea.value = "hello ";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.selectionStart = 6;
      textarea.selectionEnd = 6;

      // Without onInput and without execCommand, inserts text directly via setRangeText
      sendTextToInputOrFocused("/help ");
      expect(textarea.value).toBe("hello /help ");

      textarea.remove();
    } finally {
      if (originalExecCommand !== undefined) {
        Object.defineProperty(document, "execCommand", { configurable: true, value: originalExecCommand });
      }
    }
  });

  it("computes autocomplete suggestions for English and Greek prefixes", () => {
    expect(getAutocompleteSuggestions("", "en")).toEqual(["status", "continue", "help"]);
    expect(getAutocompleteSuggestions("", "el")).toEqual(["συνέχεια", "κατάσταση", "βοήθεια"]);

    const enSuggestions = getAutocompleteSuggestions("pl", "en");
    expect(enSuggestions).toContain("plan");

    const elSuggestions = getAutocompleteSuggestions("καν", "el");
    expect(elSuggestions).toContain("κάνε");
  });

  it("toggles word autocomplete bar with the Sparkles icon button", () => {
    const { container } = render(<KeyboardHarness />);
    openKeyboard(container);

    expect(screen.queryByRole("toolbar", { name: "Word suggestions" })).toBeNull();
    const toggle = screen.getByRole("button", { name: "Enable word autocompletion" });
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(screen.getByRole("toolbar", { name: "Word suggestions" })).toBeTruthy();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Disable word autocompletion");

    fireEvent.click(toggle);
    expect(screen.queryByRole("toolbar", { name: "Word suggestions" })).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Enable word autocompletion");
  });

  it("completes words when typing and tapping a suggestion chip", () => {
    const { container } = render(<KeyboardHarness defaultAutocomplete />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();

    openKeyboard(container);

    const toolbar = screen.getByRole("toolbar", { name: "Word suggestions" });
    expect(toolbar).toBeTruthy();

    // Type "p" then "l"
    fireEvent.click(screen.getByRole("button", { name: "p" }));
    fireEvent.click(screen.getByRole("button", { name: "l" }));

    // Suggestion for "plan" should be visible
    const planChip = screen.getByRole("button", { name: "plan" });
    expect(planChip).toBeTruthy();

    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    fireEvent.click(planChip);
    // Completes suffix "an "
    expect(execCommand).toHaveBeenCalledWith("insertText", false, "an ");

    textarea.remove();
  });
});

describe("OnScreenKeyboard Ctrl and key repeat", () => {
  function openPanel(container: HTMLElement) {
    fireEvent.click(container.querySelector('button[aria-label="On-screen keyboard"]')!);
  }

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends Ctrl + a letter as one control character, then releases Ctrl", () => {
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness onInput={(input) => { inputs.push(input); return true; }} />);
    openPanel(container);

    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    fireEvent.click(ctrl);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "c" }));
    fireEvent.click(screen.getByRole("button", { name: "c" }));

    expect(inputs.map((input) => input.terminalData)).toEqual(["\u0003", "c"]);
    expect(inputs[0]).toMatchObject({ ctrlKey: true, text: null });
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it("dispatches Ctrl + letter as a keydown instead of typing into a focused textarea", () => {
    const { container } = render(<KeyboardHarness />);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const keydown = vi.fn();
    textarea.addEventListener("keydown", keydown);
    openPanel(container);

    fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
    fireEvent.click(screen.getByRole("button", { name: "a" }));

    expect(textarea.value).toBe("");
    expect(keydown.mock.calls[0]?.[0]).toMatchObject({ key: "a", ctrlKey: true });
    textarea.remove();
  });

  it("repeats a held Backspace and does not type again on release", () => {
    vi.useFakeTimers();
    const inputs: OnScreenKeyboardInput[] = [];
    const { container } = render(<KeyboardHarness onInput={(input) => { inputs.push(input); return true; }} />);
    openPanel(container);

    const backspace = screen.getByRole("button", { name: "⌫" });
    fireEvent.pointerDown(backspace);
    act(() => { vi.advanceTimersByTime(450 + 60 * 3); });
    fireEvent.pointerUp(backspace);
    fireEvent.click(backspace);
    act(() => { vi.advanceTimersByTime(500); });

    expect(inputs.map((input) => input.terminalData)).toEqual(["\u007f", "\u007f", "\u007f", "\u007f"]);

    // A short tap still types once, and letters never repeat.
    fireEvent.pointerDown(backspace);
    fireEvent.pointerUp(backspace);
    fireEvent.click(backspace);
    const q = screen.getByRole("button", { name: "q" });
    fireEvent.pointerDown(q);
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.pointerUp(q);
    fireEvent.click(q);
    expect(inputs.slice(4).map((input) => input.terminalData)).toEqual(["\u007f", "q"]);
  });
});

describe("OnScreenKeyboard phone inset", () => {
  afterEach(() => cleanup());

  it("reserves the board below a keyboard docked in the lower half and releases it on close", () => {
    const { container } = render(<KeyboardHarness mobile />);
    fireEvent.click(container.querySelector('button[aria-label="On-screen keyboard"]')!);
    const panel = document.getElementById(OSK_PANEL_ID)!;
    const board = document.createElement("section");
    board.className = "board";
    const shell = document.createElement("div");
    shell.className = "space-shell";
    shell.appendChild(board);
    document.body.appendChild(shell);
    vi.spyOn(board, "getBoundingClientRect").mockReturnValue({ bottom: 800 } as DOMRect);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ top: 560, bottom: 760, left: 8, right: 382, width: 374, height: 200 } as DOMRect);
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(document.documentElement.style.getPropertyValue("--osk-sheet-inset")).toBe("240px");

    fireEvent.click(screen.getByRole("button", { name: "Close on-screen keyboard" }));
    expect(document.documentElement.style.getPropertyValue("--osk-sheet-inset")).toBe("");
    shell.remove();
  });
});
