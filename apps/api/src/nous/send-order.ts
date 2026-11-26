import { FREELANCE_CHANNELS, FREELANCE_CHANNEL_HOSTS, FREELANCE_CHANNEL_LABELS, freelanceOffPlatformIssues } from "@space/contracts";
import { LINKED_FILE, unfinishedLine } from "./request-done.js";

/**
 * Operator corrections 26/11 (Daily Nous errors, corrections ×30): Nous ordered panes to send marketplace replies from draft files nobody
 * checked: decision 873d21ed (06:49Z) sent Michael-Luchetta-reply-26-11-v2.md with "[CONFIRM month/year]" to Upwork, and the 12:35Z order
 * to Work/Jack sent …-final.md with spaceapp.dev, LinkedIn and oll4.com links (Upwork Policy Warning). An order naming a marketplace, a send
 * and a draft file is held while the draft's text to send breaks a rule code can check: an unfilled placeholder or off-platform contact.
 */
const SEND = /\b(?:send|post|submit)\b|στε[ιί]λ|ποστ[αά]ρ/iu;
// A brief to write or fix a draft ("do not send it") orders no send.
const NO_SEND = /\b(?:do not|don't) (?:send|post|submit) (?:it|this|yet|anything)\b(?! else)|\bwithout (?:sending|posting)\b|μην (?:\p{L}+ )?(?:στε[ιί]λ|ποστ[αά]ρ)/iu;
// "fill the [CONFIRM] and send" orders the pane to finish the draft first.
const FILLS = /\b(?:fill|complete|replace)\b|συμπλ[ηή]ρω/iu;

function marketplace(order: string) {
  const lower = order.toLowerCase();
  // Short labels (Arc, Guru) are common words: only their hosts name them.
  return FREELANCE_CHANNELS.find((channel) => (FREELANCE_CHANNEL_LABELS[channel].length >= 5 && new RegExp(`\\b${FREELANCE_CHANNEL_LABELS[channel]}\\b`, "i").test(order))
    || FREELANCE_CHANNEL_HOSTS[channel].some((host) => lower.includes(host)));
}
/** A draft's "---- TEXT TO SEND ----" section (the drafts' own layout), else all of it. */
function textToSend(body: string): string {
  const parts = body.split(/^-{3,}[ \t]*(.*?)[ \t]*-{3,}[ \t]*$/m);
  const at = parts.findIndex((part, index) => index % 2 === 1 && /text to send/i.test(part));
  return at > 0 ? parts[at + 1] ?? "" : body;
}

export async function sendOrderIssue(order: string, read: (refs: string[]) => Promise<Array<{ ref: string; text: string | null }>>): Promise<string | null> {
  const files = [...new Set(order.match(LINKED_FILE) ?? [])];
  const channel = files.length && SEND.test(order) && !NO_SEND.test(order) ? marketplace(order) : undefined;
  if (!channel) return null;
  const label = FREELANCE_CHANNEL_LABELS[channel];
  for (const file of await read(files)) {
    if (!file.text) continue;
    const text = textToSend(file.text);
    const placeholder = FILLS.test(order) ? null : unfinishedLine(text, true);
    if (placeholder) return `${file.ref} still has an unfilled placeholder: "${placeholder.slice(0, 160)}". Nothing sent. Fill it in the file (ask the operator for the fact if only they know it), then send the order again.`;
    const issues = freelanceOffPlatformIssues(text, channel);
    if (issues.length) {
      return `${file.ref} breaks the operator's marketplace rule (26/11, Upwork Policy Warning): ${label} messages carry no link outside ${label}, email, phone or other contact `
        + `(found: ${issues.join(", ")}). Nothing sent. Remove them from the text to send (a portfolio or proof goes as an attachment on ${label}), then send the order again.`;
    }
  }
  return null;
}
