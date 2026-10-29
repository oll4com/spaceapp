import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as setupCapture from "../src/features/setup-connections/SetupCaptureCheck.js";
beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ fillRect() {} }) as unknown as CanvasRenderingContext2D); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("selected capture check", () => {
  it("requests capture only from the explicit button and allows cancellation without a success receipt", async () => {
    let checkAbort: AbortSignal | undefined; let cancelCapture: (() => void) | undefined;
    const client = { beginSetupCaptureCheck: vi.fn(async () => ({ checkId: "fixture", colors: Array(64).fill("#4080c0") })),
      completeSetupCaptureCheck: vi.fn(async () => ({ verified: true })), cancelSetupCaptureCheck: vi.fn(async () => {}) };
    const completed = vi.fn();
    render(<setupCapture.SetupCaptureCheck client={client} draftRevision={0} onVerified={completed} capture={async (_element, signal) => {
      checkAbort = signal;
      await new Promise<void>(resolve => { cancelCapture = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
      throw new DOMException("Cancelled", "AbortError");
    }} />);
    expect(client.beginSetupCaptureCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Test capture" }));
    // Focus moves in an effect after the button renders; wait for the focus, not only the button.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Capture test pattern" })));
    fireEvent.click(screen.getByRole("button", { name: "Capture test pattern" }));
    await waitFor(() => expect(checkAbort).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Cancel capture test" })); cancelCapture?.();
    await waitFor(() => expect(client.cancelSetupCaptureCheck).toHaveBeenCalledWith("fixture"));
    expect(checkAbort?.aborted).toBe(true); expect(client.completeSetupCaptureCheck).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Test capture" })));
  });
});
