import { createHash } from "node:crypto";
import { consumerMailDomain, mailAddressDomain, mailTemplateContentSchema, mailTemplateFingerprintInput, mailTemplateVariablesUsed, renderMailTemplate,
  type MailCampaignEvent, type MailCampaignEventType, type MailListCreate, type MailMadeBy, type MailSenderCreate, type MailSenderUpdate, type MailSuppressionInput,
  type MailTemplateContent, type MailTemplateCreate } from "@space/contracts";
import type { MailCampaignsRepository, MailListPatch } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError } from "@space/runtime";
import { contactsFromCsv, contactsFromRows, contactsFromText, type ParsedContacts } from "./import.js";
import { sanitizeTemplateHtml } from "./template-html.js";
import { mailSite } from "./site.js";
import type { MailTransports } from "./transports.js";
import { createCampaignEngine, type CampaignEngineDeps } from "./campaigns.js";
import { readUnsubscribeToken } from "./mime.js";
import { checkContactHealth, createDomainCheck } from "./health.js";
import { systemDns } from "./lab.js";
import { parseCampaignSignal, type CampaignSignal } from "./signals.js";

// Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw): templates, lists, contacts and suppressions for the operator, Nous and every agent.
// Nothing here sends mail; campaigns, the approval gate and the sender job build on it.

export interface MailCampaignsServiceOptions {
  repository: MailCampaignsRepository;
  /** Sender routes (Gmail, Workspace delegation, SMTP); absent in tests that send nothing. */
  transports?: MailTransports;
  now?(): string;
  /** The people a connected Gmail account wrote to in the last days (read only), for a CONTACT list. */
  mailboxCorrespondents?(owner: string, account: string, days: number): Promise<Array<{ name: string; address: string }>>;
  /** A Mail Copilot thread's participants (Gmail, read only), for "add this thread's people to a list". */
  threadParticipants?(owner: string, account: string, threadId: string): Promise<Array<{ name: string; address: string }>>;
  /** The room stream learns that the owner's campaign data changed (ids only). */
  changed?(owner: string, event: MailCampaignEvent): void;
  /** Campaigns: review cards, the Mail Copilot pane they show in, the owner's own seed mailboxes, unsubscribe tokens. */
  campaigns?: Pick<CampaignEngineDeps, "notify" | "mailPane" | "ownMailboxes" | "unsubscribeKey" | "unsubscribeBase" | "dns" | "seedMessage" | "coversApproval">;
}

export type ImportSource = { csv: string; overwrite?: boolean } | { text: string } | { rows: Array<{ address: string; name?: string; attributes?: Record<string, string> }>; overwrite?: boolean }
  | { thread: { account: string; threadId: string } };
export interface ImportResult { received: number; invalid: number; duplicates: number; suppressed: number; added: number; alreadyMembers: number }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A template's content cleaned for sending, with every variable it uses declared. */
export function prepareTemplate(raw: MailTemplateContent): { content: MailTemplateContent; fingerprint: string } {
  const content = mailTemplateContentSchema.parse({ ...raw, html: sanitizeTemplateHtml(raw.html) });
  const declared = new Set(content.variables.map((variable) => variable.name));
  const undeclared = mailTemplateVariablesUsed(content).filter((name) => !declared.has(name));
  if (undeclared.length) throw new SpaceConflictError(`Declare the template's variables: ${undeclared.map((name) => `{{${name}}}`).join(", ")} (variables: [{name, default, required}]).`);
  return { content, fingerprint: sha256(mailTemplateFingerprintInput(content)) };
}

export function createMailCampaignsService(options: MailCampaignsServiceOptions) {
  const { repository } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const receives = createDomainCheck(options.campaigns?.dns ?? systemDns());
  /** Gmail message ids already read per sender (bounded), so a pass reads each message once. */
  const seenGmail = new Map<string, Set<string>>();
  const bouncesRead = new Set<string>();
  /** Every thread a Gmail search finds (every page), each message not in `seen` read once; returns the message ids it saw. */
  async function readMailbox(owner: string, address: string, gmail: NonNullable<Awaited<ReturnType<MailTransports["gmailFor"]>>>, q: string, seen: Set<string>) {
    const window = new Set<string>();
    const ids: string[] = [];
    for (let pageToken: string | null = null, first = true; first || pageToken; first = false) {
      const page: { ids: string[]; nextPageToken: string | null } = await gmail.listThreads({ q, maxResults: 100, ...(pageToken ? { pageToken } : {}) })
        .catch(() => ({ ids: [] as string[], nextPageToken: null }));
      ids.push(...page.ids);
      pageToken = page.nextPageToken;
    }
    for (const threadId of ids) {
      const thread = await gmail.thread(threadId, "metadata").catch(() => null);
      for (const message of (thread?.messages as Array<{ id?: string }> | undefined) ?? []) {
        if (!message.id) continue;
        window.add(message.id);
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const raw = await gmail.message(message.id, "raw").catch(() => null);
        if (typeof raw?.raw === "string") await signals(owner, [Buffer.from(raw.raw, "base64url")], `mailbox ${address}`);
      }
    }
    return window;
  }
  async function applySignal(owner: string, signal: CampaignSignal, source: string) {
    let applied = 0;
    if (signal.kind === "UNSUBSCRIBE" && !signal.messageIds.length) {
      const contact = signal.from ? await repository.getContact(owner, signal.from) : null;
      if (!contact) return 0;
      await repository.updateContactHealth(owner, contact.id, { health: "UNSUBSCRIBED", reasons: ["sent the unsubscribe mail"] });
      await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "UNSUBSCRIBE", source, note: "mailto unsubscribe" }]);
      await event(owner, "HEALTH", `${contact.address} unsubscribed by mail (${source}).`, { contactId: contact.id });
      return 1;
    }
    if ((signal.kind === "HARD_BOUNCE" || signal.kind === "SOFT_BOUNCE") && signal.recipient
      && !(await Promise.all(signal.messageIds.map((id) => repository.findSendByMessageId(owner, id)))).some(Boolean)) return bounceByRecipient(owner, signal, source);
    for (const messageId of signal.messageIds) {
      const send = await repository.findSendByMessageId(owner, messageId);
      const contact = send ? await repository.getContact(owner, send.contactId) : null;
      if (!send || !contact) continue;
      const at = now();
      if (signal.kind === "HARD_BOUNCE") {
        if (contact.health === "BOUNCED" && send.bounce?.kind === "HARD") continue;
        await repository.updateSend(owner, send.campaignId, send.contactId, { bounce: { at, kind: "HARD", code: signal.status } });
        await repository.updateContactHealth(owner, contact.id, { health: "BOUNCED", reasons: [`hard bounce ${signal.status}`] });
        await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "HARD_BOUNCE", source, note: `${signal.status} from ${send.campaignId}` }]);
      } else if (signal.kind === "SOFT_BOUNCE") {
        if (send.bounce) continue;
        await repository.updateSend(owner, send.campaignId, send.contactId, { bounce: { at, kind: "SOFT", code: signal.status } });
        // A second delay (another send) means the mailbox does not take our mail: INVALID; the first one is RISKY with its note.
        const soft = contact.softBounces + 1;
        const sendable = contact.health === "VALID" || contact.health === "UNKNOWN" || contact.health === "RISKY";
        await repository.updateContactHealth(owner, contact.id, { health: sendable ? (soft >= 2 ? "INVALID" : "RISKY") : contact.health,
          reasons: sendable ? [soft >= 2 ? `${soft} delivery delays, last ${signal.status}` : `delivery delayed ${signal.status}`] : contact.healthReasons, softBounces: soft });
      } else if (signal.kind === "COMPLAINT") {
        await repository.updateSend(owner, send.campaignId, send.contactId, { complainedAt: at });
        await repository.updateContactHealth(owner, contact.id, { health: "COMPLAINED", reasons: ["marked our mail as spam"] });
        await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "COMPLAINT", source, note: send.campaignId }]);
      } else if (signal.kind === "UNSUBSCRIBE") {
        await repository.updateSend(owner, send.campaignId, send.contactId, { unsubscribedAt: at, repliedAt: at });
        await repository.updateContactHealth(owner, contact.id, { health: "UNSUBSCRIBED", reasons: ["replied asking to stop"] });
        await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "UNSUBSCRIBE", source, note: `reply to ${send.campaignId}` }]);
      } else {
        await repository.updateSend(owner, send.campaignId, send.contactId, { repliedAt: at });
        await repository.updateContactHealth(owner, contact.id, { health: contact.health === "UNKNOWN" || contact.health === "RISKY" ? "VALID" : contact.health,
          reasons: contact.health === "UNKNOWN" || contact.health === "RISKY" ? ["replied to our mail"] : contact.healthReasons, engagedAt: at });
      }
      applied++;
    }
    if (applied) await event(owner, "HEALTH", `${signal.kind.replace("_", " ").toLowerCase()} for ${applied} send${applied === 1 ? "" : "s"} (${source}).`, { kind: signal.kind });
    return applied;
  }
  /**
   * A bounce that names none of our sends (mail sent outside a campaign, or a DSN that does not quote our Message-ID), applied by its failed
   * recipient, only to an address that is already a contact. Hard: BOUNCED and on the do-not-mail list; a 5.7.x policy rejection: RISKY
   * with its note; a delay counts once by the notice's own id (kept on the contact, so a full mailbox pass after a restart counts nothing
   * again): the first RISKY, the second distinct one INVALID (Nous 6/11, eco-led). Idempotent.
   */
  async function bounceByRecipient(owner: string, signal: Extract<CampaignSignal, { kind: "HARD_BOUNCE" | "SOFT_BOUNCE" }>, source: string) {
    const contact = signal.recipient ? await repository.getContact(owner, signal.recipient) : null;
    if (!contact) return 0;
    // 5.7.x is a policy or integrity rejection of that message (public-host's DSNs of 6/11: 5.7.7), not a mailbox that does not exist: RISKY.
    const policy = /^5\.7\./.test(signal.status);
    if (signal.kind === "HARD_BOUNCE" && !policy) {
      if (contact.health === "BOUNCED") return 0;
      await repository.updateContactHealth(owner, contact.id, { health: "BOUNCED", reasons: [`hard bounce ${signal.status}`] });
      await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "HARD_BOUNCE", source, note: `${signal.status} by recipient` }]);
    } else if (policy) {
      if (contact.health !== "VALID" && contact.health !== "UNKNOWN") return 0;
      await repository.updateContactHealth(owner, contact.id, { health: "RISKY", reasons: [`rejected by policy ${signal.status}`] });
    } else {
      if (contact.health !== "VALID" && contact.health !== "UNKNOWN" && contact.health !== "RISKY") return 0;
      const delays = await repository.addDelayNotice(owner, contact.id, signal.noticeId);
      if (delays === null) return 0;
      await repository.updateContactHealth(owner, contact.id, delays >= 2
        ? { health: "INVALID", reasons: [`${delays} delivery delays, last ${signal.status}`] } : { health: "RISKY", reasons: [`delivery delayed ${signal.status}`] });
    }
    const after = await repository.getContact(owner, contact.id);
    await event(owner, "HEALTH", `${contact.address}: ${signal.kind === "HARD_BOUNCE" && !policy ? `hard bounce ${signal.status}, now BOUNCED and not mailed again` : `${policy ? "rejected by policy" : "delivery delayed"} ${signal.status}, now ${after?.health ?? "RISKY"}`} (${source}).`, { kind: signal.kind, contactId: contact.id });
    return 1;
  }
  async function checkHealth(owner: string, contacts: Awaited<ReturnType<MailCampaignsRepository["contactsDueForCheck"]>>) {
    const changed: Record<string, number> = {};
    for (const contact of contacts) {
      const result = await checkContactHealth(contact, receives);
      await repository.updateContactHealth(owner, contact.id, { health: result.health, reasons: result.reasons.length ? result.reasons : contact.healthReasons });
      if (result.health !== contact.health) changed[result.health] = (changed[result.health] ?? 0) + 1;
    }
    if (Object.keys(changed).length) await event(owner, "HEALTH", `Health checked for ${contacts.length} address${contacts.length === 1 ? "" : "es"}: ${Object.entries(changed).map(([health, count]) => `${count} now ${health}`).join(", ")}.`, { changed });
    return { checked: contacts.length, changed };
  }
  /** Raw messages from a sender's mailbox (bounces, complaints, replies): only those naming our own Message-IDs change anything. */
  async function signals(owner: string, raws: Buffer[], source: string) {
    const outcome = { read: raws.length, ours: 0, applied: 0 };
    for (const raw of raws) {
      const signal = parseCampaignSignal(raw);
      if (!signal) continue;
      outcome.ours++;
      outcome.applied += await applySignal(owner, signal, source);
    }
    return outcome;
  }
  const engine = createCampaignEngine({ repository, transports: options.transports, now, event: (...args) => event(...args), unsubscribeKey: Buffer.alloc(32), unsubscribeBase: null, ...options.campaigns });

  async function event(owner: string, type: MailCampaignEventType, message: string, payload: Record<string, unknown> = {}, campaignId: string | null = null) {
    const row = await repository.addEvent({ ownerUserId: owner, campaignId, type, message: message.slice(0, 2000), payload });
    options.changed?.(owner, row);
    return row;
  }
  async function template(owner: string, id: string) {
    const found = await repository.getTemplate(owner, id);
    if (!found) throw new SpaceNotFoundError(`Mail template ${id} was not found.`);
    return found;
  }
  async function list(owner: string, id: string) {
    const found = await repository.getList(owner, id);
    if (!found) throw new SpaceNotFoundError(`Mail list ${id} was not found.`);
    return found;
  }
  async function templateView(owner: string, id: string, version?: number) {
    const row = await template(owner, id);
    const content = await repository.getTemplateVersion(owner, id, version ?? row.currentVersion);
    if (!content) throw new SpaceNotFoundError(`Version ${version} of mail template ${id} was not found.`);
    const versions = (await repository.listTemplateVersions(owner, id)).map(({ version: number, fingerprint, madeBy, createdAt }) => ({ version: number, fingerprint, madeBy, createdAt }));
    return { template: row, version: content, versions };
  }
  function parse(source: ImportSource): ParsedContacts | null {
    try {
      if ("csv" in source) return contactsFromCsv(source.csv);
      if ("text" in source) return contactsFromText(source.text);
      if ("rows" in source) return contactsFromRows(source.rows);
      return null;
    } catch (error) { throw new SpaceConflictError(error instanceof Error ? error.message : String(error)); }
  }

  const api = {
    ...engine,
    signals,
    /** Check now: a list's members, given contacts, or (default) the owner's 200 checked longest ago (the rest follow on the job's passes). */
    async checkHealth(owner: string, scope: { listId?: string; contactIds?: string[] }) {
      const contacts = scope.listId ? await repository.listContacts(owner, { listId: scope.listId })
        : scope.contactIds ? (await Promise.all(scope.contactIds.map((id) => repository.getContact(owner, id)))).filter((row) => row !== null)
          : await repository.contactsDueForCheck(owner, now(), 200);
      return checkHealth(owner, contacts);
    },
    /** The health job's pass (instance job mail-campaign-health, every 10 minutes): due contacts (30 days), then Gmail senders' mailboxes. */
    async healthTick() {
      const monthAgo = new Date(Date.parse(now()) - 30 * 86_400_000).toISOString();
      for (const owner of await repository.contactOwners()) {
        // Technical: each pass probes at most 300 addresses (DNS and SMTP of other people's servers); the rest are due on the next pass.
        const due = await repository.contactsDueForCheck(owner, monthAgo, 300);
        if (due.length) await checkHealth(owner, due);
        for (const sender of await repository.listSenders(owner)) {
          const gmail = await options.transports?.gmailFor(owner, sender)?.catch(() => null);
          if (!gmail) continue;
          // The first pass of each sender after a start reads every bounce the mailbox ever got (the backfill of 6/11: bounces were
          // matched only by our Message-ID before, so most were never applied); the rest read the 3-day window.
          if (!bouncesRead.has(sender.id)) {
            await readMailbox(owner, sender.address, gmail, "in:anywhere (from:mailer-daemon OR from:postmaster)", new Set());
            bouncesRead.add(sender.id);
          }
          seenGmail.set(sender.id, await readMailbox(owner, sender.address, gmail, "newer_than:3d -in:sent -in:drafts", seenGmail.get(sender.id) ?? new Set()));
        }
      }
    },
    /**
     * Unsubscribe tokens collected by the public one-click endpoint (or read from a List-Unsubscribe click): each valid one suppresses its
     * address everywhere, marks the contact UNSUBSCRIBED and the send. A forged or unknown token does nothing.
     */
    async unsubscribe(tokens: string[], source: string) {
      let done = 0;
      for (const token of tokens) {
        const parsed = readUnsubscribeToken(options.campaigns?.unsubscribeKey ?? Buffer.alloc(32), token);
        const owner = parsed ? await repository.campaignOwner(parsed.campaignId) : null;
        const contact = owner && parsed ? await repository.getContact(owner, parsed.contactId) : null;
        if (!owner || !parsed || !contact) continue;
        // The same click twice (or a page and a mail client's one-click) changes nothing more.
        if (contact.health === "UNSUBSCRIBED" && (await repository.suppressedAmong(owner, [contact.address])).size) { done++; continue; }
        await repository.addSuppressions(owner, [{ pattern: contact.address, reason: "UNSUBSCRIBE", source, note: `campaign ${parsed.campaignId}` }]);
        await repository.updateContactHealth(owner, contact.id, { health: "UNSUBSCRIBED", reasons: [`unsubscribed from ${parsed.campaignId}`] });
        await repository.updateSend(owner, parsed.campaignId, contact.id, { unsubscribedAt: now() });
        await event(owner, "SUPPRESSION", `${contact.address} unsubscribed (${source}).`, { contactId: contact.id }, parsed.campaignId);
        done++;
      }
      return { unsubscribed: done, ignored: tokens.length - done };
    },
    // ---- templates ----------------------------------------------------------------------------------
    async templates(owner: string, includeArchived = false) {
      const rows = await repository.listTemplates(owner, includeArchived);
      return Promise.all(rows.map(async (row) => {
        const version = await repository.getTemplateVersion(owner, row.id, row.currentVersion);
        return { ...row, subject: version?.subject ?? "", fingerprint: version?.fingerprint ?? null };
      }));
    },
    template: templateView,
    async createTemplate(owner: string, input: MailTemplateCreate, madeBy: MailMadeBy, paneId: string | null) {
      const { name, language, ...raw } = input;
      const { content, fingerprint } = prepareTemplate(raw);
      const created = await repository.createTemplate({ ownerUserId: owner, name, language, paneId, content, fingerprint, madeBy });
      await event(owner, "NOTE", `Template "${name}" created (version 1).`, { templateId: created.template.id, fingerprint });
      return created;
    },
    /** A change to what recipients see is a new version (the old ones stay, a campaign keeps the one it names); a rename is not. */
    async updateTemplate(owner: string, id: string, patch: Partial<MailTemplateContent> & { name?: string }, madeBy: MailMadeBy) {
      const row = await template(owner, id);
      const { name, ...given } = patch;
      const contentPatch = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) as Partial<MailTemplateContent>;
      if (name && name !== row.name) await repository.updateTemplate(owner, id, { name });
      const current = (await repository.getTemplateVersion(owner, id, row.currentVersion))!;
      if (!Object.keys(contentPatch).length) return templateView(owner, id);
      const { content, fingerprint } = prepareTemplate({ subject: current.subject, preheader: current.preheader, html: current.html, text: current.text, variables: current.variables, ...contentPatch });
      if (fingerprint === current.fingerprint) return templateView(owner, id);
      const added = (await repository.addTemplateVersion(owner, id, { content, fingerprint, madeBy }))!;
      await event(owner, "NOTE", `Template "${added.template.name}" changed: version ${added.version.version}.`, { templateId: id, version: added.version.version, fingerprint });
      return templateView(owner, id);
    },
    async archiveTemplate(owner: string, id: string, archived: boolean) {
      await template(owner, id);
      return repository.updateTemplate(owner, id, { archivedAt: archived ? new Date().toISOString() : null });
    },
    /** The template with sample values; a variable without one shows as [name]. */
    async previewTemplate(owner: string, id: string, version: number | undefined, values: Record<string, string>) {
      const { version: content } = await templateView(owner, id, version);
      const filled = Object.fromEntries(content.variables.map((variable) => [variable.name, values[variable.name] ?? variable.default ?? `[${variable.name}]`]));
      return { version: content.version, fingerprint: content.fingerprint, ...renderMailTemplate(content, filled) };
    },

    // ---- lists and contacts -------------------------------------------------------------------------
    async lists(owner: string, includeArchived = false) {
      const rows = await repository.listLists(owner, includeArchived);
      return Promise.all(rows.map(async (row) => ({ ...row, health: await repository.listHealth(owner, row.id) })));
    },
    async list(owner: string, id: string) { return { list: await list(owner, id), health: await repository.listHealth(owner, id) }; },
    async createList(owner: string, input: MailListCreate) {
      if ((await repository.listLists(owner, true)).some((row) => row.name.toLowerCase() === input.name.toLowerCase())) throw new SpaceConflictError(`A list named "${input.name}" exists.`);
      const created = await repository.createList({ ownerUserId: owner, ...input });
      await event(owner, "LIST", `List "${created.name}" created (${created.consentBasis}).`, { listId: created.id });
      return created;
    },
    async updateList(owner: string, id: string, patch: MailListPatch) {
      await list(owner, id);
      return repository.updateList(owner, id, patch);
    },
    async contacts(owner: string, filter: Parameters<MailCampaignsRepository["listContacts"]>[1]) {
      if (filter.listId) await list(owner, filter.listId);
      return repository.listContacts(owner, filter);
    },
    async contact(owner: string, idOrAddress: string) {
      const found = await repository.getContact(owner, idOrAddress.trim().toLowerCase().startsWith("mcontact:") ? idOrAddress.trim() : idOrAddress.trim().toLowerCase());
      if (!found) throw new SpaceNotFoundError(`Contact ${idOrAddress} was not found.`);
      const suppressed = (await repository.suppressedAmong(owner, [found.address])).size > 0;
      return { contact: found, suppressed, lastMailedAt: await repository.lastMailedAt(owner, found.id) };
    },
    /** Adds contacts to a list: invalid and suppressed addresses are left out and counted; known contacts keep their health. */
    async importContacts(owner: string, listId: string, source: ImportSource, by: string): Promise<ImportResult> {
      const target = await list(owner, listId);
      let parsed = parse(source);
      if (!parsed && "thread" in source) {
        if (!options.threadParticipants) throw new SpaceConflictError("Thread imports need the Mail Copilot.");
        const own = new Set((await repository.listSenders(owner)).map((sender) => sender.address).concat(source.thread.account.toLowerCase()));
        parsed = contactsFromRows((await options.threadParticipants(owner, source.thread.account, source.thread.threadId)).filter((person) => !own.has(person.address.toLowerCase())));
      }
      const { contacts, invalid, duplicates } = parsed!;
      const suppressedSet = await repository.suppressedAmong(owner, contacts.map((row) => row.address));
      const allowed = contacts.filter((row) => !suppressedSet.has(row.address));
      // overwrite: a corrected import replaces names and fields (merge fields such as a per-shop observation); otherwise known facts win.
      const upserted = await repository.upsertContacts(owner, allowed, "overwrite" in source && source.overwrite === true);
      const added = upserted.length ? await repository.addMembers(owner, listId, upserted.map((row) => row.id), by) : 0;
      const result: ImportResult = { received: contacts.length + invalid + duplicates, invalid, duplicates, suppressed: suppressedSet.size, added, alreadyMembers: upserted.length - added };
      await event(owner, "IMPORT", `Imported into "${target.name}": ${added} added, ${result.alreadyMembers} already there, ${invalid} invalid, ${suppressedSet.size} suppressed.`, { listId, ...result, by });
      return result;
    },
    /** Everyone a connected account wrote to (its sent mail) into a CONTACT list: people we already correspond with. */
    async importMailbox(owner: string, listId: string, input: { account: string; days: number }, by: string): Promise<ImportResult> {
      const target = await list(owner, listId);
      if (target.consentBasis !== "CONTACT") throw new SpaceConflictError(`Correspondents go only into a CONTACT list; "${target.name}" is ${target.consentBasis}.`);
      if (!options.mailboxCorrespondents) throw new SpaceConflictError("Mailbox imports need Google access on this server.");
      const own = new Set([input.account.toLowerCase(), ...(await repository.listSenders(owner)).map((sender) => sender.address)]);
      const people = (await options.mailboxCorrespondents(owner, input.account, input.days)).filter((person) => !own.has(person.address.toLowerCase()));
      return api.importContacts(owner, listId, { rows: people.map((person) => ({ address: person.address, name: person.name })) }, `${by} (sent mail of ${input.account}, ${input.days} days)`);
    },
    async removeMembers(owner: string, listId: string, contactIds: string[]) {
      await list(owner, listId);
      return { removed: await repository.removeMembers(owner, listId, contactIds) };
    },

    // ---- suppressions -------------------------------------------------------------------------------
    suppressions: (owner: string, filter: { q?: string; limit?: number }) => repository.listSuppressions(owner, filter),
    async addSuppressions(owner: string, inputs: MailSuppressionInput[]) {
      const added = await repository.addSuppressions(owner, inputs);
      if (added) await event(owner, "SUPPRESSION", `${added} address${added === 1 ? "" : "es"} or domain${added === 1 ? "" : "s"} suppressed (${[...new Set(inputs.map((input) => input.reason))].join(", ")}).`, { added });
      return { added, alreadySuppressed: inputs.length - added };
    },
    /** Only the operator lifts a suppression (the route checks a person's session). */
    async removeSuppression(owner: string, pattern: string) {
      const removed = await repository.deleteSuppression(owner, pattern);
      if (removed) await event(owner, "SUPPRESSION", `Suppression of ${pattern} lifted by the operator.`, { pattern });
      return { removed };
    },
    events: (owner: string, filter: { campaignId?: string; limit?: number }) => repository.listEvents(owner, filter),

    // ---- senders ------------------------------------------------------------------------------------
    senders: (owner: string) => repository.listSenders(owner),
    /** A sender starts in SETUP; its check (a sign-in or Send-as proof, no mail) makes it ACTIVE. Consumer Gmail is never bulk by default. */
    async createSender(owner: string, input: MailSenderCreate, by: string) {
      const domain = mailAddressDomain(input.address);
      if ((await repository.listSenders(owner)).some((row) => row.address === input.address)) throw new SpaceConflictError(`A sender for ${input.address} exists.`);
      if (input.config.route === "GMAIL_DELEGATED" && mailAddressDomain(input.config.subject) !== domain) throw new SpaceConflictError("A delegated sender sends as a mailbox of its own domain.");
      if (input.config.route === "SMTP" && !mailSite().smtpHosts.has(input.config.host)) throw new SpaceConflictError(`${input.config.host} is not our own mail server; another relay or provider needs the operator's EXTERNAL decision.`);
      const consumer = consumerMailDomain(domain);
      const sender = await repository.createSender({ ownerUserId: owner, address: input.address, displayName: input.displayName, domain, config: input.config, replyTo: input.replyTo,
        footerAddress: input.footerAddress, status: "SETUP", warmup: { stage: 0, since: now() }, caps: input.caps, bulk: !consumer,
        bulkNote: consumer ? "Consumer Gmail: Google caps it near 500 mails a day and the operator's rule of 21/10 keeps bulk mail off @gmail.com; only the operator turns bulk on." : null, createdBy: by });
      await event(owner, "SENDER", `Sender ${sender.address} added (${sender.config.route}); it is used once its check passes.`, { senderId: sender.id });
      return sender;
    },
    /** Proves the route without sending: SMTP signs in, Gmail confirms the Send-as address. Passing makes a SETUP sender ACTIVE. */
    async checkSender(owner: string, id: string) {
      const sender = await repository.getSender(owner, id);
      if (!sender) throw new SpaceNotFoundError(`Sender ${id} was not found.`);
      if (!options.transports) throw new SpaceConflictError("Sending is not available on this server.");
      let detail: string;
      try { detail = await options.transports.for(owner, sender).check(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await event(owner, "SENDER", `Check of ${sender.address} failed: ${message}`.slice(0, 2000), { senderId: id, ok: false });
        throw new SpaceConflictError(`Check of ${sender.address} failed: ${message}`);
      }
      const updated = sender.status === "SETUP" ? await repository.updateSender(owner, id, { status: "ACTIVE" }) : sender;
      await event(owner, "SENDER", `Check of ${sender.address} passed: ${detail}`, { senderId: id, ok: true });
      return { sender: updated!, detail };
    },
    /** Name, reply-to, footer, caps, pause or disable; ACTIVE again only through a passing check. */
    async updateSender(owner: string, id: string, patch: MailSenderUpdate) {
      const sender = await repository.getSender(owner, id);
      if (!sender) throw new SpaceNotFoundError(`Sender ${id} was not found.`);
      if (patch.status === "ACTIVE" && sender.status !== "ACTIVE") throw new SpaceConflictError("Run the sender's check to make it active.");
      const { dkim, ...rest } = patch;
      if (dkim === undefined) return repository.updateSender(owner, id, rest);
      if (sender.config.route !== "SMTP") throw new SpaceConflictError("Space signs only SMTP senders' mail; Gmail signs its own.");
      const { dkim: _old, ...config } = sender.config;
      return repository.updateSender(owner, id, { ...rest, config: dkim ? { ...config, dkim } : config });
    },
    /** An established mailbox may start above the first warm-up stage; `by` is who set it (operator, a pane, Nous). */
    async setSenderWarmup(owner: string, id: string, stage: number, by = "operator") {
      const sender = await repository.updateSender(owner, id, { warmup: { stage, since: now() } });
      if (!sender) throw new SpaceNotFoundError(`Sender ${id} was not found.`);
      await event(owner, "SENDER", `Warm-up of ${sender.address} set to stage ${stage} by ${by}.`, { senderId: id, stage, by });
      return sender;
    },
    /** Bulk on a consumer address, or off for any sender; `by` is who set it. */
    async setSenderBulk(owner: string, id: string, bulk: boolean, by = "operator") {
      const sender = await repository.updateSender(owner, id, { bulk, bulkNote: bulk ? null : `Bulk turned off by ${by}.` });
      if (!sender) throw new SpaceNotFoundError(`Sender ${id} was not found.`);
      await event(owner, "SENDER", `Bulk ${bulk ? "allowed" : "turned off"} for ${sender.address} by ${by}.`, { senderId: id, bulk, by });
      return sender;
    }
  };
  return api;
}
export type MailCampaignsService = ReturnType<typeof createMailCampaignsService>;
