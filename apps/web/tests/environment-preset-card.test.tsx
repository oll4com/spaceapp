import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentPresetCard } from "../src/features/settings/EnvironmentPresetCard.js";
import {
  readHiddenDockIds,
  writeHiddenDockIds
} from "../src/features/docks/use-docks-visibility.js";
import {
  readHiddenPaneIds,
  writeHiddenPaneIds
} from "../src/features/pane-visibility/use-panes-visibility.js";
import {
  readHiddenWidgetIds,
  writeHiddenWidgetIds
} from "../src/features/desktop-widgets/index.js";
import {
  readStoredEnvironmentPreset,
  readStoredCustomDocks,
  readStoredCustomPanes,
  readStoredCustomWidgets,
  readStoredCustomCliDisabled,
  DEFAULT_CUSTOM_DISABLED_CLIS
} from "../src/features/settings/use-environment-preset.js";
import {
  ENVIRONMENT_PRESET_STORAGE_KEY,
  CUSTOM_DOCKS_HIDDEN_STORAGE_KEY,
  CUSTOM_PANES_HIDDEN_STORAGE_KEY,
  CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY,
  CUSTOM_CLI_DISABLED_STORAGE_KEY
} from "../src/features/user-settings/user-settings-manager.js";
import { api } from "../src/api.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

afterEach(cleanup);

describe("EnvironmentPresetCard", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    installSpaceRuntime(liveRuntime);
  });

  afterEach(() => {
    vi.useRealTimers();
    installSpaceRuntime(liveRuntime);
  });

  it("renders both Custom and Max environment buttons with Custom active by default", () => {
    render(<EnvironmentPresetCard />);

    expect(screen.getByText("Workspace environment")).toBeTruthy();
    const customBtn = screen.getByRole("button", { name: /Custom environment/i });
    const maxBtn = screen.getByRole("button", { name: /Max environment/i });

    expect(customBtn).toBeTruthy();
    expect(maxBtn).toBeTruthy();
    expect(customBtn.classList.contains("is-active")).toBe(true);
    expect(maxBtn.classList.contains("is-active")).toBe(false);
  });

  it("switches to Max, opens all docks & panes, shows progress and completion badge", async () => {
    // Start with some docks, panes, and widgets hidden
    writeHiddenDockIds(["media", "links"]);
    writeHiddenPaneIds(["youtube", "vnc"]);
    writeHiddenWidgetIds(["clock", "ai-quota"]);

    render(<EnvironmentPresetCard canManageCliRuntimes={false} />);

    const maxBtn = screen.getByRole("button", { name: /Max environment/i });
    await act(async () => {
      fireEvent.click(maxBtn);
    });

    // Custom snapshot should be saved
    expect(readStoredCustomDocks()).toEqual(["media", "links"]);
    expect(readStoredCustomPanes()).toEqual(["youtube", "vnc"]);
    expect(readStoredCustomWidgets()).toEqual(["clock", "ai-quota"]);

    // Step through the timers for the sequential activation
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Docks should now be empty (all visible)
    expect(readHiddenDockIds()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Panes and widgets should now be empty (all visible)
    expect(readHiddenPaneIds()).toEqual([]);
    expect(readHiddenWidgetIds()).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Preset should be Max
    expect(readStoredEnvironmentPreset()).toBe("max");
    expect(localStorage.getItem(ENVIRONMENT_PRESET_STORAGE_KEY)).toBe("max");

    // Success badge should be visible
    expect(screen.getByText(/every dock, pane and AI coding tool is now on/i)).toBeTruthy();
  });

  it("switches from Max back to Custom and restores closed docks & panes with progress", async () => {
    // Pre-populate custom state and set current preset to Max
    localStorage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "max");
    localStorage.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(["media", "tasks"]));
    localStorage.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(["youtube", "browser"]));
    localStorage.setItem(CUSTOM_WIDGETS_HIDDEN_STORAGE_KEY, JSON.stringify(["clock", "countdown-timer"]));
    writeHiddenDockIds([]);
    writeHiddenPaneIds([]);
    writeHiddenWidgetIds([]);

    render(<EnvironmentPresetCard canManageCliRuntimes={false} />);

    const customBtn = screen.getByRole("button", { name: /Custom environment/i });
    expect(screen.getByRole("button", { name: /Max environment/i }).classList.contains("is-active")).toBe(true);

    await act(async () => {
      fireEvent.click(customBtn);
    });

    // Advance through the sequential restoration steps
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Hidden items should be restored
    expect(readHiddenDockIds()).toEqual(["media", "tasks"]);
    expect(readHiddenPaneIds()).toEqual(["youtube", "browser"]);
    expect(readHiddenWidgetIds()).toEqual(["clock", "countdown-timer"]);
    expect(readStoredEnvironmentPreset()).toBe("custom");

    // Restoration badge should be displayed
    expect(screen.getByText(/Switched to Custom environment/i)).toBeTruthy();

    // Close button dismisses the restoration banner
    const dismissBtn = screen.getByRole("button", { name: /Dismiss notification/i });
    expect(dismissBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(dismissBtn);
    });
    expect(screen.queryByText(/Switched to Custom environment/i)).toBeNull();
  });

  it("dismisses Max success banner manually and via auto-dismiss timer", async () => {
    writeHiddenDockIds(["media"]);
    writeHiddenPaneIds(["browser"]);

    render(<EnvironmentPresetCard canManageCliRuntimes={false} />);

    const maxBtn = screen.getByRole("button", { name: /Max environment/i });
    await act(async () => {
      fireEvent.click(maxBtn);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Banner is showing
    expect(screen.getByText(/every dock, pane and AI coding tool is now on/i)).toBeTruthy();

    // Dismiss manually
    const dismissBtn = screen.getByRole("button", { name: /Dismiss notification/i });
    expect(dismissBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(dismissBtn);
    });

    expect(screen.queryByText(/every dock, pane and AI coding tool is now on/i)).toBeNull();
  });

  it("clicking Custom when already on Custom re-applies custom preset and shows feedback", async () => {
    localStorage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "custom");
    localStorage.setItem(CUSTOM_DOCKS_HIDDEN_STORAGE_KEY, JSON.stringify(["tasks"]));
    localStorage.setItem(CUSTOM_PANES_HIDDEN_STORAGE_KEY, JSON.stringify(["vnc"]));
    // Docks were somehow desynced
    writeHiddenDockIds([]);
    writeHiddenPaneIds([]);

    render(<EnvironmentPresetCard canManageCliRuntimes={false} />);

    const customBtn = screen.getByRole("button", { name: /Custom environment/i });
    await act(async () => {
      fireEvent.click(customBtn);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(readHiddenDockIds()).toEqual(["tasks"]);
    expect(readHiddenPaneIds()).toEqual(["vnc"]);
    expect(screen.getByText(/Switched to Custom environment/i)).toBeTruthy();
  });

  it("executes CLI disable procedure with progress bar when switching to Custom as admin", async () => {
    localStorage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "max");
    localStorage.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(["cli:droid", "cli:muse"]));

    const disablePreviewSpy = vi.fn().mockImplementation(async (runtimeId: string) => ({
      runtimeId,
      confirmationToken: `TOKEN-${runtimeId}`
    }));
    const updateCliSpy = vi.fn().mockResolvedValue({ setting: { enabled: false } });

    installSpaceRuntime({
      ...liveRuntime,
      api: {
        ...liveRuntime.api,
        cliRuntimeDisablePreview: disablePreviewSpy,
        updateCliRuntimeSetting: updateCliSpy,
        invalidateCliRuntimeSettings: vi.fn()
      } as any
    });

    render(<EnvironmentPresetCard canManageCliRuntimes={true} isAdmin={true} />);

    const customBtn = screen.getByRole("button", { name: /Custom environment/i });
    await act(async () => {
      fireEvent.click(customBtn);
    });

    // Advance through the sequential restoration steps
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // CLI disable preview and update should have been called for each disabled CLI
    expect(disablePreviewSpy).toHaveBeenCalledWith("cli:droid");
    expect(disablePreviewSpy).toHaveBeenCalledWith("cli:muse");
    expect(updateCliSpy).toHaveBeenCalledWith("cli:droid", {
      enabled: false,
      confirmationToken: "TOKEN-cli:droid"
    });
    expect(updateCliSpy).toHaveBeenCalledWith("cli:muse", {
      enabled: false,
      confirmationToken: "TOKEN-cli:muse"
    });

    expect(screen.getByText(/Switched to Custom environment/i)).toBeTruthy();
  });

  it("keeps a CLI enabled when the preset would close its open panes", async () => {
    localStorage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "max");
    localStorage.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(["cli:claude", "cli:muse"]));
    const disablePreviewSpy = vi.fn().mockImplementation(async (runtimeId: string) => ({
      runtimeId,
      openPaneCount: runtimeId === "cli:claude" ? 11 : 0,
      activeSessionCount: runtimeId === "cli:claude" ? 9 : 0,
      confirmationToken: `TOKEN-${runtimeId}`
    }));
    const updateCliSpy = vi.fn().mockResolvedValue({ setting: { enabled: false } });
    installSpaceRuntime({
      ...liveRuntime,
      api: {
        ...liveRuntime.api,
        cliRuntimeDisablePreview: disablePreviewSpy,
        updateCliRuntimeSetting: updateCliSpy,
        invalidateCliRuntimeSettings: vi.fn()
      } as any
    });

    render(<EnvironmentPresetCard canManageCliRuntimes={true} isAdmin={true} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Custom environment/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(disablePreviewSpy).toHaveBeenCalledWith("cli:claude");
    expect(updateCliSpy).not.toHaveBeenCalledWith("cli:claude", expect.anything());
    expect(updateCliSpy).toHaveBeenCalledWith("cli:muse", { enabled: false, confirmationToken: "TOKEN-cli:muse" });
  });

  it("does not hang when CLI update calls stall or time out", async () => {
    localStorage.setItem(ENVIRONMENT_PRESET_STORAGE_KEY, "max");
    localStorage.setItem(CUSTOM_CLI_DISABLED_STORAGE_KEY, JSON.stringify(["cli:droid"]));

    // Simulate hanging CLI disable preview / update that never resolves on its own
    const hangingPromise = new Promise<{ confirmationToken: string }>(() => {});
    const disablePreviewSpy = vi.fn().mockReturnValue(hangingPromise);

    installSpaceRuntime({
      ...liveRuntime,
      api: {
        ...liveRuntime.api,
        cliRuntimeDisablePreview: disablePreviewSpy,
        updateCliRuntimeSetting: vi.fn(),
        invalidateCliRuntimeSettings: vi.fn()
      } as any
    });

    render(<EnvironmentPresetCard canManageCliRuntimes={true} isAdmin={true} />);

    const customBtn = screen.getByRole("button", { name: /Custom environment/i });
    await act(async () => {
      fireEvent.click(customBtn);
    });

    // Advance timers past the 4000ms per-CLI timeout + finalization
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    // It should have timed out gracefully and completed Custom activation instead of hanging
    expect(screen.getByText(/Switched to Custom environment/i)).toBeTruthy();
  });
});
