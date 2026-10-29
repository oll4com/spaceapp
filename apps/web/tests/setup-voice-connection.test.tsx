import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LIVE_AUDIO_PROVIDERS } from "@space/contracts";
import { SetupVoiceConnection } from "../src/features/setup-connections/SetupVoiceConnection.js";

describe("selected Live connection form", () => {
  it("explains an unsupported saved provider without asking for its keys or silently changing it", async () => {
    const amazon = LIVE_AUDIO_PROVIDERS.amazon; const google = LIVE_AUDIO_PROVIDERS.google;
    const onCheckAudio = vi.fn();
    render(<SetupVoiceConnection client={{ getSetupVoiceProviders: async () => ({ providers: [
      { ...amazon, configured: false, credentialSource: null, setupVerificationSupported: false, setupUnavailableReason: "Choose another provider or skip Live for now." },
      { ...google, configured: false, credentialSource: null, setupVerificationSupported: true }
    ] }), saveSetupVoiceCredential: vi.fn() }} onChoice={vi.fn()} onCheckAudio={onCheckAudio}
      initialChoice={{ featureId: "pane:live", providerId: "amazon", modelId: amazon.defaultModel, voiceId: amazon.defaultVoice }} />);
    await screen.findByText("Choose another provider or skip Live for now.");
    expect((screen.getByRole("combobox", { name: "Live provider" }) as HTMLSelectElement).value).toBe("amazon");
    expect(screen.queryByLabelText("AWS access key ID (required)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Test microphone and playback" })).toBeNull();
    expect(onCheckAudio).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Live provider" }), { target: { value: "google" } });
    await screen.findByLabelText("API key (required)");
  });
  it("shows supported models and voices, clears secrets after submission and exposes only opaque connection metadata", async () => {
    const local = LIVE_AUDIO_PROVIDERS.local;
    const client = {
      getSetupVoiceProviders: vi.fn().mockResolvedValue({ providers: [{ ...local, configured: false, credentialSource: null }] }),
      saveSetupVoiceCredential: vi.fn().mockResolvedValue({ configured: true, credentialRef: "cred:voice:owned-local" })
    };
    const selected = vi.fn();
    render(<SetupVoiceConnection client={client} onChoice={selected} />);
    const input = await screen.findByLabelText("Local service token (required)");
    expect((input as HTMLInputElement).type).toBe("password");
    expect(screen.queryByLabelText("API key (required)")).toBeNull();
    expect(screen.queryByLabelText("Endpoint")).toBeNull();
    fireEvent.change(input, { target: { value: "private-local-fixture-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await screen.findByText("Connection saved securely. Complete the audio check to verify Live.");
    expect((input as HTMLInputElement).value).toBe("");
    expect(selected).toHaveBeenLastCalledWith({ featureId: "pane:live", providerId: "local", modelId: local.defaultModel,
      voiceId: local.defaultVoice, credentialRef: "cred:voice:owned-local" });
    expect(JSON.stringify(selected.mock.calls)).not.toContain("private-local-fixture-token");
    expect(screen.queryByText("Ready")).toBeNull();
  });
  it("reuses an authorized connection and requests microphone only from the explicit audio test", async () => {
    const provider = LIVE_AUDIO_PROVIDERS.google;
    const onCheckAudio = vi.fn().mockResolvedValue(undefined);
    render(<SetupVoiceConnection client={{ getSetupVoiceProviders: async () => ({ providers: [{ ...provider, configured: true, credentialSource: "INSTALLATION" }] }),
      saveSetupVoiceCredential: vi.fn() }} onChoice={vi.fn()} onCheckAudio={onCheckAudio} />);
    const button = await screen.findByRole("button", { name: "Test microphone and playback" });
    expect(screen.queryByLabelText("API key (required)")).toBeNull();
    expect(onCheckAudio).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Live model" }) as HTMLSelectElement).value).toBe(provider.defaultModel);
    fireEvent.click(button);
    await waitFor(() => expect(onCheckAudio).toHaveBeenCalledWith(expect.objectContaining({ providerId: "google", modelId: provider.defaultModel, voiceId: provider.defaultVoice }),
      expect.objectContaining({ signal: expect.any(AbortSignal), onStatus: expect.any(Function) })));
  });
  it("cancels a microphone check when the connection form closes", async () => {
    const provider = LIVE_AUDIO_PROVIDERS.local;
    let signal: AbortSignal | undefined;
    const onCheckAudio = vi.fn(async (_choice, options: { signal: AbortSignal }) => { signal = options.signal; await new Promise<void>(() => undefined); });
    const view = render(<SetupVoiceConnection client={{ getSetupVoiceProviders: async () => ({ providers: [{ ...provider, configured: true, credentialSource: "OWNER" }] }),
      saveSetupVoiceCredential: vi.fn() }} onChoice={vi.fn()} onCheckAudio={onCheckAudio} />);
    fireEvent.click(await screen.findByRole("button", { name: "Test microphone and playback" }));
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount(); expect(signal!.aborted).toBe(true);
  });
});
