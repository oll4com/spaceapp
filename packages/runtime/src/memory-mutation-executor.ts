import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  memoryChangeSetSchema,
  memoryMutationExecutionResultSchema,
  memoryMutationJournalSchema,
  memoryMutationRecoveryResultSchema,
  type MemoryChangeSet,
  type MemoryMutationExecutionResult,
  type MemoryMutationJournal,
  type MemoryMutationRecoveryResult
} from "@space/contracts";
import type { MemoryGraphSourceKind } from "@space/memory-graph";
import { hashMemorySnapshot, SpaceConflictError } from "./store.js";

export interface CanonicalMemoryMutationSource {
  path: string;
  kind: MemoryGraphSourceKind;
}

export interface CanonicalMemoryMutationHooks {
  afterLock?: () => void | Promise<void>;
  afterPrepared?: () => void | Promise<void>;
  afterTemporaryFileSynced?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  afterDirectorySynced?: () => void | Promise<void>;
  afterWritten?: () => void | Promise<void>;
}

export interface CanonicalMemoryMutationOptions {
  sources: CanonicalMemoryMutationSource[];
  journalRoot: string;
  lockPath: string;
  lockTimeoutMs?: number;
  now?: () => Date;
  hooks?: CanonicalMemoryMutationHooks;
}

export class CanonicalMemoryMutationExecutionError extends Error {
  readonly name = "CanonicalMemoryMutationExecutionError";

  constructor(
    message: string,
    readonly changeSetId: string,
    readonly canonicalReplaced: boolean,
    cause?: unknown
  ) {
    super(message, { cause });
  }
}

interface ValidatedSource {
  path: string;
  kind: MemoryGraphSourceKind;
  content: string;
  uid: number;
  gid: number;
  mode: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const MAX_CANONICAL_SOURCE_BYTES = 4_000_000;
const MAX_JOURNAL_BYTES = 32_000;

function assertAbsolutePath(path: string, label: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > 2_000) {
    throw new SpaceConflictError(`${label} must be a bounded path string.`);
  }
  if (resolve(path) !== path) throw new SpaceConflictError(`${label} must be an absolute normalized path.`);
}

async function assertSafeDirectory(path: string, label: string, create: boolean): Promise<void> {
  assertAbsolutePath(path, label);
  if (create) await mkdir(path, { recursive: true, mode: 0o750 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SpaceConflictError(`${label} ${path} must be a real directory.`);
  }
  if (await realpath(path) !== path) throw new SpaceConflictError(`${label} ${path} has real path drift.`);
}

async function safeReadRegularFile(path: string, label: string, maxBytes: number): Promise<{
  content: string;
  uid: number;
  gid: number;
  mode: number;
}> {
  assertAbsolutePath(path, label);
  const pathStat = await lstat(path);
  if (pathStat.isSymbolicLink()) throw new SpaceConflictError(`${label} ${path} cannot be a symbolic link.`);
  if (!pathStat.isFile()) throw new SpaceConflictError(`${label} ${path} must be a regular file.`);
  if (pathStat.size > maxBytes) throw new SpaceConflictError(`${label} ${path} exceeds the ${maxBytes}-byte limit.`);
  if (await realpath(path) !== path) throw new SpaceConflictError(`${label} ${path} has real path drift.`);

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleStat = await handle.stat();
    if (
      !handleStat.isFile() ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino ||
      handleStat.size > maxBytes
    ) {
      throw new SpaceConflictError(`${label} ${path} changed during safe open.`);
    }
    const content = await handle.readFile("utf8");
    if (Buffer.byteLength(content, "utf8") !== handleStat.size) {
      throw new SpaceConflictError(`${label} ${path} changed while it was being read.`);
    }
    return { content, uid: handleStat.uid, gid: handleStat.gid, mode: handleStat.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

function journalPathFor(changeSetId: string, journalRoot: string): string {
  return join(journalRoot, `${changeSetId}.json`);
}

function operatorRequired(changeSet: MemoryChangeSet, reason: string): MemoryMutationRecoveryResult {
  return memoryMutationRecoveryResultSchema.parse({
    status: "OPERATOR_REQUIRED",
    changeSetId: changeSet.id,
    sourcePath: changeSet.sourcePath,
    resultingSourceHash: null,
    reason
  });
}

function assertImmutableSnapshots(changeSet: MemoryChangeSet): void {
  if (hashMemorySnapshot(changeSet.beforeSnapshot) !== changeSet.beforeContentHash) {
    throw new SpaceConflictError(`Memory change set ${changeSet.id} has an invalid before snapshot hash.`);
  }
  if (hashMemorySnapshot(changeSet.afterSnapshot) !== changeSet.afterContentHash) {
    throw new SpaceConflictError(`Memory change set ${changeSet.id} has an invalid after snapshot hash.`);
  }
}

async function validateAndReadSources(
  configuredSources: CanonicalMemoryMutationSource[],
  targetPath: string
): Promise<{ sources: ValidatedSource[]; target: ValidatedSource }> {
  if (configuredSources.length === 0 || configuredSources.length > 24) {
    throw new SpaceConflictError("Canonical mutation requires between one and 24 allowlisted sources.");
  }
  const seen = new Set<string>();
  const sources: ValidatedSource[] = [];
  for (const source of configuredSources) {
    if (source.kind !== "INDEX" && source.kind !== "MONTHLY") {
      throw new SpaceConflictError(`Canonical source ${source.path} has an invalid kind.`);
    }
    assertAbsolutePath(source.path, "Canonical source path");
    if (seen.has(source.path)) throw new SpaceConflictError(`Canonical source ${source.path} is duplicated.`);
    seen.add(source.path);
    const file = await safeReadRegularFile(source.path, "Canonical source", MAX_CANONICAL_SOURCE_BYTES);
    sources.push({
      ...source,
      ...file
    });
  }
  const target = sources.find((source) => source.path === targetPath);
  if (!target) throw new SpaceConflictError(`Memory change target ${targetPath} is outside the canonical source allowlist.`);
  return { sources, target };
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => Promise<void>> {
  assertAbsolutePath(lockPath, "Canonical memory lock path");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new SpaceConflictError("Canonical memory lock timeout must be between 0 and 60000 milliseconds.");
  }
  await assertSafeDirectory(dirname(lockPath), "Canonical memory lock directory", true);
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - startedAt >= timeoutMs) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SpaceConflictError(`Canonical memory lock ${lockPath} was not acquired within ${timeoutMs}ms.`);
        }
        throw error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_RETRY_MS));
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSafeJournalRoot(journalRoot: string, create: boolean): Promise<void> {
  await assertSafeDirectory(journalRoot, "Memory mutation journal root", create);
}

async function atomicWriteJournal(path: string, journal: MemoryMutationJournal): Promise<void> {
  const parsed = memoryMutationJournalSchema.parse(journal);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function sourceHash(sources: ValidatedSource[]): Promise<string> {
  const { calculateMemoryGraphSourceHash } = await import("@space/memory-graph");
  return calculateMemoryGraphSourceHash(sources.map(({ path, kind, content }) => ({ path, kind, content })));
}

async function journalExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Applies one approved whole-file canonical memory mutation under an exclusive lock.
 * The returned WRITTEN journal must be retained until a future adapter persists APPLIED.
 */
export async function executeCanonicalMemoryMutation(
  changeSet: MemoryChangeSet,
  options: CanonicalMemoryMutationOptions
): Promise<MemoryMutationExecutionResult> {
  changeSet = memoryChangeSetSchema.parse(changeSet);
  if (changeSet.status !== "APPROVED") {
    throw new SpaceConflictError(`Memory change set ${changeSet.id} must be APPROVED before execution.`);
  }
  assertImmutableSnapshots(changeSet);
  const startedAt = Date.now();
  const releaseLock = await acquireLock(options.lockPath, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  let temporaryPath: string | null = null;
  let journalPath: string | null = null;
  let journalCreated = false;
  let replaced = false;
  try {
    await options.hooks?.afterLock?.();
    const validated = await validateAndReadSources(options.sources, changeSet.sourcePath);
    if (validated.target.content !== changeSet.beforeSnapshot) {
      throw new SpaceConflictError(`Memory change set ${changeSet.id} target does not match its exact before snapshot.`);
    }
    if (await sourceHash(validated.sources) !== changeSet.expectedSourceHash) {
      throw new SpaceConflictError(`Memory change set ${changeSet.id} expected source hash is stale.`);
    }

    await assertSafeJournalRoot(options.journalRoot, true);
    journalPath = journalPathFor(changeSet.id, options.journalRoot);
    if (await journalExists(journalPath)) {
      throw new SpaceConflictError(`Memory change set ${changeSet.id} already has recovery evidence.`);
    }
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const prepared: MemoryMutationJournal = {
      version: 1,
      phase: "PREPARED",
      changeSetId: changeSet.id,
      sourcePath: changeSet.sourcePath,
      expectedSourceHash: changeSet.expectedSourceHash,
      beforeContentHash: changeSet.beforeContentHash,
      afterContentHash: changeSet.afterContentHash,
      resultingSourceHash: null,
      preparedAt: timestamp,
      updatedAt: timestamp
    };
    await atomicWriteJournal(journalPath, prepared);
    journalCreated = true;
    await options.hooks?.afterPrepared?.();

    temporaryPath = join(
      dirname(changeSet.sourcePath),
      `.${basename(changeSet.sourcePath)}.${changeSet.id}.${process.pid}.${Date.now()}.tmp`
    );
    const targetHandle = await open(temporaryPath, "wx", validated.target.mode);
    try {
      await targetHandle.chown(validated.target.uid, validated.target.gid);
      await targetHandle.chmod(validated.target.mode);
      const temporaryStat = await targetHandle.stat();
      if (
        temporaryStat.uid !== validated.target.uid ||
        temporaryStat.gid !== validated.target.gid ||
        (temporaryStat.mode & 0o7777) !== validated.target.mode
      ) {
        throw new SpaceConflictError("Canonical memory temporary file did not preserve target ownership and mode.");
      }
      await targetHandle.writeFile(changeSet.afterSnapshot, "utf8");
      await targetHandle.sync();
      await options.hooks?.afterTemporaryFileSynced?.();
    } finally {
      await targetHandle.close();
    }
    await rename(temporaryPath, changeSet.sourcePath);
    temporaryPath = null;
    replaced = true;
    await options.hooks?.afterRename?.();
    await syncDirectory(dirname(changeSet.sourcePath));
    await options.hooks?.afterDirectorySynced?.();

    const after = await validateAndReadSources(options.sources, changeSet.sourcePath);
    if (hashMemorySnapshot(after.target.content) !== changeSet.afterContentHash || after.target.content !== changeSet.afterSnapshot) {
      throw new SpaceConflictError(`Memory change set ${changeSet.id} failed exact post-write verification.`);
    }
    const resultingSourceHash = await sourceHash(after.sources);
    const written: MemoryMutationJournal = {
      ...prepared,
      phase: "WRITTEN",
      resultingSourceHash,
      updatedAt: (options.now ?? (() => new Date()))().toISOString()
    };
    await atomicWriteJournal(journalPath, written);
    await options.hooks?.afterWritten?.();
    return memoryMutationExecutionResultSchema.parse({
      status: "APPLIED",
      changeSetId: changeSet.id,
      sourcePath: changeSet.sourcePath,
      resultingSourceHash,
      journalPath,
      durationMs: Math.max(0, Date.now() - startedAt)
    });
  } catch (error) {
    try {
      if (temporaryPath) await rm(temporaryPath, { force: true });
      if (journalCreated && !replaced && journalPath) {
        await rm(journalPath, { force: true });
        await syncDirectory(options.journalRoot);
      }
    } catch (cleanupError) {
      throw new CanonicalMemoryMutationExecutionError(
        "Canonical memory mutation failed and its temporary evidence could not be cleaned safely.",
        changeSet.id,
        replaced,
        cleanupError
      );
    }
    throw new CanonicalMemoryMutationExecutionError(
      error instanceof Error ? error.message : "Canonical memory mutation failed.",
      changeSet.id,
      replaced,
      error
    );
  } finally {
    await releaseLock();
  }
}

/**
 * Removes a WRITTEN journal only after the durable change set is APPLIED with the same result hash.
 */
export async function finalizeCanonicalMemoryMutationJournal(
  changeSet: MemoryChangeSet,
  options: CanonicalMemoryMutationOptions
): Promise<void> {
  changeSet = memoryChangeSetSchema.parse(changeSet);
  if (changeSet.status !== "APPLIED" || !changeSet.resultingSourceHash) {
    throw new SpaceConflictError(`Memory change set ${changeSet.id} must be APPLIED before journal finalization.`);
  }
  const releaseLock = await acquireLock(options.lockPath, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    assertImmutableSnapshots(changeSet);
    const journal = await readJournal(changeSet, options.journalRoot);
    if (
      journal.phase !== "WRITTEN" ||
      journal.changeSetId !== changeSet.id ||
      journal.sourcePath !== changeSet.sourcePath ||
      journal.expectedSourceHash !== changeSet.expectedSourceHash ||
      journal.beforeContentHash !== changeSet.beforeContentHash ||
      journal.afterContentHash !== changeSet.afterContentHash ||
      journal.resultingSourceHash !== changeSet.resultingSourceHash
    ) {
      throw new SpaceConflictError(`Memory change set ${changeSet.id} does not match its WRITTEN journal evidence.`);
    }
    await rm(journalPathFor(changeSet.id, options.journalRoot));
    await syncDirectory(options.journalRoot);
  } finally {
    await releaseLock();
  }
}

async function readJournal(changeSet: MemoryChangeSet, journalRoot: string): Promise<MemoryMutationJournal> {
  await assertSafeJournalRoot(journalRoot, false);
  const path = journalPathFor(changeSet.id, journalRoot);
  const journal = await safeReadRegularFile(path, "Memory mutation journal", MAX_JOURNAL_BYTES);
  return memoryMutationJournalSchema.parse(JSON.parse(journal.content));
}

/**
 * Classifies an interrupted APPLYING mutation from immutable hashes and journal evidence.
 * Recovery never writes canonical sources or removes the journal.
 */
export async function recoverCanonicalMemoryMutation(
  changeSet: MemoryChangeSet,
  options: CanonicalMemoryMutationOptions
): Promise<MemoryMutationRecoveryResult> {
  changeSet = memoryChangeSetSchema.parse(changeSet);
  if (changeSet.status !== "APPLYING") {
    throw new SpaceConflictError(`Memory change set ${changeSet.id} must be APPLYING for recovery.`);
  }
  const releaseLock = await acquireLock(options.lockPath, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    let journal: MemoryMutationJournal;
    try {
      assertImmutableSnapshots(changeSet);
      journal = await readJournal(changeSet, options.journalRoot);
    } catch (error) {
      return operatorRequired(changeSet, error instanceof Error ? error.message : "Mutation journal validation failed.");
    }
    if (
      journal.changeSetId !== changeSet.id ||
      journal.sourcePath !== changeSet.sourcePath ||
      journal.expectedSourceHash !== changeSet.expectedSourceHash ||
      journal.beforeContentHash !== changeSet.beforeContentHash ||
      journal.afterContentHash !== changeSet.afterContentHash
    ) {
      return operatorRequired(changeSet, "Mutation journal identity or immutable hashes do not match the applying change set.");
    }

    let validated: { sources: ValidatedSource[]; target: ValidatedSource };
    try {
      validated = await validateAndReadSources(options.sources, changeSet.sourcePath);
    } catch (error) {
      return operatorRequired(changeSet, error instanceof Error ? error.message : "Canonical source validation failed.");
    }
    const reconstructedBefore = validated.sources.map((source) =>
      source.path === changeSet.sourcePath ? { ...source, content: changeSet.beforeSnapshot } : source
    );
    if (await sourceHash(reconstructedBefore) !== changeSet.expectedSourceHash) {
      return operatorRequired(changeSet, "Another canonical source drifted after the mutation was approved.");
    }

    const currentHash = hashMemorySnapshot(validated.target.content);
    if (currentHash === changeSet.afterContentHash && validated.target.content === changeSet.afterSnapshot) {
      const resultingSourceHash = await sourceHash(validated.sources);
      if (journal.phase === "WRITTEN" && journal.resultingSourceHash !== resultingSourceHash) {
        return operatorRequired(changeSet, "Written journal result hash does not match the canonical sources.");
      }
      return memoryMutationRecoveryResultSchema.parse({
        status: "COMPLETE_APPLIED",
        changeSetId: changeSet.id,
        sourcePath: changeSet.sourcePath,
        resultingSourceHash,
        reason: null
      });
    }
    if (currentHash === changeSet.beforeContentHash && validated.target.content === changeSet.beforeSnapshot) {
      if (journal.phase === "WRITTEN") {
        return operatorRequired(changeSet, "Written journal conflicts with canonical before-content.");
      }
      return memoryMutationRecoveryResultSchema.parse({
        status: "COMPLETE_FAILED",
        changeSetId: changeSet.id,
        sourcePath: changeSet.sourcePath,
        resultingSourceHash: null,
        reason: "Canonical source remains at the exact approved before snapshot."
      });
    }
    return operatorRequired(changeSet, "Canonical content matches neither immutable mutation snapshot.");
  } finally {
    await releaseLock();
  }
}
