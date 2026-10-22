import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";

const graphRenderer = vi.hoisted(() => vi.fn());
const graphLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn()
}));

vi.mock("../src/features/memory-workspace/DesktopMemoryGraph.js", () => ({
  default: (props: {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string }>;
    displayMode: "SEMANTIC" | "FOCUSED";
    relationMode: "CLUSTERED" | "RELATIONS";
    selectedNodeId: string | null;
    onSelectNode: (nodeId: string) => void;
  }) => {
    useEffect(() => {
      graphLifecycle.mounted();
      return () => graphLifecycle.unmounted();
    }, []);
    graphRenderer(props);
    return (
      <div
        className="memory-graph-canvas"
        data-testid="memory-graph-renderer"
        data-node-ids={props.nodes.map((node) => node.id).join(",")}
        data-edge-ids={props.edges.map((edge) => edge.id).join(",")}
        data-display-mode={props.displayMode}
        data-relation-mode={props.relationMode}
        data-selected-node-id={props.selectedNodeId ?? ""}
        role="button" tabIndex={0} aria-label="Open map memory" onClick={() => props.onSelectNode("memory:agent")}
      />
    );
  }
}));

const sourceHash = "a".repeat(64);
const sourcePath = "/opt/spaceapp/docs/gemini_history_2026-07.md";
const memoryNode = {
  id: "memory:agent",
  type: "MEMORY",
  label: "Agent Memory",
  sourcePath,
  recordId: "memory:agent",
  position: {
    clustered: { x: 10, y: 20 },
    relations: { x: 30, y: 40 }
  }
} as const;
const roomNode = {
  id: "room:test",
  type: "ROOM",
  label: "room:test",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 12, y: 22 },
    relations: { x: 32, y: 42 }
  }
} as const;
const explicitTopicNode = {
  id: "topic:space",
  type: "TOPIC",
  label: "Space",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 14, y: 24 },
    relations: { x: 34, y: 44 }
  }
} as const;
const derivedTopicNode = {
  id: "topic:agent-context",
  type: "TOPIC",
  label: "Agent context",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 16, y: 26 },
    relations: { x: 36, y: 46 }
  }
} as const;
const sectionNode = {
  id: "section:agent",
  type: "SECTION",
  label: "Agent section",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 18, y: 28 },
    relations: { x: 38, y: 48 }
  }
} as const;
const provenanceNode = {
  id: "provenance:operator",
  type: "PROVENANCE",
  label: "operator",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 20, y: 30 },
    relations: { x: 40, y: 50 }
  }
} as const;
const sourceNode = {
  id: "source:monthly",
  type: "SOURCE",
  label: "gemini_history_2026-07.md",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 22, y: 32 },
    relations: { x: 42, y: 52 }
  }
} as const;

const graphEdges = [{
  id: "edge:room",
  type: "BELONGS_TO_ROOM",
  source: memoryNode.id,
  target: roomNode.id
}, {
  id: "edge:explicit",
  type: "TAGGED_WITH",
  source: memoryNode.id,
  target: explicitTopicNode.id,
  origin: "EXPLICIT_TAG",
  confidence: 1
}, {
  id: "edge:derived",
  type: "TAGGED_WITH",
  source: memoryNode.id,
  target: derivedTopicNode.id,
  origin: "DERIVED_TFIDF",
  confidence: 0.86
}, {
  id: "edge:section",
  type: "CONTAINS",
  source: sectionNode.id,
  target: memoryNode.id
}, {
  id: "edge:provenance",
  type: "DERIVED_FROM",
  source: memoryNode.id,
  target: provenanceNode.id
}, {
  id: "edge:source",
  type: "CONTAINS",
  source: sourceNode.id,
  target: sectionNode.id
}] as const;

const extraSpaceNodes = Array.from({ length: 9 }, (_, index) => ({
  id: `memory:space:${index + 1}`,
  type: "MEMORY" as const,
  label: `Space Memory ${index + 1}`,
  sourcePath,
  recordId: `record:space:${index + 1}`,
  position: {
    clustered: { x: 10 + index, y: 20 + index },
    relations: { x: 30 + index, y: 40 + index }
  }
}));

const extraSpaceEdges = extraSpaceNodes.map((extraNode, index) => ({
  id: `edge:explicit:extra:${index + 1}`,
  type: "TAGGED_WITH" as const,
  source: extraNode.id,
  target: explicitTopicNode.id,
  origin: "EXPLICIT_TAG" as const,
  confidence: 1
}));

const smallTagNode = {
  id: "topic:small",
  type: "TOPIC" as const,
  label: "small-tag",
  sourcePath: null,
  recordId: null,
  position: { clustered: { x: 15, y: 25 }, relations: { x: 35, y: 45 } }
} as const;

const smallTagEdge = {
  id: "edge:explicit:small",
  type: "TAGGED_WITH" as const,
  source: memoryNode.id,
  target: smallTagNode.id,
  origin: "EXPLICIT_TAG" as const,
  confidence: 1
} as const;

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function graphPayload(input: {
  isStale?: boolean;
  issueCount?: number;
  relationMode?: "CLUSTERED" | "RELATIONS";
  nodes?: unknown[];
  edges?: unknown[];
}) {
  const nodes = input.nodes ?? [
    memoryNode,
    ...extraSpaceNodes,
    roomNode,
    explicitTopicNode,
    smallTagNode,
    derivedTopicNode,
    sectionNode,
    provenanceNode,
    sourceNode
  ];
  const edges = input.edges ?? [...graphEdges, ...extraSpaceEdges, smallTagEdge];
  return {
    data: {
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 1,
      revisionHash: "c".repeat(64),
      generatedAt: "2026-07-16T08:00:00.000Z",
      sourceHash,
      isStale: input.isStale ?? false,
      summary: {
        sourceCount: 2,
        recordCount: 21,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        issueCount: input.issueCount ?? 2
      },
      nodes,
      edges,
      totalMatchingNodes: nodes.length,
      totalMatchingEdges: edges.length,
      truncated: false,
      filters: {
        q: null,
        nodeType: null,
        scope: null,
        roomId: null,
        sourcePath: null,
        lifecycleStatus: null,
        relationMode: input.relationMode ?? "CLUSTERED"
      }
    }
  };
}

function nodeDetail() {
  return {
    node: memoryNode,
    record: {
      id: memoryNode.id,
      sourcePath,
      sectionId: sectionNode.id,
      title: memoryNode.label,
      body: "## Agent Memory\n- Durable fact.",
      createdAt: "2026-07-13T08:00:00.000Z",
      scope: "SYSTEM",
      roomId: null,
      provenance: "operator",
      contentHash: "b".repeat(64),
      lifecycleStatus: "ACTIVE",
      tags: ["Space"],
      topics: [{ label: "Agent context", origin: "DERIVED_TFIDF", confidence: 0.86 }]
    },
    relatedNodes: [roomNode, explicitTopicNode, derivedTopicNode, sectionNode, provenanceNode],
    relatedEdges: graphEdges.filter((edge) => edge.id !== "edge:source"),
    issues: []
  };
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
});

describe("Memory atlas search-only experience", () => {
  afterEach(() => { graphRenderer.mockReset(); graphLifecycle.mounted.mockReset(); graphLifecycle.unmounted.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function installFetch() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/memory/graph/overview")) return json(graphPayload({}));
      if (url === "/api/admin/memory/nodes/memory%3Aagent") return json(nodeDetail());
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it.each(["desktop", "tablet"] as const)("offers only search and the interactive map on %s", async shellMode => {
    const requests = installFetch();
    render(<MemoryWorkspace shellMode={shellMode} activeRoomId="room:test" onClose={() => undefined} initialMode="atlas" />);
    await waitFor(() => expect(screen.getByTestId("memory-graph-renderer").getAttribute("data-node-ids")).toContain("memory:agent"));
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Toggle 3D memory view" }).getAttribute("aria-pressed")).toBe("false");
    const titles = screen.getByRole("button", { name: "Toggle memory titles" });
    expect(titles.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(titles);
    expect(titles.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(titles);
    expect(titles.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Current room" })).toBeNull();
    expect(requests.mock.calls.every(([url]) => String(url).includes("month=all"))).toBe(true);
    expect(screen.getByLabelText("Map topics").textContent).toContain("Space");
    expect(screen.getByLabelText("Map topics").textContent).not.toContain("small-tag");
  });
  it("searches the archive, preserves the renderer and clears search", async () => {
    const requests = installFetch();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "backup" } });
    await waitFor(() => expect(requests.mock.calls.some(([url]) => String(url).includes("q=backup") && String(url).includes("month=all"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Clear memory search" }));
    await waitFor(() => expect(String(requests.mock.calls.at(-1)?.[0])).not.toContain("q=backup"));
    expect(graphLifecycle.mounted).toHaveBeenCalledTimes(1);
  });
  it("opens readable evidence from the graph and Escape closes detail before the workspace", async () => {
    installFetch(); const onClose = vi.fn();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={onClose} initialMode="atlas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open map memory" }));
    const panel = await screen.findByLabelText("Memory node detail");
    await within(panel).findByText("Durable fact.");
    expect(within(panel).getByText("#Space")).toBeTruthy();
    expect(within(panel).queryByText("Guarded proposals")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Toggle 3D memory view" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Toggle memory titles" })).toBeNull();
    expect(document.querySelector(".memory-atlas-header .memory-atlas-view-controls")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Memory node detail")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(graphLifecycle.mounted).toHaveBeenCalledTimes(1);
  });
  it("ignores stale search responses and reports request failures", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { count++; if (count === 1) return first; return json(graphPayload({ nodes: [], edges: [] })); }));
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText("No memories found. Try another search.");
    await act(async () => resolveFirst(json(graphPayload({}))));
    expect(screen.getByTestId("memory-graph-renderer").getAttribute("data-node-ids")).toBe("");
  });
});
