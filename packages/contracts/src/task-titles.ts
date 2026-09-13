/**
 * Shared display/context rules. This module never reads attachments, executes
 * commands or calls a provider. Apply at ingestion AND at display boundaries.
 */
export const generatedTaskTitleMaxCharacters = 52;
export const taskDescriptionMaxCharacters = 1_800;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function boundedTaskText(value: string, limit: number): string {
  const segments = Array.from(segmenter.segment(value));
  return segments.slice(0, limit).map((part) => part.segment).join("");
}

/** Keep meaningful prose while removing transport metadata and prompt wrappers. */
export function cleanTaskText(value: string): string {
  return value
    .slice(0, 50_000)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/<(?:environment_context|system-reminder|INSTRUCTIONS|instructions|turn_aborted)\b[^>]*>[\s\S]*?<\/(?:environment_context|system-reminder|INSTRUCTIONS|instructions|turn_aborted)>/gi, " ")
    .replace(/<image\b[^>]*>([\s\S]*?)<\/image>/gi, " ")
    .replace(/<image\b[^>]*>/gi, " ")
    .replace(/\[(?:image|file|attachment|εικόνα|εικονα|αρχείο|αρχειο|συνημμένο)\s*#?\s*\d+\]/giu, " ")
    .replace(/\b(?:Image|File|Attachment)\s*#\s*\d+\b/gi, " ")
    .replace(/(?:αρχείο|αρχειο|εικόνα|εικονα|συνημμένο)\s*#?\s*\d+/giu, " ")
    .replace(/(?:https?:\/\/[^\s<>]*\/)?(?:\/[^\s<>]*)?\/cli-uploads\/[^\s<>"']+/gi, " ")
    .replace(/\b(?:upload[_-][\w-]+|clipboard-image-\d+)\.[\w]+\b/gi, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Automatic titles never consist of filenames, paths or attachment labels. */
export function shortTaskTitle(value: string, fallback = ""): string {
  const clean = cleanTaskText(value)
    .replace(/^(?:title|suggested title|τίτλος)\s*[:：-]\s*/iu, "")
    .replace(/(?:^|\s)(?:[A-Za-z]:\\|[./~])[^\s]+/g, " ")
    .replace(/(?:^|\s)[^\s<>]+\.(?:png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|csv|txt|md|json|jsonl|tsx?|jsx?|py|ya?ml|toml|sql|log)(?=\s|$|[.,;:])/gi, " ")
    .replace(/^[\s"'\x60*#]+|[\s"'\x60*.!?;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback ? shortTaskTitle(fallback) : "";
  const words = clean.split(" ").slice(0, 6);
  const bounded = boundedTaskText(words.join(" "), generatedTaskTitleMaxCharacters);
  if (bounded.length < words.join(" ").length && bounded.includes(" ")) {
    return bounded.slice(0, bounded.lastIndexOf(" ")).trim();
  }
  return bounded;
}

export function taskRequestFingerprint(value: string): string {
  return cleanTaskText(value).normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

/** Conservative local noise filter; uncertain substantive changes go to one summary call. */
export function isSubstantiveTaskRequest(value: string): boolean {
  if(/^\s*(?:#\s*AGENTS\.md instructions for\b|Another language model started to solve this problem and produced a summary\b)/i.test(value))return false;
  const text = cleanTaskText(value);
  const normalized = taskRequestFingerprint(text).normalize("NFD").replace(/\p{M}/gu, "");
  if (!normalized || /^(?:yes|no|ok|okay|thanks|thank you|continue|go ahead|proceed|resume|ναι|οχι|ενταξει|συνεχισε|συνεχεια|ευχαριστω|προχωρα|κανε το)(?:\s+(?:please|παρακαλω))?$/.test(normalized)) return false;
  if (/^(?:\/\w+|[$>]\s|(?:cd|ls|pwd|cat|rg|git|npm|pnpm|node|curl|sudo|systemctl)\s)/i.test(text)) return false;
  return normalized.length >= 8 && normalized.split(" ").length >= 2;
}
