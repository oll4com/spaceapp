import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryGraphSnapshotSchema } from "@space/contracts";
import {
  buildMemoryGraphSnapshot,
  createMemoryGraphSnapshotStore,
  type MemoryGraphSource
} from "../src/index.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function sources(): MemoryGraphSource[] {
  return [
    {
      path: "/opt/spaceapp/docs/gemini_history.md",
      kind: "INDEX",
      content: [
        "# Gemini History (Monthly Index)",
        "",
        "## Monthly Files",
        "- `gemini_history_2026-07.md` — current write target",
        "  Tags: Space, memory-policy"
      ].join("\n")
    },
    {
      path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      kind: "MONTHLY",
      content: [
        "# Gemini History 2026-07",
        "",
        "## 2026-07-12 09:40 EEST - Space Room Agent durable goals",
        "- Deployed the persistent Room Agent.",
        "- Evidence root: `/reports/room-agent`.",
        "",
        "<!-- space-memory:id=memory:fixed-agent-memory -->",
        "## 2026-07-12 - Space canonical memory: Agent Memory plan",
        "- Source: Space API memory.save; original_scope=ROOM, room=room:abc; provenance=operator; trace=req:123.",
        "- Build a graph workspace."
      ].join("\n")
    },
    {
      path: "/opt/spaceapp/docs/_archive/gemini_history_2026-07.pre-condense.md",
      kind: "MONTHLY",
      content: "## 2026-07-01 - Archived duplicate\n- Must not be indexed."
    }
  ];
}

describe("buildMemoryGraphSnapshot", () => {
  it("keeps record, section and source ids when the files are renamed to Space Memory", () => {
    const renamed = sources().map((source) => ({
      ...source,
      path: source.path.replace(/gemini_history/, "space_memory")
    }));
    const legacy = buildMemoryGraphSnapshot({ generatedAt: "2026-07-13T08:00:00.000Z", sources: sources() });
    const current = buildMemoryGraphSnapshot({ generatedAt: "2026-07-13T08:00:00.000Z", sources: renamed });

    expect(current.nodes.map((node) => node.id).sort()).toEqual(legacy.nodes.map((node) => node.id).sort());
    expect(current.records.map((record) => record.id)).toEqual(legacy.records.map((record) => record.id));
    expect(current.records.find((record) => record.title === "Space Room Agent durable goals")).toMatchObject({
      sourcePath: "/opt/spaceapp/docs/space_memory_2026-07.md",
      createdAt: "2026-07-12T06:40:00.000Z"
    });
  });

  it("parses monthly blocks with stable IDs, timestamps, scope and provenance while excluding raw archives", () => {
    const first = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    });
    const second = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:05:00.000Z",
      sources: sources()
    });

    expect(first).toMatchObject({
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 2,
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(first.records).toHaveLength(2);
    expect(first.revisionHash).toBe(second.revisionHash);
    expect(first.records.map((record) => record.id)).toEqual(second.records.map((record) => record.id));
    expect(first.records[0]).toMatchObject({
      title: "Space Room Agent durable goals",
      createdAt: "2026-07-12T06:40:00.000Z",
      scope: "SYSTEM",
      roomId: null,
      lifecycleStatus: "ACTIVE"
    });
    expect(first.records[1]).toMatchObject({
      id: "memory:fixed-agent-memory",
      markerId: "memory:fixed-agent-memory",
      title: "Agent Memory plan",
      createdAt: "2026-07-11T21:00:00.000Z",
      scope: "ROOM",
      roomId: "room:abc",
      provenance: "operator",
      lifecycleStatus: "ACTIVE"
    });
    expect(first.records.every((record) => record.sourceStart >= 0 && record.sourceEnd > record.sourceStart)).toBe(true);
    expect(first.records.every((record) => record.contentHash.length === 64)).toBe(true);
    expect(first.records.some((record) => record.title.includes("Archived"))).toBe(false);
    expect(first.summary).toMatchObject({ sourceCount: 2, recordCount: 2, issueCount: 0 });
  });

  it("recognizes date-with-zone headings (no clock time) as timestamped records", () => {
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-08-05T06:00:00.000Z",
      sources: [
        {
          path: "/opt/spaceapp/docs/gemini_history_2026-08.md",
          kind: "MONTHLY",
          content: [
            "# Gemini History 2026-08",
            "",
            "## 2026-08-01 EEST - public-host re-synced to d05a81590",
            "- Re-synced via the canonical procedure.",
            "",
            "## 2026-08-02 - Date only entry",
            "- No zone or time.",
            "",
            "## 2026-08-03 06:32 EEST - Full timestamp entry",
            "- Has hour, minute and zone."
          ].join("\n")
        }
      ]
    });

    const byTitle = new Map(snapshot.records.map((record) => [record.title, record]));
    expect(byTitle.get("public-host re-synced to d05a81590")?.createdAt).toBe("2026-07-31T21:00:00.000Z");
    expect(byTitle.get("Date only entry")?.createdAt).toBe("2026-08-01T21:00:00.000Z");
    expect(byTitle.get("Full timestamp entry")?.createdAt).toBe("2026-08-03T03:32:00.000Z");
    expect(snapshot.records).toHaveLength(3);
    expect(snapshot.issues.filter((issue) => issue.type === "MISSING_TIMESTAMP")).toHaveLength(0);
  });

  it("creates source, section, memory, room and provenance graph relationships", () => {
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    });

    expect(snapshot.nodes.some((node) => node.type === "SOURCE" && node.label === "gemini_history_2026-07.md")).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === "MEMORY" && node.id === "memory:fixed-agent-memory")).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === "ROOM" && node.label === "room:abc")).toBe(true);
    expect(snapshot.nodes.some((node) => node.type === "PROVENANCE" && node.label === "operator")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.type === "BELONGS_TO_ROOM" && edge.source === "memory:fixed-agent-memory")).toBe(true);
    expect(snapshot.edges.some((edge) => edge.type === "DERIVED_FROM" && edge.source === "memory:fixed-agent-memory")).toBe(true);
    expect(snapshot.nodes.every((node) =>
      Number.isFinite(node.position.clustered.x) &&
      Number.isFinite(node.position.clustered.y) &&
      Number.isFinite(node.position.relations.x) &&
      Number.isFinite(node.position.relations.y)
    )).toBe(true);
  });

  it("flags invalid markers and links exact duplicate blocks deterministically", () => {
    const source = {
      path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      kind: "MONTHLY" as const,
      content: [
        "<!-- space-memory:id=memory:duplicate-a -->",
        "## 2026-07-13 10:00 EEST - Duplicate fact",
        "- Same durable fact.",
        "",
        "<!-- space-memory:id=memory:duplicate-b -->",
        "## 2026-07-13 10:00 EEST - Duplicate fact",
        "- Same durable fact.",
        "",
        "<!-- space-memory:id=invalid marker -->",
        "## 2026-07-13 10:05 EEST - Marker needs repair",
        "- Another durable fact."
      ].join("\n")
    };
    const first = buildMemoryGraphSnapshot({ sources: [source], generatedAt: "2026-07-13T08:00:00.000Z" });
    const second = buildMemoryGraphSnapshot({ sources: [source], generatedAt: "2026-07-13T09:00:00.000Z" });

    expect(first.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "EXACT_DUPLICATE", recordId: "memory:duplicate-b" }),
      expect.objectContaining({ type: "INVALID_MARKER", recordId: expect.any(String) })
    ]));
    expect(first.edges).toContainEqual(expect.objectContaining({
      type: "DUPLICATES",
      source: "memory:duplicate-b",
      target: "memory:duplicate-a"
    }));
    expect(first.nodes.map((node) => ({ id: node.id, position: node.position }))).toEqual(
      second.nodes.map((node) => ({ id: node.id, position: node.position }))
    );
  });

  it("keeps canonical record and issue ids unique when a heading repeats in one source", () => {
    const repeatedHeading = "## 2026-07-14 09:00 EEST - Repeated heading";
    const source = {
      path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      kind: "MONTHLY" as const,
      content: [
        repeatedHeading,
        "- First durable fact for the repeated heading.",
        "",
        repeatedHeading,
        "- Second durable fact for the repeated heading.",
        "",
        repeatedHeading,
        "- First durable fact for the repeated heading.",
        "",
        "## 2026-07-14 10:00 EEST - Timestamped follow-up",
        "- Follow-up with its own heading."
      ].join("\n")
    };
    const snapshot = buildMemoryGraphSnapshot({ sources: [source], generatedAt: "2026-07-14T08:00:00.000Z" });

    const recordIds = snapshot.records.map((record) => record.id);
    expect(new Set(recordIds).size).toBe(recordIds.length);
    expect(new Set(snapshot.issues.map((issue) => issue.id)).size).toBe(snapshot.issues.length);
    expect(new Set(snapshot.nodes.map((node) => node.id)).size).toBe(snapshot.nodes.length);
    // The first occurrence keeps its canonical id, the distinct repeat is re-keyed from its content
    // hash and the byte-identical repeat is dropped.
    expect(recordIds).toContain(`memory:${createHash("sha256").update(`${source.path}\n2026-07-14T06:00:00.000Z\nRepeated heading`).digest("hex").slice(0, 24)}`);
    expect(snapshot.records.filter((record) => record.title === "Repeated heading")).toHaveLength(2);
    expect(snapshot.summary.recordCount).toBe(snapshot.records.length);
    expect(memoryGraphSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("materializes topics, explicit relations and exact cache links without guessing ambiguous matches", () => {
    const graph = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: [{
        path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        kind: "MONTHLY",
        content: [
          "<!-- space-memory:id=memory:old-fact -->",
          "## 2026-07-12 10:00 EEST - Durable cache fact",
          "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:one.",
          "- Durable cache fact.",
          "- Tags: memory, deployment",
          "",
          "<!-- space-memory:id=memory:new-fact -->",
          "## 2026-07-13 10:00 EEST - Replacement fact",
          "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:two.",
          "- Replacement fact; supersedes=memory:old-fact."
        ].join("\n")
      }],
      cacheRecords: [
        {
          id: "memory_cache:exact",
          title: "Durable cache fact",
          body: "Durable cache fact.",
          scope: "SYSTEM",
          roomId: null,
          provenance: "space-api"
        },
        {
          id: "memory_cache:missing",
          title: "No canonical match",
          body: "No canonical match.",
          scope: "SYSTEM",
          roomId: null,
          provenance: "space-api"
        }
      ]
    });

    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "TOPIC", label: "memory" }),
      expect.objectContaining({ type: "TOPIC", label: "deployment" }),
      expect.objectContaining({ type: "CACHE_RECORD", cacheRecordId: "memory_cache:exact", recordId: "memory:old-fact" })
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "TAGGED_WITH",
        source: "memory:old-fact",
        origin: "EXPLICIT_TAG",
        confidence: 1,
        evidence: expect.stringContaining("memory")
      }),
      expect.objectContaining({ type: "CACHED_AS", source: "memory:old-fact" }),
      expect.objectContaining({ type: "SUPERSEDES", source: "memory:new-fact", target: "memory:old-fact" })
    ]));
    expect(graph.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "STALE", recordId: "memory:old-fact", confidence: 1 }),
      expect.objectContaining({ type: "CACHE_MISMATCH", recordId: null, sourcePath: "memory_records" })
    ]));
  });

  it("derives deterministic Greek and English TF-IDF topics and explainable semantic relationships", () => {
    const source = {
      path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      kind: "MONTHLY" as const,
      content: [
        "<!-- space-memory:id=memory:graph-one -->",
        "## 2026-07-13 10:00 EEST - Space memory graph deployment",
        "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:graph-one.",
        "- Tags: Space-Memory, αρχιτεκτονική",
        "- Ο χάρτης μνήμης συνδέει durable memories με semantic topics και graph relationships.",
        "",
        "<!-- space-memory:id=memory:graph-two -->",
        "## 2026-07-13 10:05 EEST - Semantic memory map",
        "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:graph-two.",
        "- Το memory graph οργανώνει μνήμες με semantic topics και εμφανίζει έναν διαδραστικό χάρτη.",
        "",
        "<!-- space-memory:id=memory:backup -->",
        "## 2026-07-13 10:10 EEST - Proxmox backup rotation",
        "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:backup.",
        "- Τα vzdump archives ελέγχονται στο απομακρυσμένο storage box κάθε εβδομάδα."
      ].join("\n")
    };
    const first = buildMemoryGraphSnapshot({ sources: [source], generatedAt: "2026-07-13T08:00:00.000Z" });
    const second = buildMemoryGraphSnapshot({ sources: [source], generatedAt: "2026-07-13T09:00:00.000Z" });
    const graphOne = first.records.find((record) => record.id === "memory:graph-one")!;

    expect(graphOne.tags).toEqual(["Space-Memory", "αρχιτεκτονική"]);
    expect(graphOne.topics).toEqual(expect.arrayContaining([
      { label: "Space-Memory", origin: "EXPLICIT_TAG", confidence: 1 },
      expect.objectContaining({ origin: "DERIVED_TFIDF", confidence: expect.any(Number) })
    ]));
    expect(graphOne.topics.some((topic) => /[α-ωάέήίόύώ]/iu.test(topic.label))).toBe(true);
    expect(first.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "TAGGED_WITH",
        source: "memory:graph-one",
        origin: "DERIVED_TFIDF",
        evidence: expect.stringContaining("TF-IDF")
      }),
      expect.objectContaining({
        type: "SEMANTICALLY_RELATED",
        source: "memory:graph-one",
        target: "memory:graph-two",
        origin: "DETERMINISTIC_TFIDF",
        confidence: expect.any(Number),
        evidence: expect.stringContaining("Shared terms")
      })
    ]));
    expect(first.edges).not.toContainEqual(expect.objectContaining({
      type: "SEMANTICALLY_RELATED",
      source: "memory:graph-one",
      target: "memory:backup"
    }));
    expect(first.records.map(({ id, tags, topics }) => ({ id, tags, topics }))).toEqual(
      second.records.map(({ id, tags, topics }) => ({ id, tags, topics }))
    );
    expect(first.edges.map(({ id, type, source, target, origin, confidence, evidence }) => ({
      id, type, source, target, origin, confidence, evidence
    }))).toEqual(second.edges.map(({ id, type, source, target, origin, confidence, evidence }) => ({
      id, type, source, target, origin, confidence, evidence
    })));
  });

  it("excludes credential-shaped values from explicit and derived graph semantics", () => {
    const credentialTag = ["sk", "testcredentialvalue"].join("-");
    const detachedCredential = ["raw", "semantic", "credential", "value"].join("-");
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: [{
        path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        kind: "MONTHLY",
        content: [
          "<!-- space-memory:id=memory:sensitive-semantics -->",
          "## 2026-07-13 10:00 EEST - Credential filtering",
          "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:sensitive-semantics.",
          `- Tags: useful-topic, ${credentialTag}`,
          `- token=${detachedCredential} ${detachedCredential} ${detachedCredential}`
        ].join("\n")
      }]
    });
    const record = snapshot.records.find((candidate) => candidate.id === "memory:sensitive-semantics")!;
    const semanticPayload = JSON.stringify({
      records: snapshot.records.map(({ tags, topics }) => ({ tags, topics })),
      nodes: snapshot.nodes,
      edges: snapshot.edges
    });

    expect(record.tags).toEqual(["useful-topic"]);
    expect(semanticPayload).not.toContain(credentialTag);
    expect(semanticPayload).not.toContain(detachedCredential);
  });

  it("does not promote commit-shaped opaque identifiers into derived taxonomy", () => {
    const opaqueCommit = "8db7444a2";
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: [{
        path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        kind: "MONTHLY",
        content: [
          "<!-- space-memory:id=memory:semantic-label-quality -->",
          "## 2026-07-13 10:00 EEST - Semantic taxonomy clustering",
          "- Source: manual; original_scope=SYSTEM; provenance=operator; trace=req:semantic-label-quality.",
          `- Commit ${opaqueCommit} ${opaqueCommit} ${opaqueCommit} delivered taxonomy clustering and graph navigation.`
        ].join("\n")
      }]
    });
    const record = snapshot.records.find((candidate) => candidate.id === "memory:semantic-label-quality")!;
    const derivedLabels = record.topics
      ?.filter((topic) => topic.origin === "DERIVED_TFIDF")
      .map((topic) => topic.label) ?? [];

    expect(derivedLabels.length).toBeGreaterThan(0);
    expect(derivedLabels).not.toContain(opaqueCommit);
    expect(snapshot.nodes).not.toContainEqual(expect.objectContaining({ type: "TOPIC", label: opaqueCommit }));
  });

  it("flags undated blocks as open deterministic issues", () => {
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: [{ path: "/opt/spaceapp/docs/gemini_history_2026-07.md", kind: "MONTHLY", content: "## Undated memory\n- Needs review." }]
    });
    expect(snapshot.issues).toEqual([
      expect.objectContaining({ type: "MISSING_TIMESTAMP", severity: "WARN", status: "OPEN", confidence: 1 })
    ]);
  });

  it("indexes dated depth-three follow-ups as separate records while retaining ordinary nested headings", () => {
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: [{
        path: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        kind: "MONTHLY",
        content: [
          "## 2026-07-06 — Parent deployment memory",
          "- Parent durable fact.",
          "",
          "<!-- space-memory:id=memory:follow-up -->",
          "### 2026-07-06 18:40 EEST follow-up - Strict restart guardrail",
          "- Follow-up durable fact.",
          "",
          "#### Evidence",
          "- This nested heading remains part of the follow-up block.",
          "",
          "## 2026-07-07 10:00 EEST - Next memory",
          "- Next durable fact."
        ].join("\n")
      }]
    });

    expect(snapshot.records).toHaveLength(3);
    expect(snapshot.records[0]).toMatchObject({
      title: "Parent deployment memory",
      createdAt: "2026-07-05T21:00:00.000Z"
    });
    expect(snapshot.records[0]?.body).not.toContain("Strict restart guardrail");
    expect(snapshot.records[1]).toMatchObject({
      id: "memory:follow-up",
      title: "Strict restart guardrail",
      createdAt: "2026-07-06T15:40:00.000Z"
    });
    expect(snapshot.records[1]?.body).toContain("#### Evidence");
    expect(snapshot.records[2]?.title).toBe("Next memory");
    expect(snapshot.issues).not.toContainEqual(expect.objectContaining({ type: "MISSING_TIMESTAMP" }));
  });
});

describe("createMemoryGraphSnapshotStore", () => {
  it("writes snapshots atomically, reads them back and invalidates without leftover temp files", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-graph-"));
    cleanupRoots.push(root);
    const store = createMemoryGraphSnapshotStore({ rootDir: root });
    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    });

    await store.write(snapshot);
    await expect(store.read()).resolves.toEqual(snapshot);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);

    await store.invalidate();
    await expect(store.read()).resolves.toBeNull();
  });

  it("fails closed when a persisted snapshot is malformed or exceeds contract bounds", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-graph-invalid-"));
    cleanupRoots.push(root);
    const store = createMemoryGraphSnapshotStore({ rootDir: root });

    await writeFile(join(root, "snapshot.json"), "{not-json}\n", "utf8");
    await expect(store.read()).resolves.toBeNull();

    const snapshot = buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    });
    await writeFile(join(root, "snapshot.json"), `${JSON.stringify({
      ...snapshot,
      summary: { ...snapshot.summary, sourceCount: 25 }
    })}\n`, "utf8");
    await expect(store.read()).resolves.toBeNull();
  });

  it("syncs the parent directory after snapshot writes and invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-graph-durable-"));
    cleanupRoots.push(root);
    let parentDirectorySyncs = 0;
    const store = createMemoryGraphSnapshotStore({
      rootDir: root,
      openFile: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            if (flags === "r") parentDirectorySyncs += 1;
            await handle.sync();
          },
          close: handle.close.bind(handle)
        };
      }
    });

    await store.write(buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    }));

    expect(parentDirectorySyncs).toBe(1);
    await store.invalidate();
    expect(parentDirectorySyncs).toBe(2);
  });

  it("removes its temporary file when an injected file sync failure aborts the write", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-graph-fault-"));
    cleanupRoots.push(root);
    const store = createMemoryGraphSnapshotStore({
      rootDir: root,
      openFile: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: flags === "wx"
            ? async () => { throw new Error("injected snapshot sync failure"); }
            : handle.sync.bind(handle),
          close: handle.close.bind(handle)
        };
      }
    });

    await expect(store.write(buildMemoryGraphSnapshot({
      generatedAt: "2026-07-13T08:00:00.000Z",
      sources: sources()
    }))).rejects.toThrow("injected snapshot sync failure");
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
