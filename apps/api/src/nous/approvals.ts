import type { NousDecision, NousDecisionAction } from "@space/contracts";
import type { FreelanceCopilotService } from "../freelance-copilot/service.js";
import type { JobApplyService } from "../job-apply/service.js";
import type { MailCampaignsService } from "../mail-campaigns/service.js";
import type { MailCopilotService } from "../mail-copilot/service.js";
import type { MarketingCopilotService } from "../marketing-copilot/service.js";
import { SETTLED_DECISION_OUTCOME } from "./workbench.js";

/**
 * Nous Score's «Approved but not done» from rows that already exist (goal 84ba917a, operator 5/11; no task, no turn, no Gmail read):
 * a COPILOT decision by its item's final state, a mail decision by our logged send to its recipients in any thread or its thread.
 */
export interface ApprovalStores {
  mail?: Pick<MailCopilotService, "threadSend" | "sentTo" | "listEvents" | "listRules">;
  marketing?: Pick<MarketingCopilotService, "getPost" | "listPosts" | "listCampaigns" | "listRules">;
  freelance?: Pick<FreelanceCopilotService, "getMessage" | "getLead" | "listRules">;
  job?: Pick<JobApplyService, "listEvents" | "getApplication">;
  mailCampaigns?: Pick<MailCampaignsService, "campaigns">;
}
export type ApprovalSettlement = { state: "DONE" | "VOID"; proof: string };
type CopilotAction = Extract<NousDecisionAction, { type: "COPILOT" }>;

// By item kind and the decision taken: the statuses that complete it. Any other final status of the item voids it (declined, cancelled, superseded).
const DONE: Record<CopilotAction["item"], Record<string, string[]>> = {
  REVIEW: { approve: ["PUBLISHED", "SENT", "SUBMITTED", "VERIFIED"], edit: ["PUBLISHED", "SENT", "SUBMITTED", "VERIFIED"], reject: ["REJECTED"] },
  RULE: { approve: ["APPROVED"], reject: ["REJECTED"], retire: ["RETIRED"] },
  CAMPAIGN: { approve: ["ACTIVE", "APPROVED", "SENDING", "DONE"], complete: ["DONE"], cancel: ["CANCELLED", "STOPPED"] },
  LEAD: { won: ["WON"], lost: ["LOST"] }
};
const FINAL: Record<CopilotAction["item"], string[]> = {
  REVIEW: ["PUBLISHED", "SENT", "SUBMITTED", "VERIFIED", "REJECTED", "SUPERSEDED"], RULE: ["APPROVED", "REJECTED", "RETIRED"],
  CAMPAIGN: ["DONE", "CANCELLED", "STOPPED"], LEAD: ["WON", "LOST", "SKIPPED"]
};

/** Rule 1: DONE when the item reached the state the decision asked for, VOID when it ended another way, null while it is under way. */
export function copilotSettlement(action: CopilotAction, item: { status: string; proof: string } | null): ApprovalSettlement | null {
  if (!item) return null;
  if (DONE[action.item][action.decision]?.includes(item.status)) return { state: "DONE", proof: item.proof };
  return FINAL[action.item].includes(item.status) ? { state: "VOID", proof: `${item.proof} ended ${item.status}` } : null;
}

const quiet = <T>(promise: Promise<T> | undefined) => promise ? promise.catch(() => null) : Promise.resolve(null);

/** The copilot item's status as the copilots keep it, and its evidence (a published URL, a sent message id); null: not found or not readable. */
type MarketingPost = NonNullable<Awaited<ReturnType<MarketingCopilotService["getPost"]>>>;
const postById = async (owner: string, id: string, stores: ApprovalStores) =>
  // 5/11: an itemId without its "mktpost:" prefix read as "not found" (decision 153387ed).
  await quiet(stores.marketing?.getPost(owner, id)) ?? (id.includes(":") ? null : await quiet(stores.marketing?.getPost(owner, `mktpost:${id}`)));

/**
 * Audit 6/11 (operator «μπορεί να μην έφυγε το αρχικό αλλά έφυγε στο τέλος»): the post that took a post's place. The one its title names
 * ("[REPLACED by X]"), else for a failed or superseded post a later post of the same channel and target, a published one first.
 */
async function replacementOf(owner: string, post: MarketingPost, seen: Set<string>, stores: ApprovalStores): Promise<MarketingPost | null> {
  const named = /replaced by (?:mktpost:)?([\w-]+)/i.exec(post.title ?? "")?.[1];
  if (named) return postById(owner, named, stores);
  if (post.status !== "FAILED" && post.status !== "SUPERSEDED") return null;
  // shortcut: a target as broad as a subreddit ("r/hetzner") takes any later post there as the replacement; name it in the title when that is wrong.
  const later = ((await quiet(stores.marketing?.listPosts(owner, { channel: post.channel }))) ?? [])
    // Goal 84ba917a 6/11: a FAILED post re-filed under the same title on the channel is its replacement too.
    .filter((other) => (other.target === post.target || (!!post.title && other.title === post.title)) && other.createdAt > post.createdAt && !seen.has(other.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return later.find((other) => other.status === "PUBLISHED" && other.publishedUrl) ?? later[0] ?? null;
}

export async function copilotItemState(owner: string, action: CopilotAction, since: string, stores: ApprovalStores): Promise<{ status: string; proof: string; scheduledAt?: string | null } | null> {
  const id = action.itemId;
  switch (`${action.copilot}:${action.item}`) {
    case "MARKETING:REVIEW": {
      let post = await postById(owner, id, stores);
      for (const seen = new Set<string>(); post && !seen.has(post.id) && post.status !== "PUBLISHED";) {
        seen.add(post.id);
        post = await replacementOf(owner, post, seen, stores) ?? post;
      }
      // Published only with its URL: the evidence.
      return post && { status: post.status === "PUBLISHED" && !post.publishedUrl ? "PUBLISHED_NO_URL" : post.status, proof: post.publishedUrl ?? post.id, scheduledAt: post.scheduledAt };
    }
    case "MARKETING:CAMPAIGN": { const found = (await quiet(stores.marketing?.listCampaigns(owner)))?.find((campaign) => campaign.id === id); return found ? { status: found.status, proof: found.id } : null; }
    case "MAIL:CAMPAIGN": { const found = (await quiet(stores.mailCampaigns?.campaigns(owner)))?.find((campaign) => campaign.id === id); return found ? { status: found.status, proof: found.id } : null; }
    case "MARKETING:RULE": case "FREELANCE:RULE": case "MAIL:RULE": {
      const rules = await quiet<Array<{ id: string; status: string }>>(action.copilot === "MAIL" ? stores.mail?.listRules(owner) : action.copilot === "MARKETING" ? stores.marketing?.listRules(owner) : stores.freelance?.listRules(owner));
      const found = rules?.find((rule) => rule.id === id);
      return found ? { status: found.status, proof: found.id } : null;
    }
    case "FREELANCE:REVIEW": { const message = await quiet(stores.freelance?.getMessage(owner, id)); return message && { status: message.status, proof: message.id }; }
    case "FREELANCE:LEAD": { const lead = await quiet(stores.freelance?.getLead(owner, id)); return lead && { status: lead.status, proof: lead.url ?? lead.id }; }
    case "MAIL:REVIEW": {
      const decided = (await quiet(stores.mail?.listEvents(owner, { types: ["REVIEW_DECIDED"], since })))?.find((event) => event.payload.reviewId === id);
      if (!decided) return null;
      const sent = decided.payload.sent as { messageId?: string } | null | undefined;
      return { status: decided.payload.decision === "reject" ? "REJECTED" : sent?.messageId ? "SENT" : "DECIDED", proof: sent?.messageId ?? decided.id };
    }
    case "JOB:REVIEW": {
      const events = await quiet(stores.job?.listEvents(owner, { types: ["REVIEW_REQUESTED", "REVIEW_DECIDED"] }));
      const review = events?.filter((event) => event.payload.reviewId === id) ?? [];
      const applicationId = review.find((event) => event.applicationId)?.applicationId;
      if (review.some((event) => event.type === "REVIEW_DECIDED" && event.payload.decision === "reject")) return { status: "REJECTED", proof: applicationId ?? id };
      const application = applicationId ? await quiet(stores.job?.getApplication(owner, applicationId)) : null;
      return application && { status: application.status, proof: `${application.id} ${application.url}` };
    }
    default: return null;
  }
}

// Goal 84ba917a (6/11, nous_decision:482201cb → mktpost:-fRz78yOWFiI): decisions asked as a pane prompt or before refs.copilotItem name their post only in text.
// Nous 6/11 (nous_msg:d1325a00): a mail campaign (mcamp:<id>) too, so an approved campaign that starts later is not owed now.
const ITEM_REF = /\b(mktpost|flmsg|mcamp)[:-]([\w-]+)/;
const ITEM_KIND = { mktpost: ["MARKETING", "REVIEW"], flmsg: ["FREELANCE", "REVIEW"], mcamp: ["MAIL", "CAMPAIGN"] } as const;
/** The copilot item a decision decides: its COPILOT action, else refs.copilotItem, a file named mktpost-<id>, or mktpost:<id> (flmsg:, mcamp:) in its action text, title or body. */
export function copilotItemOf(decision: Pick<NousDecision, "title" | "body" | "refs" | "action">): CopilotAction | null {
  if (decision.action?.type === "COPILOT") return decision.action;
  const text = [decision.refs.copilotItem, ...(decision.refs.files ?? []), decision.action?.type === "PANE_TEXT" ? decision.action.text : null, decision.title, decision.body];
  for (const piece of text) {
    const found = piece ? ITEM_REF.exec(piece) : null;
    if (!found) continue;
    const [copilot, item] = ITEM_KIND[found[1] as keyof typeof ITEM_KIND];
    return { type: "COPILOT", copilot, item, itemId: `${found[1]}:${found[2]}`, paneId: null, decision: "approve" };
  }
  return null;
}

// shortcut: a D/M date (the operator's day/month, this year) after a word like from/on/for/από/για in the title; a title naming a later
// date for another reason waits until that date. Upgrade to a structured send date on the ask if that misreads.
const SEND_DATE = /(?:\b(?:from|on|for|starting|scheduled)|(?:^|\s)(?:από|για|στις|ξεκινά\S*))\s+(?!24\/7(?![\d/]))(?:[^\s\d/]{1,12}\.?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/gi;
/** Nous 6/11 (a7a0a672 «… 20 mails για Δευτ. 9/11 και Τρ. 10/11», 8fe06919 «… από 12/11»): the first day after the approval day a send's title dates it to. */
export function titleSendDate(title: string, approvedAt: string): string | null {
  const approved = new Date(approvedAt);
  const approvalDay = Date.UTC(approved.getUTCFullYear(), approved.getUTCMonth(), approved.getUTCDate());
  const days = [...title.matchAll(SEND_DATE)].map(([, day, month, year]) => Number(day) <= 31 && Number(month) <= 12
    ? Date.UTC(year ? Number(year) : approved.getUTCFullYear(), Number(month) - 1, Number(day)) : Number.NaN).filter((day) => day > approvalDay);
  return days.length ? new Date(Math.min(...days)).toISOString() : null;
}

const DONE_MARK = /^Done \(marked by Nous\): (.*?)(?: — |$)/;
/** Rule 5 of the 6/11 audit: what a decision asked for, so one send or one marked outcome settles its duplicates. */
const askOf = (decision: NousDecision, item = copilotItemOf(decision)) => item ? `item:${item.itemId.replace(/^[a-z]+:/, "")}`
  : decision.refs.recipients?.length ? `to:${decision.refs.recipients.map((address) => address.toLowerCase()).sort().join(",")}`
  : decision.refs.mailThread ? `thread:${decision.refs.mailThread.threadId}` : null;

/**
 * Per approved EXTERNAL decision of the window: `settled` by its copilot item's final state (rule 1; a replaced post by its replacement),
 * `sends` what the mail store holds of our send for it since the approval (its thread, or to its recipients or their domain in any thread
 * of any account; SENT wins over a bounced one), `scheduled` an approved post's future date or the day its title dates the send to (not late before it), and one decision done
 * settles the others that asked for the same item, recipients or thread (audit 6/11).
 */
export async function approvalStates(owner: string, decisions: NousDecision[], since: number, stores: ApprovalStores) {
  const sends: Record<string, "SENT" | "BOUNCED"> = {};
  const settled: Record<string, ApprovalSettlement> = {};
  const scheduled: Record<string, string> = {};
  const window = decisions.filter((decision) => decision.status === "APPROVED" && decision.category === "EXTERNAL"
    && Date.parse(decision.answeredAt ?? decision.createdAt) >= since);
  await Promise.all(window.map(async (decision) => {
    const approvedAt = decision.answeredAt ?? decision.createdAt;
    const action = copilotItemOf(decision);
    if (action) {
      const item = await copilotItemState(owner, action, decision.createdAt, stores);
      const settlement = copilotSettlement(action, item);
      if (settlement) { settled[decision.id] = settlement; return; }
      if (item?.status === "APPROVED" && item.scheduledAt) scheduled[decision.id] = item.scheduledAt;
    }
    const dated = scheduled[decision.id] ? null : titleSendDate(decision.title, approvedAt);
    if (dated) scheduled[decision.id] = dated;
    const thread = decision.refs.mailThread;
    const recipients = decision.refs.recipients ?? [];
    if (!stores.mail || (!thread && !recipients.length)) return;
    // Audit 6/11 rule 4 (0f222670, Snyk): a booking is done when its invitation or confirmation came from a recipient after the approval.
    // shortcut: a confirmation sent from the scheduler's own address (Ashby no-reply, Calendly) is not matched; Nous marks it.
    if (thread && /booking/i.test(decision.refs.sendKind ?? "")) {
      const confirmation = (await quiet(stores.mail.listEvents(owner, { accountEmail: thread.account.toLowerCase(), types: ["MAIL_RECEIVED"], since: approvedAt })))?.find((event) =>
        recipients.some((address) => address.toLowerCase() === String((event.payload.from as { address?: string } | undefined)?.address ?? "").toLowerCase())
        && /invitation|confirm|booked|scheduled|upcoming/i.test(String(event.payload.subject ?? "")));
      if (confirmation) { settled[decision.id] = { state: "DONE", proof: `${thread.account} message ${confirmation.messageId ?? confirmation.id}: ${String(confirmation.payload.subject)}` }; return; }
    }
    const [inThread, toRecipients] = await Promise.all([thread ? quiet(stores.mail.threadSend(owner, thread.account, thread.threadId, approvedAt, recipients)) : null,
      recipients.length ? quiet(stores.mail.sentTo(owner, null, recipients, approvedAt)) : null]);
    const state = inThread === "SENT" || toRecipients?.state === "SENT" ? "SENT" : inThread ?? toRecipients?.state;
    if (state) sends[decision.id] = state;
  }));
  const done = new Map<string, { id: string; proof: string }>();
  for (const decision of window) {
    const ask = askOf(decision);
    const proof = settled[decision.id]?.state === "DONE" ? settled[decision.id]!.proof : sends[decision.id] === "SENT" ? "our send" : DONE_MARK.exec(decision.outcome ?? "")?.[1];
    if (ask && proof && !done.has(ask)) done.set(ask, { id: decision.id, proof });
  }
  for (const decision of window) {
    const twin = done.get(askOf(decision) ?? "");
    if (twin && twin.id !== decision.id && !settled[decision.id] && sends[decision.id] !== "SENT" && !SETTLED_DECISION_OUTCOME.test(decision.outcome ?? "")) {
      settled[decision.id] = { state: "DONE", proof: `${twin.proof} (the same ask as ${twin.id})` };
    }
  }
  return { decisions, sends, settled, scheduled };
}
