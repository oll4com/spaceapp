import { describe, expect, it, vi } from "vitest";
import { routePaneKeyboardInput, browserKeyboardInputs } from "../src/features/osk-keyboard/pane-keyboard-input.js";
import { BROWSER_PANE_ACTION_EVENT, dispatchBrowserPaneActionEvent, parseBrowserPaneActionDetail, registerBrowserPaneEventTarget } from "../src/features/browser-pane/events.js";

const letter = { key: "α", code: "KeyA", shiftKey: false, text: "α", terminalData: "α" };

describe("pane keyboard routing", () => {
  it("preserves terminal control sequences, chat text and the local fallback", () => {
    const dispatch = { terminal: vi.fn(), chat: vi.fn() };
    const enter = { ...letter, key: "Enter", code: "Enter", text: null, terminalData: "\r" };
    expect(routePaneKeyboardInput({ id: "terminal", mode: "TERMINAL" }, enter, dispatch)).toBe(true);
    expect(dispatch.terminal).toHaveBeenCalledWith("terminal", { action: "keyboard_input", text: "\r" });
    expect(routePaneKeyboardInput({ id: "chat", mode: "CHAT" }, letter, dispatch)).toBe(true);
    expect(dispatch.chat).toHaveBeenCalledWith("chat", { action: "insert_text", text: "α" });
    expect(routePaneKeyboardInput({ id: "chat", mode: "CHAT" }, enter, dispatch)).toBe(false);
    expect(routePaneKeyboardInput({ id: "files", mode: "LIVE" }, letter, dispatch)).toBe(false);
    expect(routePaneKeyboardInput(null, letter, dispatch)).toBe(false);
  });

  it("sends characters as char input and Ctrl combinations as paired keys with modifiers", () => {
    expect(browserKeyboardInputs(letter)).toEqual([{ type: "KEY", eventType: "char", key: "α", code: "KeyA", text: "α", modifiers: 0 }]);
    expect(browserKeyboardInputs({ ...letter, key: "a", text: null, ctrlKey: true })).toEqual([
      { type: "KEY", eventType: "keyDown", key: "a", code: "KeyA", modifiers: 2 },
      { type: "KEY", eventType: "keyUp", key: "a", code: "KeyA", modifiers: 2 }
    ]);
  });

  it("validates keyboard actions and never replays transient keys after a browser mounts", () => {
    expect(parseBrowserPaneActionDetail({ paneId: "browser", action: "keyboard_input" })).toBeNull();
    expect(parseBrowserPaneActionDetail({ paneId: "browser", action: "keyboard_input", keyboardInput: { ...letter, text: 5 } })).toBeNull();
    const received = vi.fn();
    dispatchBrowserPaneActionEvent({ paneId: "late-browser", action: "keyboard_input", keyboardInput: letter });
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, received);
    const unregister = registerBrowserPaneEventTarget("late-browser");
    try { expect(received).not.toHaveBeenCalled(); }
    finally { unregister(); window.removeEventListener(BROWSER_PANE_ACTION_EVENT, received); }
  });
});
