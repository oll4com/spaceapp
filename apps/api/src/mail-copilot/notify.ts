import { makeNeedsYouAsk, resolveMailCopilotPaneMetadata, type MailCopilotEvent, type NeedsYouAsk, type Pane } from "@space/contracts";
import type { NotificationService } from "../notifications/service.js";

const NEEDS_YOU = new Set(["QUESTION", "REVIEW_REQUESTED", "NEEDS_USER", "RULE_PROPOSED"]);
const RESOLVES = new Set(["ANSWERED", "REVIEW_DECIDED", "RULE_DECIDED"]);
/** A rule learned (or retired) from the operator's own actions is news, not a request; so is a mail a FIX rule sent to the copilot, and what it fixed. */
const RULE_NEWS = new Set(["RULE_LEARNED", "RULE_RETIRED"]);
const FIX_NEWS = new Set(["FIX_REQUESTED", "FIXED"]);

/** The dedupe key of a Mail Copilot needs-you notification (a question, review or rule by its id, anything else by its event). */
export const mailCopilotNoticeKey = (key: string) => `mail-copilot:${key}`;

/** Whether a Mail Copilot event may raise or resolve a Space notification (checked before any lookup). */
export function mailCopilotEventNotifies(event: MailCopilotEvent): boolean {
  return NEEDS_YOU.has(event.type) || RESOLVES.has(event.type) || RULE_NEWS.has(event.type) || FIX_NEWS.has(event.type) || event.type === "MAIL_RECEIVED";
}

/** New mail (INFO), what the copilot waits on (ATTENTION), learned and retired rules (INFO) and their resolutions, by the pane's settings. */
export async function notifyMailCopilotEvent(event: MailCopilotEvent, input: { roomId: string; pane: Pane; owner: string; notifications: Pick<NotificationService, "raise" | "resolve"> }): Promise<void> {
  const { roomId, pane, owner, notifications } = input;
  const settings = resolveMailCopilotPaneMetadata(pane.mailCopilotMetadata).settings;
  const key = String(event.payload.questionId ?? event.payload.reviewId ?? event.payload.ruleId ?? event.id);
  const telegram = settings.notifications.telegram ? true : null;
  if (RESOLVES.has(event.type)) {
    await notifications.resolve(owner, mailCopilotNoticeKey(key));
    return;
  }
  if (event.type === "MAIL_RECEIVED") {
    if (!settings.notifications.newMail || !event.accountEmail || !event.threadId) return;
    if (settings.notifications.mutedAccounts.some((email) => email.toLowerCase() === event.accountEmail!.toLowerCase())) return;
    const from = event.payload.from as { name?: string; address?: string } | undefined;
    const subject = typeof event.payload.subject === "string" && event.payload.subject ? event.payload.subject : "(no subject)";
    const snippet = typeof event.payload.snippet === "string" ? event.payload.snippet : "";
    await notifications.raise({ ownerUserId: owner, roomId, paneId: pane.id, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO",
      title: `${from?.name || from?.address || "New mail"} · ${event.accountEmail}`, body: `${subject}${snippet ? ` — ${snippet}` : ""}`.slice(0, 2000),
      link: { roomId, paneId: pane.id, target: `thread:${event.accountEmail}:${event.threadId}` }, dedupeKey: `mail:${event.accountEmail}:${event.messageId ?? event.id}`,
      payload: { eventId: event.id }, telegram });
    return;
  }
  if (!settings.notifications.needsYou) return;
  if (FIX_NEWS.has(event.type)) {
    // The operator's own click needs no notice; the copilot taking a mail on its own, and every fix, do.
    if (event.type === "FIX_REQUESTED" && event.payload.by !== "rule") return;
    await notifications.raise({ ownerUserId: owner, roomId, paneId: pane.id, source: "MAIL_COPILOT", kind: event.type, severity: "INFO",
      title: event.type === "FIXED" ? `Mail Copilot fixed a mail (${pane.title})` : `Mail Copilot took a mail to fix (${pane.title})`, body: event.message.slice(0, 2000),
      link: { roomId, paneId: pane.id, target: event.threadId && event.accountEmail ? `thread:${event.accountEmail}:${event.threadId}` : `event:${event.id}` },
      dedupeKey: `mail-copilot:${event.type}:${event.id}`, payload: { eventId: event.id }, telegram });
    return;
  }
  if (RULE_NEWS.has(event.type)) {
    await notifications.raise({ ownerUserId: owner, roomId, paneId: pane.id, source: "MAIL_COPILOT", kind: event.type, severity: "INFO",
      title: `Mail Copilot ${event.type === "RULE_LEARNED" ? "learned a rule" : "retired a rule"} (${pane.title})`, body: event.message.slice(0, 2000),
      link: { roomId, paneId: pane.id, target: `event:${event.id}` }, dedupeKey: `mail-copilot:${event.type}:${key}`, payload: { eventId: event.id }, telegram });
    return;
  }
  await notifications.raise({ ownerUserId: owner, roomId, paneId: pane.id, source: "MAIL_COPILOT", kind: event.type, severity: "ATTENTION",
    title: `Mail Copilot needs you (${pane.title})`, body: event.message.slice(0, 2000),
    link: { roomId, paneId: pane.id, target: event.threadId && event.accountEmail ? `thread:${event.accountEmail}:${event.threadId}` : `event:${event.id}` },
    dedupeKey: mailCopilotNoticeKey(key), payload: { eventId: event.id, ask: mailAsk(event) }, telegram });
}

/** Needs you as questions (plan clipboard:5AQvaoSR-IZa): what the card asks and where the operator's answer goes. */
function mailAsk(event: MailCopilotEvent): NeedsYouAsk {
  const decide = (item: "REVIEW" | "RULE", itemId: unknown) => makeNeedsYouAsk(event.message, { kind: "COPILOT_DECISION", copilot: "MAIL", item, itemId: String(itemId) }, ["Approve", "Decline"]);
  if (event.type === "QUESTION") {
    return makeNeedsYouAsk(event.message, { kind: "COPILOT_QUESTION", copilot: "MAIL", questionId: String(event.payload.questionId) },
      Array.isArray(event.payload.options) ? event.payload.options.map(String) : []);
  }
  if (event.type === "REVIEW_REQUESTED") return decide("REVIEW", event.payload.reviewId);
  if (event.type === "RULE_PROPOSED") return decide("RULE", event.payload.ruleId);
  // NEEDS_USER: a mail only the operator handles; words hand it to the copilot (Send to AI).
  return makeNeedsYouAsk("What should Mail Copilot do with this mail?", { kind: "MAIL_FIX", ...(event.accountEmail ? { account: event.accountEmail } : {}), ...(event.threadId ? { threadId: event.threadId } : {}) },
    ["I handled it", "Ignore it"]);
}
