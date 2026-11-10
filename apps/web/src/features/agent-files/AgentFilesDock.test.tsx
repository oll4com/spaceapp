// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilePreviewDialog } from "./AgentFilesDock.js";

describe("FilePreviewDialog fullscreen", () => {
  it("toggles fullscreen mode on the file preview modal and body", () => {
    const { container } = render(
      <FilePreviewDialog
        filename="report.md"
        meta="1 KB"
        kind="TEXT"
        url="/preview"
        closeLabel="Close"
        onClose={() => undefined}
      />
    );
    const modal = screen.getByRole("dialog", { name: "Preview report.md" });
    const modalBody = container.querySelector(".agent-files-modal-body");
    const fullscreenButton = screen.getByRole("button", { name: "Open file preview fullscreen" });
    expect(modal.className).not.toContain("is-fullscreen");
    expect(modalBody?.className).not.toContain("is-fullscreen");

    fireEvent.click(fullscreenButton);
    expect(modal.className).toContain("is-fullscreen");
    expect(modalBody?.className).toContain("is-fullscreen");

    const exitButton = screen.getByRole("button", { name: "Exit file preview fullscreen" });
    fireEvent.click(exitButton);
    expect(modal.className).not.toContain("is-fullscreen");
    expect(modalBody?.className).not.toContain("is-fullscreen");
  });
});
