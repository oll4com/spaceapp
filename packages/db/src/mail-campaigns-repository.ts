import { randomBytes } from "node:crypto";
import { healthSendable, mailAddressDomain, mailSuppressed, type MailCampaign, type MailCampaignCheck, type MailCampaignEvent, type MailCampaignSend,
  type MailCampaignStats, type MailCampaignStatus, type MailContact, type MailContactHealthPatch, type MailContactInput, type MailHealth, type MailList,
  type MailListHealth, type MailSender, type MailSuppression, type MailSuppressionInput, type MailTemplate, type MailTemplateContent,
  type MailTemplateVersion, type MailMadeBy } from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import { rollbackKeepingError } from "./rollback.js";

// Mail Campaigns storage (migration 0265, plan clipboard:IJ2ovfLg1Lbw): senders, versioned templates, lists, one contact per owner and
// address with its health, global suppressions, campaigns, the per-recipient send log (its primary key is "never twice per campaign"),
// deliverability checks and the activity feed. Postgres live, in-memory for tests; both answer the same.

const newId = (prefix: string) => `${prefix}:${randomBytes(9).toString("base64url")}`;
const copy = <T>(row: T): T => structuredClone(row);
const defined = <T extends object>(patch: T) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;

export type MailSenderCreateRecord = Omit<MailSender, "id" | "createdAt" | "updatedAt">;
export type MailSenderPatch = Partial<Pick<MailSender, "displayName" | "replyTo" | "footerAddress" | "status" | "warmup" | "caps" | "bulk" | "bulkNote" | "config">>;
export type MailTemplateCreateRecord = Pick<MailTemplate, "ownerUserId" | "name" | "language" | "paneId"> & { content: MailTemplateContent; fingerprint: string; madeBy: MailMadeBy };
export type MailListCreateRecord = Omit<MailList, "id" | "archivedAt" | "createdAt" | "updatedAt">;
export type MailListPatch = Partial<Pick<MailList, "name" | "description" | "consentBasis" | "archivedAt">>;
export interface MailContactFilter { listId?: string; health?: MailHealth[]; q?: string; limit?: number; offset?: number }
export type MailCampaignCreateRecord = Omit<MailCampaign, "id" | "status" | "fingerprint" | "approval" | "audience" | "pauseReason" | "createdAt" | "updatedAt">;
export type MailCampaignPatch = Partial<Pick<MailCampaign, "name" | "goal" | "templateId" | "templateVersion" | "senderId" | "listIds" | "schedule" | "pacing"
  | "status" | "fingerprint" | "approval" | "audience" | "testSeeds" | "pauseReason">>;
export type MailSendPatch = Partial<Pick<MailCampaignSend, "status" | "skipReason" | "messageId" | "providerId" | "attempts" | "nextAttemptAt" | "sentAt" | "error"
  | "bounce" | "complainedAt" | "repliedAt" | "unsubscribedAt">>;
export type MailCheckCreateRecord = Omit<MailCampaignCheck, "id" | "createdAt">;
export type MailEventCreateRecord = Omit<MailCampaignEvent, "id" | "createdAt">;
/** Who a campaign would reach now: sendable contacts, and how many members are left out and why. */
export interface MailAudience { recipients: Array<{ contactId: string; address: string; priority: number }>; skipped: Record<string, number> }
/** A recipient frozen into the send log: its priority and the hash of the mail approved for it. */
export type MailFrozenRecipient = Omit<MailAudience["recipients"][number], "priority"> & { priority?: number; renderHash?: string | null };

export interface MailCampaignsRepository {
  createSender(input: MailSenderCreateRecord): Promise<MailSender>;
  getSender(owner: string, id: string): Promise<MailSender | null>;
  listSenders(owner: string): Promise<MailSender[]>;
  updateSender(owner: string, id: string, patch: MailSenderPatch): Promise<MailSender | null>;

  /** A template and its version 1. */
  createTemplate(input: MailTemplateCreateRecord): Promise<{ template: MailTemplate; version: MailTemplateVersion }>;
  /** A new immutable version (current + 1), which becomes current. */
  addTemplateVersion(owner: string, id: string, input: { content: MailTemplateContent; fingerprint: string; madeBy: MailMadeBy }): Promise<{ template: MailTemplate; version: MailTemplateVersion } | null>;
  getTemplate(owner: string, id: string): Promise<MailTemplate | null>;
  getTemplateVersion(owner: string, id: string, version: number): Promise<MailTemplateVersion | null>;
  /** Newest first; archived ones only when asked. */
  listTemplates(owner: string, includeArchived?: boolean): Promise<MailTemplate[]>;
  /** Newest first. */
  listTemplateVersions(owner: string, id: string): Promise<MailTemplateVersion[]>;
  updateTemplate(owner: string, id: string, patch: Partial<Pick<MailTemplate, "name" | "archivedAt">>): Promise<MailTemplate | null>;

  createList(input: MailListCreateRecord): Promise<MailList>;
  getList(owner: string, id: string): Promise<MailList | null>;
  listLists(owner: string, includeArchived?: boolean): Promise<MailList[]>;
  updateList(owner: string, id: string, patch: MailListPatch): Promise<MailList | null>;

  /**
   * One contact per owner and address: new addresses are added (health UNKNOWN), known ones keep their health and gain a name or attributes
   * they lacked; with `overwrite` the given name and attributes replace the known ones (a corrected import).
   */
  upsertContacts(owner: string, inputs: MailContactInput[], overwrite?: boolean): Promise<MailContact[]>;
  getContact(owner: string, idOrAddress: string): Promise<MailContact | null>;
  /** Several contacts by id (any order; unknown ids left out). */
  getContacts(owner: string, ids: string[]): Promise<MailContact[]>;
  /** Address order. */
  listContacts(owner: string, filter: MailContactFilter): Promise<MailContact[]>;
  updateContactHealth(owner: string, id: string, patch: MailContactHealthPatch, at?: string): Promise<MailContact | null>;
  /** Counts a delay notice (by its own id) once: the contact's new soft bounce count, or null when that notice was counted before. */
  addDelayNotice(owner: string, id: string, noticeId: string): Promise<number | null>;
  /** Every owner with contacts (the health job's round). */
  contactOwners(): Promise<string[]>;
  /** Contacts whose health was never checked or not since `before`, oldest first. */
  contactsDueForCheck(owner: string, before: string, limit: number): Promise<MailContact[]>;

  /** Adds contacts to a list; answers how many were new members. */
  addMembers(owner: string, listId: string, contactIds: string[], source: string): Promise<number>;
  removeMembers(owner: string, listId: string, contactIds: string[]): Promise<number>;
  listHealth(owner: string, listId: string): Promise<MailListHealth>;

  /** Keeps the first record of a pattern; answers how many were new. */
  addSuppressions(owner: string, inputs: MailSuppressionInput[]): Promise<number>;
  /** Newest first. */
  listSuppressions(owner: string, filter: { q?: string; limit?: number }): Promise<MailSuppression[]>;
  /** The operator's explicit removal of one suppression. */
  deleteSuppression(owner: string, pattern: string): Promise<boolean>;
  /** Which of these normalized addresses a suppression covers (the address itself or its @domain). */
  suppressedAmong(owner: string, addresses: string[]): Promise<Set<string>>;

  createCampaign(input: MailCampaignCreateRecord): Promise<MailCampaign>;
  getCampaign(owner: string, id: string): Promise<MailCampaign | null>;
  /** Newest first. */
  listCampaigns(owner: string, filter: { status?: MailCampaignStatus[]; limit?: number }): Promise<MailCampaign[]>;
  /** With `fromStatus` only while the campaign is in one of those states (an atomic transition), else null. */
  updateCampaign(owner: string, id: string, patch: MailCampaignPatch, fromStatus?: MailCampaignStatus[]): Promise<MailCampaign | null>;
  /** Whose campaign this is (an unsubscribe token names only the campaign). */
  campaignOwner(id: string): Promise<string | null>;
  /** Every owner with a campaign in these states (the sender job's round). */
  ownersWithCampaigns(status: MailCampaignStatus[]): Promise<string[]>;

  /** The distinct members of the lists, without suppressed or unsendable addresses. */
  audience(owner: string, listIds: string[]): Promise<MailAudience>;
  /**
   * Freezes an approved audience: a PENDING row per recipient not yet in the log (rows already there keep their state), and every
   * PENDING row of someone no longer in it becomes SKIPPED. Answers the number of PENDING rows after it.
   */
  freezeAudience(owner: string, campaignId: string, recipients: MailFrozenRecipient[], at?: string): Promise<number>;
  /** Atomically moves the next due PENDING row to SENDING (the journal written before a send), or null. */
  takeNextSend(owner: string, campaignId: string, at?: string): Promise<MailCampaignSend | null>;
  updateSend(owner: string, campaignId: string, contactId: string, patch: MailSendPatch, fromStatus?: MailCampaignSend["status"][]): Promise<MailCampaignSend | null>;
  /** SENDING rows untouched since `before` (a send whose answer was lost): UNKNOWN, never retried. Answers how many. */
  markStaleSending(before: string): Promise<number>;
  findSendByMessageId(owner: string, messageId: string): Promise<MailCampaignSend | null>;
  listSends(owner: string, campaignId: string, filter: { status?: MailCampaignSend["status"][]; limit?: number }): Promise<MailCampaignSend[]>;
  campaignStats(owner: string, campaignId: string): Promise<MailCampaignStats>;
  /** Mail a sender sent since a time, across campaigns (its daily cap). */
  sentBySenderSince(owner: string, senderId: string, since: string): Promise<number>;
  /** Mail a campaign sent since a time (its daily pacing). */
  sentByCampaignSince(owner: string, campaignId: string, since: string): Promise<number>;
  /** When any campaign last mailed this contact. */
  lastMailedAt(owner: string, contactId: string): Promise<string | null>;

  addCheck(input: MailCheckCreateRecord): Promise<MailCampaignCheck>;
  /** Newest first. */
  listChecks(owner: string, filter: { campaignId?: string; senderId?: string; limit?: number }): Promise<MailCampaignCheck[]>;
  addEvent(input: MailEventCreateRecord): Promise<MailCampaignEvent>;
  /** Newest first. */
  listEvents(owner: string, filter: { campaignId?: string; limit?: number }): Promise<MailCampaignEvent[]>;
  dispose(): Promise<void>;
}

const emptyStats = (): MailCampaignStats => ({ byStatus: {}, bounced: { hard: 0, soft: 0 }, complained: 0, replied: 0, unsubscribed: 0 });
/** Members classified the same way in both stores. */
function classify(members: Array<{ id: string; address: string; health: MailHealth; suppressed: boolean; priority?: number }>): MailAudience {
  const skipped: Record<string, number> = {};
  const recipients: MailAudience["recipients"] = [];
  for (const member of members) {
    const reason = member.suppressed ? "suppressed" : healthSendable(member.health) ? null : `health:${member.health}`;
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
    else recipients.push({ contactId: member.id, address: member.address, priority: member.priority ?? 0 });
  }
  recipients.sort((left, right) => left.priority - right.priority || left.address.localeCompare(right.address));
  return { recipients, skipped };
}
const blankSend = (owner: string, campaignId: string, recipient: MailFrozenRecipient, at: string): MailCampaignSend => ({
  campaignId, contactId: recipient.contactId, ownerUserId: owner, address: recipient.address, status: "PENDING", skipReason: null, messageId: null, providerId: null,
  attempts: 0, priority: recipient.priority ?? 0, renderHash: recipient.renderHash ?? null, nextAttemptAt: null, sentAt: null, error: null, bounce: null, complainedAt: null, repliedAt: null, unsubscribedAt: null, updatedAt: at });

export class InMemoryMailCampaignsRepository implements MailCampaignsRepository {
  private senders = new Map<string, MailSender>();
  private templates = new Map<string, MailTemplate>();
  private versions: MailTemplateVersion[] = [];
  private lists = new Map<string, MailList>();
  private contacts = new Map<string, MailContact>();
  private members = new Map<string, { listId: string; contactId: string; ownerUserId: string; source: string; addedAt: string }>();
  private suppressions = new Map<string, MailSuppression>();
  private campaigns = new Map<string, MailCampaign>();
  private sends = new Map<string, MailCampaignSend>();
  private checks: MailCampaignCheck[] = [];
  private events: MailCampaignEvent[] = [];
  private delayNotices = new Set<string>();
  constructor(private now: () => string = () => new Date().toISOString()) {}
  private owned<T extends { ownerUserId: string }>(map: Map<string, T>, owner: string, id: string): T | null { const row = map.get(id); return row && row.ownerUserId === owner ? row : null; }

  async createSender(input: MailSenderCreateRecord) {
    if ([...this.senders.values()].some((row) => row.ownerUserId === input.ownerUserId && row.address === input.address)) throw new Error(`A sender for ${input.address} exists.`);
    const at = this.now(); const row: MailSender = { ...copy(input), id: newId("msender"), createdAt: at, updatedAt: at };
    this.senders.set(row.id, row); return copy(row);
  }
  async getSender(owner: string, id: string) { const row = this.owned(this.senders, owner, id); return row ? copy(row) : null; }
  async listSenders(owner: string) { return [...this.senders.values()].filter((row) => row.ownerUserId === owner).sort((a, b) => a.address.localeCompare(b.address)).map(copy); }
  async updateSender(owner: string, id: string, patch: MailSenderPatch) {
    const row = this.owned(this.senders, owner, id); if (!row) return null;
    const next = { ...row, ...defined(copy(patch)), updatedAt: this.now() }; this.senders.set(id, next); return copy(next);
  }

  async createTemplate(input: MailTemplateCreateRecord) {
    const at = this.now();
    const template: MailTemplate = { id: newId("mtpl"), ownerUserId: input.ownerUserId, name: input.name, language: input.language, currentVersion: 1, paneId: input.paneId, archivedAt: null, createdAt: at, updatedAt: at };
    const version: MailTemplateVersion = { ...copy(input.content), templateId: template.id, version: 1, fingerprint: input.fingerprint, madeBy: copy(input.madeBy), createdAt: at };
    this.templates.set(template.id, template); this.versions.push(version);
    return { template: copy(template), version: copy(version) };
  }
  async addTemplateVersion(owner: string, id: string, input: { content: MailTemplateContent; fingerprint: string; madeBy: MailMadeBy }) {
    const row = this.owned(this.templates, owner, id); if (!row) return null;
    const at = this.now(); const template = { ...row, currentVersion: row.currentVersion + 1, updatedAt: at };
    const version: MailTemplateVersion = { ...copy(input.content), templateId: id, version: template.currentVersion, fingerprint: input.fingerprint, madeBy: copy(input.madeBy), createdAt: at };
    this.templates.set(id, template); this.versions.push(version);
    return { template: copy(template), version: copy(version) };
  }
  async getTemplate(owner: string, id: string) { const row = this.owned(this.templates, owner, id); return row ? copy(row) : null; }
  async getTemplateVersion(owner: string, id: string, version: number) {
    if (!this.owned(this.templates, owner, id)) return null;
    const row = this.versions.find((entry) => entry.templateId === id && entry.version === version); return row ? copy(row) : null;
  }
  async listTemplates(owner: string, includeArchived = false) {
    return [...this.templates.values()].filter((row) => row.ownerUserId === owner && (includeArchived || !row.archivedAt))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).map(copy);
  }
  async listTemplateVersions(owner: string, id: string) {
    if (!this.owned(this.templates, owner, id)) return [];
    return this.versions.filter((row) => row.templateId === id).sort((a, b) => b.version - a.version).map(copy);
  }
  async updateTemplate(owner: string, id: string, patch: Partial<Pick<MailTemplate, "name" | "archivedAt">>) {
    const row = this.owned(this.templates, owner, id); if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() }; this.templates.set(id, next); return copy(next);
  }

  async createList(input: MailListCreateRecord) {
    if ([...this.lists.values()].some((row) => row.ownerUserId === input.ownerUserId && row.name.toLowerCase() === input.name.toLowerCase())) throw new Error(`A list named ${input.name} exists.`);
    const at = this.now(); const row: MailList = { ...copy(input), id: newId("mlist"), archivedAt: null, createdAt: at, updatedAt: at };
    this.lists.set(row.id, row); return copy(row);
  }
  async getList(owner: string, id: string) { const row = this.owned(this.lists, owner, id); return row ? copy(row) : null; }
  async listLists(owner: string, includeArchived = false) {
    return [...this.lists.values()].filter((row) => row.ownerUserId === owner && (includeArchived || !row.archivedAt)).sort((a, b) => a.name.localeCompare(b.name)).map(copy);
  }
  async updateList(owner: string, id: string, patch: MailListPatch) {
    const row = this.owned(this.lists, owner, id); if (!row) return null;
    const next = { ...row, ...defined(patch), updatedAt: this.now() }; this.lists.set(id, next); return copy(next);
  }

  private byAddress(owner: string, address: string) { return [...this.contacts.values()].find((row) => row.ownerUserId === owner && row.address === address) ?? null; }
  async upsertContacts(owner: string, inputs: MailContactInput[], overwrite = false) {
    const at = this.now();
    return inputs.map((input) => {
      const known = this.byAddress(owner, input.address);
      const row: MailContact = known
        ? overwrite ? { ...known, name: input.name || known.name, attributes: { ...known.attributes, ...input.attributes }, updatedAt: at }
          : { ...known, name: known.name || input.name, attributes: { ...input.attributes, ...known.attributes }, updatedAt: at }
        : { id: newId("mcontact"), ownerUserId: owner, address: input.address, domain: mailAddressDomain(input.address), name: input.name, attributes: copy(input.attributes),
          health: "UNKNOWN", healthReasons: [], healthCheckedAt: null, softBounces: 0, lastEngagedAt: null, createdAt: at, updatedAt: at };
      this.contacts.set(row.id, row); return copy(row);
    });
  }
  async getContact(owner: string, idOrAddress: string) { const row = this.owned(this.contacts, owner, idOrAddress) ?? this.byAddress(owner, idOrAddress); return row ? copy(row) : null; }
  async getContacts(owner: string, ids: string[]) { return ids.map((id) => this.owned(this.contacts, owner, id)).filter((row): row is MailContact => row !== null).map(copy); }
  async listContacts(owner: string, filter: MailContactFilter) {
    const inList = filter.listId ? new Set([...this.members.values()].filter((m) => m.listId === filter.listId && m.ownerUserId === owner).map((m) => m.contactId)) : null;
    const q = filter.q?.toLowerCase();
    return [...this.contacts.values()].filter((row) => row.ownerUserId === owner && (!inList || inList.has(row.id)) && (!filter.health?.length || filter.health.includes(row.health))
      && (!q || row.address.includes(q) || row.name.toLowerCase().includes(q)))
      .sort((a, b) => a.address.localeCompare(b.address)).slice(filter.offset ?? 0, filter.limit === undefined ? undefined : (filter.offset ?? 0) + filter.limit).map(copy);
  }
  async updateContactHealth(owner: string, id: string, patch: MailContactHealthPatch, at = this.now()) {
    const row = this.owned(this.contacts, owner, id); if (!row) return null;
    const next: MailContact = { ...row, health: patch.health, healthReasons: [...patch.reasons], healthCheckedAt: at, softBounces: patch.softBounces ?? row.softBounces,
      lastEngagedAt: patch.engagedAt ?? row.lastEngagedAt, updatedAt: at };
    this.contacts.set(id, next); return copy(next);
  }
  async addDelayNotice(owner: string, id: string, noticeId: string) {
    const row = this.owned(this.contacts, owner, id); const key = `${id}\n${noticeId}`;
    if (!row || this.delayNotices.has(key)) return null;
    this.delayNotices.add(key); this.contacts.set(id, { ...row, softBounces: row.softBounces + 1, updatedAt: this.now() }); return row.softBounces + 1;
  }
  async contactOwners() { return [...new Set([...this.contacts.values()].map((row) => row.ownerUserId))].sort(); }
  async contactsDueForCheck(owner: string, before: string, limit: number) {
    return [...this.contacts.values()].filter((row) => row.ownerUserId === owner && (!row.healthCheckedAt || row.healthCheckedAt < before))
      .sort((a, b) => (a.healthCheckedAt ?? "").localeCompare(b.healthCheckedAt ?? "") || a.id.localeCompare(b.id)).slice(0, limit).map(copy);
  }

  async addMembers(owner: string, listId: string, contactIds: string[], source: string) {
    if (!this.owned(this.lists, owner, listId)) throw new Error("No such list.");
    let added = 0;
    for (const contactId of new Set(contactIds)) {
      const key = `${listId}|${contactId}`;
      if (!this.owned(this.contacts, owner, contactId) || this.members.has(key)) continue;
      this.members.set(key, { listId, contactId, ownerUserId: owner, source, addedAt: this.now() }); added++;
    }
    return added;
  }
  async removeMembers(owner: string, listId: string, contactIds: string[]) {
    let removed = 0;
    for (const contactId of new Set(contactIds)) if (this.members.get(`${listId}|${contactId}`)?.ownerUserId === owner && this.members.delete(`${listId}|${contactId}`)) removed++;
    return removed;
  }
  private memberRows(owner: string, listIds: string[]) {
    const priority = new Map<string, number>();
    for (const member of this.members.values()) {
      if (member.ownerUserId !== owner || !listIds.includes(member.listId)) continue;
      priority.set(member.contactId, Math.min(priority.get(member.contactId) ?? Infinity, listIds.indexOf(member.listId)));
    }
    const patterns = new Set([...this.suppressions.values()].filter((s) => s.ownerUserId === owner).map((s) => s.pattern));
    return [...priority].map(([id, rank]) => ({ row: this.contacts.get(id)!, rank }))
      .map(({ row, rank }) => ({ id: row.id, address: row.address, health: row.health, suppressed: mailSuppressed(patterns, row.address), priority: rank }));
  }
  async listHealth(owner: string, listId: string): Promise<MailListHealth> {
    const rows = this.memberRows(owner, [listId]);
    const byHealth: Partial<Record<MailHealth, number>> = {};
    for (const row of rows) byHealth[row.health] = (byHealth[row.health] ?? 0) + 1;
    return { listId, members: rows.length, byHealth, suppressed: rows.filter((row) => row.suppressed).length, sendable: classify(rows).recipients.length };
  }

  async addSuppressions(owner: string, inputs: MailSuppressionInput[]) {
    let added = 0;
    for (const input of inputs) {
      const key = `${owner}|${input.pattern}`;
      if (this.suppressions.has(key)) continue;
      this.suppressions.set(key, { ownerUserId: owner, pattern: input.pattern, reason: input.reason, source: input.source, note: input.note, createdAt: this.now() }); added++;
    }
    return added;
  }
  async listSuppressions(owner: string, filter: { q?: string; limit?: number }) {
    const q = filter.q?.toLowerCase();
    return [...this.suppressions.values()].filter((row) => row.ownerUserId === owner && (!q || row.pattern.includes(q)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.pattern.localeCompare(b.pattern)).slice(0, filter.limit ?? undefined).map(copy);
  }
  async deleteSuppression(owner: string, pattern: string) { return this.suppressions.delete(`${owner}|${pattern}`); }
  async suppressedAmong(owner: string, addresses: string[]) {
    const patterns = new Set([...this.suppressions.values()].filter((s) => s.ownerUserId === owner).map((s) => s.pattern));
    return new Set(addresses.filter((address) => mailSuppressed(patterns, address)));
  }

  async createCampaign(input: MailCampaignCreateRecord) {
    const at = this.now();
    const row: MailCampaign = { ...copy(input), id: newId("mcamp"), status: "DRAFT", fingerprint: null, approval: null, audience: null, pauseReason: null, createdAt: at, updatedAt: at };
    this.campaigns.set(row.id, row); return copy(row);
  }
  async getCampaign(owner: string, id: string) { const row = this.owned(this.campaigns, owner, id); return row ? copy(row) : null; }
  async listCampaigns(owner: string, filter: { status?: MailCampaignStatus[]; limit?: number }) {
    return [...this.campaigns.values()].filter((row) => row.ownerUserId === owner && (!filter.status?.length || filter.status.includes(row.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, filter.limit ?? undefined).map(copy);
  }
  async updateCampaign(owner: string, id: string, patch: MailCampaignPatch, fromStatus?: MailCampaignStatus[]) {
    const row = this.owned(this.campaigns, owner, id);
    if (!row || (fromStatus && !fromStatus.includes(row.status))) return null;
    const next = { ...row, ...defined(copy(patch)), updatedAt: this.now() }; this.campaigns.set(id, next); return copy(next);
  }
  async campaignOwner(id: string) { return this.campaigns.get(id)?.ownerUserId ?? null; }
  async ownersWithCampaigns(status: MailCampaignStatus[]) { return [...new Set([...this.campaigns.values()].filter((row) => status.includes(row.status)).map((row) => row.ownerUserId))].sort(); }

  async audience(owner: string, listIds: string[]) { return classify(this.memberRows(owner, listIds)); }
  async freezeAudience(owner: string, campaignId: string, recipients: MailFrozenRecipient[], at = this.now()) {
    const keep = new Set(recipients.map((recipient) => recipient.contactId));
    for (const recipient of recipients) {
      const key = `${campaignId}|${recipient.contactId}`;
      const known = this.sends.get(key);
      if (!known) this.sends.set(key, blankSend(owner, campaignId, recipient, at));
      else if (known.status === "PENDING") Object.assign(known, { priority: recipient.priority ?? 0, renderHash: recipient.renderHash ?? null, updatedAt: at });
    }
    for (const row of this.sends.values()) {
      if (row.campaignId === campaignId && row.status === "PENDING" && !keep.has(row.contactId)) Object.assign(row, { status: "SKIPPED", skipReason: "left the audience", updatedAt: at });
    }
    return [...this.sends.values()].filter((row) => row.campaignId === campaignId && row.status === "PENDING").length;
  }
  async takeNextSend(owner: string, campaignId: string, at = this.now()) {
    const row = [...this.sends.values()].filter((entry) => entry.ownerUserId === owner && entry.campaignId === campaignId && entry.status === "PENDING" && (!entry.nextAttemptAt || entry.nextAttemptAt <= at))
      .sort((a, b) => (a.nextAttemptAt ?? "").localeCompare(b.nextAttemptAt ?? "") || a.priority - b.priority || a.address.localeCompare(b.address))[0];
    if (!row) return null;
    Object.assign(row, { status: "SENDING", updatedAt: at });
    return copy(row);
  }
  async updateSend(owner: string, campaignId: string, contactId: string, patch: MailSendPatch, fromStatus?: MailCampaignSend["status"][]) {
    const row = this.sends.get(`${campaignId}|${contactId}`);
    if (!row || row.ownerUserId !== owner || (fromStatus && !fromStatus.includes(row.status))) return null;
    Object.assign(row, defined(copy(patch)), { updatedAt: this.now() }); return copy(row);
  }
  async markStaleSending(before: string) {
    let marked = 0;
    for (const row of this.sends.values()) if (row.status === "SENDING" && row.updatedAt < before) { Object.assign(row, { status: "UNKNOWN", error: "The send's answer was lost; never retried.", updatedAt: this.now() }); marked++; }
    return marked;
  }
  async findSendByMessageId(owner: string, messageId: string) { const row = [...this.sends.values()].find((entry) => entry.ownerUserId === owner && entry.messageId === messageId); return row ? copy(row) : null; }
  async listSends(owner: string, campaignId: string, filter: { status?: MailCampaignSend["status"][]; limit?: number }) {
    return [...this.sends.values()].filter((row) => row.ownerUserId === owner && row.campaignId === campaignId && (!filter.status?.length || filter.status.includes(row.status)))
      .sort((a, b) => a.address.localeCompare(b.address)).slice(0, filter.limit ?? undefined).map(copy);
  }
  async campaignStats(owner: string, campaignId: string) {
    const stats = emptyStats();
    for (const row of this.sends.values()) {
      if (row.ownerUserId !== owner || row.campaignId !== campaignId) continue;
      stats.byStatus[row.status] = (stats.byStatus[row.status] ?? 0) + 1;
      if (row.bounce) stats.bounced[row.bounce.kind === "HARD" ? "hard" : "soft"]++;
      if (row.complainedAt) stats.complained++;
      if (row.repliedAt) stats.replied++;
      if (row.unsubscribedAt) stats.unsubscribed++;
    }
    return stats;
  }
  async sentBySenderSince(owner: string, senderId: string, since: string) {
    const campaigns = new Set([...this.campaigns.values()].filter((row) => row.ownerUserId === owner && row.senderId === senderId).map((row) => row.id));
    return [...this.sends.values()].filter((row) => campaigns.has(row.campaignId) && (row.status === "SENT" || row.status === "SENDING" || row.status === "UNKNOWN") && (row.sentAt ?? row.updatedAt) >= since).length;
  }
  async sentByCampaignSince(owner: string, campaignId: string, since: string) {
    return [...this.sends.values()].filter((row) => row.ownerUserId === owner && row.campaignId === campaignId && (row.status === "SENT" || row.status === "SENDING" || row.status === "UNKNOWN")
      && (row.sentAt ?? row.updatedAt) >= since).length;
  }
  async lastMailedAt(owner: string, contactId: string) {
    return [...this.sends.values()].filter((row) => row.ownerUserId === owner && row.contactId === contactId && row.sentAt).map((row) => row.sentAt!).sort().at(-1) ?? null;
  }

  async addCheck(input: MailCheckCreateRecord) { const row: MailCampaignCheck = { ...copy(input), id: newId("mcheck"), createdAt: this.now() }; this.checks.push(row); return copy(row); }
  async listChecks(owner: string, filter: { campaignId?: string; senderId?: string; limit?: number }) {
    return this.checks.filter((row) => row.ownerUserId === owner && (!filter.campaignId || row.campaignId === filter.campaignId) && (!filter.senderId || row.senderId === filter.senderId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, filter.limit ?? undefined).map(copy);
  }
  async addEvent(input: MailEventCreateRecord) { const row: MailCampaignEvent = { ...copy(input), id: newId("mcevt"), createdAt: this.now() }; this.events.push(row); return copy(row); }
  async listEvents(owner: string, filter: { campaignId?: string; limit?: number }) {
    return this.events.filter((row) => row.ownerUserId === owner && (!filter.campaignId || row.campaignId === filter.campaignId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, filter.limit ?? undefined).map(copy);
  }
  async dispose() {}
}

// ---- PostgreSQL -----------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string).toISOString();
const isoNow = (value: unknown) => iso(value)!;
const senderOf = (row: Row): MailSender => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, address: row.address as string, displayName: row.display_name as string,
  domain: row.domain as string, config: row.config as MailSender["config"], replyTo: (row.reply_to as string | null) ?? null, footerAddress: row.footer_address as string,
  status: row.status as MailSender["status"], warmup: row.warmup as MailSender["warmup"], caps: row.caps as MailSender["caps"], bulk: row.bulk as boolean,
  bulkNote: (row.bulk_note as string | null) ?? null, createdBy: row.created_by as string, createdAt: isoNow(row.created_at), updatedAt: isoNow(row.updated_at) });
const templateOf = (row: Row): MailTemplate => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, name: row.name as string, language: row.language as MailTemplate["language"],
  currentVersion: row.current_version as number, paneId: (row.pane_id as string | null) ?? null, archivedAt: iso(row.archived_at), createdAt: isoNow(row.created_at), updatedAt: isoNow(row.updated_at) });
const versionOf = (row: Row): MailTemplateVersion => ({ templateId: row.template_id as string, version: row.version as number, subject: row.subject as string, preheader: row.preheader as string,
  html: row.html as string, text: row.body_text as string, variables: row.variables as MailTemplateVersion["variables"], fingerprint: row.fingerprint as string,
  madeBy: row.made_by as MailMadeBy, createdAt: isoNow(row.created_at) });
const listOf = (row: Row): MailList => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, name: row.name as string, description: row.description as string,
  source: row.source as MailList["source"], consentBasis: row.consent_basis as MailList["consentBasis"], archivedAt: iso(row.archived_at), createdAt: isoNow(row.created_at), updatedAt: isoNow(row.updated_at) });
const contactOf = (row: Row): MailContact => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, address: row.address as string, domain: row.domain as string, name: row.name as string,
  attributes: row.attributes as Record<string, string>, health: row.health as MailHealth, healthReasons: row.health_reasons as string[], healthCheckedAt: iso(row.health_checked_at),
  softBounces: row.soft_bounces as number, lastEngagedAt: iso(row.last_engaged_at), createdAt: isoNow(row.created_at), updatedAt: isoNow(row.updated_at) });
const suppressionOf = (row: Row): MailSuppression => ({ ownerUserId: row.owner_user_id as string, pattern: row.pattern as string, reason: row.reason as MailSuppression["reason"],
  source: row.source as string, note: row.note as string, createdAt: isoNow(row.created_at) });
const campaignOf = (row: Row): MailCampaign => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, paneId: (row.pane_id as string | null) ?? null, name: row.name as string,
  goal: row.goal as string, templateId: row.template_id as string, templateVersion: row.template_version as number, senderId: row.sender_id as string, listIds: row.list_ids as string[],
  schedule: row.schedule as MailCampaign["schedule"], pacing: row.pacing as MailCampaign["pacing"], status: row.status as MailCampaignStatus, fingerprint: (row.fingerprint as string | null) ?? null,
  approval: (row.approval as MailCampaign["approval"]) ?? null, audience: (row.audience as MailCampaign["audience"]) ?? null, testSeeds: row.test_seeds as string[],
  pauseReason: (row.pause_reason as string | null) ?? null, createdBy: row.created_by as string, createdAt: isoNow(row.created_at), updatedAt: isoNow(row.updated_at) });
const sendOf = (row: Row): MailCampaignSend => ({ campaignId: row.campaign_id as string, contactId: row.contact_id as string, ownerUserId: row.owner_user_id as string, address: row.address as string,
  status: row.status as MailCampaignSend["status"], skipReason: (row.skip_reason as string | null) ?? null, messageId: (row.message_id as string | null) ?? null,
  providerId: (row.provider_id as string | null) ?? null, attempts: row.attempts as number, priority: (row.priority as number | undefined) ?? 0,
  renderHash: (row.render_hash as string | null | undefined) ?? null, nextAttemptAt: iso(row.next_attempt_at), sentAt: iso(row.sent_at), error: (row.error as string | null) ?? null,
  bounce: (row.bounce as MailCampaignSend["bounce"]) ?? null, complainedAt: iso(row.complained_at), repliedAt: iso(row.replied_at), unsubscribedAt: iso(row.unsubscribed_at), updatedAt: isoNow(row.updated_at) });
const checkOf = (row: Row): MailCampaignCheck => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, campaignId: (row.campaign_id as string | null) ?? null,
  senderId: (row.sender_id as string | null) ?? null, kind: row.kind as MailCampaignCheck["kind"], status: row.status as MailCampaignCheck["status"],
  score: row.score === null || row.score === undefined ? null : Number(row.score), details: row.details as Record<string, unknown>, fingerprint: (row.fingerprint as string | null) ?? null, createdAt: isoNow(row.created_at) });
const eventOf = (row: Row): MailCampaignEvent => ({ id: row.id as string, ownerUserId: row.owner_user_id as string, campaignId: (row.campaign_id as string | null) ?? null,
  type: row.type as MailCampaignEvent["type"], message: row.message as string, payload: row.payload as Record<string, unknown>, createdAt: isoNow(row.created_at) });

/** `col=$n` assignments for the defined keys of a patch; json columns are cast. */
function assignments(patch: Record<string, unknown>, columns: Record<string, string>, json: ReadonlySet<string>, start: number): { sql: string[]; values: unknown[] } {
  const sql: string[] = []; const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !columns[key]) continue;
    const column = columns[key]!;
    values.push(json.has(column) && value !== null ? JSON.stringify(value) : value);
    sql.push(`${column}=$${start + values.length - 1}${json.has(column) ? "::jsonb" : ""}`);
  }
  return { sql, values };
}
const SENDER_COLUMNS = { displayName: "display_name", replyTo: "reply_to", footerAddress: "footer_address", status: "status", warmup: "warmup", caps: "caps", bulk: "bulk", bulkNote: "bulk_note", config: "config" };
const CAMPAIGN_COLUMNS = { name: "name", goal: "goal", templateId: "template_id", templateVersion: "template_version", senderId: "sender_id", listIds: "list_ids", schedule: "schedule",
  pacing: "pacing", status: "status", fingerprint: "fingerprint", approval: "approval", audience: "audience", testSeeds: "test_seeds", pauseReason: "pause_reason" };
const SEND_COLUMNS = { status: "status", skipReason: "skip_reason", messageId: "message_id", providerId: "provider_id", attempts: "attempts", nextAttemptAt: "next_attempt_at",
  sentAt: "sent_at", error: "error", bounce: "bounce", complainedAt: "complained_at", repliedAt: "replied_at", unsubscribedAt: "unsubscribed_at" };
const JSON_COLUMNS = new Set(["config", "warmup", "caps", "schedule", "pacing", "approval", "audience", "test_seeds", "bounce"]);
const MEMBER_ROWS = `SELECT c.id, c.address, c.health, EXISTS (SELECT 1 FROM mail_campaign_suppressions s WHERE s.owner_user_id=c.owner_user_id AND s.pattern IN (c.address, '@' || c.domain)) AS suppressed,
  MIN(array_position($2::text[], m.list_id)) - 1 AS priority
  FROM mail_campaign_list_members m JOIN mail_campaign_contacts c ON c.id=m.contact_id WHERE m.owner_user_id=$1 AND c.owner_user_id=$1 AND m.list_id = ANY($2::text[])
  GROUP BY c.id, c.address, c.health, c.owner_user_id, c.domain`;

export class PostgresMailCampaignsRepository implements MailCampaignsRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string) { return new PostgresMailCampaignsRepository(createSpacePgPool(url, { max: 4 })); }
  private async rows(sql: string, values: unknown[]): Promise<Row[]> { return (await this.pool.query<Row>(sql, values)).rows; }
  private async transaction<T>(work: (query: (sql: string, values: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let failed = false;
    try {
      await client.query("BEGIN");
      const result = await work(async (sql, values) => (await client.query<Row>(sql, values)).rows);
      await client.query("COMMIT"); return result;
    } catch (error) { const rollback = await rollbackKeepingError(client, error); failed = rollback.failed; throw rollback.error; } finally { client.release?.(failed || undefined); }
  }

  async createSender(input: MailSenderCreateRecord) {
    const [row] = await this.rows(`INSERT INTO mail_campaign_senders(id,owner_user_id,address,display_name,domain,config,reply_to,footer_address,status,warmup,caps,bulk,bulk_note,created_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14) RETURNING *`, [newId("msender"), input.ownerUserId, input.address, input.displayName, input.domain,
      JSON.stringify(input.config), input.replyTo, input.footerAddress, input.status, JSON.stringify(input.warmup), JSON.stringify(input.caps), input.bulk, input.bulkNote, input.createdBy]);
    return senderOf(row!);
  }
  async getSender(owner: string, id: string) { const [row] = await this.rows("SELECT * FROM mail_campaign_senders WHERE owner_user_id=$1 AND id=$2", [owner, id]); return row ? senderOf(row) : null; }
  async listSenders(owner: string) { return (await this.rows("SELECT * FROM mail_campaign_senders WHERE owner_user_id=$1 ORDER BY address", [owner])).map(senderOf); }
  async updateSender(owner: string, id: string, patch: MailSenderPatch) {
    const set = assignments(patch, SENDER_COLUMNS, JSON_COLUMNS, 3);
    const [row] = await this.rows(`UPDATE mail_campaign_senders SET ${[...set.sql, "updated_at=now()"].join(",")} WHERE owner_user_id=$1 AND id=$2 RETURNING *`, [owner, id, ...set.values]);
    return row ? senderOf(row) : null;
  }

  async createTemplate(input: MailTemplateCreateRecord) {
    return this.transaction(async (query) => {
      const [template] = await query(`INSERT INTO mail_campaign_templates(id,owner_user_id,name,language,current_version,pane_id) VALUES($1,$2,$3,$4,1,$5) RETURNING *`,
        [newId("mtpl"), input.ownerUserId, input.name, input.language, input.paneId]);
      const [version] = await query(`INSERT INTO mail_campaign_template_versions(template_id,version,subject,preheader,html,body_text,variables,fingerprint,made_by)
        VALUES($1,1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) RETURNING *`, [template!.id, input.content.subject, input.content.preheader, input.content.html, input.content.text,
        JSON.stringify(input.content.variables), input.fingerprint, JSON.stringify(input.madeBy)]);
      return { template: templateOf(template!), version: versionOf(version!) };
    });
  }
  async addTemplateVersion(owner: string, id: string, input: { content: MailTemplateContent; fingerprint: string; madeBy: MailMadeBy }) {
    return this.transaction(async (query) => {
      const [template] = await query("UPDATE mail_campaign_templates SET current_version=current_version+1, updated_at=now() WHERE owner_user_id=$1 AND id=$2 RETURNING *", [owner, id]);
      if (!template) return null;
      const [version] = await query(`INSERT INTO mail_campaign_template_versions(template_id,version,subject,preheader,html,body_text,variables,fingerprint,made_by)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb) RETURNING *`, [id, template.current_version, input.content.subject, input.content.preheader, input.content.html, input.content.text,
        JSON.stringify(input.content.variables), input.fingerprint, JSON.stringify(input.madeBy)]);
      return { template: templateOf(template), version: versionOf(version!) };
    });
  }
  async getTemplate(owner: string, id: string) { const [row] = await this.rows("SELECT * FROM mail_campaign_templates WHERE owner_user_id=$1 AND id=$2", [owner, id]); return row ? templateOf(row) : null; }
  async getTemplateVersion(owner: string, id: string, version: number) {
    const [row] = await this.rows(`SELECT v.* FROM mail_campaign_template_versions v JOIN mail_campaign_templates t ON t.id=v.template_id
      WHERE t.owner_user_id=$1 AND v.template_id=$2 AND v.version=$3`, [owner, id, version]);
    return row ? versionOf(row) : null;
  }
  async listTemplates(owner: string, includeArchived = false) {
    return (await this.rows(`SELECT * FROM mail_campaign_templates WHERE owner_user_id=$1 AND ($2 OR archived_at IS NULL) ORDER BY updated_at DESC, id DESC`, [owner, includeArchived])).map(templateOf);
  }
  async listTemplateVersions(owner: string, id: string) {
    return (await this.rows(`SELECT v.* FROM mail_campaign_template_versions v JOIN mail_campaign_templates t ON t.id=v.template_id WHERE t.owner_user_id=$1 AND v.template_id=$2
      ORDER BY v.version DESC`, [owner, id])).map(versionOf);
  }
  async updateTemplate(owner: string, id: string, patch: Partial<Pick<MailTemplate, "name" | "archivedAt">>) {
    const set = assignments(patch, { name: "name", archivedAt: "archived_at" }, JSON_COLUMNS, 3);
    const [row] = await this.rows(`UPDATE mail_campaign_templates SET ${[...set.sql, "updated_at=now()"].join(",")} WHERE owner_user_id=$1 AND id=$2 RETURNING *`, [owner, id, ...set.values]);
    return row ? templateOf(row) : null;
  }

  async createList(input: MailListCreateRecord) {
    const [row] = await this.rows(`INSERT INTO mail_campaign_lists(id,owner_user_id,name,description,source,consent_basis) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [newId("mlist"), input.ownerUserId, input.name, input.description, input.source, input.consentBasis]);
    return listOf(row!);
  }
  async getList(owner: string, id: string) { const [row] = await this.rows("SELECT * FROM mail_campaign_lists WHERE owner_user_id=$1 AND id=$2", [owner, id]); return row ? listOf(row) : null; }
  async listLists(owner: string, includeArchived = false) {
    return (await this.rows("SELECT * FROM mail_campaign_lists WHERE owner_user_id=$1 AND ($2 OR archived_at IS NULL) ORDER BY name", [owner, includeArchived])).map(listOf);
  }
  async updateList(owner: string, id: string, patch: MailListPatch) {
    const set = assignments(patch, { name: "name", description: "description", consentBasis: "consent_basis", archivedAt: "archived_at" }, JSON_COLUMNS, 3);
    const [row] = await this.rows(`UPDATE mail_campaign_lists SET ${[...set.sql, "updated_at=now()"].join(",")} WHERE owner_user_id=$1 AND id=$2 RETURNING *`, [owner, id, ...set.values]);
    return row ? listOf(row) : null;
  }

  async upsertContacts(owner: string, inputs: MailContactInput[], overwrite = false) {
    if (!inputs.length) return [];
    const unique = [...new Map(inputs.map((input) => [input.address, input])).values()];
    const rows = await this.rows(`INSERT INTO mail_campaign_contacts(id,owner_user_id,address,domain,name,attributes,health,health_reasons)
      SELECT x.id, $1, x.address, x.domain, x.name, x.attributes, 'UNKNOWN', '[]'::jsonb FROM jsonb_to_recordset($2::jsonb) AS x(id text, address text, domain text, name text, attributes jsonb)
      ON CONFLICT (owner_user_id, address) DO UPDATE SET name=CASE WHEN $3 AND EXCLUDED.name<>'' THEN EXCLUDED.name WHEN mail_campaign_contacts.name='' THEN EXCLUDED.name ELSE mail_campaign_contacts.name END,
        attributes=CASE WHEN $3 THEN mail_campaign_contacts.attributes || EXCLUDED.attributes ELSE EXCLUDED.attributes || mail_campaign_contacts.attributes END, updated_at=now() RETURNING *`,
      [owner, JSON.stringify(unique.map((input) => ({ id: newId("mcontact"), address: input.address, domain: mailAddressDomain(input.address), name: input.name, attributes: input.attributes }))), overwrite]);
    const byAddress = new Map(rows.map((row) => [row.address as string, contactOf(row)]));
    return inputs.map((input) => byAddress.get(input.address)!);
  }
  async getContact(owner: string, idOrAddress: string) {
    const [row] = await this.rows("SELECT * FROM mail_campaign_contacts WHERE owner_user_id=$1 AND (id=$2 OR address=$2)", [owner, idOrAddress]); return row ? contactOf(row) : null;
  }
  async getContacts(owner: string, ids: string[]) {
    return ids.length ? (await this.rows("SELECT * FROM mail_campaign_contacts WHERE owner_user_id=$1 AND id = ANY($2::text[])", [owner, ids])).map(contactOf) : [];
  }
  async listContacts(owner: string, filter: MailContactFilter) {
    return (await this.rows(`SELECT c.* FROM mail_campaign_contacts c WHERE c.owner_user_id=$1
      AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM mail_campaign_list_members m WHERE m.list_id=$2 AND m.contact_id=c.id))
      AND (cardinality($3::text[])=0 OR c.health = ANY($3::text[])) AND ($4::text IS NULL OR c.address LIKE '%' || $4 || '%' OR lower(c.name) LIKE '%' || $4 || '%')
      ORDER BY c.address LIMIT $5 OFFSET $6`, [owner, filter.listId ?? null, filter.health ?? [], filter.q?.toLowerCase() ?? null, filter.limit ?? null, filter.offset ?? 0])).map(contactOf);
  }
  async updateContactHealth(owner: string, id: string, patch: MailContactHealthPatch, at = new Date().toISOString()) {
    const [row] = await this.rows(`UPDATE mail_campaign_contacts SET health=$3, health_reasons=$4::jsonb, health_checked_at=$5, soft_bounces=COALESCE($6, soft_bounces),
      last_engaged_at=COALESCE($7, last_engaged_at), updated_at=$5 WHERE owner_user_id=$1 AND id=$2 RETURNING *`,
      [owner, id, patch.health, JSON.stringify(patch.reasons), at, patch.softBounces ?? null, patch.engagedAt ?? null]);
    return row ? contactOf(row) : null;
  }
  async addDelayNotice(owner: string, id: string, noticeId: string) {
    const [row] = await this.rows(`UPDATE mail_campaign_contacts SET delay_notices = delay_notices || jsonb_build_array($3::text), soft_bounces = soft_bounces + 1, updated_at = now()
      WHERE owner_user_id=$1 AND id=$2 AND NOT delay_notices ? $3 RETURNING soft_bounces`, [owner, id, noticeId]);
    return row ? row.soft_bounces as number : null;
  }
  async contactOwners() { return (await this.rows("SELECT DISTINCT owner_user_id FROM mail_campaign_contacts ORDER BY owner_user_id", [])).map((row) => row.owner_user_id as string); }
  async contactsDueForCheck(owner: string, before: string, limit: number) {
    return (await this.rows(`SELECT * FROM mail_campaign_contacts WHERE owner_user_id=$1 AND (health_checked_at IS NULL OR health_checked_at < $2)
      ORDER BY health_checked_at NULLS FIRST, id LIMIT $3`, [owner, before, limit])).map(contactOf);
  }

  async addMembers(owner: string, listId: string, contactIds: string[], source: string) {
    if (!await this.getList(owner, listId)) throw new Error("No such list.");
    const rows = await this.rows(`INSERT INTO mail_campaign_list_members(list_id,contact_id,owner_user_id,source)
      SELECT $2, c.id, $1, $4 FROM mail_campaign_contacts c WHERE c.owner_user_id=$1 AND c.id = ANY($3::text[]) ON CONFLICT DO NOTHING RETURNING contact_id`, [owner, listId, [...new Set(contactIds)], source]);
    return rows.length;
  }
  async removeMembers(owner: string, listId: string, contactIds: string[]) {
    return (await this.rows("DELETE FROM mail_campaign_list_members WHERE owner_user_id=$1 AND list_id=$2 AND contact_id = ANY($3::text[]) RETURNING contact_id", [owner, listId, contactIds])).length;
  }
  private async memberRows(owner: string, listIds: string[]) {
    return (await this.rows(MEMBER_ROWS, [owner, listIds])).map((row) => ({ id: row.id as string, address: row.address as string, health: row.health as MailHealth,
      suppressed: row.suppressed as boolean, priority: Number(row.priority) }));
  }
  async listHealth(owner: string, listId: string): Promise<MailListHealth> {
    const rows = await this.memberRows(owner, [listId]);
    const byHealth: Partial<Record<MailHealth, number>> = {};
    for (const row of rows) byHealth[row.health] = (byHealth[row.health] ?? 0) + 1;
    return { listId, members: rows.length, byHealth, suppressed: rows.filter((row) => row.suppressed).length, sendable: classify(rows).recipients.length };
  }

  async addSuppressions(owner: string, inputs: MailSuppressionInput[]) {
    if (!inputs.length) return 0;
    return (await this.rows(`INSERT INTO mail_campaign_suppressions(owner_user_id,pattern,reason,source,note)
      SELECT $1, x.pattern, x.reason, x.source, x.note FROM jsonb_to_recordset($2::jsonb) AS x(pattern text, reason text, source text, note text)
      ON CONFLICT DO NOTHING RETURNING pattern`, [owner, JSON.stringify(inputs)])).length;
  }
  async listSuppressions(owner: string, filter: { q?: string; limit?: number }) {
    return (await this.rows(`SELECT * FROM mail_campaign_suppressions WHERE owner_user_id=$1 AND ($2::text IS NULL OR pattern LIKE '%' || $2 || '%')
      ORDER BY created_at DESC, pattern LIMIT $3`, [owner, filter.q?.toLowerCase() ?? null, filter.limit ?? null])).map(suppressionOf);
  }
  async deleteSuppression(owner: string, pattern: string) {
    return (await this.rows("DELETE FROM mail_campaign_suppressions WHERE owner_user_id=$1 AND pattern=$2 RETURNING pattern", [owner, pattern])).length > 0;
  }
  async suppressedAmong(owner: string, addresses: string[]) {
    if (!addresses.length) return new Set<string>();
    const rows = await this.rows(`SELECT a.address FROM unnest($2::text[]) AS a(address) WHERE EXISTS (SELECT 1 FROM mail_campaign_suppressions s WHERE s.owner_user_id=$1
      AND s.pattern IN (a.address, '@' || split_part(a.address, '@', 2)))`, [owner, addresses]);
    return new Set(rows.map((row) => row.address as string));
  }

  async createCampaign(input: MailCampaignCreateRecord) {
    const [row] = await this.rows(`INSERT INTO mail_campaigns(id,owner_user_id,pane_id,name,goal,template_id,template_version,sender_id,list_ids,schedule,pacing,status,test_seeds,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10::jsonb,$11::jsonb,'DRAFT',$12::jsonb,$13) RETURNING *`, [newId("mcamp"), input.ownerUserId, input.paneId, input.name, input.goal,
      input.templateId, input.templateVersion, input.senderId, input.listIds, JSON.stringify(input.schedule), JSON.stringify(input.pacing), JSON.stringify(input.testSeeds), input.createdBy]);
    return campaignOf(row!);
  }
  async getCampaign(owner: string, id: string) { const [row] = await this.rows("SELECT * FROM mail_campaigns WHERE owner_user_id=$1 AND id=$2", [owner, id]); return row ? campaignOf(row) : null; }
  async listCampaigns(owner: string, filter: { status?: MailCampaignStatus[]; limit?: number }) {
    return (await this.rows(`SELECT * FROM mail_campaigns WHERE owner_user_id=$1 AND (cardinality($2::text[])=0 OR status = ANY($2::text[])) ORDER BY created_at DESC, id DESC LIMIT $3`,
      [owner, filter.status ?? [], filter.limit ?? null])).map(campaignOf);
  }
  async updateCampaign(owner: string, id: string, patch: MailCampaignPatch, fromStatus?: MailCampaignStatus[]) {
    const set = assignments(patch, CAMPAIGN_COLUMNS, JSON_COLUMNS, 4);
    const [row] = await this.rows(`UPDATE mail_campaigns SET ${[...set.sql, "updated_at=now()"].join(",")} WHERE owner_user_id=$1 AND id=$2
      AND ($3::text[] IS NULL OR status = ANY($3::text[])) RETURNING *`, [owner, id, fromStatus ?? null, ...set.values]);
    return row ? campaignOf(row) : null;
  }
  async campaignOwner(id: string) { const [row] = await this.rows("SELECT owner_user_id FROM mail_campaigns WHERE id=$1", [id]); return (row?.owner_user_id as string | undefined) ?? null; }
  async ownersWithCampaigns(status: MailCampaignStatus[]) {
    return (await this.rows("SELECT DISTINCT owner_user_id FROM mail_campaigns WHERE status = ANY($1::text[]) ORDER BY owner_user_id", [status])).map((row) => row.owner_user_id as string);
  }

  async audience(owner: string, listIds: string[]) { return classify(await this.memberRows(owner, listIds)); }
  async freezeAudience(owner: string, campaignId: string, recipients: MailFrozenRecipient[], at = new Date().toISOString()) {
    return this.transaction(async (query) => {
      await query(`INSERT INTO mail_campaign_sends(campaign_id,contact_id,owner_user_id,address,status,priority,render_hash,updated_at)
        SELECT $1, x.contact_id, $2, x.address, 'PENDING', x.priority, x.render_hash, $4 FROM jsonb_to_recordset($3::jsonb) AS x(contact_id text, address text, priority int, render_hash text)
        ON CONFLICT (campaign_id, contact_id) DO UPDATE SET priority=EXCLUDED.priority, render_hash=EXCLUDED.render_hash, updated_at=EXCLUDED.updated_at WHERE mail_campaign_sends.status='PENDING'`,
        [campaignId, owner, JSON.stringify(recipients.map((recipient) => ({ contact_id: recipient.contactId, address: recipient.address, priority: recipient.priority ?? 0, render_hash: recipient.renderHash ?? null }))), at]);
      await query(`UPDATE mail_campaign_sends SET status='SKIPPED', skip_reason='left the audience', updated_at=$3 WHERE campaign_id=$1 AND owner_user_id=$2 AND status='PENDING'
        AND NOT (contact_id = ANY($4::text[]))`, [campaignId, owner, at, recipients.map((recipient) => recipient.contactId)]);
      const [count] = await query("SELECT count(*)::int AS n FROM mail_campaign_sends WHERE campaign_id=$1 AND status='PENDING'", [campaignId]);
      return count!.n as number;
    });
  }
  async takeNextSend(owner: string, campaignId: string, at = new Date().toISOString()) {
    const [row] = await this.rows(`UPDATE mail_campaign_sends SET status='SENDING', updated_at=$3 WHERE (campaign_id, contact_id) = (
      SELECT campaign_id, contact_id FROM mail_campaign_sends WHERE owner_user_id=$1 AND campaign_id=$2 AND status='PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
      ORDER BY next_attempt_at NULLS FIRST, priority, address LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='PENDING' RETURNING *`, [owner, campaignId, at]);
    return row ? sendOf(row) : null;
  }
  async updateSend(owner: string, campaignId: string, contactId: string, patch: MailSendPatch, fromStatus?: MailCampaignSend["status"][]) {
    const set = assignments(patch, SEND_COLUMNS, JSON_COLUMNS, 5);
    const [row] = await this.rows(`UPDATE mail_campaign_sends SET ${[...set.sql, "updated_at=now()"].join(",")} WHERE owner_user_id=$1 AND campaign_id=$2 AND contact_id=$3
      AND ($4::text[] IS NULL OR status = ANY($4::text[])) RETURNING *`, [owner, campaignId, contactId, fromStatus ?? null, ...set.values]);
    return row ? sendOf(row) : null;
  }
  async markStaleSending(before: string) {
    return (await this.rows(`UPDATE mail_campaign_sends SET status='UNKNOWN', error='The send''s answer was lost; never retried.', updated_at=now() WHERE status='SENDING' AND updated_at < $1
      RETURNING contact_id`, [before])).length;
  }
  async findSendByMessageId(owner: string, messageId: string) {
    const [row] = await this.rows("SELECT * FROM mail_campaign_sends WHERE message_id=$2 AND owner_user_id=$1", [owner, messageId]); return row ? sendOf(row) : null;
  }
  async listSends(owner: string, campaignId: string, filter: { status?: MailCampaignSend["status"][]; limit?: number }) {
    return (await this.rows(`SELECT * FROM mail_campaign_sends WHERE owner_user_id=$1 AND campaign_id=$2 AND (cardinality($3::text[])=0 OR status = ANY($3::text[])) ORDER BY address LIMIT $4`,
      [owner, campaignId, filter.status ?? [], filter.limit ?? null])).map(sendOf);
  }
  async campaignStats(owner: string, campaignId: string) {
    const stats = emptyStats();
    const rows = await this.rows(`SELECT status, count(*)::int AS n, count(*) FILTER (WHERE bounce->>'kind'='HARD')::int AS hard, count(*) FILTER (WHERE bounce->>'kind'='SOFT')::int AS soft,
      count(complained_at)::int AS complained, count(replied_at)::int AS replied, count(unsubscribed_at)::int AS unsubscribed
      FROM mail_campaign_sends WHERE owner_user_id=$1 AND campaign_id=$2 GROUP BY status`, [owner, campaignId]);
    for (const row of rows) {
      stats.byStatus[row.status as MailCampaignSend["status"]] = row.n as number;
      stats.bounced.hard += row.hard as number; stats.bounced.soft += row.soft as number;
      stats.complained += row.complained as number; stats.replied += row.replied as number; stats.unsubscribed += row.unsubscribed as number;
    }
    return stats;
  }
  async sentBySenderSince(owner: string, senderId: string, since: string) {
    const [row] = await this.rows(`SELECT count(*)::int AS n FROM mail_campaign_sends s JOIN mail_campaigns c ON c.id=s.campaign_id WHERE c.owner_user_id=$1 AND c.sender_id=$2
      AND s.status IN ('SENT','SENDING','UNKNOWN') AND COALESCE(s.sent_at, s.updated_at) >= $3`, [owner, senderId, since]);
    return row!.n as number;
  }
  async sentByCampaignSince(owner: string, campaignId: string, since: string) {
    const [row] = await this.rows(`SELECT count(*)::int AS n FROM mail_campaign_sends WHERE owner_user_id=$1 AND campaign_id=$2 AND status IN ('SENT','SENDING','UNKNOWN')
      AND COALESCE(sent_at, updated_at) >= $3`, [owner, campaignId, since]);
    return row!.n as number;
  }
  async lastMailedAt(owner: string, contactId: string) {
    const [row] = await this.rows("SELECT max(sent_at) AS at FROM mail_campaign_sends WHERE owner_user_id=$1 AND contact_id=$2", [owner, contactId]); return iso(row?.at);
  }

  async addCheck(input: MailCheckCreateRecord) {
    const [row] = await this.rows(`INSERT INTO mail_campaign_checks(id,owner_user_id,campaign_id,sender_id,kind,status,score,details,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
      [newId("mcheck"), input.ownerUserId, input.campaignId, input.senderId, input.kind, input.status, input.score, JSON.stringify(input.details), input.fingerprint]);
    return checkOf(row!);
  }
  async listChecks(owner: string, filter: { campaignId?: string; senderId?: string; limit?: number }) {
    return (await this.rows(`SELECT * FROM mail_campaign_checks WHERE owner_user_id=$1 AND ($2::text IS NULL OR campaign_id=$2) AND ($3::text IS NULL OR sender_id=$3)
      ORDER BY created_at DESC, id DESC LIMIT $4`, [owner, filter.campaignId ?? null, filter.senderId ?? null, filter.limit ?? null])).map(checkOf);
  }
  async addEvent(input: MailEventCreateRecord) {
    const [row] = await this.rows(`INSERT INTO mail_campaign_events(id,owner_user_id,campaign_id,type,message,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [newId("mcevt"), input.ownerUserId, input.campaignId, input.type, input.message, JSON.stringify(input.payload)]);
    return eventOf(row!);
  }
  async listEvents(owner: string, filter: { campaignId?: string; limit?: number }) {
    return (await this.rows(`SELECT * FROM mail_campaign_events WHERE owner_user_id=$1 AND ($2::text IS NULL OR campaign_id=$2) ORDER BY created_at DESC, id DESC LIMIT $3`,
      [owner, filter.campaignId ?? null, filter.limit ?? null])).map(eventOf);
  }
  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}
