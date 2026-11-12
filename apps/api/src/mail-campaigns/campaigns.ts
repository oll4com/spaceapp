import { createHash } from "node:crypto";
import { consentDailyCap, healthSendable, mailAddressDomain, mailCampaignFingerprintInput, MAIL_CAMPAIGN_APPROVED_STATES, MAIL_WARMUP_DAILY, makeNeedsYouAsk,
  renderMailTemplate, type MailCampaign, type MailCampaignPreview, type MailCampaignPreviewMail, type MailCampaignCreate, type MailCampaignEventType, type MailCampaignSend, type MailCampaignUpdate, type MailContact,
  type MailSender, type NotificationRaiseInput } from "@space/contracts";
import type { MailCampaignsRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { SmtpError } from "./smtp.js";
import { buildCampaignMime, htmlWithFooter, textWithFooter, unsubscribeToken } from "./mime.js";
import type { MailTransports } from "./transports.js";
import { dnsblCheck, dnsCheck, linkDomains, lintCheck, systemDns, type LabCheck, type LabDns } from "./lab.js";

// Campaigns (plan clipboard:IJ2ovfLg1Lbw step 5): DRAFT → TESTING → IN_REVIEW → APPROVED → SENDING ⇄ PAUSED → DONE | STOPPED.
// A person approves the exact fingerprint (template version, sender, lists and eligible count, schedule, pacing); approving freezes the
// audience as the send log, and any change after it sends the campaign back to review. The sender job mails one PENDING row at a time
// (the row is SENDING before the send: a lost answer becomes UNKNOWN and is never retried), re-checks suppression and health at send
// time, paces per sender (warm-up, caps, the campaign's hours), and pauses on hard bounces or complaints.

export interface CampaignEngineDeps {
  repository: MailCampaignsRepository;
  transports?: MailTransports;
  now(): string;
  event(owner: string, type: MailCampaignEventType, message: string, payload?: Record<string, unknown>, campaignId?: string | null): Promise<unknown>;
  /** Needs-you cards and results (source MAIL_COPILOT); resolve by dedupe key. */
  notify?: { raise(input: NotificationRaiseInput): Promise<unknown>; resolve(owner: string, dedupeKey: string): Promise<unknown> };
  /** The owner's newest open Mail Copilot pane, where the review card shows. */
  mailPane?(owner: string): Promise<{ id: string; roomId: string } | null>;
  /** The owner's own mailboxes test copies may go to without approval. */
  ownMailboxes?(owner: string): Promise<string[]>;
  unsubscribeKey: Buffer;
  /** e.g. https://oll4.com/u/ ; null: mailto unsubscribe only. */
  unsubscribeBase: string | null;
  /** Tests replace DNS. */
  dns?: LabDns;
  /** A seed mailbox's copy of one message (Gmail, read only): its labels and headers; null when the account is not one of the owner's or the mail is not there. */
  seedMessage?(owner: string, account: string, messageId: string): Promise<{ labels: string[]; headers: Array<{ name: string; value: string }> } | null>;
  /** Nous on with "May send to third parties" (nous/wiring.ts `coversApproval`): resumes are no person's alone, the server's after an outage too. */
  coversApproval?(owner: string): Promise<boolean>;
}

/** The receiving side's verdict on a seed copy: authentication, ARC and spam headers, nothing about the mail's content or route. */
const SEED_VERDICT_HEADER = /^(authentication-results|arc-authentication-results|received-spf|x-spam[\w-]*|x-gm-spam|x-gm-phishy)$/i;
/** The mailbox a seed address lands in: a plus-address (a seed list's operator7+seed@gmail.com) is read in its base mailbox. */
export const seedMailbox = (address: string) => address.toLowerCase().replace(/\+[^@]*@/, "@");
/** SPF, DKIM and DMARC from the topmost Authentication-Results, the one the seed's own provider added. */
export function seedAuth(headers: Array<{ name: string; value: string }>) {
  const value = headers.find((entry) => entry.name.toLowerCase() === "authentication-results")?.value;
  if (!value) return null;
  const result = (method: string) => value.match(new RegExp(`\\b${method}=(\\w+)`, "i"))?.[1]?.toLowerCase() ?? null;
  return { by: value.split(";")[0]!.trim(), spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The hash of one recipient's mail as the operator saw it and as it is sent (subject, preheader, HTML, text). */
export const renderHashOf = (rendered: { subject: string; preheader: string; html: string; text: string }) =>
  sha256(JSON.stringify([rendered.subject, rendered.preheader, rendered.html, rendered.text]));
export const campaignReviewKey = (id: string) => `mail-copilot:campaign:${id}`;
const campaignNoticeKey = (id: string, kind: string) => `mail-copilot:campaign-${kind}:${id}`;
/** Recipients of a campaign above this many need the https one-click endpoint (mailto alone is not enough for a big send). */
export const MAILTO_ONLY_MAX = 500;
/** No contact gets two campaigns within this long. */
export const FREQUENCY_CAP_MS = 72 * 3_600_000;
/** An approval that has not started sending within this long goes back to review. */
export const APPROVAL_FRESH_MS = 7 * 24 * 3_600_000;
const STALE_SENDING_MS = 10 * 60_000;
/** pg's own errors when the database is out of reach (stable 3/11 08:15 UTC, the API out of heap): no sign about the campaign, so its pass is
 * skipped, not paused; the next pass goes on, and a send whose answer was lost stays SENDING until markStaleSending makes it UNKNOWN. */
const DATABASE_UNREACHABLE = /^(timeout exceeded when trying to connect|Connection terminated)/;
const JOB_FAILED = "the sender job failed: ";
/** The pause a failing route leaves (`work`'s ROUTE outcome). */
const ROUTE_PAUSE = /^the route of \S+ failed;/;
/** A failing route check is a login attempt: one per sender every 10 minutes stays well under a mail server's fail2ban (technical bound). */
const ROUTE_RECHECK_MS = 10 * 60_000;

/** The campaign's local weekday (1-7) and hour, and whether mail may go out now. */
export function inSendWindow(schedule: MailCampaign["schedule"], at: Date): boolean {
  if (schedule.startAt && Date.parse(schedule.startAt) > at.getTime()) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((part) => [part.type, part.value]));
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday!) + 1;
  const hour = Number(parts.hour);
  return schedule.days.includes(weekday) && hour >= schedule.fromHour && hour < schedule.toHour;
}
/** The values a recipient's template gets: their attributes, name and first name. */
export function contactValues(contact: Pick<MailContact, "name" | "attributes" | "address">): Record<string, string> {
  const name = contact.name.trim();
  return { ...contact.attributes, ...(name ? { name, firstName: name.split(/\s+/)[0]! } : {}), email: contact.address };
}

export function createCampaignEngine(deps: CampaignEngineDeps) {
  const { repository } = deps;
  const perMinute = new Map<string, number[]>();
  const dns = deps.dns ?? systemDns();
  /** Sample MIMEs handed out for SpamAssassin: a score counts only for the exact bytes of the campaign's current fingerprint. */
  const issued = new Map<string, { owner: string; campaignId: string; fingerprint: string; until: number }>();

  async function campaign(owner: string, id: string) {
    const found = await repository.getCampaign(owner, id);
    if (!found) throw new SpaceNotFoundError(`Campaign ${id} was not found.`);
    return found;
  }
  async function parts(owner: string, row: Pick<MailCampaign, "templateId" | "templateVersion" | "senderId" | "listIds">) {
    const template = await repository.getTemplate(owner, row.templateId);
    const version = template ? await repository.getTemplateVersion(owner, row.templateId, row.templateVersion) : null;
    if (!template || !version) throw new SpaceConflictError(`Template ${row.templateId} version ${row.templateVersion} was not found.`);
    const sender = await repository.getSender(owner, row.senderId);
    if (!sender) throw new SpaceConflictError(`Sender ${row.senderId} was not found.`);
    const lists = await Promise.all(row.listIds.map((id) => repository.getList(owner, id)));
    const missing = row.listIds.filter((_, index) => !lists[index] || lists[index]!.archivedAt);
    if (missing.length) throw new SpaceConflictError(`Lists not found or archived: ${missing.join(", ")}.`);
    const noConsent = lists.filter((list) => list!.consentBasis === "NO_CONSENT");
    if (noConsent.length) throw new SpaceConflictError(`No bulk mail to lists without consent: ${noConsent.map((list) => list!.name).join(", ")}.`);
    return { template, version, sender, lists: lists.map((list) => list!) };
  }
  /** What would go out now, hashed: the template version, sender, lists and how many they reach, schedule and pacing. */
  /** Every recipient's mail as it would go out now (priority order); one that cannot render is left out with the reason. */
  async function renderAudience(owner: string, row: MailCampaign, version: Awaited<ReturnType<typeof parts>>["version"]) {
    const audience = await repository.audience(owner, row.listIds);
    const contacts = new Map((await repository.getContacts(owner, audience.recipients.map((recipient) => recipient.contactId))).map((contact) => [contact.id, contact]));
    const skipped = { ...audience.skipped };
    const mails: Array<{ contactId: string; address: string; name: string; priority: number; renderHash: string; rendered: ReturnType<typeof renderMailTemplate> }> = [];
    for (const recipient of audience.recipients) {
      const contact = contacts.get(recipient.contactId);
      if (!contact) continue;
      try {
        const rendered = renderMailTemplate(version, contactValues(contact));
        mails.push({ ...recipient, name: contact.name, renderHash: renderHashOf(rendered), rendered });
      } catch { skipped["render failed (a required field is empty)"] = (skipped["render failed (a required field is empty)"] ?? 0) + 1; }
    }
    return { mails, skipped };
  }
  /** What would go out now, hashed: template version, sender, lists in priority order, every recipient's rendered mail, schedule and pacing. */
  async function fingerprintOf(owner: string, row: MailCampaign) {
    const { version, sender } = await parts(owner, row);
    const { mails, skipped } = await renderAudience(owner, row, version);
    const contentHash = sha256(mails.map((mail) => `${mail.contactId}:${mail.renderHash}`).join("\n"));
    const audience = { recipients: mails.map(({ contactId, address, priority, renderHash }) => ({ contactId, address, priority, renderHash })), skipped };
    return { fingerprint: sha256(mailCampaignFingerprintInput({ templateFingerprint: version.fingerprint, sender, listIds: row.listIds, eligible: mails.length,
      schedule: row.schedule, pacing: row.pacing, contentHash })), audience, mails };
  }
  async function seedsAllowed(owner: string, seeds: string[]) {
    const own = new Set((await deps.ownMailboxes?.(owner) ?? []).map((address) => address.toLowerCase()));
    const domains = new Set((await repository.listSenders(owner)).map((sender) => sender.domain));
    // port25's automatic checker (rule 47252755: one marked copy passes SPF, DKIM and DMARC first) answers only the envelope sender.
    const outside = seeds.filter((seed) => !own.has(seed) && !domains.has(mailAddressDomain(seed)) && seed !== "check-auth@verifier.port25.com");
    if (outside.length) throw new SpaceConflictError(`Test copies go only to the operator's own mailboxes (connected accounts and the senders' own domains): ${outside.join(", ")}.`);
  }
  async function card(owner: string, row: MailCampaign, body: string) {
    if (!deps.notify) return;
    // The review belongs in the Mail Copilot pane (Needs you shows cards of open panes); without one it still reaches the notifications.
    const where = await deps.mailPane?.(owner) ?? null;
    // Only Decline here: the operator approves in the pane, after reading every mail (approval binds what they read). No recommended option.
    await deps.notify.raise({ ownerUserId: owner, roomId: where?.roomId ?? null, paneId: where?.id ?? null, source: "MAIL_COPILOT", kind: "CAMPAIGN_REVIEW", severity: "ATTENTION",
      title: `Approve mail campaign "${row.name}"?`, body, link: where ? { roomId: where.roomId, paneId: where.id, target: `campaign:${row.id}` } : {}, dedupeKey: campaignReviewKey(row.id),
      payload: { campaignId: row.id, fingerprint: row.fingerprint, ask: makeNeedsYouAsk(`Read and approve mail campaign "${row.name}" in Mail Copilot → Campaigns`, { kind: "COPILOT_DECISION", copilot: "MAIL", item: "CAMPAIGN", itemId: row.id }, ["Decline"]) },

      telegram: null } as NotificationRaiseInput);
  }
  /** An approved, paused or asked campaign that changed: the old approval or card goes, and it is asked again (or is a draft until it can be). */
  async function backToReview(owner: string, row: MailCampaign, why: string) {
    const updated = await repository.updateCampaign(owner, row.id, { status: "IN_REVIEW", approval: null, fingerprint: null }, [row.status]);
    if (!updated) return row;
    await deps.notify?.resolve(owner, campaignReviewKey(row.id));
    await deps.event(owner, "BACK_TO_REVIEW", `"${row.name}" went back to review: ${why}`, { previousApproval: row.approval }, row.id);
    return submit(owner, row.id, true).catch(async (error) => {
      await deps.event(owner, "NOTE", `"${row.name}" is a draft again: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000), {}, row.id);
      return (await repository.updateCampaign(owner, row.id, { status: "DRAFT" }, ["IN_REVIEW"])) ?? updated;
    });
  }
  async function reviewBody(owner: string, row: MailCampaign, audience: Awaited<ReturnType<MailCampaignsRepository["audience"]>>) {
    const { version, sender, lists } = await parts(owner, row);
    const checks = (await repository.listChecks(owner, { campaignId: row.id })).filter((check) => check.fingerprint === row.fingerprint);
    const flagged = lists.filter((list) => list.consentBasis === "B2B" || list.consentBasis === "IMPORTED");
    const skipped = Object.entries(audience.skipped).map(([reason, count]) => `${count} ${reason}`).join(", ");
    return ["Read every mail and approve in Mail Copilot → Campaigns (Go to pane).", `From: ${sender.displayName} <${sender.address}> (${sender.config.route}, warm-up stage ${sender.warmup.stage})`,
      `Subject: ${version.subject}`, `Template: version ${version.version}, fingerprint ${version.fingerprint.slice(0, 8)}`,
      `Lists: ${lists.map((list) => `${list.name} (${list.consentBasis})`).join(", ")}`, `Recipients: ${audience.recipients.length}${skipped ? `; left out: ${skipped}` : ""}`,
      `Schedule: ${row.schedule.timeZone} days ${row.schedule.days.join(",")} ${row.schedule.fromHour}:00-${row.schedule.toHour}:00${row.schedule.startAt ? ` from ${row.schedule.startAt}` : ""}; pacing ${row.pacing.perMinute}/min, ${row.pacing.perDay}/day`,
      ...(flagged.length ? [`Flagged: ${flagged.map((list) => `${list.name} is ${list.consentBasis} (at most ${consentDailyCap(list.consentBasis)} a day)`).join("; ")}`] : []),
      ...(deps.unsubscribeBase ? [] : ["Unsubscribe: mailto only (no public one-click endpoint yet)"]),
      `Checks: ${checks.length ? checks.map((check) => `${check.kind} ${check.status}${check.score === null ? "" : ` ${check.score}`}`).join(", ") : "none run"}`,
      `Fingerprint: ${row.fingerprint?.slice(0, 12)}`].join("\n");
  }
  async function submit(owner: string, id: string, again = false) {
    const row = await campaign(owner, id);
    if (!["DRAFT", "TESTING", ...(again ? ["IN_REVIEW"] : [])].includes(row.status)) throw new SpaceConflictError(`"${row.name}" is ${row.status}; only a draft or tested campaign goes to review.`);
    const { sender } = await parts(owner, row);
    if (sender.status !== "ACTIVE") throw new SpaceConflictError(`Sender ${sender.address} is ${sender.status}: run its check first.`);
    if (!sender.bulk) throw new SpaceConflictError(`Sender ${sender.address} is not for bulk mail: ${sender.bulkNote ?? "the operator turned bulk off"}.`);
    const { fingerprint, audience } = await fingerprintOf(owner, row);
    if (!audience.recipients.length) throw new SpaceConflictError("Nobody on these lists can be mailed (all suppressed, unhealthy or empty).");
    if (!deps.unsubscribeBase && audience.recipients.length > MAILTO_ONLY_MAX) throw new SpaceConflictError(`${audience.recipients.length} recipients need the public one-click unsubscribe endpoint; without it a campaign reaches at most ${MAILTO_ONLY_MAX}.`);
    // The server's checks run for every fingerprint that goes to review, so the card always shows them.
    if (!(await repository.listChecks(owner, { campaignId: id })).some((check) => check.fingerprint === fingerprint && check.kind === "LINT")) await serverLab(owner, row);
    const failed = (await repository.listChecks(owner, { campaignId: id })).filter((check) => check.fingerprint === fingerprint && check.status === "FAIL");
    if (failed.length) throw new SpaceConflictError(`Fix the failed checks first: ${failed.map((check) => check.kind).join(", ")}.`);
    const updated = (await repository.updateCampaign(owner, id, { status: "IN_REVIEW", fingerprint, approval: null }))!;
    await card(owner, updated, await reviewBody(owner, updated, audience));
    await deps.event(owner, "REVIEW_REQUESTED", `"${row.name}" waits for the operator's approval: ${audience.recipients.length} recipients.`, { fingerprint, eligible: audience.recipients.length }, id);
    return updated;
  }

  async function sendOne(owner: string, row: MailCampaign, sender: MailSender, send: MailCampaignSend, content: Awaited<ReturnType<typeof parts>>["version"], language: "el" | "en"): Promise<"SENT" | "SKIPPED" | "RETRY" | "FAILED" | "ROUTE" | "CHANGED"> {
    const at = deps.now();
    const skip = async (reason: string) => { await repository.updateSend(owner, row.id, send.contactId, { status: "SKIPPED", skipReason: reason }, ["SENDING"]); return "SKIPPED" as const; };
    const contact = await repository.getContact(owner, send.contactId);
    if (!contact) return skip("contact gone");
    if ((await repository.suppressedAmong(owner, [contact.address])).size) return skip("suppressed");
    if (!healthSendable(contact.health)) return skip(`health:${contact.health}`);
    const last = await repository.lastMailedAt(owner, contact.id);
    if (last && Date.parse(at) - Date.parse(last) < FREQUENCY_CAP_MS) return skip("mailed by another campaign within 72 h");
    let rendered: ReturnType<typeof renderMailTemplate>;
    try { rendered = renderMailTemplate(content, contactValues(contact)); } catch (error) { return skip(error instanceof Error ? error.message.slice(0, 200) : "render failed"); }
    // The approval covers the mail the operator read for this recipient; a different one (its data or the template changed) is not sent on it.
    if (send.renderHash && renderHashOf(rendered) !== send.renderHash) {
      await repository.updateSend(owner, row.id, send.contactId, { status: "PENDING" }, ["SENDING"]);
      return "CHANGED";
    }
    const unsubscribeUrl = deps.unsubscribeBase ? `${deps.unsubscribeBase}${unsubscribeToken(deps.unsubscribeKey, row.id, contact.id)}` : null;
    const { raw, messageId } = buildCampaignMime({ from: sender.address, fromName: sender.displayName, to: contact.address, replyTo: sender.replyTo, ...rendered, language,
      campaignId: row.id, contactId: contact.id, senderDomain: sender.domain, footerAddress: sender.footerAddress, unsubscribeUrl });
    try {
      const sent = await deps.transports!.for(owner, sender).send(raw, { from: sender.address, to: contact.address });
      await repository.updateSend(owner, row.id, contact.id, { status: "SENT", messageId: sent.messageId ?? messageId, providerId: sent.providerId, sentAt: deps.now(), attempts: send.attempts + 1, error: null }, ["SENDING"]);
      return "SENT";
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const status = error instanceof SmtpError ? error.code : Number((error as { status?: number }).status ?? 0);
      // The route itself (sign-in, revoked grant, missing key) stops the campaign; nothing about this recipient is known.
      if (error instanceof SpaceConflictError || status === 535 || status === 401 || status === 403 || (error instanceof SmtpError && ["AUTH", "GREETING", "EHLO", "STARTTLS"].includes(error.stage))) {
        await repository.updateSend(owner, row.id, contact.id, { status: "PENDING", error: message }, ["SENDING"]);
        return "ROUTE";
      }
      if (error instanceof SmtpError && error.permanent && error.stage === "RCPT TO") {
        await repository.updateSend(owner, row.id, contact.id, { status: "FAILED", error: message, attempts: send.attempts + 1 }, ["SENDING"]);
        await repository.updateContactHealth(owner, contact.id, { health: "INVALID", reasons: [message.slice(0, 200)] });
        return "FAILED";
      }
      const attempts = send.attempts + 1;
      if (attempts >= 3) { await repository.updateSend(owner, row.id, contact.id, { status: "FAILED", error: message, attempts }, ["SENDING"]); return "FAILED"; }
      await repository.updateSend(owner, row.id, contact.id, { status: "PENDING", error: message, attempts, nextAttemptAt: new Date(Date.parse(at) + 2 ** attempts * 60_000).toISOString() }, ["SENDING"]);
      return "RETRY";
    }
  }
  async function pause(owner: string, row: MailCampaign, reason: string, alert: boolean) {
    const updated = await repository.updateCampaign(owner, row.id, { status: "PAUSED", pauseReason: reason }, ["APPROVED", "SENDING"]);
    if (!updated) return;
    await deps.event(owner, alert ? "AUTO_PAUSED" : "PAUSED", `"${row.name}" paused: ${reason}`, {}, row.id);
    if (alert) await deps.notify?.raise({ ownerUserId: owner, roomId: null, paneId: row.paneId, source: "MAIL_COPILOT", kind: "CAMPAIGN_PAUSED", severity: "ATTENTION",
      title: `Mail campaign "${row.name}" paused`, body: reason, link: {}, dedupeKey: campaignNoticeKey(row.id, "paused"), payload: { campaignId: row.id }, telegram: null } as NotificationRaiseInput);
  }
  /** Today's allowance for a campaign: the lowest of its pacing, the sender's caps and warm-up stage and the lists' consent caps, minus what went out in 24 h. */
  async function allowance(owner: string, row: MailCampaign, sender: MailSender, lists: Awaited<ReturnType<typeof parts>>["lists"]) {
    const since = new Date(Date.parse(deps.now()) - 86_400_000).toISOString();
    const stageCap = MAIL_WARMUP_DAILY[Math.min(sender.warmup.stage, MAIL_WARMUP_DAILY.length - 1)]!;
    const senderLeft = Math.min(sender.caps.perDay, sender.warmup.stage >= MAIL_WARMUP_DAILY.length ? Infinity : stageCap) - await repository.sentBySenderSince(owner, sender.id, since);
    const campaignSent = await repository.sentByCampaignSince(owner, row.id, since);
    const consent = Math.min(...lists.map((list) => consentDailyCap(list.consentBasis) ?? Infinity));
    return Math.min(senderLeft, row.pacing.perDay - campaignSent, consent - campaignSent);
  }
  /** One pass of the sender job for one campaign: at most the minute's pacing. */
  async function work(owner: string, row: MailCampaign) {
    const at = new Date(deps.now());
    if (row.status === "APPROVED" && row.approval && at.getTime() - Date.parse(row.approval.at) > APPROVAL_FRESH_MS
      && !(await repository.listSends(owner, row.id, { status: ["SENT", "UNKNOWN"], limit: 1 })).length) {
      await backToReview(owner, row, "it was approved more than 7 days ago and has not started");
      return;
    }
    if (!inSendWindow(row.schedule, at)) return;
    const { version, sender, lists, template } = await parts(owner, row);
    if (sender.status !== "ACTIVE" || !sender.bulk) { await pause(owner, row, `sender ${sender.address} is ${sender.status}${sender.bulk ? "" : " and not for bulk"}`, true); return; }
    // Bad signals: hard bounces over 3 % (after 30 sent) or complaints.
    const stats = await repository.campaignStats(owner, row.id);
    const sent = stats.byStatus.SENT ?? 0;
    if ((sent >= 30 && stats.bounced.hard / sent > 0.03) || (row.pacing.maxHardBounces !== undefined && stats.bounced.hard > row.pacing.maxHardBounces)
      || stats.complained >= 2 || (sent >= 1000 && stats.complained / sent > 0.001)) {
      await pause(owner, row, `${stats.bounced.hard} hard bounces and ${stats.complained} complaints in ${sent} sent: check the list's health before resuming`, true);
      await repository.updateSender(owner, sender.id, { warmup: { stage: Math.max(0, sender.warmup.stage - 1), since: at.toISOString() } });
      return;
    }
    let current = row;
    if (row.status === "APPROVED") {
      current = (await repository.updateCampaign(owner, row.id, { status: "SENDING" }, ["APPROVED"])) ?? row;
      if (current.status === "SENDING") await deps.event(owner, "STARTED", `"${row.name}" started sending.`, {}, row.id);
    }
    if (current.status !== "SENDING") return;
    const minute = (perMinute.get(sender.id) ?? []).filter((time) => at.getTime() - time < 60_000);
    let budget = Math.min(row.pacing.perMinute, sender.caps.perMinute) - minute.length;
    budget = Math.min(budget, await allowance(owner, row, sender, lists));
    if (row.pacing.intervalSeconds) {
      // A mail exactly one interval ago no longer holds the next one back.
      const since = new Date(at.getTime() - row.pacing.intervalSeconds * 1000 + 1000).toISOString();
      budget = (await repository.sentByCampaignSince(owner, row.id, since)) ? 0 : Math.min(budget, 1);
    }
    for (; budget > 0; budget--) {
      const next = await repository.takeNextSend(owner, row.id, at.toISOString());
      if (!next) break;
      const outcome = await sendOne(owner, current, sender, next, version, template.language);
      if (outcome === "SENT" || outcome === "FAILED" || outcome === "RETRY") minute.push(at.getTime());
      if (outcome === "ROUTE") { await pause(owner, current, `the route of ${sender.address} failed; check the sender (space_mail_sender_check)`, true); break; }
      if (outcome === "CHANGED") { await backToReview(owner, current, `the mail for ${next.address} changed since the approval (its contact data or the template)`); return; }
    }
    perMinute.set(sender.id, minute);
    const left = await repository.listSends(owner, row.id, { status: ["PENDING", "SENDING"], limit: 1 });
    if (!left.length) {
      const done = await repository.updateCampaign(owner, row.id, { status: "DONE" }, ["SENDING"]);
      if (done) {
        const final = await repository.campaignStats(owner, row.id);
        const summary = Object.entries(final.byStatus).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(", ");
        await deps.event(owner, "DONE", `"${row.name}" finished: ${summary}.`, { stats: final }, row.id);
        await deps.notify?.raise({ ownerUserId: owner, roomId: null, paneId: row.paneId, source: "MAIL_COPILOT", kind: "CAMPAIGN_DONE", severity: "INFO",
          title: `Mail campaign "${row.name}" finished`, body: summary, link: {}, dedupeKey: campaignNoticeKey(row.id, "done"), payload: { campaignId: row.id }, telegram: null } as NotificationRaiseInput);
      }
    }
  }
  /** Warm-up: after two days at a stage with no auto-pause, a sender climbs one stage. */
  async function climb(owner: string) {
    const at = Date.parse(deps.now());
    for (const sender of await repository.listSenders(owner)) {
      if (sender.status !== "ACTIVE" || sender.warmup.stage >= MAIL_WARMUP_DAILY.length || at - Date.parse(sender.warmup.since) < 2 * 86_400_000) continue;
      // Two days of SENDING at this stage, not two days since the stage was set: a sender made days before its first campaign starts at
      // stage 0 (stable 2/11: ntheo@example.invalid, made 29/10, climbed to 100/day 6 ms after its first mail).
      const sendingSince = await repository.sentBySenderSince(owner, sender.id, sender.warmup.since);
      if (sendingSince - await repository.sentBySenderSince(owner, sender.id, new Date(at - 2 * 86_400_000).toISOString()) <= 0) continue;
      await repository.updateSender(owner, sender.id, { warmup: { stage: sender.warmup.stage + 1, since: new Date(at).toISOString() } });
      await deps.event(owner, "SENDER", `${sender.address} climbed to warm-up stage ${sender.warmup.stage + 1}.`, { senderId: sender.id });
    }
  }

  async function resumeCampaign(owner: string, row: MailCampaign, by: string) {
    await repository.updateCampaign(owner, row.id, { status: "APPROVED", pauseReason: null }, ["PAUSED"]);
    await deps.notify?.resolve(owner, campaignNoticeKey(row.id, "paused"));
    await deps.event(owner, "RESUMED", `"${row.name}" resumed by ${by}.`, { by, pauseReason: row.pauseReason }, row.id);
  }
  /** Operator 3/11 18:28 BKK («αυτα πρεπει να τα κανεις εσυ»): a campaign the infrastructure paused (its route, or the database before
   * DATABASE_UNREACHABLE skipped such passes) goes on by itself once the cause is gone, while "May send to third parties" covers resumes.
   * A bad signal (bounces, complaints, a sender someone stopped) never resumes by itself. */
  const routeChecked = new Map<string, number>();
  async function resumeAfterOutage(owner: string) {
    if (!deps.transports || !await deps.coversApproval?.(owner).catch(() => false)) return;
    const at = Date.parse(deps.now());
    for (const row of await repository.listCampaigns(owner, { status: ["PAUSED"] })) {
      const reason = row.pauseReason ?? "";
      const database = reason.startsWith(JOB_FAILED) && DATABASE_UNREACHABLE.test(reason.slice(JOB_FAILED.length));
      if (!row.approval || (!database && !ROUTE_PAUSE.test(reason))) continue;
      if (!database) {
        if (at - (routeChecked.get(row.senderId) ?? -Infinity) < ROUTE_RECHECK_MS) continue;
        routeChecked.set(row.senderId, at);
        const sender = await repository.getSender(owner, row.senderId);
        if (sender?.status !== "ACTIVE" || !await deps.transports.for(owner, sender).check().then(() => true, () => false)) continue;
      }
      await resumeCampaign(owner, row, `the server, after ${database ? "the database outage" : "its sender's route failure"} cleared`);
    }
  }

  async function serverLab(owner: string, row: MailCampaign) {
    const { version, sender } = await parts(owner, row);
    const { fingerprint } = await fingerprintOf(owner, row);
    const checks = [await dnsCheck(dns, sender), await dnsblCheck(dns, sender, linkDomains(`${version.html}\n${version.text}`)), lintCheck(version, sender.domain)];
    for (const check of checks) await record(owner, row, sender, fingerprint, check);
    const score = Math.min(...checks.map((check) => check.score));
    await deps.event(owner, "LAB", `Checks of "${row.name}": ${checks.map((check) => `${check.kind} ${check.status}`).join(", ")} (score ${score}).`, { fingerprint, score }, row.id);
    return { fingerprint, score, checks, fixes: checks.flatMap((check) => check.details.fixes) };
  }
  async function record(owner: string, row: MailCampaign, sender: MailSender, fingerprint: string, check: LabCheck | { kind: "SPAMASSASSIN" | "AUTH_VERIFIER" | "SEED"; status: LabCheck["status"]; score: number | null; details: Record<string, unknown> }) {
    return repository.addCheck({ ownerUserId: owner, campaignId: row.id, senderId: sender.id, kind: check.kind, status: check.status, score: check.score, details: check.details, fingerprint });
  }
  /** One sample message as a recipient would get it (the first eligible contact, else the template's defaults). */
  /** The first recipient the campaign would mail now and its template values; with none, each variable's default or `fallback(name)`. */
  async function firstRecipient(owner: string, row: MailCampaign, version: Awaited<ReturnType<typeof parts>>["version"], fallback: (name: string) => string) {
    const { fingerprint, audience } = await fingerprintOf(owner, row);
    const first = audience.recipients[0] ? await repository.getContact(owner, audience.recipients[0].contactId) : null;
    const values = first ? contactValues(first) : Object.fromEntries(version.variables.map((variable) => [variable.name, variable.default ?? fallback(variable.name)]));
    return { fingerprint, first, values };
  }
  async function sampleMime(owner: string, row: MailCampaign) {
    const { version, sender, template } = await parts(owner, row);
    const { fingerprint, first, values } = await firstRecipient(owner, row, version, (name) => name);
    let rendered: ReturnType<typeof renderMailTemplate>;
    try { rendered = renderMailTemplate(version, values); } catch { rendered = renderMailTemplate(version, Object.fromEntries(version.variables.map((variable) => [variable.name, variable.default ?? variable.name]))); }
    const unsubscribeUrl = deps.unsubscribeBase ? `${deps.unsubscribeBase}${unsubscribeToken(deps.unsubscribeKey, row.id, first?.id ?? "mcontact:sample000")}` : null;
    const built = buildCampaignMime({ from: sender.address, fromName: sender.displayName, to: first?.address ?? `sample@${sender.domain}`, replyTo: sender.replyTo, ...rendered,
      language: template.language, campaignId: row.id, contactId: first?.id ?? "mcontact:sample000", senderDomain: sender.domain, footerAddress: sender.footerAddress, unsubscribeUrl });
    return { ...built, fingerprint, sender };
  }

  return {
    /**
     * Every mail the campaign would send now, one row per recipient in send order: the operator browses them (search by address, name or
     * subject) before approving; `fingerprint` is what their Approve binds.
     */
    async preview(owner: string, id: string, filter: { q?: string; offset: number; limit: number }): Promise<MailCampaignPreview> {
      const row = await campaign(owner, id);
      const { fingerprint, audience, mails } = await fingerprintOf(owner, row);
      const q = filter.q?.toLowerCase().trim();
      const indexed = mails.map((mail, index) => ({ index, mail }));
      const found = q ? indexed.filter(({ mail }) => mail.address.includes(q) || mail.name.toLowerCase().includes(q) || mail.rendered.subject.toLowerCase().includes(q)) : indexed;
      return { fingerprint, total: mails.length, matched: found.length, skipped: audience.skipped, status: row.status,
        items: found.slice(filter.offset, filter.offset + filter.limit).map(({ index, mail }) => ({ index, contactId: mail.contactId, address: mail.address, name: mail.name,
          priority: mail.priority, subject: mail.rendered.subject })) };
    },
    /** Nous's read before it approves under "May send" (operator 2/11 15:08 BKK): every mail as it would leave, text whole, a page at a time. */
    async mailTexts(owner: string, id: string, offset: number, limit: number) {
      const row = await campaign(owner, id);
      const { sender, template } = await parts(owner, row);
      const { fingerprint, mails } = await fingerprintOf(owner, row);
      return { fingerprint, status: row.status, total: mails.length, items: mails.slice(offset, offset + limit).map((mail, at) => {
        const unsubscribeUrl = deps.unsubscribeBase ? `${deps.unsubscribeBase}${unsubscribeToken(deps.unsubscribeKey, row.id, mail.contactId)}` : null;
        const base = { from: sender.address, fromName: sender.displayName, footerAddress: sender.footerAddress, language: template.language, unsubscribeUrl, ...mail.rendered };
        return { index: offset + at, to: mail.address, from: `${sender.displayName} <${sender.address}>`, subject: mail.rendered.subject, text: textWithFooter(base) };
      }) };
    },
    /** One recipient's complete mail as it would leave (subject, from, the server's footer), with its neighbours for next and previous. */
    async previewMail(owner: string, id: string, contactId: string): Promise<MailCampaignPreviewMail> {
      const row = await campaign(owner, id);
      const { sender, template } = await parts(owner, row);
      const { fingerprint, mails } = await fingerprintOf(owner, row);
      const index = mails.findIndex((mail) => mail.contactId === contactId);
      if (index < 0) throw new SpaceNotFoundError("That contact is not among this campaign's recipients (suppressed, unhealthy or not on its lists).");
      const mail = mails[index]!;
      const unsubscribeUrl = deps.unsubscribeBase ? `${deps.unsubscribeBase}${unsubscribeToken(deps.unsubscribeKey, row.id, mail.contactId)}` : null;
      const base = { from: sender.address, fromName: sender.displayName, footerAddress: sender.footerAddress, language: template.language, unsubscribeUrl, ...mail.rendered };
      return { fingerprint, index, total: mails.length, previous: mails[index - 1]?.contactId ?? null, next: mails[index + 1]?.contactId ?? null,
        contactId: mail.contactId, to: mail.address, name: mail.name, priority: mail.priority, from: `${sender.displayName} <${sender.address}>`, replyTo: sender.replyTo,
        subject: mail.rendered.subject, preheader: mail.rendered.preheader, html: htmlWithFooter(base), text: textWithFooter(base), renderHash: mail.renderHash };
    },
    /** The server's own checks (DNS, blocklists, content) for what would go out now; each bound to the current fingerprint. */
    runLab: async (owner: string, id: string) => serverLab(owner, await campaign(owner, id)),
    async labResults(owner: string, id: string) {
      const row = await campaign(owner, id);
      const { fingerprint } = await fingerprintOf(owner, row);
      const checks = await repository.listChecks(owner, { campaignId: id });
      return { fingerprint, current: checks.filter((check) => check.fingerprint === fingerprint), older: checks.filter((check) => check.fingerprint !== fingerprint).slice(0, 10) };
    },
    /** A sample message's exact bytes for SpamAssassin where it runs (public-host); the score comes back bound to their SHA-256. */
    async labMime(owner: string, id: string) {
      const row = await campaign(owner, id);
      const { raw, fingerprint } = await sampleMime(owner, row);
      const sha256 = createHash("sha256").update(raw).digest("hex");
      issued.set(sha256, { owner, campaignId: id, fingerprint, until: Date.now() + 3_600_000 });
      return { sha256, mime: raw.toString("base64") };
    },
    /** A check the agent ran where the server cannot: SpamAssassin on the issued MIME, or the port25 verifier's verdict on a test copy. */
    async recordLab(owner: string, id: string, input: { kind: "SPAMASSASSIN"; sha256: string; score: number; rules: string[] } | { kind: "AUTH_VERIFIER"; spf: boolean; dkim: boolean; dmarc: boolean; score: number | null; note?: string }) {
      const row = await campaign(owner, id);
      const { sender } = await parts(owner, row);
      const { fingerprint } = await fingerprintOf(owner, row);
      if (input.kind === "SPAMASSASSIN") {
        const handed = issued.get(input.sha256);
        if (!handed || handed.owner !== owner || handed.campaignId !== id || handed.until < Date.now()) throw new SpaceConflictError("Score only the MIME space_mail_deliverability_mime handed out for this campaign (within the hour).");
        if (handed.fingerprint !== fingerprint) throw new SpaceConflictError("The campaign changed since that MIME was handed out: fetch it again.");
        const status = input.score >= 5 ? "FAIL" : input.score >= 3 ? "WARN" : "PASS";
        const check = await record(owner, row, sender, fingerprint, { kind: "SPAMASSASSIN", status, score: input.score, details: { sha256: input.sha256, rules: input.rules.slice(0, 50),
          findings: input.rules.slice(0, 10), fixes: status === "PASS" ? [] : ["change what the listed rules hit, then score the new MIME"] } });
        await deps.event(owner, "LAB", `SpamAssassin scored "${row.name}" ${input.score} (${status}).`, { score: input.score }, id);
        return check;
      }
      const passed = input.spf && input.dkim && input.dmarc;
      const check = await record(owner, row, sender, fingerprint, { kind: "AUTH_VERIFIER", status: passed ? "PASS" : "FAIL", score: input.score,
        details: { spf: input.spf, dkim: input.dkim, dmarc: input.dmarc, note: input.note ?? "", findings: passed ? [] : ["authentication failed at the verifier"], fixes: passed ? [] : ["fix the failing SPF, DKIM or DMARC for the route (see the DNS check)"] } });
      await deps.event(owner, "LAB", `Verifier: SPF ${input.spf ? "pass" : "fail"}, DKIM ${input.dkim ? "pass" : "fail"}, DMARC ${input.dmarc ? "pass" : "fail"}.`, {}, id);
      return check;
    },
    /** Where the last test copies and the campaign's own mail to the owner's Gmail landed (inbox, promotions, spam, not found), with the receiving side's verdict headers. */
    async seedPlacement(owner: string, id: string) {
      const row = await campaign(owner, id);
      const { sender } = await parts(owner, row);
      const { fingerprint } = await fingerprintOf(owner, row);
      const test = (await repository.listEvents(owner, { campaignId: id })).find((event) => event.type === "TEST_SENT");
      const own = new Set((await deps.ownMailboxes?.(owner) ?? []).map((address) => address.toLowerCase()));
      const seeds = [...((test?.payload.results as Array<{ seed: string; messageId: string }> | undefined) ?? []).map((result) => ({ ...result, kind: "TEST" as const })),
        ...(await repository.listSends(owner, id, { status: ["SENT"] })).filter((send) => send.messageId && own.has(seedMailbox(send.address)))
          .map((send) => ({ seed: send.address, messageId: send.messageId!, kind: "SENT" as const }))];
      if (!seeds.length || !deps.seedMessage) throw new SpaceConflictError("Send test copies (space_mail_campaign_test) or the campaign's mail to the operator's own Gmail first.");
      const placements = await Promise.all(seeds.map(async ({ seed, messageId, kind }) => {
        const found = await deps.seedMessage!(owner, seedMailbox(seed), messageId).catch(() => null);
        const labels = found?.labels;
        const where = !labels ? "NOT_FOUND" : labels.includes("SPAM") ? "SPAM" : labels.includes("CATEGORY_PROMOTIONS") ? "PROMOTIONS" : labels.includes("INBOX") ? "INBOX" : "OTHER";
        const headers = (found?.headers ?? []).filter((entry) => SEED_VERDICT_HEADER.test(entry.name)).map((entry) => ({ name: entry.name, value: entry.value.slice(0, 2000) }));
        return { seed, kind, messageId, where, auth: seedAuth(headers), headers };
      }));
      const spam = placements.filter((placement) => placement.where === "SPAM").length;
      const missing = placements.filter((placement) => placement.where === "NOT_FOUND").length;
      const said = (placement: (typeof placements)[number]) => `${placement.seed}: ${placement.where}${placement.auth ? ` (spf=${placement.auth.spf} dkim=${placement.auth.dkim} dmarc=${placement.auth.dmarc})` : ""}`;
      const check = await record(owner, row, sender, fingerprint, { kind: "SEED", status: spam ? "FAIL" : missing ? "WARN" : "PASS", score: Math.round(100 * (placements.length - spam) / placements.length),
        details: { placements, findings: placements.map(said), fixes: spam ? ["read the DNS, SpamAssassin and content checks; a new sender warms up slowly"] : [] } });
      await deps.event(owner, "LAB", `Seed placement of "${row.name}": ${placements.map(said).join(", ")}.`, {}, id);
      return check;
    },
    async createCampaign(owner: string, input: MailCampaignCreate, by: string, paneId: string | null) {
      const template = await repository.getTemplate(owner, input.templateId);
      if (!template || template.archivedAt) throw new SpaceConflictError(`Template ${input.templateId} was not found or is archived.`);
      const row = { templateId: input.templateId, templateVersion: input.templateVersion ?? template.currentVersion, senderId: input.senderId, listIds: input.listIds };
      await parts(owner, row);
      await seedsAllowed(owner, input.testSeeds);
      const created = await repository.createCampaign({ ownerUserId: owner, paneId, name: input.name, goal: input.goal, ...row, schedule: input.schedule, pacing: input.pacing, testSeeds: input.testSeeds, createdBy: by });
      await deps.event(owner, "CREATED", `Campaign "${created.name}" drafted.`, {}, created.id);
      return created;
    },
    campaign,
    campaigns: (owner: string, status?: MailCampaign["status"][]) => repository.listCampaigns(owner, { status }),
    /** A change: a draft just changes; an approved or paused campaign goes back to review; a sending one must be paused first. */
    async updateCampaign(owner: string, id: string, patch: MailCampaignUpdate) {
      const row = await campaign(owner, id);
      if (row.status === "SENDING") throw new SpaceConflictError("Pause the campaign before changing it.");
      if (row.status === "DONE" || row.status === "STOPPED") throw new SpaceConflictError(`"${row.name}" is ${row.status}.`);
      const next = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as MailCampaign;
      if (patch.templateId && patch.templateVersion === undefined) next.templateVersion = (await repository.getTemplate(owner, patch.templateId))?.currentVersion ?? 0;
      await parts(owner, next);
      if (patch.testSeeds) await seedsAllowed(owner, patch.testSeeds);
      const updated = (await repository.updateCampaign(owner, id, { name: next.name, goal: next.goal, templateId: next.templateId, templateVersion: next.templateVersion, senderId: next.senderId,
        listIds: next.listIds, schedule: next.schedule, pacing: next.pacing, testSeeds: next.testSeeds }))!;
      await deps.event(owner, "UPDATED", `"${row.name}" changed (${Object.keys(patch).join(", ")}).`, {}, id);
      if (MAIL_CAMPAIGN_APPROVED_STATES.includes(row.status) || row.status === "IN_REVIEW") return backToReview(owner, updated, "it changed after it was asked or approved");
      return updated;
    },
    /** Test copies to the owner's own seed mailboxes only, marked as tests; no approval needed. */
    async testCampaign(owner: string, id: string, seeds?: string[]) {
      const row = await campaign(owner, id);
      const targets = seeds?.length ? seeds : row.testSeeds;
      if (!targets.length) throw new SpaceConflictError("Name the seed mailboxes (the operator's own) for the test copies.");
      await seedsAllowed(owner, targets);
      if (!deps.transports) throw new SpaceConflictError("Sending is not available on this server.");
      const { version, sender, template } = await parts(owner, row);
      if (sender.status !== "ACTIVE") throw new SpaceConflictError(`Sender ${sender.address} is ${sender.status}: run its check first.`);
      // The copy shows the mail the first recipient would get (their list fields filled), as the operator reads it in the review.
      const { first, values } = await firstRecipient(owner, row, version, (name) => `[${name}]`);
      const rendered = renderMailTemplate(version, values);
      const results = [];
      for (const seed of targets) {
        const { raw, messageId } = buildCampaignMime({ from: sender.address, fromName: sender.displayName, to: seed, replyTo: sender.replyTo, ...rendered, language: template.language,
          campaignId: row.id, contactId: "mcontact:test-seed", senderDomain: sender.domain, footerAddress: sender.footerAddress, unsubscribeUrl: null, test: true });
        const sent = await deps.transports.for(owner, sender).send(raw, { from: sender.address, to: seed });
        results.push({ seed, messageId: sent.messageId ?? messageId, providerId: sent.providerId, asRecipient: first?.address ?? null });
      }
      if (row.status === "DRAFT") await repository.updateCampaign(owner, id, { status: "TESTING" }, ["DRAFT"]);
      await deps.event(owner, "TEST_SENT", `Test copies of "${row.name}" sent to ${targets.length} seed mailbox${targets.length === 1 ? "" : "es"}.`, { results }, id);
      return { sent: results };
    },
    submit: (owner: string, id: string) => submit(owner, id),
    /**
     * The operator's decision (a person in the rail or Needs you, or an approved Nous decision): approve binds the fingerprint the card showed
     * and freezes the audience; cancel or decline sends it back to draft. Never called by an agent; Nous approves only under "May send" (space_mail_campaign_approve).
     */
    async decide(owner: string, id: string, decision: "approve" | "cancel" | "decline", by: { who: string; via: "RAIL" | "NOUS"; decisionId: string | null; note?: string; fingerprint?: string }) {
      const row = await campaign(owner, id);
      if (row.status !== "IN_REVIEW") throw new SpaceConflictError(`"${row.name}" is ${row.status}, not waiting for a decision.`);
      // The operator approves what they read: only the pane's Approve carries the fingerprint of the mails on their screen.
      if (decision === "approve" && !by.fingerprint) throw new SpaceConflictError(`Read the mails of "${row.name}" in Mail Copilot → Campaigns and approve there.`);
      if (decision === "approve" && by.fingerprint !== row.fingerprint) throw new SpaceConflictError(`"${row.name}" changed since you opened it: read it again before approving.`);
      await deps.notify?.resolve(owner, campaignReviewKey(id));
      if (decision !== "approve") {
        await repository.updateCampaign(owner, id, { status: "DRAFT", fingerprint: null }, ["IN_REVIEW"]);
        await deps.event(owner, "DECLINED", `"${row.name}" declined by the operator${by.note ? `: ${by.note}` : ""}.`, { by: by.who, via: by.via }, id);
        return `Declined "${row.name}": it is a draft again.`;
      }
      const { fingerprint, audience } = await fingerprintOf(owner, row);
      if (fingerprint !== row.fingerprint) {
        await submit(owner, id, true).catch(() => undefined);
        throw new SpaceConflictError(`"${row.name}" changed since it was asked (lists, template or sender); it is asked again with what goes out now.`);
      }
      const approval = { fingerprint, at: deps.now(), by: by.who, via: by.via, decisionId: by.decisionId };
      const updated = await repository.updateCampaign(owner, id, { status: "APPROVED", approval, audience: { eligible: audience.recipients.length, skipped: audience.skipped } }, ["IN_REVIEW"]);
      if (!updated) throw new SpaceConflictError(`"${row.name}" changed state while it was being approved.`);
      const pending = await repository.freezeAudience(owner, id, audience.recipients, deps.now());
      await deps.event(owner, "APPROVED", `"${row.name}" approved by ${by.via === "NOUS" && by.who === "nous" ? "Nous" : "the operator"} for ${pending} recipients${by.note ? `: ${by.note}` : ""}.`, { fingerprint, by: by.who, via: by.via, decisionId: by.decisionId }, id);
      return `Approved "${row.name}": ${pending} recipients, sending in its hours at its pace.`;
    },
    async pause(owner: string, id: string, by: string) {
      const row = await campaign(owner, id);
      if (row.status !== "APPROVED" && row.status !== "SENDING") throw new SpaceConflictError(`"${row.name}" is ${row.status}.`);
      await pause(owner, row, `paused by ${by}`, false);
      return campaign(owner, id);
    },
    /** A person resumes, or Nous and agents while "May send to third parties" covers it (the routes and Nous's tool check it): an auto-pause is a
     * bad signal someone must look at. `by` names who did. */
    async resume(owner: string, id: string, by = "the operator") {
      const row = await campaign(owner, id);
      if (row.status !== "PAUSED" || !row.approval) throw new SpaceConflictError(`"${row.name}" is ${row.status}${row.approval ? "" : " and not approved"}.`);
      await resumeCampaign(owner, row, by);
      return campaign(owner, id);
    },
    async stop(owner: string, id: string, by: string) {
      const row = await campaign(owner, id);
      if (row.status === "DONE" || row.status === "STOPPED") return row;
      if (row.status === "SENDING") throw new SpaceConflictError("Pause the campaign first, then stop it.");
      await repository.updateCampaign(owner, id, { status: "STOPPED" });
      for (const send of await repository.listSends(owner, id, { status: ["PENDING"] })) await repository.updateSend(owner, id, send.contactId, { status: "SKIPPED", skipReason: "campaign stopped" }, ["PENDING"]);
      await deps.notify?.resolve(owner, campaignReviewKey(id));
      await deps.event(owner, "STOPPED", `"${row.name}" stopped by ${by}.`, {}, id);
      return campaign(owner, id);
    },
    /** A campaign's counts only (the Nous Marketing page; results() adds every send). */
    stats: (owner: string, id: string) => repository.campaignStats(owner, id),
    async results(owner: string, id: string) {
      const row = await campaign(owner, id);
      return { campaign: row, stats: await repository.campaignStats(owner, id), recent: await repository.listSends(owner, id, {}) }; // every send (until 1/11 the newest 50)
    },
    /** The sender job's pass (instance job mail-campaign-sender): stale journals, every approved or sending campaign, warm-up. */
    async tick() {
      await repository.markStaleSending(new Date(Date.parse(deps.now()) - STALE_SENDING_MS).toISOString());
      if (!deps.transports) return;
      for (const owner of await repository.ownersWithCampaigns(["PAUSED"])) await resumeAfterOutage(owner);
      for (const owner of await repository.ownersWithCampaigns(["APPROVED", "SENDING"])) {
        for (const row of await repository.listCampaigns(owner, { status: ["APPROVED", "SENDING"] })) await work(owner, row).catch((error) => {
          if (error instanceof Error && DATABASE_UNREACHABLE.test(error.message)) throw error;
          return pause(owner, row, `${JOB_FAILED}${error instanceof Error ? error.message : String(error)}`.slice(0, 400), true);
        });
        await climb(owner);
      }
    }
  };
}
export type CampaignEngine = ReturnType<typeof createCampaignEngine>;
