import { detectKeyboardLayoutMismatch } from "../agent-pane/greek-layout-converter.js";
import type { KeyboardAutocorrectSettings } from "./keyboard-autocorrect-settings.js";

/**
 * The text a chat dock sends. Only a message typed wholly in the wrong layout ("veltiose mou") becomes Greek, and
 * only with keyboard autocorrect on for Greek. Latin words inside Greek text are meant as typed ("στο youtube",
 * "κλείσε τον Bob"): rewriting them breaks names and commands.
 */
export function textToSend(text: string, settings: Pick<KeyboardAutocorrectSettings, "enabled" | "supportedLanguages">): string {
  const trimmed = text.trim();
  if (!settings.enabled || !settings.supportedLanguages.includes("el") || /[\u0370-\u03FF]/.test(trimmed)) return trimmed;
  const detection = detectKeyboardLayoutMismatch(trimmed);
  return detection.hasMismatch && !detection.requiresConfirmation && detection.confidence >= 0.90 && detection.direction === "toGreek"
    ? detection.convertedText.trim()
    : trimmed;
}
