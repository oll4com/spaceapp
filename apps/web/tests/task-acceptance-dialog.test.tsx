import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAcceptanceDialog } from "../src/features/agent-pane/TaskAcceptanceDialog.js";
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
    value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
});
afterEach(() => { delete (HTMLDialogElement.prototype as unknown as { showModal?: unknown }).showModal; vi.restoreAllMocks(); });
describe("Optional result check editor", () => {
  it("saves the literal expected text and does not allow an empty check", () => {
    const onSave = vi.fn();
    render(<TaskAcceptanceDialog onSave={onSave} onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "Save check" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Expected answer" }), { target: { value: "Εντάξει" } });
    fireEvent.click(screen.getByRole("button", { name: "Save check" }));
    expect(onSave).toHaveBeenCalledWith({ version: 1, checks: [{ id: "expected-text", kind: "TEXT_EQUALS", expected: "Εντάξει", normalization: "TRIM", critical: true }] });
  });
  it("removes a saved check and closes on native Escape cancellation", () => {
    const onSave = vi.fn(), onClose = vi.fn();
    render(<TaskAcceptanceDialog current={{ version: 1, checks: [{ id: "text", kind: "TEXT_EQUALS", expected: "42", normalization: "TRIM", critical: true }] }}
      onSave={onSave} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove check" }));
    expect(onSave).toHaveBeenCalledWith(undefined);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
