import type { UiLanguage } from "@space/contracts";

/**
 * Operator 1/11 23:08 BKK «needs you … επεξηγηματικα»: a card read "flq:U-Ji6bd-RQ2e". Space's record ids in a card's text read as what they
 * name, in the operator's language, in the original too (S6, 13/11: "Show original" changes the language only). Tickets (q-…) and anything in `code` stay: the operator
 * types those. A new id prefix that reaches cards joins this table.
 */
const LABELS: Record<string, [el: string, en: string]> = {
  room: ["δωμάτιο", "room"], clipboard: ["πλάνο", "plan"], task: ["εργασία", "task"], notification: ["κάρτα", "card"],
  nous_decision: ["απόφαση του Nous", "Nous decision"], nous_goal: ["στόχος", "goal"], nous_msg: ["μήνυμά σου", "your message"],
  space_memory: ["μνήμη Space", "Space Memory entry"], artifact: ["αρχείο", "file"], cli_session: ["συνεδρία CLI", "CLI session"],
  jobq: ["ερώτηση αναζήτησης εργασίας", "Job Copilot question"], jobapp: ["αίτηση εργασίας", "job application"], jobrev: ["έλεγχος αίτησης", "application review"],
  flq: ["ερώτηση freelance", "Freelance question"], fllead: ["πελάτης freelance", "Freelance lead"], flmsg: ["μήνυμα freelance", "Freelance message"],
  mailrev: ["email για έλεγχο", "mail review"], mailq: ["ερώτηση αλληλογραφίας", "mail question"], mcamp: ["καμπάνια email", "mail campaign"],
  mktpost: ["ανάρτηση", "post"], mktcamp: ["καμπάνια μάρκετινγκ", "marketing campaign"], mktq: ["ερώτηση μάρκετινγκ", "Marketing question"],
  flrule: ["κανόνας", "rule"], mktrule: ["κανόνας", "rule"], mailrule: ["κανόνας", "rule"],
  jobmem: ["μνήμη του βοηθού", "copilot memory"], mailmem: ["μνήμη του βοηθού", "copilot memory"], mktmem: ["μνήμη του βοηθού", "copilot memory"],
  flmem: ["μνήμη του βοηθού", "copilot memory"], secmem: ["μνήμη του βοηθού", "copilot memory"], monmem: ["μνήμη του βοηθού", "copilot memory"],
  secfind: ["εύρημα ασφαλείας", "security finding"], secact: ["αλλαγή ασφαλείας", "security change"],
  monact: ["αλλαγή παρακολούθησης", "monitoring change"], monalert: ["ειδοποίηση παρακολούθησης", "monitoring alert"],
  dreq: ["αίτημα γραφικού", "design request"], vreq: ["αίτημα βίντεο", "video request"], asevt: ["brief του Στούντιο εφαρμογών", "App Studio brief"]
};
const PREFIXES = [...Object.keys(LABELS), "pane"].join("|");
// Not inside a URL, a path or another id (the character before it), and the id's own characters to its end.
const ID = new RegExp(`(?<![\\w/=?&#.:@-])(${PREFIXES}):([A-Za-z0-9_-]{6,})(?![\\w-])`, "g");
// "Andy (pane:abc)": the name already says it; the bracket goes.
const AFTER_NAME = new RegExp(`\\s*\\((?:pane|room|cli_session):[A-Za-z0-9_-]{6,}\\)`, "g");

const stem = (word: string) => word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().slice(0, 4);

/**
 * `text` with Space's ids read as what they name (code spans untouched); Proxmox guests read as VM/CT numbers. An id right after a word
 * that already names it ("plan clipboard:…", «του πλάνου clipboard:…») just goes.
 */
export function labelIds(text: string, language: UiLanguage): string {
  return text.split(/(`[^`]*`)/).map((part, index) => index % 2 ? part : part
    .replace(AFTER_NAME, "")
    .replace(new RegExp(`(\\p{L}+)?(\\s*)${ID.source}`, "gu"), (_all, word: string | undefined, space: string, prefix: string) => {
      const label = prefix === "pane" ? ["pane", "pane"] as const : LABELS[prefix]!;
      if (word && space && label.join(" ").split(" ").some((named) => named.length >= 4 && stem(named) === stem(word))) return word;
      return `${word ?? ""}${space}${label[language === "el" ? 0 : 1]}`;
    })
    .replace(/(?<![\w/:-])(qm|pct):(\d{2,6})\b/g, (_guest, kind: string, id: string) => `${kind === "qm" ? "VM" : "CT"} ${id}`)).join("");
}
