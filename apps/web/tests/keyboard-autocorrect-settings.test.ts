import { beforeEach, describe, expect, it } from "vitest";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  defaultKeyboardAutocorrectSettings,
  isComposerLayoutIconVisible,
  isComposerSuggestionBarVisible,
  KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY,
  KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT,
  playLayoutSuggestionBeep,
  readKeyboardAutocorrectSettings,
  writeKeyboardAutocorrectSettings
} from "../src/features/keyboard-autocorrect/keyboard-autocorrect-settings.js";

describe("Keyboard autocorrect settings", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.removeItem(KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY);
  });

  it("reads default settings when nothing is stored", () => {
    const settings = readKeyboardAutocorrectSettings();
    expect(settings).toEqual(defaultKeyboardAutocorrectSettings);
    expect(settings.enabled).toBe(true);
    expect(settings.showSuggestionBar).toBe(true);
    expect(settings.showComposerIcon).toBe(true);
    expect(settings.soundEnabled).toBe(true);
    expect(settings.supportedLanguages).toEqual(["el", "en"]);
  });

  it("persists and reads updated settings", () => {
    writeKeyboardAutocorrectSettings({
      enabled: false,
      showSuggestionBar: false,
      showComposerIcon: false,
      soundEnabled: false,
      supportedLanguages: ["el"]
    });

    const settings = readKeyboardAutocorrectSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.showSuggestionBar).toBe(false);
    expect(settings.showComposerIcon).toBe(false);
    expect(settings.soundEnabled).toBe(false);
    expect(settings.supportedLanguages).toEqual(["el"]);
  });

  it("dispatches update event when settings are written", () => {
    let capturedDetail: any = null;
    const listener = (event: Event) => {
      capturedDetail = (event as CustomEvent).detail;
    };
    window.addEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, listener);

    writeKeyboardAutocorrectSettings({
      enabled: true,
      showSuggestionBar: true,
      showComposerIcon: false,
      soundEnabled: true,
      supportedLanguages: ["en"]
    });

    window.removeEventListener(KEYBOARD_AUTOCORRECT_SETTINGS_UPDATED_EVENT, listener);
    expect(capturedDetail).not.toBeNull();
    expect(capturedDetail?.showComposerIcon).toBe(false);
    expect(capturedDetail?.supportedLanguages).toEqual(["en"]);
  });

  it("handles malformed JSON in localStorage gracefully with defaults", () => {
    window.localStorage.setItem(KEYBOARD_AUTOCORRECT_SETTINGS_STORAGE_KEY, "invalid-json{{");
    const settings = readKeyboardAutocorrectSettings();
    expect(settings).toEqual(defaultKeyboardAutocorrectSettings);
  });

  it("plays layout suggestion beep without throwing", () => {
    expect(() => playLayoutSuggestionBeep({ force: true })).not.toThrow();
    expect(() => playLayoutSuggestionBeep()).not.toThrow();
  });

  it("determines composer layout icon visibility correctly", () => {
    // Default: both enabled -> visible
    expect(isComposerLayoutIconVisible(defaultKeyboardAutocorrectSettings)).toBe(true);

    // Master enabled = false -> hidden immediately even if showComposerIcon is true
    expect(isComposerLayoutIconVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: false,
      showComposerIcon: true
    })).toBe(false);

    // Master enabled = true, but showComposerIcon = false -> hidden
    expect(isComposerLayoutIconVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: true,
      showComposerIcon: false
    })).toBe(false);

    // Both false -> hidden
    expect(isComposerLayoutIconVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: false,
      showComposerIcon: false
    })).toBe(false);
  });

  it("determines composer suggestion bar visibility correctly", () => {
    // Default: both enabled -> visible
    expect(isComposerSuggestionBarVisible(defaultKeyboardAutocorrectSettings)).toBe(true);

    // Master enabled = false -> hidden immediately even if showSuggestionBar is true
    expect(isComposerSuggestionBarVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: false,
      showSuggestionBar: true
    })).toBe(false);

    // Master enabled = true, but showSuggestionBar = false -> hidden
    expect(isComposerSuggestionBarVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: true,
      showSuggestionBar: false
    })).toBe(false);

    // Both false -> hidden
    expect(isComposerSuggestionBarVisible({
      ...defaultKeyboardAutocorrectSettings,
      enabled: false,
      showSuggestionBar: false
    })).toBe(false);
  });
});
