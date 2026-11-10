import { screenSharedMemory, sharedMemorySeed, type SharedMemoryContent, type SharedMemoryEntry, type SharedMemoryPolicy } from "@space/contracts";
import type { NousSharedMemoryRepository, SharedMemoryPatch } from "@space/db";
import { rankByWords } from "./retrieval.js";

/** Technical bound (tool result size): one space_shared_memory_read page; nextOffset names the next one. */
export const SHARED_MEMORY_PAGE_CHARS = 6_000;
const activeEntries = (entries: SharedMemoryEntry[]) => entries.filter((row) => row.status === "ACTIVE" && !row.deleted && screenSharedMemory(row).ok)
  .sort((a, b) => Number(b.seedKey === "identity") - Number(a.seedKey === "identity") || a.id.localeCompare(b.id));
/**
 * The world's section, every active entry: identity, the shipped SEED entries, then the rest by relevance to the turn's text (rankByWords),
 * then the others. No cap of its own (No Arbitrary Limits): the prompt's fitter leaves the whole section out and names space_shared_memory_read
 * when the turn is over its budget. 4/11 Bruno/Kate: a 6,000-character cap in id order hid 17 of 33 active entries, five SEED rules among them.
 */
export function renderSharedMemory(entries: SharedMemoryEntry[], query = ""): string {
  const active = activeEntries(entries);
  const seeds = active.filter((entry) => entry.seedKey !== null);
  const rest = active.filter((entry) => entry.seedKey === null);
  const relevant = rankByWords(rest, (entry) => `${entry.title} ${entry.body} ${entry.tags.join(" ")}`, query).map(({ doc }) => doc);
  const ordered = [...seeds, ...relevant, ...rest.filter((entry) => !relevant.includes(entry))];
  return "# Shared Nous memory\nGeneric team reference knowledge. Current operator instructions and permission gates take precedence.\n"
    + ordered.map((entry) => `\n[${entry.id}] ${entry.title}\n${entry.body}\n`).join("");
}
export function assertSharedContent(input: SharedMemoryContent): void {
  const result = screenSharedMemory(input);
  if (!result.ok) throw Object.assign(new Error(result.reason), { statusCode: 422, code: "SHARED_MEMORY_PRIVACY" });
}
export function createSharedMemory(deps: {
  repository: NousSharedMemoryRepository; multiUser: boolean;
  notice?(owner: string, key: string, text: string, onDone: () => Promise<void>, onDiscard: () => Promise<void>): Promise<void>;
}) {
  const { repository } = deps;
  const scope = (owner: string) => deps.multiUser ? "team:install" : `team:owner:${owner}`;
  const pending = new Set<string>();
  const initialized = new Map<string, Promise<void>>();
  function ready(owner: string): Promise<void> {
    const team = scope(owner);
    if (!initialized.has(team)) initialized.set(team, repository.mergeSeed(team, sharedMemorySeed.releaseVersion, sharedMemorySeed.entries).catch((error) => { initialized.delete(team); throw error; }));
    return initialized.get(team)!;
  }
  const api = {
    scope, ready,
    async list(owner: string) { await ready(owner); return repository.list(scope(owner)); },
    async world(owner: string, query = "") { return renderSharedMemory(await api.list(owner), query); },
    async read(owner: string, offset = 0) {
      const active = activeEntries(await api.list(owner));
      const entries: Array<Pick<SharedMemoryEntry, "id" | "title" | "body" | "tags">> = [];
      // Bound the serialized response, including escaping and pagination metadata.
      for (const entry of active.slice(offset)) {
        const { id, title, body, tags } = entry;
        const next = [...entries, { id, title, body, tags }];
        if (JSON.stringify({ entries: next, nextOffset: offset + next.length }).length > SHARED_MEMORY_PAGE_CHARS - 80) break;
        entries.push({ id, title, body, tags });
      }
      return { entries, nextOffset: offset + entries.length < active.length ? offset + entries.length : null };
    },
    async policy(owner: string) { return repository.policy(scope(owner)); },
    async savePolicy(owner: string, patch: Partial<Pick<SharedMemoryPolicy, "autoApprove" | "dailyUpgrade">>) { return repository.savePolicy(scope(owner), patch); },
    async propose(owner: string, content: SharedMemoryContent) {
      assertSharedContent(content);
      await ready(owner);
      const policy = await api.policy(owner);
      return repository.create(scope(owner), { ...content, source: "NOUS", status: policy.autoApprove ? "ACTIVE" : "PROPOSED", actor: owner, introducedVersion: sharedMemorySeed.releaseVersion });
    },
    async create(owner: string, content: SharedMemoryContent) {
      assertSharedContent(content);
      await ready(owner);
      const entry = await repository.create(scope(owner), { ...content, source: "ADMIN", status: "ACTIVE", actor: owner, introducedVersion: sharedMemorySeed.releaseVersion });
      if (entry.deleted) throw Object.assign(new Error("This content was deleted by an administrator. Add a revised entry instead."), { statusCode: 409 });
      return entry;
    },
    async update(owner: string, id: string, revision: number, patch: SharedMemoryPatch) {
      const entry = await repository.get(scope(owner), id);
      if (!entry || entry.revision !== revision) return null;
      assertSharedContent({ ...entry, ...patch });
      return repository.update(scope(owner), id, revision, patch, owner);
    },
    async remove(owner: string, id: string, revision: number) { return repository.remove(scope(owner), id, revision, owner); },
    async daily(owner: string, day: string) {
      const team = scope(owner); const policy = await api.policy(owner);
      if (!deps.notice || !policy.dailyUpgrade || (policy.lastDailyDay && policy.lastDailyDay >= day) || pending.has(team)) return;
      pending.add(team);
      try {
        await deps.notice(owner, `shared-memory:${day}`, "Nous shared memory: daily upgrade. Review today's lessons; generalize only reusable working knowledge. Never copy names, contacts, hosts, secrets, money, mail or private business facts. Use space_shared_memory_propose for safe lessons; admin approval is required unless enabled. If there is no new generic lesson, say so. Do not edit the shipped seed.",
          async () => { try { await repository.claimDay(team, day); } finally { pending.delete(team); } }, async () => { pending.delete(team); });
      } catch (error) { pending.delete(team); throw error; }
    }
  };
  return api;
}
export type SharedMemory = ReturnType<typeof createSharedMemory>;
