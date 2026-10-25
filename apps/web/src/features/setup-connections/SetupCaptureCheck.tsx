import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { captureSnip, checkAbort } from "../snip-tool/snip-capture.js";
import { buildSetupCaptureProofPixels } from "./setup-capture-pixels.js";

export interface SetupCaptureClient {
  beginSetupCaptureCheck(draftRevision: number): Promise<{ checkId: string; colors: string[] }>;
  completeSetupCaptureCheck(checkId: string, rgba: string): Promise<{ verified: boolean }>;
  cancelSetupCaptureCheck(checkId: string): Promise<void>;
}

/** Sends only the cropped synthetic pattern, never the captured viewport. */
async function capturePattern(controls: HTMLElement, signal: AbortSignal, board: HTMLCanvasElement, colors: string[]): Promise<string> {
  let aligned = false;
  const image = await captureSnip(controls, signal, { onSource: value => { aligned = value; } });
  checkAbort(signal);
  if (!aligned) throw new Error("Select this Space tab so the test can safely read only its pattern.");
  const bitmap = await createImageBitmap(image);
  try {
    checkAbort(signal);
    const rect = board.getBoundingClientRect();
    const scaleX = bitmap.width / window.innerWidth; const scaleY = bitmap.height / window.innerHeight;
    if (rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
      throw new Error("Keep the complete test pattern visible and try again.");
    }
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d"); if (!context) throw new Error("The capture image could not be checked.");
    context.drawImage(bitmap, rect.left * scaleX, rect.top * scaleY, rect.width * scaleX, rect.height * scaleY, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    return buildSetupCaptureProofPixels(pixels, colors);
  } finally { bitmap.close(); }
}

export function SetupCaptureCheck({ client, draftRevision, onVerified, onActiveChange, portalTarget,
  capture = capturePattern }: { client: SetupCaptureClient; draftRevision: number; onVerified: () => Promise<void> | void;
  onActiveChange?: (active: boolean) => void; portalTarget?: HTMLElement | null;
  capture?: (controls: HTMLElement, signal: AbortSignal, board: HTMLCanvasElement, colors: string[]) => Promise<string> }) {
  const [check, setCheck] = useState<{ checkId: string; colors: string[] } | null>(null);
  const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null); const checkId = useRef<string | null>(null);
  const board = useRef<HTMLCanvasElement>(null); const controls = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const captureButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => () => {
    controller.current?.abort();
    if (checkId.current) void client.cancelSetupCaptureCheck(checkId.current).catch(() => {});
  }, [client]);
  useEffect(() => {
    if (!check) return;
    restoreFocus.current = true;
    const canvas = board.current; const context = canvas?.getContext("2d");
    if (canvas && context) for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
      context.fillStyle = check.colors[row * 8 + col]!; context.fillRect(col * 16, row * 16, 16, 16);
    }
    captureButton.current?.focus();
  }, [check]);
  useEffect(() => {
    if (!check && !pending && restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); }
  }, [check, pending]);
  function cancel() {
    controller.current?.abort();
    const id = checkId.current; checkId.current = null;
    if (id) void client.cancelSetupCaptureCheck(id).catch(() => {});
    setCheck(null); setPending(false); onActiveChange?.(false); trigger.current?.focus();
  }
  async function begin() {
    if (pending) return;
    setPending(true); setError(null); const abort = new AbortController(); controller.current = abort;
    try {
      const value = await client.beginSetupCaptureCheck(draftRevision);
      if (abort.signal.aborted) { await client.cancelSetupCaptureCheck(value.checkId); return; }
      if (value.colors.length !== 64 || value.colors.some(color => !/^#[a-f0-9]{6}$/i.test(color))) throw new Error("The capture check is unavailable.");
      checkId.current = value.checkId; setCheck(value); onActiveChange?.(true);
    } catch { if (!abort.signal.aborted) setError("The capture check could not start. Try again."); }
    finally { if (!abort.signal.aborted) setPending(false); }
  }
  async function testCapture() {
    if (pending || !check || !board.current || !controls.current) return;
    const abort = controller.current!; setPending(true); setError(null);
    try {
      const rgba = await capture(controls.current, abort.signal, board.current, check.colors);
      checkAbort(abort.signal);
      const result = await client.completeSetupCaptureCheck(check.checkId, rgba);
      checkAbort(abort.signal); if (!result.verified) throw new Error("The capture test did not verify.");
      checkId.current = null; setCheck(null); onActiveChange?.(false);
      await onVerified();
    } catch (cause) {
      if (!abort.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "The capture test failed. Try again or remove Screen capture for now.");
        const id = checkId.current; checkId.current = null;
        if (id) void client.cancelSetupCaptureCheck(id).catch(() => {});
        setCheck(null); onActiveChange?.(false); trigger.current?.focus();
      }
    } finally { if (!abort.signal.aborted) setPending(false); }
  }
  function trapFocus(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
    if (event.key !== "Tab") return;
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const first = buttons[0]; const last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div className="first-setup-service" aria-busy={pending}>
    <strong>Screen capture</strong>
    <p>Test the existing capture tool after granting permission. Only this synthetic pattern is checked; the image of your workspace is discarded.</p>
    <button ref={trigger} type="button" disabled={pending || Boolean(check)} onClick={() => void begin()}>Test capture</button>
    {error && <p role="alert">{error}</p>}
    {check && createPortal(<div className="first-setup-capture-overlay" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="setup-capture-title" onKeyDown={trapFocus}>
      <div className="first-setup-capture-content">
        <h3 id="setup-capture-title">Screen capture test</h3>
        <p>Choose this Space tab in the permission prompt. Your browser or operating system must allow capture.</p>
        <canvas ref={board} width={128} height={128} aria-label="Synthetic capture test pattern" />
        <div ref={controls} className="first-setup-capture-controls">
          <button ref={captureButton} type="button" disabled={pending} onClick={() => void testCapture()}>{pending ? "Capturing…" : "Capture test pattern"}</button>
          <button type="button" onClick={cancel}>Cancel capture test</button>
        </div>
      </div>
    </div>, portalTarget ?? document.body)}
  </div>;
}
