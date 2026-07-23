import { useEffect } from "react";
import type { ClipboardOperatorSource } from "@space/contracts";
import { clipboardTextMaxCharacters } from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

export const SPACE_CLIPBOARD_ITEM_MIME = "application/x-space-clipboard-item-id";
export const SPACE_CLIPBOARD_UPDATED_EVENT = "space:clipboard-updated";
export const SPACE_CLIPBOARD_NOTICE_EVENT = "space:clipboard-notice";
export const SPACE_CLIPBOARD_PAUSE_EVENT = "space:clipboard-pause";
export const SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE = "data-space-clipboard-capture";

const pauseStorageKey = "space.clipboard.capture-paused";
const capturedClipboardEvents = new WeakSet<Event>();

export function clipboardCharacterCount(text: string): number {
  return Array.from(text).length;
}

export async function writeClipboardText(text: string): Promise<"live" | "demo"> {
  const runtime = getSpaceRuntime();
  if (runtime.platform.clipboard?.writeText) {
    try {
      await runtime.platform.clipboard.writeText(text);
      return runtime.kind;
    } catch {
      // Fall through for HTTP, headless, or permission-restricted browser contexts.
    }
  }
  if (runtime.kind === "demo") {
    throw new Error("Demo clipboard is unavailable.");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute(SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE, "off");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy failed.");
  } finally {
    textarea.remove();
  }
  return runtime.kind;
}

export function isClipboardCapturePaused(): boolean {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(pauseStorageKey) === "true";
  } catch {
    return false;
  }
}

export function setClipboardCapturePaused(paused: boolean): void {
  try {
    getSpaceRuntime().platform.localStorage.setItem(pauseStorageKey, String(paused));
  } catch {
    // Capture still pauses for the current mounted UI through the event below.
  }
  window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_PAUSE_EVENT, { detail: { paused } }));
}

export function notifyClipboardUpdated(): void {
  window.dispatchEvent(new Event(SPACE_CLIPBOARD_UPDATED_EVENT));
}

function notifyClipboardNotice(message: string): void {
  window.dispatchEvent(new CustomEvent(SPACE_CLIPBOARD_NOTICE_EVENT, { detail: { message } }));
}

export async function captureClipboardText(input: {
  text: string;
  source: ClipboardOperatorSource;
  roomId?: string | null;
  paneId?: string | null;
  paneTitle?: string | null;
}): Promise<"CAPTURED" | "IGNORED" | "PAUSED" | "TOO_LARGE" | "FAILED"> {
  if (!input.text.trim()) return "IGNORED";
  if (isClipboardCapturePaused()) return "PAUSED";
  if (clipboardCharacterCount(input.text) > clipboardTextMaxCharacters) {
    notifyClipboardNotice("Text was copied or pasted, but it was too large to add to Clipboard history.");
    return "TOO_LARGE";
  }
  try {
    await api.createClipboardItem(input);
    notifyClipboardUpdated();
    return "CAPTURED";
  } catch {
    notifyClipboardNotice("Clipboard history could not record this text. The copy or paste still completed.");
    return "FAILED";
  }
}

export function captureClipboardEventText(
  event: Event,
  input: Parameters<typeof captureClipboardText>[0]
): Promise<Awaited<ReturnType<typeof captureClipboardText>>> {
  if (capturedClipboardEvents.has(event)) return Promise.resolve("IGNORED");
  capturedClipboardEvents.add(event);
  return captureClipboardText(input);
}

function captureTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  return target instanceof Node ? target.parentElement : null;
}

export function isClipboardCaptureExcluded(target: EventTarget | null): boolean {
  const element = captureTargetElement(target);
  if (!element) return false;
  return Boolean(
    element.closest("input[type='password']") ||
      element.closest(".login-shell") ||
      element.closest(`[${SPACE_CLIPBOARD_CAPTURE_OPT_OUT_ATTRIBUTE}='off']`)
  );
}

function selectedInputText(target: EventTarget | null): string {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return "";
  if (target.type === "password") return "";
  const start = target.selectionStart;
  const end = target.selectionEnd;
  return start === null || end === null || end <= start ? "" : target.value.slice(start, end);
}

function copiedText(event: ClipboardEvent): string {
  return (
    event.clipboardData?.getData("text/plain") ||
    selectedInputText(event.target) ||
    window.getSelection()?.toString() ||
    ""
  );
}

function captureMetadata(target: EventTarget | null) {
  const element = captureTargetElement(target);
  const pane = element?.closest<HTMLElement>("[data-space-pane-id]");
  return {
    roomId: pane?.dataset.spaceRoomId ?? null,
    paneId: pane?.dataset.spacePaneId ?? null,
    paneTitle: pane?.dataset.spacePaneTitle ?? null
  };
}

export function useSpaceClipboardCapture(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onCopy = (event: ClipboardEvent) => {
      if (isClipboardCaptureExcluded(event.target)) return;
      const text = copiedText(event);
      if (text) void captureClipboardEventText(event, { text, source: "COPY", ...captureMetadata(event.target) });
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isClipboardCaptureExcluded(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) void captureClipboardEventText(event, { text, source: "PASTE", ...captureMetadata(event.target) });
    };
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("paste", onPaste, true);
    return () => {
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("paste", onPaste, true);
    };
  }, [enabled]);
}
