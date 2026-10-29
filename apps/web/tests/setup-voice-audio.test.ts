import { describe, expect, it, vi } from "vitest";
import * as audio from "../src/features/setup-connections/setup-voice-audio.js";

const getUserMedia = vi.hoisted(() => vi.fn());
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ platform: { getUserMedia } }) }));

describe("explicit setup microphone check", () => {
  it("converts 48 kHz audio to bounded 16 kHz little endian PCM without changing playback speed", () => {
    const input = new Float32Array([1, 1, 1, -1, -1, -1, 0, 0, 0, .5, .5, .5]);
    const pcm = audio.setupPcm16(input, 48000);
    expect(pcm.byteLength).toBe(8);
    const samples = new DataView(pcm);
    expect([0, 2, 4, 6].map(offset => samples.getInt16(offset, true))).toEqual([32767, -32768, 0, 16384]);
  });
  it("stops an acquired microphone when the server rejects or cannot create the check", async () => {
    const stop = vi.fn();
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop }] });
    await expect(audio.runSetupVoiceAudioCheck({ startSetupVoiceCheck: async () => { throw new Error("Provider unavailable"); } }, 3))
      .rejects.toThrow();
    expect(stop).toHaveBeenCalledOnce();
  });
});
