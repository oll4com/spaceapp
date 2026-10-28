import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliPaneControlsSettingsCard } from "../src/features/voice-input/CliPaneControlsSettingsCard.js";
import { defaultVoiceComposerSettings, writeVoiceComposerSettings } from "../src/voice-settings.js";
import { useOptionalVoiceInput } from "../src/features/voice-input/VoiceInputProvider.js";

vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useOptionalVoiceInput: vi.fn() }));
vi.mock("../src/voice-settings.js", async (original) => ({
  ...await original<typeof import("../src/voice-settings.js")>(),
  writeVoiceComposerSettings: vi.fn()
}));

describe("CLI pane controls settings card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useOptionalVoiceInput).mockReturnValue({
      settings: { ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false }
    } as unknown as ReturnType<typeof useOptionalVoiceInput>);
  });

  it("hides a CLI shortcut from the CLI pane controls while keeping Continue locked and other preferences", () => {
    render(<CliPaneControlsSettingsCard />);
    const shortcuts = screen.getByRole("group", { name: "Visible shortcuts" });
    expect((within(shortcuts).getByRole("switch", { name: "Continue" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(shortcuts).getByRole("switch", { name: "Clear" }));
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false, terminalHiddenShortcuts: ["clear"]
    });
  });

  it("hides the Plans button from the CLI pane controls without touching other preferences", () => {
    render(<CliPaneControlsSettingsCard />);
    fireEvent.click(screen.getByRole("switch", { name: "Plans" }));
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false, terminalPlansButton: false
    });
  });

  it("explains each button and keeps the right-click menu on by default", () => {
    render(<CliPaneControlsSettingsCard />);
    expect((screen.getByRole("switch", { name: "Right-click menu" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("switch", { name: "Turn control" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("A Stop button while the agent is working.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Turn control" }));
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: true
    });
  });

  it("shows the account picker by default and hides it when switched off", () => {
    render(<CliPaneControlsSettingsCard />);
    const toggle = screen.getByRole("switch", { name: "Account picker" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false, terminalAccountPicker: false
    });
  });

  it("shows the local draft button by default and hides it when switched off", () => {
    render(<CliPaneControlsSettingsCard />);
    const toggle = screen.getByRole("switch", { name: "Local draft" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false, terminalLocalDraftButton: false
    });
  });

  it("opens the local draft by default only when switched on", () => {
    render(<CliPaneControlsSettingsCard />);
    const toggle = screen.getByRole("switch", { name: "Local draft open by default" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false, terminalLocalDraft: true
    });
  });
});
