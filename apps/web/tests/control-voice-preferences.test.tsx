// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { voiceTranscriptionSettingsSchema } from "@space/contracts";
import { api } from "../src/live-api.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { VOICE_SETTINGS_STORAGE_KEY, VOICE_SETTINGS_UPDATED_EVENT, readVoiceComposerSettings, writeVoiceComposerSettings } from "../src/voice-settings.js";
import { applyControlVoicePreferences } from "../src/features/room-agent/control-voice-preferences.js";
import { useSpaceControlClient } from "../src/features/room-agent/space-control-client.js";

const capabilities = () => voiceTranscriptionSettingsSchema.parse({
  enabled: true, statusReason: "Test fixture", defaultModel: "gemini-3.8-live", modelOptions: ["gemini-3.8-live", "gpt-live-transcribe"],
  defaultVoice: "Kore", voiceOptions: ["Kore", "alloy"], defaultLanguage: "auto", languageOptions: ["auto", "el", "en"],
  defaultDelay: "low", delayOptions: ["low"], maxBytes: 1024, maxDurationMs: 3000, updatedAt: "2026-09-19T00:00:00Z"
});
beforeEach(() => {
  installSpaceRuntime(liveRuntime); window.localStorage.clear();
  vi.spyOn(api, "voiceTranscriptionSettings").mockResolvedValue(capabilities());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Verified browser voice preferences", () => {
  it("persists the available Google model/profile, preserves unrelated preferences and emits a precise receipt", async () => {
    const current = { ...readVoiceComposerSettings(), prompt: "Keep my prompt", delegatedModel: "user-selected-model" };
    writeVoiceComposerSettings(current);
    const result = await applyControlVoicePreferences({ model: "gemini-3.8-live", voice: "Kore", language: "el", prewarm: false }, () => true);
    expect(readVoiceComposerSettings()).toMatchObject({ model: "gemini-3.8-live", voice: "Kore", language: "el", prompt: current.prompt, delegatedModel: current.delegatedModel, prewarm: false });
    expect(result).toMatchObject({ ok: true, evidence: { persisted: true, scope: "BROWSER_VOICE_COMPOSER", changesActiveLiveSession: false,
      preferences: { model: "gemini-3.8-live", voice: "Kore", language: "el", prewarm: false } } });
    expect(result.evidence.preferences).not.toHaveProperty("prompt");
  });
  it.each([{ model: "gpt-live-1-mini" }, { voice: "Puck" }, { language: "fr" }, { enabled: "yes" }, { language: "el", delegatedModel: "unrequested-model" }, {}])("rejects unavailable or invalid choices %j without fallback writes", async input => {
    await expect(applyControlVoicePreferences(input, () => true)).rejects.toThrow();
    expect(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull();
  });
  it("does not mutate preferences if capability lookup fails", async () => {
    vi.mocked(api.voiceTranscriptionSettings).mockRejectedValue(new Error("Settings offline"));
    await expect(applyControlVoicePreferences({ language: "el" }, () => true)).rejects.toThrow("Settings offline");
    expect(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull();
  });
  it("can turn off prewarm/input offline without claiming provider availability", async () => {
    await applyControlVoicePreferences({ enabled: false, prewarm: false, insertMode: "replace" }, () => true);
    expect(api.voiceTranscriptionSettings).not.toHaveBeenCalled();
    expect(readVoiceComposerSettings()).toMatchObject({ enabled: false, prewarm: false, insertMode: "replace" });
  });
  it("does not enable unavailable voice input", async () => {
    vi.mocked(api.voiceTranscriptionSettings).mockResolvedValue({ ...capabilities(), enabled: false });
    await expect(applyControlVoicePreferences({ enabled: true }, () => true)).rejects.toThrow("unavailable");
    expect(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull();
  });
  it("rechecks room/focus/expiry after the asynchronous capability lookup", async () => {
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(applyControlVoicePreferences({ language: "el" }, isCurrent)).rejects.toThrow("changed or the command expired");
    expect(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBeNull();
  });
  it("rejects unreadable storage instead of overwriting it with defaults", async () => {
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, "malformed-json");
    await expect(applyControlVoicePreferences({ prewarm: false }, () => true)).rejects.toThrow();
    expect(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)).toBe("malformed-json");
  });
  it("reports a storage write error instead of applied:true", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    await expect(applyControlVoicePreferences({ prewarm: false }, () => true)).rejects.toThrow("Storage full");
  });
  it("rejects mismatched read-back after an observer overwrites the saved preference", async () => {
    window.addEventListener(VOICE_SETTINGS_UPDATED_EVENT, () => {
      const stored = JSON.parse(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY)!);
      window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ ...stored, prewarm: true }));
    }, { once: true });
    await expect(applyControlVoicePreferences({ prewarm: false }, () => true)).rejects.toThrow("read-back did not match");
  });
  it("dispatches and acknowledges from the real client hook, deduplicating repeated commands", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const updates = vi.fn();window.addEventListener(VOICE_SETTINGS_UPDATED_EVENT, updates);
    const acks: unknown[] = [];
    const command = { id: "command:voice", roomId: "room:voice", expiresAt: Date.now()+6000, action: { kind: "resource", operation: "settings.voice", input: { language: "el" } } };
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if(path === "/api/auth/csrf") return new Response(JSON.stringify({csrfToken:"test-csrf"}));
      if(path.endsWith("client/ack")) { acks.push(JSON.parse(String(init?.body))); return new Response("{}"); }
      if(path.endsWith("client/release")) return new Response("{}");
      return new Response(JSON.stringify({ commands: [command, {...command,id:"foreign",roomId:"room:other"}, {...command,id:"expired",expiresAt:0}], layout:null }));
    }));
    const hook = renderHook(() => useSpaceControlClient("room:voice", true, async()=>{}, ()=>{}, 500));
    try {
      await waitFor(() => expect(acks.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
      expect(acks[0]).toMatchObject({id:command.id,ok:true,evidence:{persisted:true,preferences:{language:"el"}}});
      expect(updates).toHaveBeenCalledTimes(1);
      expect(acks.every(ack => (ack as {id:string}).id === command.id)).toBe(true);
    } finally { hook.unmount(); window.removeEventListener(VOICE_SETTINGS_UPDATED_EVENT, updates); }
  });
});
