import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserLink } from "@space/contracts";
import { EmbeddedDashboardDialog } from "../src/features/embedded-dashboard/EmbeddedDashboardDialog.js";

const link: UserLink = {
  id: "link:headroom", title: "Headroom", description: "Capacity dashboard",
  url: "https://example.invalid:8787/dashboard", openMode: "EMBEDDED", category: "GENERAL", isQuick: true, sortOrder: 1,
  createdAt: "2026-07-16T08:00:00.000Z", updatedAt: "2026-07-16T08:00:00.000Z"
};

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open link</button>{open ? <EmbeddedDashboardDialog link={link} onClose={() => setOpen(false)} /> : null}</>;
}

afterEach(() => vi.restoreAllMocks());

describe("EmbeddedDashboardDialog", () => {
  it("renders a dynamic iframe with least-privilege attributes and visible external fallback", () => {
    render(<EmbeddedDashboardDialog link={link} onClose={vi.fn()} />);
    const iframe = screen.getByTitle("Headroom link");
    expect(iframe.getAttribute("src")).toBe(link.url);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    const external = screen.getByRole("link", { name: "Open Headroom in new tab" });
    expect(external.getAttribute("rel")).toBe("noreferrer noopener");
    expect(screen.getByText("Capacity dashboard")).toBeTruthy();
  });

  it("loads, reloads, closes on Escape cancel, and restores focus", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open link" });
    opener.focus(); fireEvent.click(opener);
    const first = screen.getByTitle("Headroom link");
    expect(screen.getByRole("status").textContent).toContain("Loading Headroom");
    fireEvent.load(first);
    fireEvent.click(screen.getByRole("button", { name: "Reload Headroom" }));
    expect(screen.getByTitle("Headroom link")).not.toBe(first);
    const dialog = screen.getByRole("dialog", { name: "Headroom" });
    fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "Headroom" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
