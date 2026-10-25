import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "@space/contracts";
import { MediaDock } from "../src/features/media-dock/MediaDock.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testRoom: Room = {
  id: "room:test",
  name: "Test Room",
  description: null,
  kind: "WORKSPACE",
  order: 0,
  paneLayoutColumns: null,
  paneLayoutHeight: 1,
  paneCap: 16,
  traceId: "trace:test",
  archivedAt: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z"
};

describe("Fullscreen and Maximize Red Border", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
  });

  it("applies dock-fullscreen-toggle and is-active classes when MediaDock is maximized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/artifacts")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              page: 1,
              pageSize: 100,
              total: 0,
              items: []
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      })
    );

    render(<MediaDock activeRoom={testRoom} />);

    const button = await screen.findByRole("button", { name: "Open media fullscreen" });
    expect(button.classList.contains("dock-fullscreen-toggle")).toBe(true);
    expect(button.classList.contains("is-active")).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);

    const exitButton = screen.getByRole("button", { name: "Exit media fullscreen" });
    expect(exitButton.classList.contains("dock-fullscreen-toggle")).toBe(true);
    expect(exitButton.classList.contains("is-active")).toBe(true);
    expect(exitButton.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(exitButton);

    const restoredButton = screen.getByRole("button", { name: "Open media fullscreen" });
    expect(restoredButton.classList.contains("is-active")).toBe(false);
    expect(restoredButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("defines active red border CSS in styles.css and modern-theme.css", () => {
    const classicCss = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
    const modernCss = readFileSync(resolve(__dirname, "../src/features/ui-theme/modern-theme.css"), "utf8");

    // Classic styles.css definitions
    expect(classicCss).toContain(".pane-maximize-toggle.is-active");
    expect(classicCss).toContain(".dock-fullscreen-toggle.is-active");
    expect(classicCss).toContain("var(--active-icon-border, #ff4d5e)");

    // Modern theme definitions
    expect(modernCss).toContain(".pane-maximize-toggle.is-active");
    expect(modernCss).toContain(".dock-fullscreen-toggle.is-active");
    expect(modernCss).toContain("var(--active-icon-border, #ff4d5e)");
    expect(modernCss).not.toContain("!important");
  });
});
