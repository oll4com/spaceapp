import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryGraphSnapshot, createMemoryGraphSnapshotStore } from "@space/memory-graph";
import type { MemoryGraphSnapshot } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryGraphService } from "../src/memory-graph-service.js";

describe("memory graph service", () => {
  it("returns a read-only cache miss without reading canonical sources or writing a snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-cache-miss-"));
    const graphRoot = join(root, "graph");
    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath: join(root, "missing-index.md"),
      monthlyPath: join(root, "missing-monthly.md")
    });

    expect(await service.getCachedSnapshot()).toBeNull();
    await expect(readFile(join(graphRoot, "snapshot.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds and persists one snapshot, then reports canonical source changes as stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    await writeFile(monthlyPath, "# July\n\n## 2026-07-13 08:00 EEST - Durable fact\n\n- body\n", "utf8");
    const service = createMemoryGraphService({
      rootDir: join(root, "graph"),
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-13T09:00:00.000Z")
    });

    const initial = await service.getSnapshot();
    expect(initial.isStale).toBe(false);
    expect(initial.snapshot.generatedAt).toBe("2026-07-13T09:00:00.000Z");
    expect(initial.snapshot.records).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "graph", "snapshot.json"), "utf8"))).toMatchObject({
      sourceHash: initial.snapshot.sourceHash
    });

    await writeFile(monthlyPath, "# July\n\n## 2026-07-13 08:00 EEST - Changed fact\n\n- changed\n", "utf8");
    const changed = await service.getSnapshot();
    expect(changed.snapshot.sourceHash).toBe(initial.snapshot.sourceHash);
    expect(changed.isStale).toBe(true);
    expect(await service.getCachedSnapshot()).toBeNull();

    const refreshedSnapshot = buildMemoryGraphSnapshot({
      sources: [
        { path: indexPath, kind: "INDEX", content: await readFile(indexPath, "utf8") },
        { path: monthlyPath, kind: "MONTHLY", content: await readFile(monthlyPath, "utf8") }
      ],
      generatedAt: "2026-07-13T09:30:00.000Z"
    });
    await createMemoryGraphSnapshotStore({ rootDir: join(root, "graph") }).write(refreshedSnapshot);
    const refreshed = await service.getSnapshot();
    expect(refreshed.snapshot.sourceHash).toBe(refreshedSnapshot.sourceHash);
    expect(refreshed.snapshot.generatedAt).toBe("2026-07-13T09:30:00.000Z");
    expect(refreshed.isStale).toBe(false);

    const restarted = createMemoryGraphService({
      rootDir: join(root, "graph"),
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-13T10:00:00.000Z")
    });
    const persisted = await restarted.getSnapshot();
    expect(persisted.snapshot.generatedAt).toBe("2026-07-13T09:30:00.000Z");
    expect(persisted.isStale).toBe(false);
    expect((await restarted.getCachedSnapshot())?.sourceHash).toBe(refreshedSnapshot.sourceHash);

    await restarted.invalidateCachedSnapshot();
    expect(await restarted.getCachedSnapshot()).toBeNull();
    await expect(readFile(join(root, "graph", "snapshot.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically rebuilds a legacy snapshot whose nodes have no persisted positions", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-legacy-layout-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const graphRoot = join(root, "graph");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    const memoryBlocks = Array.from({ length: 221 }, (_, index) => [
      `## 2026-07-13 08:${String(index % 60).padStart(2, "0")} EEST - Durable fact ${index}`,
      index === 0
        ? "- Source: test; original_scope=ROOM, room=room:test; provenance=operator; trace=req:legacy."
        : "- Source: test; original_scope=SYSTEM; provenance=operator; trace=req:legacy.",
      `- Durable body ${index}.`
    ].join("\n"));
    await writeFile(monthlyPath, `# July\n\n${memoryBlocks.join("\n\n")}\n`, "utf8");

    const current = buildMemoryGraphSnapshot({
      sources: [
        { path: indexPath, kind: "INDEX", content: await readFile(indexPath, "utf8") },
        { path: monthlyPath, kind: "MONTHLY", content: await readFile(monthlyPath, "utf8") }
      ],
      generatedAt: "2026-07-13T08:30:00.000Z"
    });
    expect(current.nodes).toHaveLength(447);
    const legacy = {
      ...current,
      version: 1,
      layoutVersion: undefined,
      taxonomyVersion: undefined,
      revisionHash: undefined,
      nodes: current.nodes.map(({ position: _position, ...node }) => node)
    } as unknown as MemoryGraphSnapshot;
    await createMemoryGraphSnapshotStore({ rootDir: graphRoot }).write(legacy);

    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-13T09:00:00.000Z")
    });
    const upgraded = await service.getSnapshot();

    expect(upgraded.isStale).toBe(false);
    expect(upgraded.snapshot).toMatchObject({
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      generatedAt: "2026-07-13T09:00:00.000Z"
    });
    expect(upgraded.snapshot.nodes).toHaveLength(447);
    expect(upgraded.snapshot.nodes.every((node) => node.position !== undefined)).toBe(true);
    for (const mode of ["clustered", "relations"] as const) {
      const coordinates = upgraded.snapshot.nodes.map((node) => `${node.position![mode].x},${node.position![mode].y}`);
      expect(new Set(coordinates)).toHaveLength(447);
    }

    const persisted = JSON.parse(await readFile(join(graphRoot, "snapshot.json"), "utf8"));
    expect(persisted).toMatchObject({
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: upgraded.snapshot.revisionHash
    });
    expect(persisted.nodes.every((node: { position?: unknown }) => node.position !== undefined)).toBe(true);
  });

  it("rebuilds a persisted snapshot when its taxonomy contract version is outdated", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-legacy-taxonomy-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const graphRoot = join(root, "graph");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    await writeFile(monthlyPath, [
      "# July",
      "",
      "## 2026-07-13 08:00 EEST - Taxonomy contract",
      "",
      "- Tags: Space, Memory Graph",
      "- Commit 8db7444a2 delivered the graph taxonomy."
    ].join("\n"), "utf8");

    const current = buildMemoryGraphSnapshot({
      sources: [
        { path: indexPath, kind: "INDEX", content: await readFile(indexPath, "utf8") },
        { path: monthlyPath, kind: "MONTHLY", content: await readFile(monthlyPath, "utf8") }
      ],
      generatedAt: "2026-07-13T08:30:00.000Z"
    });
    const outdated = { ...current, taxonomyVersion: 1 } as MemoryGraphSnapshot;
    await createMemoryGraphSnapshotStore({ rootDir: graphRoot }).write(outdated);

    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-13T09:00:00.000Z")
    });
    const upgraded = await service.getSnapshot();

    expect(upgraded.isStale).toBe(false);
    expect(upgraded.snapshot).toMatchObject({
      taxonomyVersion: 2,
      generatedAt: "2026-07-13T09:00:00.000Z"
    });
    expect(JSON.parse(await readFile(join(graphRoot, "snapshot.json"), "utf8"))).toMatchObject({
      taxonomyVersion: 2,
      generatedAt: "2026-07-13T09:00:00.000Z"
    });
  });

  it("lists available months and builds a persisted all-months archive snapshot from monthly files", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-archive-"));
    const indexPath = join(root, "gemini_history.md");
    const graphRoot = join(root, "graph");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    await writeFile(join(root, "gemini_history_2026-06.md"), "# June\n\n## 2026-06-13 08:00 EEST - June fact\n\n- body\n", "utf8");
    await writeFile(join(root, "gemini_history_2026-07.md"), "# July\n\n## 2026-07-13 08:00 EEST - July fact\n\n- body\n", "utf8");

    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath,
      monthlyPath: join(root, "gemini_history_2026-07.md"),
      now: () => new Date("2026-07-13T09:00:00.000Z")
    });

    expect(await service.listAvailableMonths()).toEqual(["2026-06", "2026-07"]);

    const archive = await service.getArchiveSnapshot();
    expect(archive.generatedAt).toBe("2026-07-13T09:00:00.000Z");
    expect(archive.nodes.filter((node) => node.type === "SOURCE").map((node) => node.sourcePath)).toEqual(
      expect.arrayContaining([
        join(root, "gemini_history_2026-06.md"),
        join(root, "gemini_history_2026-07.md")
      ])
    );
    expect(archive.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/June fact/), expect.stringMatching(/July fact/)])
    );

    const persisted = JSON.parse(await readFile(join(graphRoot, "snapshot-all-months.json"), "utf8"));
    expect(persisted).toMatchObject({ revisionHash: archive.revisionHash });

    const cached = await service.getArchiveSnapshot();
    expect(cached).toEqual(archive);
    expect((await service.getArchiveSnapshotState!()).isStale).toBe(false);
    await writeFile(join(root, "gemini_history_2026-06.md"), "# Changed archive\n");
    expect((await service.getArchiveSnapshotState!()).isStale).toBe(true);
  });

  it("serves a persisted all-months archive snapshot without rebuilding it per request", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-archive-cache-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const graphRoot = join(root, "graph");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    await writeFile(monthlyPath, "# July\n\n## 2026-07-13 08:00 EEST - July fact\n\n- body\n", "utf8");
    const sources = [
      { path: indexPath, kind: "INDEX" as const, content: await readFile(indexPath, "utf8") },
      { path: monthlyPath, kind: "MONTHLY" as const, content: await readFile(monthlyPath, "utf8") }
    ];
    const persistedArchive = buildMemoryGraphSnapshot({ sources, generatedAt: "2026-07-13T09:00:00.000Z" });
    await createMemoryGraphSnapshotStore({ rootDir: graphRoot, filename: "snapshot-all-months.json" }).write(persistedArchive);
    const builds: unknown[] = [];
    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-14T09:00:00.000Z"),
      buildArchiveSnapshot: async ({ previousSnapshot }) => {
        builds.push(previousSnapshot);
        return persistedArchive;
      }
    });

    expect(await service.getArchiveSnapshot()).toMatchObject({ revisionHash: persistedArchive.revisionHash });
    expect(await service.getArchiveSnapshot()).toMatchObject({ revisionHash: persistedArchive.revisionHash });
    expect((await service.getArchiveSnapshotState!()).snapshot.revisionHash).toBe(persistedArchive.revisionHash);
    expect(builds).toHaveLength(0);
  });

  it("builds an unusable all-months archive snapshot once and serves the rebuild from memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-api-archive-rebuild-"));
    const indexPath = join(root, "gemini_history.md");
    const monthlyPath = join(root, "gemini_history_2026-07.md");
    const graphRoot = join(root, "graph");
    await writeFile(indexPath, "# History\n\n## Current month\n", "utf8");
    await writeFile(monthlyPath, "# July\n\n## 2026-07-13 08:00 EEST - July fact\n\n- body\n", "utf8");
    const sources = [
      { path: indexPath, kind: "INDEX" as const, content: await readFile(indexPath, "utf8") },
      { path: monthlyPath, kind: "MONTHLY" as const, content: await readFile(monthlyPath, "utf8") }
    ];
    const rebuilt = buildMemoryGraphSnapshot({ sources, generatedAt: "2026-07-13T09:00:00.000Z" });
    // A snapshot that fails the uniqueness contract can never be read back, so the archive must not
    // rebuild it on every request the way it did before.
    const duplicateRecords = {
      ...rebuilt,
      records: [...rebuilt.records, rebuilt.records[0]!]
    };
    await createMemoryGraphSnapshotStore({ rootDir: graphRoot, filename: "snapshot-all-months.json" }).write(duplicateRecords);
    let buildCount = 0;
    const service = createMemoryGraphService({
      rootDir: graphRoot,
      indexPath,
      monthlyPath,
      now: () => new Date("2026-07-14T09:00:00.000Z"),
      buildArchiveSnapshot: async () => {
        buildCount += 1;
        return rebuilt;
      }
    });

    const first = await service.getArchiveSnapshot();
    const second = await service.getArchiveSnapshot();
    const third = await service.getArchiveSnapshotState!();

    expect(buildCount).toBe(1);
    expect(first.revisionHash).toBe(rebuilt.revisionHash);
    expect(second).toEqual(first);
    expect(third.snapshot).toEqual(first);
    expect(JSON.parse(await readFile(join(graphRoot, "snapshot-all-months.json"), "utf8"))).toMatchObject({
      revisionHash: rebuilt.revisionHash
    });
  });
});
