// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("FilePreviewDialog HTML", () => {
  afterEach(() => vi.unstubAllGlobals());
  const source = "<button onclick=\"next()\">Next</button><script>function next(){}</script>";
  const open = (pageUrl?: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source)));
    return render(<FilePreviewDialog filename="rating-trial.html" meta="1 KB" kind="TEXT" url="/preview" pageUrl={pageUrl} closeLabel="Close" onClose={() => undefined} />);
  };

  it("runs an Agent Files HTML file as a page in a sandbox without Space's origin, and shows its source on request (operator nous_msg:709c40fa)", async () => {
    const { container } = open("/preview?view=page");
    const frame = screen.getByTitle("Preview of rating-trial.html");
    expect([frame.tagName, frame.getAttribute("src")]).toEqual(["IFRAME", "/preview?view=page"]);
    expect(frame.getAttribute("sandbox")?.split(" ").sort()).toEqual(["allow-downloads", "allow-forms", "allow-modals", "allow-scripts"]);
    fireEvent.click(screen.getByRole("button", { name: "Show page source" }));
    await vi.waitFor(() => expect(container.querySelector(".agent-files-text-preview")?.textContent).toBe(source));
    fireEvent.click(screen.getByRole("button", { name: "Show page" }));
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("keeps an HTML file as text where no page URL serves it (a Nous attachment)", async () => {
    const { container } = open();
    await vi.waitFor(() => expect(container.querySelector(".agent-files-text-preview")?.textContent).toBe(source));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show page" })).toBeNull();
  });
});
