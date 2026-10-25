import { afterEach, describe, expect, it } from "vitest";
import {
  noteVoiceRelayClose, resetVoiceProviderAvailability, resolveVoiceProvider, voiceProviderUnavailable, VOICE_PROVIDER_RECHECK_MS
} from "../src/voice-relay-close.js";

afterEach(() => resetVoiceProviderAvailability());
const google = { provider: "google" as const, model: "gemini-3.8-live", voice: "Aoede" };

describe("voice provider fallback", () => {
  it("keeps the operator's provider until it reports no credits or a rejected key", () => {
    noteVoiceRelayClose("google", "upstream_closed", 0);
    noteVoiceRelayClose("google", undefined, 0);
    expect(resolveVoiceProvider(google, ["google", "openai"], 1)).toEqual({ ...google, fallbackFrom: null });
  });

  it("uses OpenAI with its default model while Google has no credits, then tries Google again", () => {
    noteVoiceRelayClose("google", "provider_quota_exhausted", 0);
    expect(resolveVoiceProvider(google, ["google", "openai"], 1)).toEqual({ provider: "openai", model: "gpt-live-1", voice: "gleam", fallbackFrom: "google" });
    expect(voiceProviderUnavailable("google", VOICE_PROVIDER_RECHECK_MS + 1)).toBe(false);
    expect(resolveVoiceProvider(google, ["google", "openai"], VOICE_PROVIDER_RECHECK_MS + 1)).toEqual({ ...google, fallbackFrom: null });
  });

  it("stays on the preferred provider when no other configured provider can take over", () => {
    noteVoiceRelayClose("google", "provider_auth_failed", 0);
    expect(resolveVoiceProvider(google, ["google"], 1).fallbackFrom).toBeNull();
    expect(resolveVoiceProvider(google, undefined, 1).fallbackFrom).toBeNull();
    noteVoiceRelayClose("openai", "provider_quota_exhausted", 0);
    expect(resolveVoiceProvider(google, ["google", "openai"], 1).provider).toBe("google");
  });
});
