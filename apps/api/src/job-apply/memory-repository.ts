import {
  newJobApplicationFieldId,
  newJobApplicationId,
  newJobApplyEventId,
  newJobApplyMemoryId,
  newJobApplyRunId,
  type JobApplicationCreateRecord,
  type JobApplicationFieldRecord,
  type JobApplicationFieldUpsert,
  type JobApplicationPatch,
  type JobApplicationRecord,
  type JobApplicationStatsRow,
  type JobApplyEventCreateRecord,
  type JobApplyEventFilter,
  type JobApplyEventRecord,
  type JobApplyMemoryCreateRecord,
  type JobApplyMemoryPatch,
  type JobApplyMemoryQuery,
  type JobApplyMemoryRecord,
  type JobApplyProfilePatch,
  type JobApplyProfileRecord,
  type JobApplyRepository,
  type JobApplyRunPatch,
  type JobApplyRunRecord
} from "@space/db";

/** Undefined patch fields mean "leave as is", exactly like the SQL CASE expressions. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1);
}

/** Token overlap stands in for Postgres full-text rank: same ordering rules, no stemming. */
function scoreMemory(memory: JobApplyMemoryRecord, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokens(`${memory.key ?? ""} ${memory.text} ${memory.company ?? ""} ${memory.site ?? ""} ${memory.tags.join(" ")}`));
  let hits = 0;
  for (const token of queryTokens) if (haystack.has(token)) hits += 1;
  return hits / queryTokens.length;
}

/** In-memory twin of the Postgres repository for tests and database-less installs. */
export class InMemoryJobApplyRepository implements JobApplyRepository {
  private profiles = new Map<string, JobApplyProfileRecord>();
  private applications = new Map<string, JobApplicationRecord>();
  private memories = new Map<string, JobApplyMemoryRecord>();
  private fields = new Map<string, JobApplicationFieldRecord>();
  private events: JobApplyEventRecord[] = [];
  private runs = new Map<string, JobApplyRunRecord>();
  constructor(private now: () => string = () => new Date().toISOString()) {}

  async getProfile(owner: string) {
    const profile = this.profiles.get(owner);
    return profile ? structuredClone(profile) : null;
  }
  async listGoogleProfileOwners() {
    return [...this.profiles.values()].filter((profile) => profile.googleEmail).map((profile) => profile.ownerUserId).sort();
  }
  async upsertProfile(owner: string, patch: JobApplyProfilePatch) {
    const timestamp = this.now();
    const current = this.profiles.get(owner) ?? {
      ownerUserId: owner, candidate: {}, qaBank: [], cvArtifactId: null, coverLetterArtifactId: null, cvText: null,
      mailbox: null, mailboxPasswordEncrypted: null, mailboxVerifiedAt: null, googleEmail: null, campaignStartedAt: null, createdAt: timestamp, updatedAt: timestamp
    };
    const next: JobApplyProfileRecord = { ...current, ...structuredClone(defined(patch)), updatedAt: timestamp } as JobApplyProfileRecord;
    this.profiles.set(owner, next);
    return structuredClone(next);
  }
  async resetCampaign(owner: string, expected: string | null) {
    const current = this.profiles.get(owner);
    if ((current?.campaignStartedAt ?? null) !== expected) return null;
    const startedAt = this.now();
    await this.upsertProfile(owner, {});
    this.profiles.set(owner, { ...this.profiles.get(owner)!, campaignStartedAt: startedAt });
    return startedAt;
  }
  async listApplications(owner: string, filter: { status?: string; limit: number }) {
    return [...this.applications.values()]
      .filter((row) => row.ownerUserId === owner && (!filter.status || row.status === filter.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit)
      .map((row) => structuredClone(row));
  }
  async getApplication(owner: string, id: string) {
    const row = this.applications.get(id);
    return row?.ownerUserId === owner ? structuredClone(row) : null;
  }
  async getApplicationByUrl(owner: string, url: string) {
    const row = [...this.applications.values()].find((entry) => entry.ownerUserId === owner && entry.url === url);
    return row ? structuredClone(row) : null;
  }
  async createApplication(input: JobApplicationCreateRecord) {
    if (await this.getApplicationByUrl(input.ownerUserId, input.url)) throw new Error("duplicate key value violates unique constraint");
    const timestamp = this.now();
    const { queuePosition, ...rest } = input;
    const row: JobApplicationRecord = { id: newJobApplicationId(), ...rest, evidenceArtifactIds: [], externalConfirmation: null,
      appliedAt: null, queuePosition: queuePosition ?? null, notBefore: null, createdAt: timestamp, updatedAt: timestamp };
    this.applications.set(row.id, row);
    return structuredClone(row);
  }
  async updateApplication(owner: string, id: string, patch: JobApplicationPatch) {
    const row = this.applications.get(id);
    if (!row || row.ownerUserId !== owner) return null;
    const next = { ...row, ...structuredClone(defined(patch)), updatedAt: this.now() } as JobApplicationRecord;
    this.applications.set(id, next);
    return structuredClone(next);
  }
  async deleteQueuedApplication(owner: string, id: string) {
    const row = this.applications.get(id);
    if (!row || row.ownerUserId !== owner || row.status !== "QUEUED") return false;
    this.applications.delete(id);
    for (const [fieldId, field] of this.fields) if (field.applicationId === id) this.fields.delete(fieldId);
    this.events = this.events.filter((event) => event.applicationId !== id);
    return true;
  }
  async countApplications(owner: string, ats: string, statuses: string[], sinceIso: string) {
    return [...this.applications.values()].filter((row) => row.ownerUserId === owner && row.ats === ats && statuses.includes(row.status)
      && (row.appliedAt ?? row.updatedAt) >= sinceIso).length;
  }
  async listQueue(owner: string, paneId: string | null) {
    // shortcut: the twin knows no panes, so a closed pane still holds its postings here; the Postgres test covers the release.
    return [...this.applications.values()]
      .filter((row) => row.ownerUserId === owner && row.status === "QUEUED" && (paneId === null || row.paneId === null || row.paneId === paneId))
      .sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER)
        || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((row) => structuredClone(row));
  }
  async applicationStats(owner: string, input: { tz: string; since: string | null; importedUrlPrefix: string }) {
    const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: input.tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const counts = new Map<string, JobApplicationStatsRow>();
    for (const row of this.applications.values()) {
      if (row.ownerUserId !== owner) continue;
      const scope = row.url.startsWith(input.importedUrlPrefix) ? "IMPORTED" : input.since && row.createdAt < input.since ? "ARCHIVED" : "CURRENT";
      const day = dayOf.format(new Date(row.appliedAt ?? row.updatedAt));
      const key = `${day}|${row.status}|${scope}`;
      const entry = counts.get(key) ?? { day, status: row.status, scope, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.values()];
  }
  async nextQueuePosition(owner: string) {
    let max = -1;
    for (const row of this.applications.values()) if (row.ownerUserId === owner && row.status === "QUEUED" && row.queuePosition !== null) max = Math.max(max, row.queuePosition);
    return max + 1;
  }
  async setQueueOrder(owner: string, applicationIds: string[]) {
    applicationIds.forEach((id, position) => {
      const row = this.applications.get(id);
      if (row && row.ownerUserId === owner && row.status === "QUEUED") this.applications.set(id, { ...row, queuePosition: position, updatedAt: this.now() });
    });
  }

  async listMemory(owner: string, query: JobApplyMemoryQuery) {
    const queryTokens = tokens(query.query ?? "");
    const keys = new Set(query.keys ?? []);
    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
    const textSearch = queryTokens.length > 0;
    return [...this.memories.values()]
      .filter((memory) => memory.ownerUserId === owner
        && (!kinds || kinds.has(memory.kind))
        && (!query.site || memory.site === null || memory.site === query.site)
        && (!query.company || memory.company === null || memory.company.toLowerCase() === query.company.toLowerCase())
        && (!query.pinnedOnly || memory.pinned))
      .map((memory) => ({ memory, keyHit: memory.key !== null && keys.has(memory.key), rank: scoreMemory(memory, queryTokens) }))
      .filter(({ keyHit, rank }) => (!textSearch && keys.size === 0) || keyHit || (textSearch && rank > 0))
      .sort((left, right) => Number(right.keyHit) - Number(left.keyHit) || Number(right.memory.pinned) - Number(left.memory.pinned) || right.rank - left.rank
        || Number(right.memory.site !== null) - Number(left.memory.site !== null) || Number(right.memory.company !== null) - Number(left.memory.company !== null)
        || right.memory.uses - left.memory.uses || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, query.limit)
      .map(({ memory }) => structuredClone(memory));
  }
  async getMemory(owner: string, id: string) {
    const memory = this.memories.get(id);
    return memory?.ownerUserId === owner ? structuredClone(memory) : null;
  }
  async createMemory(input: JobApplyMemoryCreateRecord) {
    const timestamp = this.now();
    const memory: JobApplyMemoryRecord = { id: newJobApplyMemoryId(), ...structuredClone(input), uses: 0, lastUsedAt: null, createdAt: timestamp, updatedAt: timestamp };
    this.memories.set(memory.id, memory);
    return structuredClone(memory);
  }
  async upsertMemoryByKey(input: JobApplyMemoryCreateRecord & { key: string }) {
    const existing = [...this.memories.values()].find((memory) => memory.ownerUserId === input.ownerUserId && memory.kind === input.kind && memory.key === input.key
      && (memory.site ?? "") === (input.site ?? "") && (memory.company ?? "") === (input.company ?? ""));
    if (!existing) return this.createMemory(input);
    const next: JobApplyMemoryRecord = { ...existing, text: input.text, tags: input.tags.length > 0 ? [...input.tags] : existing.tags, source: input.source,
      confidence: input.confidence, pinned: existing.pinned || input.pinned, updatedAt: this.now() };
    this.memories.set(next.id, next);
    return structuredClone(next);
  }
  async updateMemory(owner: string, id: string, patch: JobApplyMemoryPatch) {
    const memory = this.memories.get(id);
    if (!memory || memory.ownerUserId !== owner) return null;
    const next = { ...memory, ...structuredClone(defined(patch)), updatedAt: this.now() } as JobApplyMemoryRecord;
    this.memories.set(id, next);
    return structuredClone(next);
  }
  async deleteMemory(owner: string, id: string) {
    const memory = this.memories.get(id);
    if (!memory || memory.ownerUserId !== owner) return false;
    this.memories.delete(id);
    return true;
  }
  async touchMemory(owner: string, ids: string[], usedAtIso: string) {
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (memory && memory.ownerUserId === owner) this.memories.set(id, { ...memory, uses: memory.uses + 1, lastUsedAt: usedAtIso });
    }
  }
  async countMemory(owner: string) {
    return [...this.memories.values()].filter((memory) => memory.ownerUserId === owner).length;
  }

  async listFields(owner: string, applicationId: string) {
    return [...this.fields.values()]
      .filter((field) => field.ownerUserId === owner && field.applicationId === applicationId)
      .sort((left, right) => left.stepIndex - right.stepIndex || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((field) => structuredClone(field));
  }
  async upsertFields(owner: string, applicationId: string, fields: JobApplicationFieldUpsert[], filledAtIso: string) {
    const records: JobApplicationFieldRecord[] = [];
    for (const field of fields) {
      const existing = [...this.fields.values()].find((entry) => entry.applicationId === applicationId && entry.stepIndex === field.stepIndex && entry.label === field.label);
      const timestamp = this.now();
      const next: JobApplicationFieldRecord = existing
        ? { ...existing, stepTitle: field.stepTitle ?? existing.stepTitle, fieldType: field.fieldType, refHint: field.refHint ?? existing.refHint, value: field.value,
            source: field.source, filledAt: filledAtIso, verifiedAt: field.verifiedAt ?? existing.verifiedAt, updatedAt: timestamp }
        : { id: newJobApplicationFieldId(), applicationId, ownerUserId: owner, ...structuredClone(field), filledAt: filledAtIso, createdAt: timestamp, updatedAt: timestamp };
      this.fields.set(next.id, next);
      records.push(structuredClone(next));
    }
    return records;
  }
  async updateField(owner: string, id: string, patch: { value?: string | null; source?: string; verifiedAt?: string | null }) {
    const field = this.fields.get(id);
    if (!field || field.ownerUserId !== owner) return null;
    const next = { ...field, ...structuredClone(defined(patch)), updatedAt: this.now() } as JobApplicationFieldRecord;
    this.fields.set(id, next);
    return structuredClone(next);
  }
  async countFields(owner: string, applicationId: string) {
    return [...this.fields.values()].filter((field) => field.ownerUserId === owner && field.applicationId === applicationId).length;
  }

  async createEvent(input: JobApplyEventCreateRecord) {
    const event: JobApplyEventRecord = { id: newJobApplyEventId(), ...structuredClone(input), payload: structuredClone(input.payload ?? {}), createdAt: this.now() };
    this.events.push(event);
    return structuredClone(event);
  }
  async listEvents(owner: string, filter: JobApplyEventFilter) {
    // Newest first; events of the same millisecond keep the order they were recorded in (ids are random).
    return this.events
      .filter((event) => event.ownerUserId === owner && (!filter.applicationId || event.applicationId === filter.applicationId)
        && (!filter.runId || event.runId === filter.runId) && (!filter.paneId || event.paneId === filter.paneId) && (!filter.types?.length || filter.types.includes(event.type))
        && (!filter.since || event.createdAt > filter.since))
      .reverse()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filter.limit)
      .map((event) => structuredClone(event));
  }

  async listActiveRuns(owner: string) {
    return [...this.runs.values()].filter((entry) => entry.ownerUserId === owner && (entry.status === "RUNNING" || entry.status === "PAUSED"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((run) => structuredClone(run));
  }
  async getActiveRun(paneId: string) {
    const run = [...this.runs.values()].filter((entry) => entry.paneId === paneId && (entry.status === "RUNNING" || entry.status === "PAUSED"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return run ? structuredClone(run) : null;
  }
  async getRun(owner: string, id: string) {
    const run = this.runs.get(id);
    return run?.ownerUserId === owner ? structuredClone(run) : null;
  }
  async createRun(input: { ownerUserId: string; paneId: string; status: string }) {
    const timestamp = this.now();
    const run: JobApplyRunRecord = { id: newJobApplyRunId(), ownerUserId: input.ownerUserId, paneId: input.paneId, status: input.status,
      counters: { taken: 0, submitted: 0, verified: 0, failed: 0, needsUser: 0 }, currentApplicationId: null, kickoffSentAt: null,
      startedAt: timestamp, pausedAt: null, stoppedAt: null, lastActivityAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }
  async updateRun(owner: string, id: string, patch: JobApplyRunPatch) {
    const run = this.runs.get(id);
    if (!run || run.ownerUserId !== owner) return null;
    const next = { ...run, ...structuredClone(defined(patch)), updatedAt: this.now() } as JobApplyRunRecord;
    this.runs.set(id, next);
    return structuredClone(next);
  }
  async listRuns(owner: string, paneId: string, limit: number) {
    return [...this.runs.values()].filter((run) => run.ownerUserId === owner && run.paneId === paneId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit).map((run) => structuredClone(run));
  }
  async dispose() { /* nothing to release */ }
}
