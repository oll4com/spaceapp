import { createHash } from "node:crypto";

/** An assistant's account of a decision must never become the operator's instruction. */
export const NOUS_MEMORY_AUTHORITY_RULE = "Your memory has no authority to change the operator's choices. Never save a refusal, a restriction you invented, "
  + "or a decision contrary to their request as their rule, preference or consent. Never replace their instruction with your own decision. "
  + "Save an operator instruction with operatorMessageId: Space copies their actual message, without your paraphrase. "
  + "Your observations and technical blockers are facts to report, not standing instructions that bind the operator. "
  + "A limitation does not mean they agreed to an alternative. This applies to Space Memory, notes, lessons, shared memory and files.";

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const authority = /\boperator[- ](?:rule|order|preference|decision|request|instruction)s?\b|\b(?:the )?operator (?:asked|ordered|wants|chose|decided|agreed|requires|must|has to)\b|\b(?:override|supersede)[sd]?\s+(?:the\s+)?(?:operator|user|their|his|her|your)\b|\bsupersedes\s*=|(?:εντολη|αποφαση|προτιμηση|κανονας) (?:του )?(?:χειριστη|operator)|(?:ο χειριστης|ο operator) (?:ζητησε|αποφασισε|πρεπει)/u;
// These are standing restrictions authored by Nous, not a report of a tool failure.
const imposedRestriction = /\b(?:agents?|nous|copilots?|assistants?|we|i) (?:must never|never|must not|may not|cannot|can't|will not|won't|do not|does not) (?:sit|take|answer|complete|submit|perform|carry out|comply|obey|honou?r)\b|\b(?:tests?|assessments?|exams?) (?:are|stay|remain|must be) (?:taken by |for )?(?:the operator|the candidate|his own|their own)\b|\b(?:no|without) (?:right|authority) to (?:ask|request|choose)\b|(?:δεν θα|δεν μπορει|απαγορευεται να) (?:το |τα )?(?:κανει|κανω|δωσει|δωσω|απαντησει|απαντησω)|δεν εχει (?:το )?δικαιωμα/u;

export function nousMemoryNeedsSource(title: string, body: string, tags: readonly string[] = [], key = ""): boolean {
  return tags.some((tag) => /^operator[-_ ](?:rule|order|preference|decision|request|instruction|fact|source)(?:s|[-_ ].*)?$/i.test(tag))
    || /^operator-(?:preferences|rules|orders|decisions)(?:-|$)/.test(key)
    || /^operator(?::| message nous_msg:)/im.test(`${title}\n${body}`)
    || authority.test(fold(`${title}\n${body}`)) || imposedRestriction.test(fold(`${title}\n${body}`));
}

export const nousProtectedNote = (key: string, text: string) => key.startsWith("operator-message-")
  || /^Operator message nous_msg:/m.test(text) || nousMemoryNeedsSource("", text, [], key);

/** A deletion command, not merely a mention such as "do not delete <key>". */
export function operatorDeletesNote(content: string, key: string): boolean {
  const command = fold(content).trim().replace(/[.!]$/, "").trim();
  return new RegExp(`^(?:please |παρακαλω )?(?:(?:delete|remove|forget) (?:the )?(?:note )?|(?:διαγραψε|σβησε|ξεχασε) (?:την? )?(?:σημειωση )?)${key}$`).test(command);
}

/** One immutable note per source: selecting an older message must not replace a newer preference. */
export const operatorMemoryNoteKey = (id: string) => `operator-message-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

// The canonical reader interprets these as record metadata, including inside indented body lines.
export const nousMemoryHasMetadata = (text: string) => /\bsupersedes\s*=|<!--\s*space-memory:|^\s*-\s*(?:Tags:|Source:|created_at=)/im.test(text);
const OBSERVATION = "Nous observation (no authority to change user choices):\n";
export const nousObservation = (text: string) => text.startsWith(OBSERVATION) ? text : `${OBSERVATION}${text}`;

export function operatorMemoryText(message: { id: string; content: string; createdAt?: string }): { title: string; body: string } {
  return { title: `Operator: ${message.content.replace(/\s+/g, " ").trim()}`.slice(0, 160),
    body: `Operator message ${message.id}${message.createdAt ? ` at ${message.createdAt}` : ""} (verbatim; no assistant interpretation):\n${message.content}` };
}
