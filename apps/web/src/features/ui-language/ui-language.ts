import { useEffect, useState } from "react";
import { NOTIFICATION_SOURCE_LABELS, agentLanguageOf, uiLanguageOf, type NotificationSource, type UiLanguage } from "@space/contracts";
import { api } from "../../api.js";

export const UI_LANGUAGE_STORAGE_KEY = "space.uiLanguage.v1";
const UI_LANGUAGE_PACK_EVENT = "space:ui-language-pack";

let elDict: Record<string, string> = {};
let elLoaded = false;
let elLoad: Promise<void> | null = null;

/**
 * Loads the ~580 KB Greek dictionary chunk on demand (speed audit 21/11) so English sessions never download or parse it.
 * Greek sessions preload it in main.tsx in parallel with the app chunk, or re-render via UI_LANGUAGE_PACK_EVENT once loaded.
 */
export function ensureUiLanguagePack(language: UiLanguage): Promise<void> {
  if (language !== "el" || elLoaded) return Promise.resolve();
  if (!elLoad) {
    elLoad = import("./ui-language-el.js").then(({ EL }) => {
      elDict = EL;
      elLoaded = true;
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UI_LANGUAGE_PACK_EVENT));
    }).catch(() => { elLoad = null; });
  }
  return elLoad;
}

/**
 * A language setting read once per tab and told to every user when Settings changes it: the interface language (chrome: labels, buttons)
 * and, since operator 2/11 09:51 BKK, the agents' language (what Nous, agents and copilots write to him; ui-language.ts in contracts).
 */
function languageSetting(changed: string, of: (saved: Parameters<typeof uiLanguageOf>[0]) => UiLanguage, apply: (language: UiLanguage) => void = () => {}) {
  let current: UiLanguage | null = null;
  let reading: Promise<UiLanguage> | null = null;
  const read = (): Promise<UiLanguage> => {
    if (reading) return reading;
    // A language announced while the settings are still on their way wins over what they say.
    const pending: Promise<UiLanguage> = Promise.resolve().then(() => api.userSettings()).then((saved) => {
      if (reading !== pending) return current ?? "en";
      current = of(saved); apply(current); return current;
    }).catch(() => { if (reading === pending) reading = null; return current ?? "en"; });
    return (reading = pending);
  };
  return {
    now: (): UiLanguage => current ?? "en",
    announce(language: UiLanguage): void {
      current = language;
      apply(language);
      reading = Promise.resolve(language);
      window.dispatchEvent(new CustomEvent<UiLanguage>(changed, { detail: language }));
    },
    /** `read: false` (a hook App runs before sign-in) keeps English and makes no request until it is true. */
    useLanguage(read_ = true): UiLanguage {
      const [language, setLanguage] = useState<UiLanguage>(current ?? "en");
      const [, setPackVersion] = useState(0);
      useEffect(() => {
        let live = true;
        if (read_) void read().then(() => { if (live) setLanguage(current ?? "en"); }); // the latest, should an announce come first
        const onChange = (event: Event) => setLanguage((event as CustomEvent<UiLanguage>).detail);
        const onPack = () => setPackVersion((version) => version + 1);
        window.addEventListener(changed, onChange);
        window.addEventListener(UI_LANGUAGE_PACK_EVENT, onPack);
        return () => {
          live = false;
          window.removeEventListener(changed, onChange);
          window.removeEventListener(UI_LANGUAGE_PACK_EVENT, onPack);
        };
      }, [read_]);
      return language;
    }
  };
}

// <html lang> follows the interface language (plan clipboard:aE7U1J_gU9OV step 7): screen readers and hyphenation read Greek as Greek.
const ui = languageSetting("space:ui-language", (saved) => uiLanguageOf(saved, navigator.languages), (language) => {
  if (typeof document !== "undefined") document.documentElement.lang = language;
  try { window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language); } catch { /* best-effort preload hint */ }
  if (language === "el") void ensureUiLanguagePack("el");
});
const agents = languageSetting("space:agent-language", (saved) => agentLanguageOf(saved, navigator.languages));
/** The interface language now, for code outside React. */
export const uiLanguageNow = ui.now;
export const announceUiLanguage = ui.announce;
export const useUiLanguage = ui.useLanguage;
/** The language agents write to the operator in: card translations, the Nous conversation's steps, the desktop pop-up's text. */
export const agentLanguageNow = agents.now;
export const announceAgentLanguage = agents.announce;
export const useAgentLanguage = agents.useLanguage;

/**
 * A notification's source as toasts, desktop pop-ups, the Go now banner and Needs you cards name it (plan clipboard:32etNsBgtbI- step 6:
 * «MAIL COPILOT» on a Greek toast). The table keeps the copilots' names as names for Settings and the Create menu, so the sources carry
 * their own Greek here; the rest (Browser, Design, Agent…) come from the table. Nous and Space are the app's own names.
 */
const SOURCE_EL: Partial<Record<NotificationSource, string>> = {
  MAIL_COPILOT: "Βοηθός αλληλογραφίας", JOB_COPILOT: "Βοηθός αναζήτησης εργασίας", MARKETING_COPILOT: "Βοηθός μάρκετινγκ",
  FREELANCE_COPILOT: "Βοηθός freelance", APP_STUDIO: "Στούντιο εφαρμογών", SECURITY_COPILOT: "Βοηθός ασφάλειας",
  MONITORING_COPILOT: "Βοηθός παρακολούθησης", ROOM_AGENT: "Πράκτορας δωματίου", COUNCIL: "Συμβούλιο"
};
export const uiSourceLabel = (language: UiLanguage, source: NotificationSource): string =>
  (language === "el" ? SOURCE_EL[source] : undefined) ?? uiText(language, NOTIFICATION_SOURCE_LABELS[source]);

/** The text in the operator's language; anything the table lacks stays as written. `{name}` slots take `vars` (the table keeps them in place). */
export const uiText = (language: UiLanguage, text: string, vars?: Record<string, string | number>): string => {
  if (language === "el" && !elLoaded) void ensureUiLanguagePack("el");
  const base = language === "el" ? elDict[text] ?? text : text;
  return vars ? base.replace(/\{(\w+)\}/g, (slot, key: string) => key in vars ? String(vars[key]) : slot) : base;
};

/**
 * The lines the server writes into a card's text (pane-notices.ts, notifications/service.ts) in the operator's language; the rest of the
 * text is the producer's and stays as written. Records already stored read the same way.
 */
const SERVER_LINES: Array<[RegExp, (language: UiLanguage, ...parts: string[]) => string]> = [
  [/\(Recommended "([^"]+)" by your rule \[([^\]]+)\] "([^"]*)"\.\)/g, (l, option, id, title) => `(Προτείνεται «${uiText(l, option)}» από τον κανόνα σου [${id}] «${title}».)`],
  [/Recommended "([^"]+)" by your last (\d+) answers\./g, (l, option, count) => `Προτείνεται «${uiText(l, option)}» από τις τελευταίες ${count} απαντήσεις σου.`],
  [/\(Since your answer: /g, () => "(Από την απάντησή σου: "],
  [/\(answers the (.+?)'s question\)/g, (_l, source) => `(απαντά στην ερώτηση του ${source})`],
  [/^Space's account facts:$/gm, () => "Στοιχεία λογαριασμών του Space:"],
  // The account and mail facts Space writes on decisions and cards (nous/tools.ts accountFacts, nous/mail-context.ts; nous_msg:40900116).
  [/\bVault: (\d+) logins? for (\S+):/g, (_l, count, site) => `Vault: ${count} ${count === "1" ? "σύνδεση" : "συνδέσεις"} για το ${site}:`],
  [/\bSign-ins for (\S+): Space never signed in there \(do not call it an existing account\)/g,
    (_l, site) => `Συνδέσεις στο ${site}: το Space δεν έχει συνδεθεί ποτέ εκεί (μην το λες υπάρχοντα λογαριασμό)`],
  [/\bSign-ins for (\S+): (.*)$/gm, (_l, site, records) => `Συνδέσεις στο ${site}: ${records.replace(/ with /g, " με ").replace(/ as /g, " ως ")
    .replace(/\((\d+) successful\)/g, (_m, count: string) => `(${count} ${count === "1" ? "επιτυχής" : "επιτυχείς"})`)}`],
  [/\bConnected Google accounts: /g, () => "Συνδεδεμένοι λογαριασμοί Google: "],
  [/\bMail (from|with) (\S+) in (\d+) days: (.*)$/gm, (_l, way, target, days, rest) => `Αλληλογραφία ${way === "from" ? "από" : "με"} ${target} τις τελευταίες ${days} ημέρες: ${
    rest === "none" ? "καμία" : rest === "unknown (the mail read failed)" ? "άγνωστο (η ανάγνωση της αλληλογραφίας απέτυχε)"
      : rest.replace(/^(\d+\+?) threads? in a connected mailbox, newest (\S+) /, (_m, count: string, date: string) => `${count} ${count === "1" ? "νήμα" : "νήματα"} σε συνδεδεμένο γραμματοκιβώτιο, νεότερο ${date} `)
        .replace(/: (\d+\+?) threads?, newest (\S+) /, (_m, count: string, date: string) => `: ${count} ${count === "1" ? "νήμα" : "νήματα"}, νεότερο ${date} `)}`]
];
export const uiServerText = (language: UiLanguage, text: string): string =>
  language === "el" ? SERVER_LINES.reduce((out, [pattern, to]) => out.replace(pattern, (_match, ...parts: string[]) => to(language, ...parts)), text) : text;

/** `t("Go to pane")` in the operator's language. */
export function useUiText(): (text: string, vars?: Record<string, string | number>) => string {
  const language = useUiLanguage();
  return (text, vars) => uiText(language, text, vars);
}
