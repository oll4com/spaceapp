import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_AUDIO_PROVIDERS } from "@space/contracts";
import { VoiceModelQuickPick } from "../src/features/voice-input/VoiceModelQuickPick.js";
import { defaultVoiceComposerSettings, writeVoiceComposerSettings } from "../src/voice-settings.js";
import { useVoiceInput } from "../src/features/voice-input/VoiceInputProvider.js";

vi.mock("../src/features/voice-input/VoiceInputProvider.js", () => ({ useVoiceInput: vi.fn() }));
vi.mock("../src/voice-settings.js", async (original) => ({
  ...await original<typeof import("../src/voice-settings.js")>(),
  writeVoiceComposerSettings: vi.fn()
}));

describe("Terminal voice model quick pick", () => {
  const settings = { ...defaultVoiceComposerSettings, engine: "relay" as const, provider: "google" as const, model: "gemini-3.8-live" as const, voice: "Aoede" as const };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useVoiceInput).mockReturnValue({
      settings, serverSettings: { enabled: true, providerOptions: ["google", "local"] }
    } as unknown as ReturnType<typeof useVoiceInput>);
  });

  it("lists the offered providers' models and switches to local SenseVoice with its default voice", () => {
    render(<VoiceModelQuickPick />);
    const pick = screen.getByRole("combobox", { name: "Voice model" });
    expect((pick as HTMLSelectElement).value).toBe("google:gemini-3.8-live");
    expect(within(pick).getByRole("option", { name: "Local SenseVoice-Small (INT8 Offline)" })).toBeTruthy();
    fireEvent.change(pick, { target: { value: "local:local-sensevoice-small" } });
    expect(writeVoiceComposerSettings).toHaveBeenCalledExactlyOnceWith({
      ...settings, provider: "local", model: "local-sensevoice-small", voice: LIVE_AUDIO_PROVIDERS.local.defaultVoice
    });
  });

  it("warns in its title when SenseVoice is set for Greek", () => {
    vi.mocked(useVoiceInput).mockReturnValue({
      ...useVoiceInput(), settings: { ...settings, provider: "local", model: "local-sensevoice-small", language: "el" }
    });
    render(<VoiceModelQuickPick />);
    expect(screen.getByRole("combobox", { name: "Voice model" }).getAttribute("title")).toMatch(/does not know Greek/);
  });
});
