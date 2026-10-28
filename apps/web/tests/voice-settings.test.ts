import { beforeEach, describe, expect, it } from "vitest";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  VOICE_SETTINGS_STORAGE_KEY,
  readVoiceComposerSettings,
  writeVoiceComposerSettings
} from "../src/voice-settings.js";

describe("Voice composer settings", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.removeItem(VOICE_SETTINGS_STORAGE_KEY);
  });

  it("migrates stale model, delay, and auto-send fields to the supported preferences", () => {
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({
      enabled: false,
      model: "invalid-legacy-model",
      language: "el",
      delay: "high",
      insertMode: "replace",
      autoSend: false
    }));

    expect(readVoiceComposerSettings()).toEqual({
      enabled: false,
      provider: "openai",
      model: "invalid-legacy-model",
      voice: "Aoede",
      language: "el",
      insertMode: "replace",
      prewarm: true,
      opening: "",
      prompt: "",
      delegatedModel: "gpt-6-astra",
      delegatedType: "responses",
      delegatedReasoningEffort: "xhigh",
      delegatedWebSearch: true,
      delegatedPrompt: "",
      terminalVoiceButton: true,
      terminalModelPicker: true,
      terminalTurnControl: true,
      terminalShortcutsButton: true,
      terminalVariablesButton: true,
      terminalPlansButton: true,
      terminalContextMenu: true,
      terminalAccountPicker: true,
      terminalLocalDraftButton: true,
      terminalLocalDraft: false,
      terminalHiddenShortcuts: []
    });

    writeVoiceComposerSettings(readVoiceComposerSettings());
    expect(JSON.parse(window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      enabled: false,
      provider: "openai",
      model: "invalid-legacy-model",
      voice: "Aoede",
      language: "el",
      insertMode: "replace",
      prewarm: true,
      opening: "",
      prompt: "",
      delegatedModel: "gpt-6-astra",
      delegatedType: "responses",
      delegatedReasoningEffort: "xhigh",
      delegatedWebSearch: true,
      delegatedPrompt: "",
      terminalVoiceButton: true,
      terminalModelPicker: true,
      terminalTurnControl: true,
      terminalShortcutsButton: true,
      terminalVariablesButton: true,
      terminalPlansButton: true,
      terminalContextMenu: true,
      terminalAccountPicker: true,
      terminalLocalDraftButton: true,
      terminalLocalDraft: false,
      terminalHiddenShortcuts: [],
      terminalControlsVersion: 2
    });
  });

  it("persists prewarm, float-button toggles and hidden shortcuts in menu order", () => {
    writeVoiceComposerSettings({
      enabled: true,
      model: "gpt-live-1",
      voice: "ash",
      language: "en",
      insertMode: "append",
      prewarm: false,
      opening: "Hello",
      prompt: "Be brief",
      delegatedModel: "gpt-4o",
      delegatedType: "responses",
      delegatedReasoningEffort: "low",
      delegatedWebSearch: false,
      delegatedPrompt: "No search",
      terminalVoiceButton: false,
      terminalModelPicker: true,
      terminalTurnControl: false,
      terminalShortcutsButton: true,
      terminalVariablesButton: true,
      terminalPlansButton: false,
      terminalContextMenu: true,
      terminalLocalDraft: false,
      terminalHiddenShortcuts: ["clear", "continue", "bogus", "test"]
    });

    expect(readVoiceComposerSettings()).toEqual({
      enabled: true,
      provider: "openai",
      model: "gpt-live-1",
      voice: "ash",
      language: "en",
      insertMode: "append",
      prewarm: false,
      opening: "Hello",
      prompt: "Be brief",
      delegatedModel: "gpt-4o",
      delegatedType: "responses",
      delegatedReasoningEffort: "low",
      delegatedWebSearch: false,
      delegatedPrompt: "No search",
      terminalVoiceButton: false,
      terminalModelPicker: true,
      terminalTurnControl: false,
      terminalShortcutsButton: true,
      terminalVariablesButton: true,
      terminalPlansButton: false,
      terminalContextMenu: true,
      terminalAccountPicker: true,
      terminalLocalDraftButton: true,
      terminalLocalDraft: false,
      terminalHiddenShortcuts: ["test", "clear"]
    });
  });
});

 it("enables the new footer once and honors a subsequent opt-out", () => {
   window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify({ terminalModelPicker: false }));
   expect(readVoiceComposerSettings().terminalModelPicker).toBe(true);
   writeVoiceComposerSettings({ ...readVoiceComposerSettings(), terminalModelPicker: false });
   expect(readVoiceComposerSettings().terminalModelPicker).toBe(false);
 });
