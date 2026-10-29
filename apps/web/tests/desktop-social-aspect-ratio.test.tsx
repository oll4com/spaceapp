import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopWindowTitlebar } from "../src/features/desktop-titlebar/DesktopWindowTitlebar.js";
import { registerLocalCliDraftReloadGuard } from "../src/features/terminal-pane/local-cli-draft.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("DesktopWindowTitlebar Social Aspect Ratio & Window Recording", () => {
  let mockBridge: any;

  beforeEach(() => {
    mockBridge = {
      isDesktop: true,
      getSystemInfo: vi.fn().mockResolvedValue({
        platform: "win32",
        arch: "x64",
        version: "0.1.18",
        electronVersion: "33.2.1"
      }),
      isMaximized: vi.fn().mockResolvedValue(true),
      setAspectRatio: vi.fn().mockResolvedValue({ success: true, preset: "16:9", width: 1600, height: 900 }),
      getWindowMediaSourceId: vi.fn().mockResolvedValue({ success: true, sourceId: "window:12345:0" }),
      capturePage: vi.fn().mockResolvedValue({ success: true, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }),
      saveRecording: vi.fn().mockResolvedValue({ success: true, filePath: "C:\\Users\\User\\Downloads\\recording.webm" }),
      openDownloadsFolder: vi.fn().mockResolvedValue(true),
      displays: {
        getAll: vi.fn().mockResolvedValue([{ id: 1, label: "Display 1", isPrimary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }])
      }
    };
    (window as any).spaceDesktop = mockBridge;
  });

  afterEach(() => {
    cleanup();
    delete (window as any).spaceDesktop;
    vi.restoreAllMocks();
  });

  it("renders titlebar with dedicated Record Window button and SpaceApp menu", async () => {
    render(<DesktopWindowTitlebar activeRoomName="Room 1" />);

    // SpaceApp menu trigger
    const menuTrigger = await screen.findByRole("button", { name: /SpaceApp/i });
    expect(menuTrigger).toBeTruthy();

    // Titlebar Record Window button
    const recordBtn = await screen.findByRole("button", { name: "Record Window" });
    expect(recordBtn).toBeTruthy();
    expect(recordBtn.textContent).toContain("Record Window");
  });

  it("marks body for the title bar inset only while the bar shows (no body:has() restyle on every DOM change)", () => {
    const { rerender, unmount } = render(<DesktopWindowTitlebar activeRoomName="Room 1" />);
    expect(document.body.getAttribute("data-desktop-titlebar")).toBe("true");
    rerender(<DesktopWindowTitlebar activeRoomName="Room 1" isFullscreen />);
    expect(document.body.hasAttribute("data-desktop-titlebar")).toBe(false);
    rerender(<DesktopWindowTitlebar activeRoomName="Room 1" />);
    expect(document.body.getAttribute("data-desktop-titlebar")).toBe("true");
    unmount();
    expect(document.body.hasAttribute("data-desktop-titlebar")).toBe(false);
  });

  it("reveals Social Media Aspect Ratio controls below Full Screen when opening menu", async () => {
    render(<DesktopWindowTitlebar activeRoomName="Room 1" />);

    const menuTrigger = await screen.findByRole("button", { name: /SpaceApp/i });
    fireEvent.click(menuTrigger);

    // Full Screen item
    const fullScreenItem = await screen.findByRole("menuitem", { name: /Full Screen/i });
    expect(fullScreenItem).toBeTruthy();

    // Social Media Aspect Ratio Section
    expect(screen.getByText("Social Media Aspect Ratio")).toBeTruthy();
    expect(screen.getByText("X.com · LinkedIn")).toBeTruthy();

    // Aspect ratio preset buttons
    expect(screen.getByTitle(/16:9 Landscape/i)).toBeTruthy();
    expect(screen.getByTitle(/1:1 Square/i)).toBeTruthy();
    expect(screen.getByTitle(/4:5 Portrait/i)).toBeTruthy();
    expect(screen.getByTitle(/9:16 Vertical/i)).toBeTruthy();
    expect(screen.getByTitle(/Maximize Window/i)).toBeTruthy();

    // Snapshot photo & Record window actions inside menu
    expect(screen.getByTitle(/Capture clean snapshot/i)).toBeTruthy();
    expect(screen.getByTitle(/Record video of only this window/i)).toBeTruthy();

    // Clicking 16:9 preset calls bridge.setAspectRatio
    fireEvent.click(screen.getByTitle(/16:9 Landscape/i));
    expect(mockBridge.setAspectRatio).toHaveBeenCalledWith("16:9");
  });

  it("handles Snapshot Photo capture", async () => {
    render(<DesktopWindowTitlebar activeRoomName="Room 1" />);

    const menuTrigger = await screen.findByRole("button", { name: /SpaceApp/i });
    fireEvent.click(menuTrigger);

    const snapshotBtn = screen.getByTitle(/Capture clean snapshot/i);
    fireEvent.click(snapshotBtn);

    await waitFor(() => {
      expect(mockBridge.capturePage).toHaveBeenCalled();
    });
  });

  it("opens local diagnostic logs when supported by the installed desktop version", async () => {
    mockBridge.openDiagnosticLogs = vi.fn().mockResolvedValue(true);
    render(<DesktopWindowTitlebar activeRoomName="Room 1" />);
    fireEvent.click(await screen.findByRole("button", { name: /SpaceApp/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Open diagnostic logs/i }));
    expect(mockBridge.openDiagnosticLogs).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: /Open diagnostic logs/i })).toBeNull();
  });

  it("checks unsaved drafts before the desktop Reload Window action", async () => {
    const guard = vi.fn(() => false);
    const unregister = registerLocalCliDraftReloadGuard(guard);
    try {
      render(<DesktopWindowTitlebar activeRoomName="Room 1" />);
      fireEvent.click(await screen.findByRole("button", { name: /SpaceApp/i }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Reload Window/i }));
      await waitFor(() => expect(guard).toHaveBeenCalledOnce());
    } finally { unregister(); }
  });

  it("keeps the app open and shows why when Windows did not start Setup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.1.19", installerUrl: "/api/desktop/download/SpaceApp-Setup-0.1.19.exe" })
    }));
    mockBridge.installUpdate = vi.fn().mockResolvedValue(false);
    mockBridge.runInstaller = vi.fn().mockResolvedValue({ success: false, reason: "launch-failed", error: "spawn UNKNOWN" });
    try {
      render(<DesktopWindowTitlebar activeRoomName="Room 1" />);
      fireEvent.click(await screen.findByText("Update v0.1.19!"));
      fireEvent.click(await screen.findByRole("button", { name: /Update & Restart SpaceApp/i }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Update did not start");
      expect(alert.textContent).toContain("spawn UNKNOWN");
      expect(mockBridge.runInstaller).toHaveBeenCalledWith({ version: "0.1.19" });
    } finally { vi.unstubAllGlobals(); }
  });

  it("enforces titlebar button height constraints to prevent overflow past titlebar or adjacent buttons", async () => {
    render(<DesktopWindowTitlebar activeRoomName="Room 1" />);

    const recordBtn = await screen.findByRole("button", { name: "Record Window" });
    expect(recordBtn).toBeTruthy();
    expect(recordBtn.className).toContain("desktop-window-record-btn");

    const cssPath = path.resolve(__dirname, "../src/features/desktop-titlebar/desktop-window-titlebar.css");
    const cssContent = fs.readFileSync(cssPath, "utf-8");
    const recordBtnMatch = cssContent.match(/\.desktop-window-record-btn\s*\{([^}]+)\}/);
    expect(recordBtnMatch).toBeTruthy();
    const rules = recordBtnMatch![1];
    expect(rules).toContain("height: 24px;");
    expect(rules).toContain("min-height: 24px;");
    expect(rules).toContain("max-height: 24px;");
    expect(rules).toContain("box-sizing: border-box;");
  });
});
