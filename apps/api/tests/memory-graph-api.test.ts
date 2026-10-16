import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ListMemoryQuery, MemoryEntry, MemoryGraphSnapshot } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import type { MemoryMutationCoordinator } from "../src/memory-mutation-coordinator.js";
import type { MemoryConsolidationCoordinator } from "../src/memory-consolidation-coordinator.js";

const sessionSecret = "test-secret-with-enough-length";
const sessionToken = signSession(
  { id: "user:operator", email: "operator@space.test", role: "OPERATOR" },
  sessionSecret
);
const cookie = `space_session=${sessionToken}`;
const csrfToken = createCsrfToken(sessionToken, sessionSecret)!;
const mutationHeaders = {
  cookie,
  "x-space-csrf-token": csrfToken,
  "idempotency-key": "memory-command:default-retry"
};

function snapshot() {
  return {
    version: 1 as const,
    generatedAt: "2026-07-13T08:00:00.000Z",
    sourceHash: "a".repeat(64),
    records: [
      {
        id: "memory:agent",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        sectionId: "section:agent",
        title: "Agent Memory",
        body: "## Agent Memory\n- Durable fact. token=raw-test-value",
        createdAt: "2026-07-13T08:00:00.000Z",
        scope: "ROOM" as const,
        roomId: "room:test",
        provenance: "operator",
        contentHash: "b".repeat(64),
        lifecycleStatus: "ACTIVE" as const
      }
    ],
    nodes: [
      {
        id: "source:history",
        type: "SOURCE" as const,
        label: "gemini_history_2026-07.md",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        recordId: null
      },
      {
        id: "memory:agent",
        type: "MEMORY" as const,
        label: "Agent Memory",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        recordId: "memory:agent"
      }
    ],
    edges: [{
      id: "edge:contains",
      type: "CONTAINS" as const,
      source: "source:history",
      target: "memory:agent",
      evidence: "Canonical relationship token=raw-edge-value"
    }],
    issues: [
      {
        id: "issue:timestamp",
        type: "MISSING_TIMESTAMP" as const,
        severity: "WARN" as const,
        status: "OPEN" as const,
        confidence: 1,
        recordId: "memory:agent",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        evidence: "Agent Memory password=raw-test-password"
      }
    ],
    summary: { sourceCount: 1, recordCount: 1, nodeCount: 2, edgeCount: 1, issueCount: 1 }
  };
}

async function memoryGraphApp(
  enabled: boolean,
  store = new InMemorySpaceStore(),
  mutationsEnabled = false,
  memoryMutationCoordinator?: MemoryMutationCoordinator,
  options: {
    cachedSnapshot?: MemoryGraphSnapshot | null;
    canonicalList?: (query: ListMemoryQuery) => Promise<MemoryEntry[]> | MemoryEntry[];
    canonicalSave?: () => Promise<MemoryEntry> | MemoryEntry;
    invalidateCachedSnapshot?: () => Promise<void> | void;
    graphSnapshot?: MemoryGraphSnapshot;
    sourceContent?: (sourcePath: string) => Promise<string> | string;
    archiveSnapshot?: MemoryGraphSnapshot;
    availableMonths?: string[];
    maintenanceEnabled?: boolean;
    memoryConsolidationCoordinator?: MemoryConsolidationCoordinator;
  } = {}
) {
  return createApp({
    store,
    config: getApiConfig({
      SPACE_MEMORY_GRAPH_ENABLED: enabled ? "true" : "false",
      SPACE_MEMORY_MAINTENANCE_ENABLED: options.maintenanceEnabled ? "true" : "false",
      SPACE_MEMORY_MUTATIONS_ENABLED: mutationsEnabled ? "true" : "false",
      SPACE_BROWSER_EVIDENCE_ENABLED: "false"
    }),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    canonicalMemory: {
      async list(query) {
        return options.canonicalList?.(query) ?? [];
      },
      async save() {
        if (options.canonicalSave) return options.canonicalSave();
        throw new Error("not used");
      }
    },
    memoryGraphService: {
      async getSnapshot() {
        return { snapshot: options.graphSnapshot ?? snapshot(), isStale: false };
      },
      async getCachedSnapshot() {
        return options.cachedSnapshot === undefined ? snapshot() : options.cachedSnapshot;
      },
      async invalidateCachedSnapshot() {
        await options.invalidateCachedSnapshot?.();
      },
      async getArchiveSnapshot() {
        return options.archiveSnapshot ?? options.graphSnapshot ?? snapshot();
      },
      async listAvailableMonths() {
        return options.availableMonths ?? ["2026-07"];
      },
      async getSourceContent(sourcePath) {
        if (options.sourceContent) return options.sourceContent(sourcePath);
        throw new Error(`Unexpected canonical source read ${sourcePath}`);
      }
    },
    memoryMutationCoordinator,
    memoryConsolidationCoordinator: options.memoryConsolidationCoordinator
  });
}

function changeSetInput() {
  const beforeSnapshot = "## Agent Memory\n- Durable fact. token=raw-change-before\n";
  const afterSnapshot = "## Agent Memory\n- Updated durable fact. token=raw-change-after\n";
  return {
    kind: "EDIT",
    sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
    recordIds: ["memory:agent"],
    resolvesIssueIds: ["issue:timestamp"],
    expectedSourceHash: "a".repeat(64),
    beforeContentHash: createHash("sha256").update(beforeSnapshot).digest("hex"),
    afterContentHash: createHash("sha256").update(afterSnapshot).digest("hex"),
    beforeSnapshot,
    afterSnapshot,
    reason: "Refresh the durable fact.",
    actorUserId: "user:forged"
  };
}

describe("Memory graph API", () => {
  it("invalidates immediately after canonical save and links the cache record", async () => {
    const order: string[] = [];
    const store = new InMemorySpaceStore();
    const canonicalEntry: MemoryEntry = {
      id: "gemini_memory:canonical-save",
      scope: "SYSTEM",
      roomId: null,
      title: "Canonical save",
      body: "Canonical body",
      provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      createdAt: "2026-07-13T08:00:00.000Z"
    };
    const app = await memoryGraphApp(true, store, false, undefined, {
      canonicalSave() {
        order.push("canonical-save");
        return canonicalEntry;
      },
      invalidateCachedSnapshot() {
        order.push("snapshot-invalidate");
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: mutationHeaders,
      payload: {
        scope: "SYSTEM",
        title: "Canonical save",
        body: "Canonical body",
        provenance: "api-test"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["canonical-save", "snapshot-invalidate"]);
    const [cacheEntry] = store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" });
    expect(cacheEntry).toBeDefined();
    expect(store.getMemoryCacheLink(cacheEntry!.id)).toMatchObject({
      memoryRecordId: cacheEntry!.id,
      canonicalMemoryId: canonicalEntry.id,
      linkSource: "CANONICAL_SAVE"
    });
  });

  it("stops cache work when snapshot invalidation fails", async () => {
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, false, undefined, {
      canonicalSave() {
        return {
          id: "gemini_memory:canonical-save-failure",
          scope: "SYSTEM",
          roomId: null,
          title: "Canonical save failure",
          body: "Canonical body",
          provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
          createdAt: "2026-07-13T08:00:00.000Z"
        };
      },
      invalidateCachedSnapshot() {
        throw new Error("invalidation failed");
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/memory",
      headers: mutationHeaders,
      payload: {
        scope: "SYSTEM",
        title: "Canonical save failure",
        body: "Canonical body",
        provenance: "api-test"
      }
    });

    expect(response.statusCode).toBe(500);
    expect(store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" })).toEqual([]);
  });

  it("serves keyword memory from canonical retrieval even when a graph snapshot exists", async () => {
    const cached = snapshot();
    cached.records.push({
      ...cached.records[0]!,
      id: "memory:older-agent",
      sectionId: "section:older-agent",
      title: "Older Agent Memory",
      body: "## Older Agent Memory\n- Another durable fact.",
      createdAt: "2026-07-12T08:00:00.000Z",
      contentHash: "c".repeat(64)
    });
    const app = await memoryGraphApp(true, new InMemorySpaceStore(), false, undefined, {
      cachedSnapshot: cached,
      canonicalList() {
        return cached.records.map(r => ({id:r.id,scope:r.scope,roomId:r.roomId,title:r.title,body:"Durable redacted fact",provenance:r.provenance,createdAt:r.createdAt})).sort((a,b)=>a.title.localeCompare(b.title));
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/memory?q=durable&scope=ROOM&roomId=room:test&page=1&pageSize=1&sortBy=title&sortOrder=asc",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [
        {
          id: "memory:agent",
          scope: "ROOM",
          roomId: "room:test",
          title: "Agent Memory",
          provenance: "operator",
          createdAt: "2026-07-13T08:00:00.000Z"
        }
      ],
      pagination: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2 }
    });
    expect(JSON.stringify(response.json())).not.toContain("raw-test-value");
  });

  it("falls back to canonical keyword memory when no valid graph snapshot exists", async () => {
    let canonicalReads = 0;
    const app = await memoryGraphApp(true, new InMemorySpaceStore(), false, undefined, {
      cachedSnapshot: null,
      canonicalList() {
        canonicalReads += 1;
        return [
          {
            id: "gemini_memory:fallback",
            scope: "SYSTEM",
            roomId: null,
            title: "Canonical fallback",
            body: "Fallback remains available.",
            provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
            createdAt: "2026-07-13T08:00:00.000Z"
          }
        ];
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/memory?q=fallback", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({ id: "gemini_memory:fallback" })]);
    expect(canonicalReads).toBe(1);
  });

  it("fails closed when the feature is disabled and requires authentication", async () => {
    const app = await memoryGraphApp(false);
    const unauthenticated = await app.inject({ method: "GET", url: "/api/admin/memory/graph" });
    expect(unauthenticated.statusCode).toBe(401);

    const disabled = await app.inject({ method: "GET", url: "/api/admin/memory/graph", headers: { cookie } });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error.code).toBe("MEMORY_GRAPH_DISABLED");

    const disabledChangeSet = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    expect(disabledChangeSet.statusCode).toBe(503);
    expect(disabledChangeSet.json().error.code).toBe("MEMORY_GRAPH_DISABLED");
    await app.close();
  });

  it("returns a filtered, paginated graph with ETag/304 semantics", async () => {
    const app = await memoryGraphApp(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?q=agent&nodeType=MEMORY&pageSize=10",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe(`"${"a".repeat(64)}"`);
    expect(response.json()).toMatchObject({
      data: {
        sourceHash: "a".repeat(64),
        isStale: false,
        nodes: [
          { id: "memory:agent", type: "MEMORY" },
          { id: "source:history", type: "SOURCE" }
        ],
        filters: { q: "agent", nodeType: "MEMORY", relationMode: "RELATIONS" }
      },
      pagination: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 }
    });

    const notModified = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph",
      headers: { cookie, "if-none-match": response.headers.etag }
    });
    expect(notModified.statusCode).toBe(304);
    await app.close();
  });

  it("serves the complete bounded overview without changing paginated graph semantics", async () => {
    const graphSnapshot = snapshot() as MemoryGraphSnapshot;
    graphSnapshot.nodes = Array.from({ length: 447 }, (_, index) => ({
      id: `memory:overview-${index}`,
      type: "MEMORY" as const,
      label: `Overview memory ${index}`,
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordId: null,
      position: {
        clustered: { x: index % 30, y: Math.floor(index / 30) },
        relations: { x: index % 25, y: Math.floor(index / 25) }
      }
    }));
    graphSnapshot.edges = [];
    graphSnapshot.version = 2;
    graphSnapshot.layoutVersion = 2;
    graphSnapshot.taxonomyVersion = 1;
    graphSnapshot.revisionHash = "d".repeat(64);
    graphSnapshot.summary = {
      ...graphSnapshot.summary,
      nodeCount: graphSnapshot.nodes.length,
      edgeCount: 0
    };
    const app = await memoryGraphApp(true, new InMemorySpaceStore(), false, undefined, { graphSnapshot });

    const overview = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview",
      headers: { cookie }
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.headers.etag).toBe(`"${"d".repeat(64)}"`);
    const overviewBody = overview.json();
    expect(overviewBody).toMatchObject({
      data: {
        totalMatchingNodes: 447,
        totalMatchingEdges: 0,
        truncated: false
      }
    });
    expect(overviewBody.data.nodes).toHaveLength(447);
    expect(overviewBody.data.nodes).toContainEqual(expect.objectContaining({ id: "memory:overview-446" }));

    const page = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?page=1&pageSize=100",
      headers: { cookie }
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data.nodes).toHaveLength(100);
    expect(page.json().pagination).toMatchObject({ page: 1, pageSize: 100, totalItems: 447, totalPages: 5 });
    await app.close();
  });

  it("retains real tags and their neighbors when an archive exceeds the overview cap", async () => {
    const graphSnapshot = snapshot() as MemoryGraphSnapshot;
    graphSnapshot.nodes = Array.from({ length: 2200 }, (_, index) => ({ id: `memory:${String(index).padStart(4, "0")}`, type: "MEMORY" as const, label: `Memory ${index}`, sourcePath: null, recordId: null }));
    graphSnapshot.nodes.push({ id: "topic:important", type: "TOPIC", label: "Important", sourcePath: null, recordId: null });
    graphSnapshot.nodes.push({ id: "source:root", type: "SOURCE", label: "gemini.md", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null });
    graphSnapshot.edges = [{ id: "edge:tag", source: "memory:2199", target: "topic:important", type: "TAGGED_WITH", origin: "EXPLICIT_TAG", confidence: 1, evidence: "Explicit tag in canonical memory." }];
    const app = await memoryGraphApp(true, new InMemorySpaceStore(), false, undefined, { graphSnapshot });
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.nodes).toHaveLength(2000);
    expect(data.nodes).toContainEqual(expect.objectContaining({ id: "topic:important" }));
    expect(data.nodes).toContainEqual(expect.objectContaining({ id: "source:root" }));
    expect(data.nodes).toContainEqual(expect.objectContaining({ id: "memory:2199" }));
    expect(data.edges).toContainEqual(expect.objectContaining({ id: "edge:tag" }));
    expect(data.truncated).toBe(true);
    expect(data.totalMatchingNodes).toBe(2202);

    // Request with higher limit to fetch full dataset without truncation
    const responseWithLimit = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=5000", headers: { cookie } });
    expect(responseWithLimit.statusCode).toBe(200);
    const dataWithLimit = responseWithLimit.json().data;
    expect(dataWithLimit.nodes).toHaveLength(2202);
    expect(dataWithLimit.truncated).toBe(false);

    // Conditional ETag response depends on requested limit
    const defaultEtag = response.headers.etag;
    const limitEtag = responseWithLimit.headers.etag;
    expect(limitEtag).not.toBe(defaultEtag);

    const revalidateDifferentLimit = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview?limit=5000",
      headers: { cookie, "if-none-match": defaultEtag }
    });
    expect(revalidateDifferentLimit.statusCode).toBe(200);

    const revalidateMatchingLimit = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview?limit=5000",
      headers: { cookie, "if-none-match": limitEtag }
    });
    expect(revalidateMatchingLimit.statusCode).toBe(304);

    // Verify small limit enforces strict upper bound
    const smallLimitResponse = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=5", headers: { cookie } });
    expect(smallLimitResponse.statusCode).toBe(200);
    expect(smallLimitResponse.json().data.nodes.length).toBeLessThanOrEqual(5);

    // Rejection on limit > 50000
    const outOfRange = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=99999", headers: { cookie } });
    expect(outOfRange.statusCode).toBe(400);

    await app.close();
  });

  it("serves the all-months archive and single-month filtering through the month query param", async () => {
    const graphSnapshot = snapshot() as MemoryGraphSnapshot;
    const archiveSnapshot = snapshot() as MemoryGraphSnapshot;
    const junePath = "/opt/spaceapp/docs/gemini_history_2026-06.md";
    archiveSnapshot.nodes = [
      {
        id: "source:history-june",
        type: "SOURCE" as const,
        label: "gemini_history_2026-06.md",
        sourcePath: junePath,
        recordId: null
      },
      {
        id: "memory:june",
        type: "MEMORY" as const,
        label: "June Memory",
        sourcePath: junePath,
        recordId: null
      },
      {
        id: "source:history-july",
        type: "SOURCE" as const,
        label: "gemini_history_2026-07.md",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        recordId: null
      },
      {
        id: "memory:july",
        type: "MEMORY" as const,
        label: "July Memory",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
        recordId: null
      }
    ];
    archiveSnapshot.edges = [];
    archiveSnapshot.version = 2;
    archiveSnapshot.layoutVersion = 2;
    archiveSnapshot.taxonomyVersion = 2;
    archiveSnapshot.revisionHash = "e".repeat(64);
    archiveSnapshot.summary = {
      ...archiveSnapshot.summary,
      sourceCount: 2,
      recordCount: 2,
      nodeCount: 4,
      edgeCount: 0
    };
    const app = await memoryGraphApp(
      true,
      new InMemorySpaceStore(),
      false,
      undefined,
      { graphSnapshot, archiveSnapshot, availableMonths: ["2026-06", "2026-07"] }
    );

    const live = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview", headers: { cookie } });
    expect(live.json().data.months).toEqual(["2026-06", "2026-07"]);
    expect(live.json().data.filters.month).toBeNull();

    const june = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview?month=2026-06",
      headers: { cookie }
    });
    expect(june.statusCode).toBe(200);
    expect(june.headers.etag).toBe(`"${"e".repeat(64)}"`);
    expect(june.json()).toMatchObject({
      data: {
        months: ["2026-06", "2026-07"],
        filters: { month: "2026-06" }
      }
    });
    const juneNodes = june.json().data.nodes.map((node: { id: string }) => node.id).sort();
    expect(juneNodes).toEqual(["memory:june", "source:history-june"]);
    expect(june.json().data.summary).toEqual({ sourceCount: 1, recordCount: 0, nodeCount: 2, edgeCount: 0, issueCount: 0 });

    const all = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview?month=all",
      headers: { cookie }
    });
    expect(all.json().data.nodes).toHaveLength(4);
    expect(all.json().data.summary).toEqual(archiveSnapshot.summary);

    const allPages = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?month=all&pageSize=100",
      headers: { cookie }
    });
    expect(allPages.json().data.nodes).toHaveLength(4);

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Ajune",
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().node).toMatchObject({ id: "memory:june", label: "June Memory" });

    await app.close();
  });

  it("preserves one-hop relationships for filtered relation-mode anchors", async () => {
    const app = await memoryGraphApp(true);
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?nodeType=MEMORY&scope=ROOM&relationMode=RELATIONS&pageSize=1",
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        nodes: [
          { id: "memory:agent", type: "MEMORY" },
          { id: "source:history", type: "SOURCE" }
        ],
        edges: [
          { id: "edge:contains", type: "CONTAINS", source: "source:history", target: "memory:agent" }
        ],
        filters: {
          nodeType: "MEMORY",
          scope: "ROOM",
          relationMode: "RELATIONS"
        }
      },
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 }
    });
    await app.close();
  });

  it("uses relationship mode by default while preserving explicit clustered queries", async () => {
    const app = await memoryGraphApp(true);
    const related = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?nodeType=MEMORY&scope=ROOM&pageSize=1",
      headers: { cookie }
    });

    expect(related.statusCode).toBe(200);
    expect(related.json().data).toMatchObject({
      nodes: [
        { id: "memory:agent", type: "MEMORY" },
        { id: "source:history", type: "SOURCE" }
      ],
      filters: { relationMode: "RELATIONS" }
    });

    const clustered = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph?nodeType=MEMORY&scope=ROOM&relationMode=CLUSTERED&pageSize=1",
      headers: { cookie }
    });

    expect(clustered.statusCode).toBe(200);
    expect(clustered.json().data).toMatchObject({
      nodes: [{ id: "memory:agent", type: "MEMORY" }],
      filters: { relationMode: "CLUSTERED" }
    });
    await app.close();
  });

  it("returns node details and paginated issues", async () => {
    const app = await memoryGraphApp(true);
    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Aagent",
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      node: { id: "memory:agent" },
      record: { title: "Agent Memory" },
      relatedEdges: [{ id: "edge:contains", evidence: "Canonical relationship token:[REDACTED]" }]
    });

    const issues = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?severity=WARN&status=OPEN&pageSize=10",
      headers: { cookie }
    });
    expect(issues.statusCode).toBe(200);
    expect(issues.json()).toMatchObject({
      data: [{ id: "issue:timestamp", status: "OPEN", severity: "WARN" }],
      pagination: { totalItems: 1 }
    });
    await app.close();
  });

  it("drops credential-shaped taxonomy values from persisted node details", async () => {
    const credential = ["sk", "testresponsecredential"].join("-");
    const graphSnapshot = snapshot() as MemoryGraphSnapshot;
    graphSnapshot.records[0] = {
      ...graphSnapshot.records[0]!,
      tags: ["safe-topic", credential],
      topics: [
        { label: "safe-topic", origin: "EXPLICIT_TAG", confidence: 1 },
        { label: credential, origin: "EXPLICIT_TAG", confidence: 1 }
      ]
    };
    const app = await memoryGraphApp(true, new InMemorySpaceStore(), false, undefined, { graphSnapshot });

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Aagent",
      headers: { cookie }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().record).toMatchObject({
      tags: ["safe-topic"],
      topics: [{ label: "safe-topic", origin: "EXPLICIT_TAG", confidence: 1 }]
    });
    expect(JSON.stringify(detail.json())).not.toContain(credential);
    await app.close();
  });

  it("creates server-derived retry-safe node archive proposals and rejects sensitive edits", async () => {
    const store = new InMemorySpaceStore();
    const body = "## Agent Memory\n- Durable fact. token=raw-test-value";
    const graphSnapshot: MemoryGraphSnapshot = {
      ...snapshot(),
      records: [{
        ...snapshot().records[0]!,
        body,
        contentHash: createHash("sha256").update(body).digest("hex"),
        sourceStart: 0,
        sourceEnd: body.length + 1
      }]
    };
    const app = await memoryGraphApp(true, store, false, undefined, {
      graphSnapshot,
      sourceContent: () => `${body}\n`
    });
    const headers = { ...mutationHeaders, "idempotency-key": "memory-node:archive-agent" };

    const missingKey = await app.inject({
      method: "POST",
      url: "/api/admin/memory/nodes/memory%3Aagent/change-sets",
      headers: { cookie, "x-space-csrf-token": csrfToken },
      payload: {
        kind: "ARCHIVE",
        expectedContentHash: graphSnapshot.records[0]!.contentHash,
        reason: "Archive the reviewed durable fact."
      }
    });
    expect(missingKey.statusCode).toBe(422);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/nodes/memory%3Aagent/change-sets",
      headers,
      payload: {
        kind: "ARCHIVE",
        expectedContentHash: graphSnapshot.records[0]!.contentHash,
        reason: "Archive the reviewed durable fact."
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: "ARCHIVE", status: "PROPOSED", recordIds: ["memory:agent"] });
    expect(created.json()).not.toHaveProperty("beforeSnapshot");
    const proposal = store.getMemoryChangeSet(created.json().id);
    expect(proposal.beforeSnapshot).toBe(`${body}\n`);
    expect(proposal.afterSnapshot).toContain("lifecycle_status=ARCHIVED");
    expect(proposal.actorUserId).toBe("user:operator");

    const retried = await app.inject({
      method: "POST",
      url: "/api/admin/memory/nodes/memory%3Aagent/change-sets",
      headers,
      payload: {
        kind: "ARCHIVE",
        expectedContentHash: graphSnapshot.records[0]!.contentHash,
        reason: "Archive the reviewed durable fact."
      }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(created.json().id);

    const sensitiveEdit = await app.inject({
      method: "POST",
      url: "/api/admin/memory/nodes/memory%3Aagent/change-sets",
      headers: { ...headers, "idempotency-key": "memory-node:edit-sensitive" },
      payload: {
        kind: "EDIT",
        expectedContentHash: graphSnapshot.records[0]!.contentHash,
        body: "## Agent Memory\n- Updated durable fact. token=[REDACTED]",
        reason: "Edit a protected durable fact."
      }
    });
    expect(sensitiveEdit.statusCode).toBe(409);
    await app.close();
  });

  it("creates retry-safe durable consolidation runs and exposes bounded detail", async () => {
    const starts: Array<{ runId: string; traceId: string; workflowId: string }> = [];
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, false, undefined, {
      maintenanceEnabled: true,
      memoryConsolidationCoordinator: {
        async start(input, workflowId) {
          starts.push({ ...input, workflowId });
          return {
            status: starts.length === 1 ? "SCHEDULED" : "ALREADY_SCHEDULED",
            workflowId,
            runId: starts.length === 1 ? "temporal:run-audit" : null
          };
        }
      }
    });
    const headers = { ...mutationHeaders, "idempotency-key": "memory-command:consolidation-audit" };

    const missingKey = await app.inject({
      method: "POST",
      url: "/api/admin/memory/consolidations",
      headers: { cookie, "x-space-csrf-token": csrfToken },
      payload: { mode: "AUDIT" }
    });
    expect(missingKey.statusCode).toBe(422);

    const forged = await app.inject({
      method: "POST",
      url: "/api/admin/memory/consolidations",
      headers,
      payload: { mode: "AUDIT", actorUserId: "user:forged" }
    });
    expect(forged.statusCode).toBe(422);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/consolidations",
      headers,
      payload: { mode: "AUDIT" }
    });
    expect(created.statusCode).toBe(202);
    expect(created.headers["x-ratelimit-limit"]).toBe("10");
    expect(created.json()).toMatchObject({
      run: {
        mode: "AUDIT",
        triggerKind: "OPERATOR",
        status: "QUEUED",
        actorUserId: "user:operator"
      },
      schedule: {
        status: "SCHEDULED",
        runId: "temporal:run-audit"
      },
      maintenanceEnabled: true,
      mutationsEnabled: false
    });
    const consolidationId = created.json().run.id as string;

    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/memory/consolidations",
      headers,
      payload: { mode: "AUDIT" }
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().run.id).toBe(consolidationId);
    expect(replay.json().schedule).toMatchObject({
      status: "ALREADY_SCHEDULED",
      workflowId: created.json().schedule.workflowId
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/memory/consolidations/${encodeURIComponent(consolidationId)}`,
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      run: { id: consolidationId },
      findings: [],
      operations: [],
      maintenanceEnabled: true,
      mutationsEnabled: false
    });
    expect(starts).toHaveLength(2);
    expect(starts[1]!.workflowId).toBe(starts[0]!.workflowId);
    expect(starts.every((start) => start.runId === consolidationId && start.traceId.startsWith("req:"))).toBe(true);

    const repair = await app.inject({
      method: "POST",
      url: "/api/admin/memory/consolidations",
      headers: { ...headers, "idempotency-key": "memory-command:consolidation-repair" },
      payload: { mode: "REPAIR" }
    });
    expect(repair.statusCode).toBe(503);
    expect(repair.json().error.code).toBe("MEMORY_MUTATIONS_DISABLED");
    await app.close();
  });

  it("patches issue overlays with optimistic state, server-derived identity and scoped rate limits", async () => {
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store);

    const withoutCsrf = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: { cookie },
      payload: { status: "IGNORED", reason: "Reviewed by the operator." }
    });
    expect(withoutCsrf.statusCode).toBe(403);

    const forged = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: mutationHeaders,
      payload: {
        status: "IGNORED",
        reason: "Reviewed by the operator.",
        actorUserId: "user:forged",
        sourceHash: "f".repeat(64)
      }
    });
    expect(forged.statusCode).toBe(422);

    const ignored = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: mutationHeaders,
      payload: { status: "IGNORED", reason: "Reviewed by the operator." }
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.headers["x-ratelimit-limit"]).toBe("30");
    expect(ignored.json()).toMatchObject({
      id: "issue:timestamp",
      type: "MISSING_TIMESTAMP",
      status: "IGNORED",
      statusReason: "Reviewed by the operator.",
      stateVersion: 1
    });
    expect(store.getMemoryIssueState("issue:timestamp")).toMatchObject({
      issueType: "MISSING_TIMESTAMP",
      recordId: "memory:agent",
      sourceHash: "a".repeat(64),
      actorUserId: "user:operator",
      status: "IGNORED",
      version: 1
    });

    const missingVersion = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: mutationHeaders,
      payload: { status: "RESOLVED" }
    });
    expect(missingVersion.statusCode).toBe(409);

    const resolved = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: mutationHeaders,
      payload: { status: "RESOLVED", expectedVersion: 1 }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: "RESOLVED", stateVersion: 2 });

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=RESOLVED&pageSize=10",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      data: [{ id: "issue:timestamp", status: "RESOLVED", stateVersion: 2 }],
      pagination: { totalItems: 1 }
    });

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Aagent",
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().issues[0]).toMatchObject({ status: "RESOLVED", stateVersion: 2 });
    expect(store.listAuditEvents().map((event) => event.action)).toContain("memory.issue.status_updated");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("Reviewed by the operator.");
    await app.close();
  });

  it("revalidates issue collections after resolve and keeps stable issue state across snapshot refreshes", async () => {
    const store = new InMemorySpaceStore();
    const graphSnapshot = snapshot() as MemoryGraphSnapshot;
    const app = await memoryGraphApp(true, store, false, undefined, { graphSnapshot });

    const initial = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=OPEN&pageSize=10",
      headers: { cookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data).toEqual([expect.objectContaining({ id: "issue:timestamp", status: "OPEN" })]);
    const initialEtag = initial.headers.etag;
    expect(initialEtag).toBeTruthy();

    const resolved = await app.inject({
      method: "PATCH",
      url: "/api/admin/memory/issues/issue%3Atimestamp",
      headers: mutationHeaders,
      payload: { status: "RESOLVED" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: "RESOLVED", stateVersion: 1 });

    const revalidated = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=OPEN&pageSize=10",
      headers: { cookie, "if-none-match": initialEtag }
    });
    expect(revalidated.statusCode).toBe(200);
    expect(revalidated.headers.etag).not.toBe(initialEtag);
    expect(revalidated.headers["cache-control"]).toBe("private, no-cache");
    expect(revalidated.json()).toMatchObject({ data: [], pagination: { totalItems: 0 } });

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=OPEN&pageSize=10",
      headers: { cookie, "if-none-match": revalidated.headers.etag }
    });
    expect(unchanged.statusCode).toBe(304);

    graphSnapshot.sourceHash = "b".repeat(64);
    graphSnapshot.generatedAt = "2026-07-13T09:00:00.000Z";
    const afterSnapshotRefresh = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=RESOLVED&pageSize=10",
      headers: { cookie }
    });
    expect(afterSnapshotRefresh.statusCode).toBe(200);
    expect(afterSnapshotRefresh.json().data).toEqual([
      expect.objectContaining({ id: "issue:timestamp", status: "RESOLVED", stateVersion: 1 })
    ]);

    const detailAfterSnapshotRefresh = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Aagent",
      headers: { cookie }
    });
    expect(detailAfterSnapshotRefresh.statusCode).toBe(200);
    expect(detailAfterSnapshotRefresh.json().issues[0]).toMatchObject({ status: "RESOLVED", stateVersion: 1 });

    graphSnapshot.sourceHash = "c".repeat(64);
    graphSnapshot.issues[0] = { ...graphSnapshot.issues[0]!, type: "INVALID_MARKER", status: "OPEN" };
    const identityMismatch = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?status=OPEN&pageSize=10",
      headers: { cookie }
    });
    expect(identityMismatch.statusCode).toBe(200);
    expect(identityMismatch.json().data).toEqual([
      expect.objectContaining({ id: "issue:timestamp", type: "INVALID_MARKER", status: "OPEN", stateVersion: null })
    ]);
    await app.close();
  });

  it("redacts canonical bodies and issue evidence in explicit node detail", async () => {
    const app = await memoryGraphApp(true);
    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/memory/nodes/memory%3Aagent",
      headers: { cookie }
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().record.body).toContain("Durable fact.");
    expect(detail.json().record.body).toContain("token:[REDACTED]");
    expect(detail.json().record.body).not.toContain("raw-test-value");
    expect(detail.json().issues[0].evidence).toContain("password:[REDACTED]");
    expect(detail.json().issues[0].evidence).not.toContain("raw-test-password");

    const issues = await app.inject({
      method: "GET",
      url: "/api/admin/memory/issues?pageSize=10",
      headers: { cookie }
    });
    expect(issues.statusCode).toBe(200);
    expect(issues.json().data[0].evidence).toContain("password:[REDACTED]");
    expect(issues.json().data[0].evidence).not.toContain("raw-test-password");
    await app.close();
  });

  it("creates change sets with the authenticated actor and lists summaries without snapshots", async () => {
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store);
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: { cookie, "x-space-csrf-token": csrfToken },
      payload: changeSetInput()
    });
    expect(missingKey.statusCode).toBe(422);

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });

    expect(created.statusCode).toBe(201);
    expect(created.headers["x-ratelimit-limit"]).toBe("20");
    expect(created.json()).toMatchObject({ status: "PROPOSED", actorUserId: "user:operator" });
    expect(created.json()).not.toHaveProperty("beforeSnapshot");
    expect(created.json()).not.toHaveProperty("afterSnapshot");

    const retried = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(created.json().id);

    const conflictingRetry = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: { ...changeSetInput(), reason: "A different request body." }
    });
    expect(conflictingRetry.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/memory/change-sets?status=PROPOSED&pageSize=10",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      data: [{ id: created.json().id, status: "PROPOSED", actorUserId: "user:operator" }],
      pagination: { page: 1, pageSize: 10 },
      mutationsEnabled: false
    });
    expect(listed.json().data[0]).not.toHaveProperty("beforeSnapshot");
    expect(listed.json().data[0]).not.toHaveProperty("afterSnapshot");

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(created.json().id)}`,
      headers: { cookie }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: created.json().id
    });
    expect(detail.json().beforeSnapshot).toContain("Durable fact.");
    expect(detail.json().beforeSnapshot).toContain("token:[REDACTED]");
    expect(detail.json().afterSnapshot).toContain("token:[REDACTED]");
    expect(JSON.stringify(detail.json())).not.toContain("raw-change-before");
    expect(JSON.stringify(detail.json())).not.toContain("raw-change-after");
    expect(store.getMemoryChangeSet(created.json().id).beforeSnapshot).toContain("raw-change-before");
    expect(store.listAuditEvents().map((event) => event.action)).toContain("memory.change_set.created");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("memory-command:default-retry");
    await app.close();
  });

  it("allows only operator review transitions through the public PATCH route", async () => {
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store);
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const changeSetId = created.json().id as string;

    const internalTransition = await app.inject({
      method: "PATCH",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`,
      headers: mutationHeaders,
      payload: { status: "APPLYING" }
    });
    expect(internalTransition.statusCode).toBe(422);

    const approved = await app.inject({
      method: "PATCH",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`,
      headers: mutationHeaders,
      payload: { status: "APPROVED" }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ id: changeSetId, status: "APPROVED" });
    expect(approved.json()).not.toHaveProperty("beforeSnapshot");
    expect(approved.json()).not.toHaveProperty("afterSnapshot");

    const second = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: { ...mutationHeaders, "idempotency-key": "memory-command:review-second" },
      payload: changeSetInput()
    });
    const rejected = await app.inject({
      method: "PATCH",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(second.json().id)}`,
      headers: mutationHeaders,
      payload: { status: "REJECTED", statusReason: "The proposal needs a narrower scope." }
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: "REJECTED", statusReason: "The proposal needs a narrower scope." });
    expect(rejected.json()).not.toHaveProperty("beforeSnapshot");
    expect(rejected.json()).not.toHaveProperty("afterSnapshot");
    expect(store.listAuditEvents().map((event) => event.action)).toContain("memory.change_set.reviewed");
    await app.close();
  });

  it("creates exact server-derived rollbacks through the dedicated retry-safe route", async () => {
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, true);
    const targetResponse = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const targetId = targetResponse.json().id as string;
    store.updateMemoryChangeSet(targetId, { status: "APPROVED" });
    store.updateMemoryChangeSet(targetId, { status: "APPLYING" });
    const resultingSourceHash = "c".repeat(64);
    const target = store.updateMemoryChangeSet(targetId, { status: "APPLIED", resultingSourceHash });
    const rollbackHeaders = { ...mutationHeaders, "idempotency-key": "memory-command:rollback-exact" };

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(targetId)}/rollbacks`,
      headers: { cookie, "x-space-csrf-token": csrfToken },
      payload: { reason: "Restore the reviewed canonical state." }
    });
    expect(missingKey.statusCode).toBe(422);

    const forged = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(targetId)}/rollbacks`,
      headers: rollbackHeaders,
      payload: {
        reason: "Restore the reviewed canonical state.",
        actorUserId: "user:forged",
        sourcePath: "/tmp/forged",
        beforeSnapshot: "forged"
      }
    });
    expect(forged.statusCode).toBe(422);

    const created = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(targetId)}/rollbacks`,
      headers: rollbackHeaders,
      payload: { reason: "Restore the reviewed canonical state." }
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers["x-ratelimit-limit"]).toBe("20");
    expect(created.json()).toMatchObject({
      kind: "ROLLBACK",
      status: "PROPOSED",
      sourcePath: target.sourcePath,
      recordIds: target.recordIds,
      resolvesIssueIds: target.resolvesIssueIds,
      expectedSourceHash: resultingSourceHash,
      beforeContentHash: target.afterContentHash,
      afterContentHash: target.beforeContentHash,
      actorUserId: "user:operator",
      rollbackOfChangeSetId: targetId
    });
    expect(created.json()).not.toHaveProperty("beforeSnapshot");
    expect(created.json()).not.toHaveProperty("afterSnapshot");
    expect(store.getMemoryChangeSet(created.json().id)).toMatchObject({
      beforeSnapshot: target.afterSnapshot,
      afterSnapshot: target.beforeSnapshot
    });

    const rollbackDetail = await app.inject({
      method: "GET",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(created.json().id)}`,
      headers: { cookie }
    });
    expect(rollbackDetail.statusCode).toBe(200);
    expect(rollbackDetail.json().beforeSnapshot).toContain("token:[REDACTED]");
    expect(JSON.stringify(rollbackDetail.json())).not.toContain("raw-change-after");

    const retried = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(targetId)}/rollbacks`,
      headers: rollbackHeaders,
      payload: { reason: "Restore the reviewed canonical state." }
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().id).toBe(created.json().id);

    const conflictingRetry = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(targetId)}/rollbacks`,
      headers: rollbackHeaders,
      payload: { reason: "A different rollback command." }
    });
    expect(conflictingRetry.statusCode).toBe(409);

    const genericRollback = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: { ...mutationHeaders, "idempotency-key": "memory-command:generic-rollback" },
      payload: {
        kind: "ROLLBACK",
        sourcePath: target.sourcePath,
        recordIds: target.recordIds,
        resolvesIssueIds: target.resolvesIssueIds,
        expectedSourceHash: resultingSourceHash,
        beforeContentHash: target.afterContentHash,
        afterContentHash: target.beforeContentHash,
        beforeSnapshot: target.afterSnapshot,
        afterSnapshot: target.beforeSnapshot,
        reason: "Bypass the dedicated endpoint.",
        rollbackOfChangeSetId: targetId
      }
    });
    expect(genericRollback.statusCode).toBe(409);
    expect(store.listMemoryChangeSets({ page: 1, pageSize: 25, sortOrder: "desc" }))
      .toHaveLength(2);
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("memory-command:rollback-exact");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("Restore the reviewed canonical state.");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain(target.beforeSnapshot);
    await app.close();
  });

  it("fails closed before scheduling execution when mutations are disabled", async () => {
    const starts: unknown[] = [];
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, false, {
      async start(input) {
        starts.push(input);
        return { status: "SCHEDULED", workflowId: `space-memory-mutation:${input.changeSetId}`, runId: null };
      }
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const changeSetId = created.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`,
      headers: mutationHeaders,
      payload: { status: "APPROVED" }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/executions`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("MEMORY_MUTATIONS_DISABLED");
    expect(starts).toEqual([]);
    await app.close();
  });

  it("keeps canonical execution and reconciliation commands retry-safe across compatibility aliases", async () => {
    const starts: Array<{ changeSetId: string; traceId: string }> = [];
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, true, {
      async start(input) {
        starts.push(input);
        return {
          status: starts.length === 1 ? "SCHEDULED" : "ALREADY_SCHEDULED",
          workflowId: `space-memory-mutation:${input.changeSetId}`,
          runId: starts.length === 1 ? "run:canonical-command" : null
        };
      }
    });
    const primaryResponse = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const primaryId = primaryResponse.json().id as string;
    store.updateMemoryChangeSet(primaryId, { status: "APPROVED" });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: { ...mutationHeaders, "idempotency-key": "memory-command:command-second" },
      payload: changeSetInput()
    });
    const secondId = secondResponse.json().id as string;
    store.updateMemoryChangeSet(secondId, { status: "APPROVED" });

    const noKey = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/execute`,
      headers: { cookie, "x-space-csrf-token": csrfToken },
      payload: {}
    });
    expect(noKey.statusCode).toBe(422);

    const badBody = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/execute`,
      headers: { ...mutationHeaders, "idempotency-key": "memory-command:command-invalid" },
      payload: { actorUserId: "user:forged" }
    });
    expect(badBody.statusCode).toBe(422);

    const executeHeaders = { ...mutationHeaders, "idempotency-key": "memory-command:execute-alias" };
    const executed = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/execute`,
      headers: executeHeaders,
      payload: {}
    });
    expect(executed.statusCode).toBe(202);
    expect(executed.headers["x-ratelimit-limit"]).toBe("20");
    expect(executed.json()).toEqual({
      status: "SCHEDULED",
      workflowId: `space-memory-mutation:${primaryId}`,
      runId: "run:canonical-command"
    });

    const executeReplay = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/executions`,
      headers: executeHeaders,
      payload: {}
    });
    expect(executeReplay.statusCode).toBe(202);
    expect(executeReplay.json()).toEqual({
      status: "ALREADY_SCHEDULED",
      workflowId: `space-memory-mutation:${primaryId}`,
      runId: null
    });

    const executeConflict = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(secondId)}/execute`,
      headers: executeHeaders,
      payload: {}
    });
    expect(executeConflict.statusCode).toBe(409);

    store.updateMemoryChangeSet(primaryId, { status: "APPLYING" });
    store.updateMemoryChangeSet(secondId, { status: "APPLYING" });
    const reconcileHeaders = { ...mutationHeaders, "idempotency-key": "memory-command:reconcile-alias" };
    const reconciled = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/reconcile`,
      headers: reconcileHeaders,
      payload: {}
    });
    expect(reconciled.statusCode).toBe(202);
    expect(reconciled.json()).toMatchObject({
      status: "ALREADY_SCHEDULED",
      workflowId: `space-memory-mutation:${primaryId}`
    });

    const reconcileReplay = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(primaryId)}/reconciliations`,
      headers: reconcileHeaders,
      payload: {}
    });
    expect(reconcileReplay.statusCode).toBe(202);
    expect(reconcileReplay.json()).toMatchObject({
      workflowId: `space-memory-mutation:${primaryId}`
    });

    const reconcileConflict = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(secondId)}/reconcile`,
      headers: reconcileHeaders,
      payload: {}
    });
    expect(reconcileConflict.statusCode).toBe(409);
    expect(starts).toHaveLength(4);
    expect(starts.every((input) => input.traceId.startsWith("req:"))).toBe(true);
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("memory-command:execute-alias");
    expect(JSON.stringify(store.listAuditEvents())).not.toContain("memory-command:reconcile-alias");
    await app.close();
  });

  it("gives new reconciliation commands fresh workflow identities while keeping replays stable", async () => {
    const starts: Array<{ changeSetId: string; commandHash?: string }> = [];
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, true, {
      async start(input, commandHash) {
        starts.push({ changeSetId: input.changeSetId, commandHash });
        return {
          status: "SCHEDULED",
          workflowId: commandHash
            ? `space-memory-mutation:command:${commandHash}`
            : `space-memory-mutation:${input.changeSetId}`,
          runId: `run:reconcile-${starts.length}`
        };
      }
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const changeSetId = created.json().id as string;
    store.updateMemoryChangeSet(changeSetId, { status: "APPROVED" });
    store.updateMemoryChangeSet(changeSetId, { status: "APPLYING" });

    const firstHeaders = { ...mutationHeaders, "idempotency-key": "memory-command:reconcile-first" };
    const secondHeaders = { ...mutationHeaders, "idempotency-key": "memory-command:reconcile-second" };
    const first = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconcile`,
      headers: firstHeaders,
      payload: {}
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconciliations`,
      headers: firstHeaders,
      payload: {}
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconcile`,
      headers: secondHeaders,
      payload: {}
    });

    expect([first.statusCode, replay.statusCode, second.statusCode]).toEqual([202, 202, 202]);
    expect(replay.json().workflowId).toBe(first.json().workflowId);
    expect(second.json().workflowId).not.toBe(first.json().workflowId);
    expect(starts[0]!.commandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(starts[1]!.commandHash).toBe(starts[0]!.commandHash);
    expect(starts[2]!.commandHash).not.toBe(starts[0]!.commandHash);
    await app.close();
  });

  it("schedules approved execution and APPLYING reconciliation through the dedicated coordinator", async () => {
    const starts: Array<{ changeSetId: string; traceId: string }> = [];
    const store = new InMemorySpaceStore();
    const app = await memoryGraphApp(true, store, true, {
      async start(input) {
        starts.push(input);
        return {
          status: starts.length === 1 ? "SCHEDULED" : "ALREADY_SCHEDULED",
          workflowId: `space-memory-mutation:${input.changeSetId}`,
          runId: starts.length === 1 ? "run:memory-mutation" : null
        };
      }
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/memory/change-sets",
      headers: mutationHeaders,
      payload: changeSetInput()
    });
    const changeSetId = created.json().id as string;
    const prematureExecution = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/executions`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(prematureExecution.statusCode).toBe(409);
    await app.inject({
      method: "PATCH",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}`,
      headers: mutationHeaders,
      payload: { status: "APPROVED" }
    });

    const execution = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/executions`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(execution.statusCode).toBe(202);
    expect(execution.json()).toEqual({
      status: "SCHEDULED",
      workflowId: `space-memory-mutation:${changeSetId}`,
      runId: "run:memory-mutation"
    });

    const prematureReconciliation = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconciliations`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(prematureReconciliation.statusCode).toBe(409);

    store.updateMemoryChangeSet(changeSetId, { status: "APPLYING" });
    const reconciliation = await app.inject({
      method: "POST",
      url: `/api/admin/memory/change-sets/${encodeURIComponent(changeSetId)}/reconciliations`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(reconciliation.statusCode).toBe(202);
    expect(reconciliation.json()).toMatchObject({
      status: "ALREADY_SCHEDULED",
      workflowId: `space-memory-mutation:${changeSetId}`
    });
    expect(starts).toHaveLength(2);
    expect(starts.every((input) => input.changeSetId === changeSetId && input.traceId.startsWith("req:"))).toBe(true);
    expect(store.listAuditEvents().map((event) => event.action)).toEqual(expect.arrayContaining([
      "memory.change_set.executed",
      "memory.change_set.reconciled"
    ]));
    await app.close();
  });
});
