import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryChangeSet, MemoryMutationJournal } from "@space/contracts";
import { calculateMemoryGraphSourceHash } from "@space/memory-graph";
import { describe, expect, it } from "vitest";
import {
  CanonicalMemoryMutationExecutionError,
  executeCanonicalMemoryMutation,
  finalizeCanonicalMemoryMutationJournal,
  recoverCanonicalMemoryMutation,
  type CanonicalMemoryMutationOptions
} from "../src/memory-mutation-executor.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(kind: MemoryChangeSet["kind"] = "EDIT") {
  const root = await mkdtemp(join(tmpdir(), "space-memory-mutation-"));
  const indexPath = join(root, "gemini_history.md");
  const monthlyPath = join(root, "gemini_history_2026-07.md");
  const journalRoot = join(root, "journals");
  const lockPath = join(root, "canonical-memory.lock");
  const indexContent = "# Canonical index\n\n## Current month\n";
  const beforeSnapshot = "# July\n\n## 2026-07-13 03:30 EEST - Before\n\nOriginal memory.\n";
  const afterSnapshot = "# July\n\n## 2026-07-13 03:30 EEST - After\n\nApproved memory.\n";
  await writeFile(indexPath, indexContent, "utf8");
  await writeFile(monthlyPath, beforeSnapshot, "utf8");
  await chmod(monthlyPath, 0o640);
  const sources = [
    { path: indexPath, kind: "INDEX" as const },
    { path: monthlyPath, kind: "MONTHLY" as const }
  ];
  const expectedSourceHash = calculateMemoryGraphSourceHash([
    { ...sources[0], content: indexContent },
    { ...sources[1], content: beforeSnapshot }
  ]);
  const changeSet: MemoryChangeSet = {
    id: `memory_change:${kind.toLowerCase()}`,
    kind,
    status: "APPROVED",
    sourcePath: monthlyPath,
    recordIds: ["memory_record:test"],
    resolvesIssueIds: [],
    expectedSourceHash,
    resultingSourceHash: null,
    beforeContentHash: hash(beforeSnapshot),
    afterContentHash: hash(afterSnapshot),
    beforeSnapshot,
    afterSnapshot,
    reason: "Approved fixture mutation.",
    statusReason: null,
    actorUserId: "user:test",
    traceId: "trace:test",
    rollbackOfChangeSetId: kind === "ROLLBACK" ? "memory_change:target" : null,
    rolledBackByChangeSetId: null,
    createdAt: "2026-07-13T01:00:00.000Z",
    updatedAt: "2026-07-13T01:01:00.000Z",
    appliedAt: null,
    failedAt: null,
    rolledBackAt: null
  };
  const options: CanonicalMemoryMutationOptions = {
    sources,
    journalRoot,
    lockPath,
    lockTimeoutMs: 50,
    now: () => new Date("2026-07-13T01:02:00.000Z")
  };
  return { root, indexPath, monthlyPath, journalRoot, lockPath, indexContent, beforeSnapshot, afterSnapshot, sources, changeSet, options };
}

describe("canonical memory mutation executor", () => {
  it.each(["EDIT", "MERGE", "ARCHIVE", "ROLLBACK"] as const)("atomically applies an approved %s and retains bounded recovery evidence", async (kind) => {
    const test = await fixture(kind);
    const beforeStat = await lstat(test.monthlyPath);

    const result = await executeCanonicalMemoryMutation(test.changeSet, test.options);
    const journalText = await readFile(result.journalPath, "utf8");
    const journal = JSON.parse(journalText) as MemoryMutationJournal;
    const afterStat = await lstat(test.monthlyPath);

    expect(result).toMatchObject({ status: "APPLIED", changeSetId: test.changeSet.id, sourcePath: test.monthlyPath });
    expect(await readFile(test.monthlyPath, "utf8")).toBe(test.afterSnapshot);
    expect(await readFile(test.indexPath, "utf8")).toBe(test.indexContent);
    expect(afterStat.mode & 0o777).toBe(beforeStat.mode & 0o777);
    expect({ uid: afterStat.uid, gid: afterStat.gid }).toEqual({ uid: beforeStat.uid, gid: beforeStat.gid });
    expect(journal).toMatchObject({ phase: "WRITTEN", resultingSourceHash: result.resultingSourceHash });
    expect(journalText).not.toContain(test.beforeSnapshot);
    expect(journalText).not.toContain(test.afterSnapshot);
  });

  it("fails closed before journaling for invalid state, stale content, stale aggregate hash, and unsafe paths", async () => {
    const invalidState = await fixture();
    await expect(executeCanonicalMemoryMutation({ ...invalidState.changeSet, status: "PROPOSED" }, invalidState.options)).rejects.toThrow(
      /APPROVED/
    );

    const staleContent = await fixture();
    await writeFile(staleContent.monthlyPath, "unexpected concurrent content\n", "utf8");
    await expect(executeCanonicalMemoryMutation(staleContent.changeSet, staleContent.options)).rejects.toThrow(/before snapshot/i);
    await expect(lstat(staleContent.journalRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const staleAggregate = await fixture();
    await writeFile(staleAggregate.indexPath, "# Changed index\n", "utf8");
    await expect(executeCanonicalMemoryMutation(staleAggregate.changeSet, staleAggregate.options)).rejects.toThrow(/source hash/i);
    expect(await readFile(staleAggregate.monthlyPath, "utf8")).toBe(staleAggregate.beforeSnapshot);

    const unsafe = await fixture();
    const realTarget = join(unsafe.root, "real-month.md");
    const linkedTarget = join(unsafe.root, "linked-month.md");
    await writeFile(realTarget, unsafe.beforeSnapshot, "utf8");
    await symlink(realTarget, linkedTarget);
    const unsafeSources = unsafe.sources.map((source) => source.path === unsafe.monthlyPath ? { ...source, path: linkedTarget } : source);
    await expect(
      executeCanonicalMemoryMutation(
        { ...unsafe.changeSet, sourcePath: linkedTarget },
        { ...unsafe.options, sources: unsafeSources }
      )
    ).rejects.toThrow(/symbolic link|regular file|real path/i);

    await expect(
      executeCanonicalMemoryMutation(unsafe.changeSet, {
        ...unsafe.options,
        sources: [...unsafe.sources, unsafe.sources[0]!]
      })
    ).rejects.toThrow(/duplicated/i);
    await expect(
      executeCanonicalMemoryMutation(
        { ...unsafe.changeSet, sourcePath: realTarget },
        unsafe.options
      )
    ).rejects.toThrow(/allowlist/i);
    await expect(
      executeCanonicalMemoryMutation(
        { ...unsafe.changeSet, sourcePath: unsafe.root },
        { ...unsafe.options, sources: [{ path: unsafe.root, kind: "MONTHLY" }] }
      )
    ).rejects.toThrow(/regular file/i);
    await expect(
      executeCanonicalMemoryMutation(
        { ...unsafe.changeSet, id: "../../unsafe-journal" },
        unsafe.options
      )
    ).rejects.toThrow();
  });

  it("serializes mutation execution with a bounded exclusive lock", async () => {
    const first = await fixture();
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const running = executeCanonicalMemoryMutation(first.changeSet, {
      ...first.options,
      hooks: {
        afterLock: async () => {
          signalLocked();
          await release;
        }
      }
    });
    await locked;
    await expect(
      executeCanonicalMemoryMutation(first.changeSet, { ...first.options, lockTimeoutMs: 10 })
    ).rejects.toThrow(/lock/i);
    releaseLock();
    await expect(running).resolves.toMatchObject({ status: "APPLIED" });
  });

  it("recovers a rename-boundary crash by exact hashes without rewriting canonical content", async () => {
    const test = await fixture();
    await expect(
      executeCanonicalMemoryMutation(test.changeSet, {
        ...test.options,
        hooks: { afterRename: () => { throw new Error("injected crash after rename"); } }
      })
    ).rejects.toThrow(/injected crash/);
    expect(await readFile(test.monthlyPath, "utf8")).toBe(test.afterSnapshot);

    const recovered = await recoverCanonicalMemoryMutation(
      { ...test.changeSet, status: "APPLYING" },
      test.options
    );
    expect(recovered).toMatchObject({ status: "COMPLETE_APPLIED", changeSetId: test.changeSet.id });
    expect(await readFile(test.monthlyPath, "utf8")).toBe(test.afterSnapshot);
  });

  it("preserves the correct evidence on every injected commit boundary", async () => {
    const preCommitHooks = ["afterPrepared", "afterTemporaryFileSynced"] as const;
    for (const hook of preCommitHooks) {
      const test = await fixture();
      const execution = executeCanonicalMemoryMutation(test.changeSet, {
          ...test.options,
          hooks: { [hook]: () => { throw new Error(`injected ${hook}`); } }
        });
      await expect(execution).rejects.toMatchObject({
        name: "CanonicalMemoryMutationExecutionError",
        canonicalReplaced: false
      });
      expect(await readFile(test.monthlyPath, "utf8")).toBe(test.beforeSnapshot);
      await expect(readFile(join(test.journalRoot, `${test.changeSet.id}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(test.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }

    const postCommitHooks = ["afterRename", "afterDirectorySynced", "afterWritten"] as const;
    for (const hook of postCommitHooks) {
      const test = await fixture();
      const execution = executeCanonicalMemoryMutation(test.changeSet, {
          ...test.options,
          hooks: { [hook]: () => { throw new Error(`injected ${hook}`); } }
        });
      await expect(execution).rejects.toMatchObject({
        name: "CanonicalMemoryMutationExecutionError",
        canonicalReplaced: true
      });
      expect(await readFile(test.monthlyPath, "utf8")).toBe(test.afterSnapshot);
      const journal = JSON.parse(await readFile(join(test.journalRoot, `${test.changeSet.id}.json`), "utf8")) as MemoryMutationJournal;
      expect(journal.phase).toBe(hook === "afterWritten" ? "WRITTEN" : "PREPARED");
    }
  });

  it("removes WRITTEN evidence only after the durable change set is APPLIED", async () => {
    const test = await fixture();
    const result = await executeCanonicalMemoryMutation(test.changeSet, test.options);
    const journalPath = join(test.journalRoot, `${test.changeSet.id}.json`);

    await expect(
      finalizeCanonicalMemoryMutationJournal({ ...test.changeSet, status: "APPLYING" }, test.options)
    ).rejects.toThrow(/APPLIED/);
    expect(await readFile(journalPath, "utf8")).toContain("WRITTEN");

    await finalizeCanonicalMemoryMutationJournal(
      {
        ...test.changeSet,
        status: "APPLIED",
        resultingSourceHash: result.resultingSourceHash,
        appliedAt: "2026-07-13T01:03:00.000Z"
      },
      test.options
    );
    await expect(readFile(journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(CanonicalMemoryMutationExecutionError.name).toBe("CanonicalMemoryMutationExecutionError");
  });

  it("classifies exact-before and ambiguous recovery states without writing sources", async () => {
    const exactBefore = await fixture();
    await mkdir(exactBefore.journalRoot, { recursive: true });
    const journal: MemoryMutationJournal = {
      version: 1,
      phase: "PREPARED",
      changeSetId: exactBefore.changeSet.id,
      sourcePath: exactBefore.monthlyPath,
      expectedSourceHash: exactBefore.changeSet.expectedSourceHash,
      beforeContentHash: exactBefore.changeSet.beforeContentHash,
      afterContentHash: exactBefore.changeSet.afterContentHash,
      resultingSourceHash: null,
      preparedAt: "2026-07-13T01:02:00.000Z",
      updatedAt: "2026-07-13T01:02:00.000Z"
    };
    await writeFile(join(exactBefore.journalRoot, `${exactBefore.changeSet.id}.json`), `${JSON.stringify(journal)}\n`, "utf8");
    await expect(
      recoverCanonicalMemoryMutation({ ...exactBefore.changeSet, status: "APPLYING" }, exactBefore.options)
    ).resolves.toMatchObject({ status: "COMPLETE_FAILED", resultingSourceHash: null });
    expect(await readFile(exactBefore.monthlyPath, "utf8")).toBe(exactBefore.beforeSnapshot);

    await writeFile(exactBefore.monthlyPath, "unknown operator content\n", "utf8");
    const unknownBefore = await readFile(exactBefore.monthlyPath, "utf8");
    await expect(
      recoverCanonicalMemoryMutation({ ...exactBefore.changeSet, status: "APPLYING" }, exactBefore.options)
    ).resolves.toMatchObject({ status: "OPERATOR_REQUIRED", resultingSourceHash: null });
    expect(await readFile(exactBefore.monthlyPath, "utf8")).toBe(unknownBefore);
  });

  it("requires an operator for drifted, malformed, mismatched, or phase-inconsistent recovery evidence", async () => {
    const drifted = await fixture();
    await expect(
      executeCanonicalMemoryMutation(drifted.changeSet, {
        ...drifted.options,
        hooks: { afterRename: () => { throw new Error("retain prepared journal"); } }
      })
    ).rejects.toThrow(/retain prepared/);
    await writeFile(drifted.indexPath, "# Concurrent canonical index change\n", "utf8");
    const driftedBytes = await readFile(drifted.monthlyPath, "utf8");
    await expect(
      recoverCanonicalMemoryMutation({ ...drifted.changeSet, status: "APPLYING" }, drifted.options)
    ).resolves.toMatchObject({ status: "OPERATOR_REQUIRED", reason: expect.stringMatching(/drifted/i) });
    expect(await readFile(drifted.monthlyPath, "utf8")).toBe(driftedBytes);

    const malformed = await fixture();
    await mkdir(malformed.journalRoot, { recursive: true });
    const malformedPath = join(malformed.journalRoot, `${malformed.changeSet.id}.json`);
    await writeFile(malformedPath, "{not-json}\n", "utf8");
    await expect(
      recoverCanonicalMemoryMutation({ ...malformed.changeSet, status: "APPLYING" }, malformed.options)
    ).resolves.toMatchObject({ status: "OPERATOR_REQUIRED" });

    const mismatched = await fixture();
    await mkdir(mismatched.journalRoot, { recursive: true });
    const mismatchedJournal: MemoryMutationJournal = {
      version: 1,
      phase: "PREPARED",
      changeSetId: "memory_change:different",
      sourcePath: mismatched.monthlyPath,
      expectedSourceHash: mismatched.changeSet.expectedSourceHash,
      beforeContentHash: mismatched.changeSet.beforeContentHash,
      afterContentHash: mismatched.changeSet.afterContentHash,
      resultingSourceHash: null,
      preparedAt: "2026-07-13T01:02:00.000Z",
      updatedAt: "2026-07-13T01:02:00.000Z"
    };
    await writeFile(
      join(mismatched.journalRoot, `${mismatched.changeSet.id}.json`),
      `${JSON.stringify(mismatchedJournal)}\n`,
      "utf8"
    );
    await expect(
      recoverCanonicalMemoryMutation({ ...mismatched.changeSet, status: "APPLYING" }, mismatched.options)
    ).resolves.toMatchObject({ status: "OPERATOR_REQUIRED", reason: expect.stringMatching(/identity/i) });

    const inconsistent = await fixture();
    await mkdir(inconsistent.journalRoot, { recursive: true });
    const writtenBefore: MemoryMutationJournal = {
      version: 1,
      phase: "WRITTEN",
      changeSetId: inconsistent.changeSet.id,
      sourcePath: inconsistent.monthlyPath,
      expectedSourceHash: inconsistent.changeSet.expectedSourceHash,
      beforeContentHash: inconsistent.changeSet.beforeContentHash,
      afterContentHash: inconsistent.changeSet.afterContentHash,
      resultingSourceHash: "f".repeat(64),
      preparedAt: "2026-07-13T01:02:00.000Z",
      updatedAt: "2026-07-13T01:03:00.000Z"
    };
    await writeFile(
      join(inconsistent.journalRoot, `${inconsistent.changeSet.id}.json`),
      `${JSON.stringify(writtenBefore)}\n`,
      "utf8"
    );
    await expect(
      recoverCanonicalMemoryMutation({ ...inconsistent.changeSet, status: "APPLYING" }, inconsistent.options)
    ).resolves.toMatchObject({ status: "OPERATOR_REQUIRED", reason: expect.stringMatching(/conflicts/i) });
  });
});
