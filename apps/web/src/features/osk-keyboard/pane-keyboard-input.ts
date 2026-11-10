import type { Pane } from "@space/contracts";
import { dispatchBrowserPaneActionEvent, type BrowserPaneKeyboardInput } from "../browser-pane/events.js";
import type { BrowserCanvasInput } from "../browser-pane/BrowserCanvas.js";
import type { OnScreenKeyboardInput } from "./OnScreenKeyboard.js";

const BROWSER_PANE_MODES: ReadonlyArray<Pane["mode"]> = ["BROWSER", "YOUTUBE", "JOB_APPLY", "MARKETING_COPILOT", "FREELANCE_COPILOT"];

export function routePaneKeyboardInput(
  pane: Pick<Pane, "id" | "mode"> | null | undefined,
  input: OnScreenKeyboardInput,
  dispatch: {
    terminal: (paneId: string, action: { action: "keyboard_input"; text: string }) => void;
    chat: (paneId: string, action: { action: "insert_text"; text: string }) => void;
  }
): boolean {
  if (!pane) return false;
  if (pane.mode === "TERMINAL") {
    dispatch.terminal(pane.id, { action: "keyboard_input", text: input.terminalData });
    return true;
  }
  if (pane.mode === "CHAT" && input.text !== null) {
    dispatch.chat(pane.id, { action: "insert_text", text: input.text });
    return true;
  }
  if (!BROWSER_PANE_MODES.includes(pane.mode)) return false;
  dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "keyboard_input", keyboardInput: input });
  return true;
}

export function browserKeyboardInputs(input: BrowserPaneKeyboardInput): BrowserCanvasInput[] {
  const base = { type: "KEY" as const, key: input.key, code: input.code, modifiers: (input.ctrlKey ? 2 : 0) | (input.shiftKey ? 8 : 0) };
  if (input.text !== null && !input.ctrlKey) return [{ ...base, eventType: "char", text: input.text }];
  return [
    { ...base, eventType: "keyDown", ...(input.key === "Enter" ? { text: "\r" } : {}) },
    { ...base, eventType: "keyUp" }
  ];
}
