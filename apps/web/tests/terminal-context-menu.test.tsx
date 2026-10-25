import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Pane } from "@space/contracts";
import { liveRuntime } from "../src/live/live-runtime.js";
import { SpaceRuntimeProvider, installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { VoiceInputProvider } from "../src/features/voice-input/VoiceInputProvider.js";
import { TerminalPane } from "../src/features/terminal-pane/TerminalPane.js";
import {
  VOICE_SETTINGS_STORAGE_KEY,
  readVoiceComposerSettings,
  writeVoiceComposerSettings
} from "../src/voice-settings.js";

function createMockPane(id = "pane:test-cli"): Pane {
  return {
    id,
    roomId: "room:cli",
    title: "Terminal 1",
    titleSource: "auto",
    mode: "TERMINAL",
    status: "IDLE",
    providerId: null,
    modelId: null,
    reasoningEffort: "medium",
    cwd: "/opt/spaceapp",
    terminalRuntimeId: "cli:codex",
    order: 0,
    columnSpan: 1,
    isMaximized: false,
    isMinimized: false,
    isClosed: false,
    split: { parentId: null, direction: null, size: null },
    categoryColor: null,
    vncTarget: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe("TerminalPane Right-Click Context Menu", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.removeItem(VOICE_SETTINGS_STORAGE_KEY);
  });

  it("has terminalContextMenu enabled by default in settings", () => {
    const settings = readVoiceComposerSettings();
    expect(settings.terminalContextMenu).toBe(true);
  });

  it("persists toggling terminalContextMenu setting", () => {
    const initial = readVoiceComposerSettings();
    writeVoiceComposerSettings({
      ...initial,
      terminalContextMenu: false
    });
    expect(readVoiceComposerSettings().terminalContextMenu).toBe(false);

    writeVoiceComposerSettings({
      ...initial,
      terminalContextMenu: true
    });
    expect(readVoiceComposerSettings().terminalContextMenu).toBe(true);
  });

  it("opens context menu on right click when enabled", async () => {
    const pane = createMockPane();
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider>
          <TerminalPane pane={pane} terminalFontSize={12} />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const viewport = document.querySelector(".terminal-viewport");
    expect(viewport).toBeTruthy();

    fireEvent.contextMenu(viewport!, { clientX: 200, clientY: 200 });

    const menu = await screen.findByRole("menu", { name: /Terminal context menu/i });
    expect(menu).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Copy\s+Ctrl\+C/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Paste\s+Ctrl\+V/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Attach as TXT file/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Select all in pane/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Copy all contents/i })).toBeTruthy();

    // Copy should be disabled when there is no text selection
    const copyButton = screen.getByRole("menuitem", { name: /Copy\s+Ctrl\+C/i });
    expect(copyButton.hasAttribute("disabled")).toBe(true);

    // Escape closes the menu
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("menu", { name: /Terminal context menu/i })).toBeNull();
  });

  it("does not open custom context menu on right click when terminalContextMenu is disabled", () => {
    writeVoiceComposerSettings({
      ...readVoiceComposerSettings(),
      terminalContextMenu: false
    });

    const pane = createMockPane();
    render(
      <SpaceRuntimeProvider runtime={liveRuntime}>
        <VoiceInputProvider>
          <TerminalPane pane={pane} terminalFontSize={12} />
        </VoiceInputProvider>
      </SpaceRuntimeProvider>
    );

    const viewport = document.querySelector(".terminal-viewport");
    expect(viewport).toBeTruthy();

    fireEvent.contextMenu(viewport!, { clientX: 200, clientY: 200 });
    expect(screen.queryByRole("menu", { name: /Terminal context menu/i })).toBeNull();
  });
});
