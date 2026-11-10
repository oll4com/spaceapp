import { z } from "zod";

/**
 * The operator's interface language (operator 1/11 11:59 BKK «απο την στιγμή που εχω επιλεξει ελληνικα στις ρυθμισεις να εχω αντιστοιχα στο
 * need you και σε οποιο αλλο pane την γλώσσα που εχω επιλεξει, και οχι default αγγλικα»): Settings → Personal → Language, `uiLanguage`.
 * Unset, it follows Voice input's language when that is Greek (the only Greek choice Settings had before), or Voice input's Auto when the
 * browser lists Greek first (`navigator.languages`, or a request's Accept-Language; nous_msg:40900116: the operator dictates in Greek on Auto), else English.
 */
export const UI_LANGUAGES = ["en", "el"] as const;
export const uiLanguageSchema = z.enum(UI_LANGUAGES);
export type UiLanguage = z.infer<typeof uiLanguageSchema>;
export const UI_LANGUAGE_NAMES: Record<UiLanguage, string> = { en: "English", el: "Ελληνικά" };

export function uiLanguageOf(settings: { uiLanguage?: unknown; voice?: { language?: unknown } | null } | null | undefined, browserLanguages: readonly string[] = []): UiLanguage {
  const voice = settings?.voice?.language ?? "auto";
  return uiLanguageSchema.safeParse(settings?.uiLanguage).data ?? (voice === "el" || (voice === "auto" && /^el\b/i.test(browserLanguages[0] ?? "")) ? "el" : "en");
}

/**
 * The language Nous, every agent and copilot write to the operator in: replies, the Nous conversation's steps, Needs you cards and their
 * translation, decisions, toast text (operator 2/11 09:51 BKK «προσθεσε 2 επιλογές γλώσσας … μια για το ui μια για της γλώσσα που μιλας στους
 * agent»). `agentLanguage`; unset, it is the interface language, so a uiLanguage saved before the split keeps both.
 */
export function agentLanguageOf(settings: { uiLanguage?: unknown; agentLanguage?: unknown; voice?: { language?: unknown } | null } | null | undefined,
  browserLanguages: readonly string[] = []): UiLanguage {
  return uiLanguageSchema.safeParse(settings?.agentLanguage).data ?? uiLanguageOf(settings, browserLanguages);
}

/** An Accept-Language header's tags, most preferred first ("el-GR,el;q=0.9,en;q=0.8" → ["el-GR", "el", "en"]). */
export const acceptLanguages = (header: string | undefined): string[] =>
  (header ?? "").split(",").map((part) => part.split(";")[0]!.trim()).filter(Boolean);
