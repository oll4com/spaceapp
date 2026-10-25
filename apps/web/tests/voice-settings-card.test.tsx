import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_AUDIO_PROVIDERS } from "@space/contracts";
import { VoiceSettingsCard } from "../src/features/voice-input/VoiceSettingsCard.js";
import { defaultVoiceComposerSettings, writeVoiceComposerSettings } from "../src/voice-settings.js";
import { useVoiceInput } from "../src/features/voice-input/VoiceInputProvider.js";

vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useVoiceInput: vi.fn() }));
vi.mock("../src/voice-settings.js", async (original) => ({
  ...await original<typeof import("../src/voice-settings.js")>(),
  writeVoiceComposerSettings: vi.fn()
}));

describe("Voice settings card", () => {
  const refresh = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useVoiceInput).mockReturnValue({
      settings: { ...defaultVoiceComposerSettings, opening: "Remember this", terminalTurnControl: false },
      serverSettings: { enabled: true, statusReason: "Ready", providerOptions: ["google", "openai"], languageOptions: ["auto", "el", "en"] },
      settingsLoading: false,
      settingsError: null,
      refreshServerSettings: refresh
    } as unknown as ReturnType<typeof useVoiceInput>);
  });

  it("renders provider choices without writing preferences during hydration", () => {
    render(<VoiceSettingsCard />);
    expect(screen.getByText("READY")).toBeTruthy();
    expect(within(screen.getByRole("combobox", { name: /Voice provider/ })).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["google", "openai"]);
    expect(writeVoiceComposerSettings).not.toHaveBeenCalled();
  });

  it("selects the new provider's model and voice while retaining unrelated preferences", () => {
    render(<VoiceSettingsCard />);
    fireEvent.change(screen.getByRole("combobox", { name: /Voice provider/ }), { target: { value: "openai" } });
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings,
      provider: "openai",
      model: LIVE_AUDIO_PROVIDERS.openai.defaultModel,
      voice: LIVE_AUDIO_PROVIDERS.openai.defaultVoice,
      opening: "Remember this",
      terminalTurnControl: false
    });
  });

  it("changes insertion mode without losing provider or terminal preferences", () => {
    render(<VoiceSettingsCard />);
    fireEvent.change(screen.getByRole("combobox", { name: /Insert mode/ }), { target: { value: "replace" } });
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...defaultVoiceComposerSettings, insertMode: "replace", opening: "Remember this", terminalTurnControl: false
    });
  });

  it("leaves the CLI pane buttons and shortcuts to their own section", () => {
    render(<VoiceSettingsCard />);
    expect(screen.queryByRole("group", { name: "Visible shortcuts" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Plans" })).toBeNull();
  });

  it("shows unavailable settings and retries only from the explicit refresh action", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...useVoiceInput(), serverSettings: null, settingsError: "Voice provider unavailable"
    });
    render(<VoiceSettingsCard />);
    expect(screen.getByRole("alert").textContent).toContain("Voice provider unavailable");
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Voice input actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh voice status" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(writeVoiceComposerSettings).not.toHaveBeenCalled();
  });
});
