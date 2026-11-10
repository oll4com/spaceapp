import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a preview or cleanup answers NOOP exactly when it found nothing to remove" is one business rule that the
// Codex history purge and CLI session cleanup responses share. This pins what each answers for every status with and
// without targets (message and path), so moving the rule out of the schema file changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const at = "2026-10-28T12:00:00.000Z";
const purgeCounts = (n: number) => ({ threads: n, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 });
const stores = (n: number) => [{ cli: "kimi", entries: n, bytes: 0 }];
const cleanupCounts = (n: number) => ({
  opencode: { sessions: 0, newSessionSessions: 0, emptySessions: 0, mappingFiles: 0 },
  opencodeTmp: { entries: 0, bytes: 0 },
  codex: { status: "NOOP", previewId: null, threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
  codexOrphans: { rolloutFiles: 0, bytes: 0 },
  codexPaneHomes: { dirs: n, bytes: 0 },
  cliStores: stores(0),
  totalBytes: 0
});
const cleaned = (n: number) => ({
  opencode: { sessions: 0, newSessionSessions: 0, emptySessions: 0, mappingFiles: 0 },
  opencodeTmp: { entries: 0, bytes: 0 },
  codex: { status: "SKIPPED", threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
  codexOrphans: { rolloutFiles: 0, bytes: 0 },
  codexPaneHomes: { dirs: 0, bytes: 0 },
  cliStores: stores(n)
});
const cases = [
  { name: "codexHistoryPurgePreviewResponseSchema", schema: contracts.codexHistoryPurgePreviewResponseSchema, statuses: ["READY"], body: (n: number) => ({ previewId: uuid, candidates: purgeCounts(n), protectedThreads: 0, expiresAt: at, checkedAt: at }), message: "READY previews require candidates and NOOP previews require zero candidates." },
  { name: "codexHistoryPurgeResponseSchema", schema: contracts.codexHistoryPurgeResponseSchema, statuses: ["COMPLETED"], body: (n: number) => ({ previewId: uuid, backupId: uuid, purged: purgeCounts(n), protectedThreads: 0, newlyProtectedThreads: 0, completedAt: at }), message: "COMPLETED purges require removed history and NOOP purges require zero removals." },
  { name: "cliSessionCleanupPreviewResponseSchema", schema: contracts.cliSessionCleanupPreviewResponseSchema, statuses: ["READY"], body: (n: number) => ({ previewId: uuid, counts: cleanupCounts(n), checkedAt: at }), message: "READY previews require targets and NOOP previews require zero targets." },
  { name: "cliSessionCleanupResponseSchema", schema: contracts.cliSessionCleanupResponseSchema, statuses: ["COMPLETED", "PARTIAL"], body: (n: number) => ({ previewId: uuid, cleaned: cleaned(n), totalBytes: 0, failures: [], completedAt: at }), message: "NOOP cleanups require zero removals and non-NOOP cleanups require removals." }
] as const;

describe("responses that answer NOOP exactly when nothing is removed", () => {
  for (const item of cases) {
    it(`${item.name}: a status that disagrees with the targets is refused at status`, () => {
      const schema = item.schema as Parse;
      const issues = (status: string, n: number) => schema.safeParse({ status, ...item.body(n) }).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      const refused = [[item.message, ["status"]]];
      expect(issues("NOOP", 0)).toEqual([]);
      expect(issues("NOOP", 2)).toEqual(refused);
      for (const status of item.statuses) {
        expect(issues(status, 2)).toEqual([]);
        expect(issues(status, 0)).toEqual(refused);
      }
    });
  }
});
