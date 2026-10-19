import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { FilesPane } from "../src/features/files-pane/FilesPane.js";

installSpaceRuntime(liveRuntime);

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("FilesPane Component", () => {
  it("starts mobile with the sidebar closed without changing desktop preference", async () => {
    localStorage.setItem("space_fm_sidebar", "true");
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "filesList").mockResolvedValue({ currentPath: "/opt/spaceapp", parentPath: null, canGoUp: false, workspaceRoot: "/opt/spaceapp", entries: [] } as any);
    render(<FilesPane mobile />);
    expect(await screen.findByRole("button", { name: "Show sidebar" })).toBeTruthy();
    expect(localStorage.getItem("space_fm_sidebar")).toBe("true");
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("renders without crashing with minimal props", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "filesList").mockResolvedValue({
      currentPath: "/opt/spaceapp",
      parentPath: "/",
      canGoUp: true,
      workspaceRoot: "/opt/spaceapp",
      entries: [
        {
          name: "test-dir",
          path: "/opt/spaceapp/test-dir",
          isDirectory: true,
          size: 4096,
          mtime: "2026-09-21T12:00:00.000Z",
          birthtime: "2026-09-21T12:00:00.000Z",
          permissions: "rwxr-xr-x",
          owner: "space",
          group: "space"
        },
        {
          name: "test-file.txt",
          path: "/opt/spaceapp/test-file.txt",
          isDirectory: false,
          size: 1024,
          mtime: "2026-09-21T12:00:00.000Z",
          birthtime: "2026-09-21T12:00:00.000Z",
          permissions: "rw-r--r--",
          owner: "space",
          group: "space",
          mimeType: "text/plain"
        }
      ]
    } as any);

    const { container } = render(
      <FilesPane
        pane={{
          id: "pane:test",
          roomId: "room:test",
          title: "Files 5",
          mode: "FILES",
          status: "OPEN",
          columnSpan: 1,
          isMaximized: false,
          isMinimized: false,
          isClosed: false,
          paneOrder: 0,
          reasoningEffort: "medium",
          titleSource: "auto",
          split: { size: null, parentId: null, direction: null },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } as any}
      />
    );

    expect(container).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText("test-file.txt")).toBeDefined();
      expect(screen.getAllByText("test-dir").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("handles empty entries safely", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "filesList").mockResolvedValue({
      currentPath: "/opt/spaceapp",
      parentPath: null,
      canGoUp: false,
      workspaceRoot: "/opt/spaceapp",
      entries: []
    } as any);

    render(
      <FilesPane
        pane={{
          id: "pane:test-empty",
          roomId: "room:test",
          title: "Files 5",
          mode: "FILES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("This folder is empty")).toBeDefined();
    });
  });

  it("handles undefined entries gracefully", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "ADMIN" } } as any);
    vi.spyOn(liveRuntime.api, "filesList").mockResolvedValue({
      currentPath: "/opt/spaceapp",
      parentPath: null,
      canGoUp: false,
      workspaceRoot: "/opt/spaceapp",
      entries: undefined as any
    } as any);

    render(
      <FilesPane
        pane={{
          id: "pane:test-undefined",
          roomId: "room:test",
          title: "Files 5",
          mode: "FILES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("This folder is empty")).toBeDefined();
    });
  });

  it("handles api failure gracefully without crashing the view", async () => {
    vi.spyOn(liveRuntime.api, "me").mockRejectedValue(new Error("Network failure"));
    vi.spyOn(liveRuntime.api, "filesList").mockRejectedValue(new Error("Disk error"));

    render(
      <FilesPane
        pane={{
          id: "pane:test-error",
          roomId: "room:test",
          title: "Files 5",
          mode: "FILES"
        } as any}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Disk error")).toBeDefined();
    });
  });

  it("verifies action buttons render with type=button and fm-action-btn class", async () => {
    vi.spyOn(liveRuntime.api, "me").mockResolvedValue({ user: { id: "user:1", role: "USER" } } as any);
    vi.spyOn(liveRuntime.api, "filesList").mockResolvedValue({
      currentPath: "/opt/spaceapp",
      parentPath: "/",
      canGoUp: true,
      workspaceRoot: "/opt/spaceapp",
      entries: [
        {
          name: "example.txt",
          path: "/opt/spaceapp/example.txt",
          isDirectory: false,
          size: 100,
          mtime: "2026-09-21T12:00:00.000Z",
          permissions: "rw-r--r--",
          mimeType: "text/plain"
        }
      ]
    } as any);

    const { container } = render(
      <FilesPane
        pane={{
          id: "pane:test-actions",
          roomId: "room:test",
          title: "Files 11",
          mode: "FILES"
        } as any}
      />
    );

    await waitFor(() => {
      const actionBtns = container.querySelectorAll(".fm-actions-cell button.fm-action-btn");
      expect(actionBtns.length).toBeGreaterThanOrEqual(2); // Preview and Download
      actionBtns.forEach((btn) => {
        expect(btn.getAttribute("type")).toBe("button");
      });
    });
  });

  it("ensures files-pane.css contains transparent background for action buttons and responsive rules for disk storage", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const cssPath = resolve(__dirname, "../src/features/files-pane/files-pane.css");
    const cssContent = readFileSync(cssPath, "utf-8");

    // Action buttons must have transparent background without separate color
    expect(cssContent).toContain(".fm-action-btn");
    expect(cssContent).toContain("background: transparent !important");
    expect(cssContent).toContain("border: none !important");

    // Disk storage must have rules to hide on small screens / compact viewports
    expect(cssContent).toContain(".fm-sidebar-scroll-area");
    expect(cssContent).toContain(".fm-sidebar.is-compact .fm-sidebar-disk-section");
    expect(cssContent).toContain("@media (max-width: 767px), (max-height: 600px)");
    expect(cssContent).toContain("@container filespane (max-width: 768px)");
  });
});
