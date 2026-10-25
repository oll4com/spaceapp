import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import {
  memoryGraphEdgeStyle,
  memoryGraphNodeStyle,
  memoryGraphTaxonomySummary,
  orderMemoryGraphNodes,
  resolveMemoryGraphPosition,
  shouldForceMemoryGraphLabel
} from "../src/features/memory-workspace/memory-graph-visuals.js";

function node(id: string, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode {
  return { id, type, label: id, sourcePath: null, recordId: type === "MEMORY" ? id : null };
}

describe("memory graph visuals", () => {
  it("uses versioned positions and gives legacy nodes distinct deterministic fallbacks", () => {
    const positioned: MemoryGraphNode = {
      ...node("memory:positioned"),
      position: {
        clustered: { x: 12.5, y: -7.25 },
        relations: { x: -2.5, y: 4.75 }
      }
    };
    expect(resolveMemoryGraphPosition(positioned, 0, "CLUSTERED")).toEqual({ x: 12.5, y: -7.25 });
    expect(resolveMemoryGraphPosition(positioned, 0, "RELATIONS")).toEqual({ x: -2.5, y: 4.75 });

    const legacyNodes = [node("memory:alpha"), node("memory:beta"), node("topic:space", "TOPIC")];
    const firstPass = legacyNodes.map((candidate, index) => resolveMemoryGraphPosition(candidate, index, "CLUSTERED"));
    const secondPass = legacyNodes.map((candidate, index) => resolveMemoryGraphPosition(candidate, index, "CLUSTERED"));
    expect(firstPass).toEqual(secondPass);
    expect(firstPass.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(new Set(firstPass.map(({ x, y }) => `${x}:${y}`)).size).toBe(legacyNodes.length);
  });

  it("reveals connected anchors first and gives tag and semantic edges distinct visual semantics", () => {
    const nodes = [node("memory:leaf-a"), node("source:canonical", "SOURCE"), node("topic:space", "TOPIC"), node("memory:leaf-b")];
    const edges: MemoryGraphEdge[] = [{
      id: "edge:contains-a",
      type: "CONTAINS",
      source: "source:canonical",
      target: "memory:leaf-a"
    }, {
      id: "edge:contains-b",
      type: "CONTAINS",
      source: "source:canonical",
      target: "memory:leaf-b"
    }, {
      id: "edge:tag",
      type: "TAGGED_WITH",
      source: "memory:leaf-a",
      target: "topic:space",
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Explicit tag: Space."
    }];

    expect(orderMemoryGraphNodes(nodes, edges)[0]?.id).toBe("source:canonical");
    const tagStyle = memoryGraphEdgeStyle(edges[2]!);
    const semanticStyle = memoryGraphEdgeStyle({
      id: "edge:semantic",
      type: "SEMANTICALLY_RELATED",
      source: "memory:leaf-a",
      target: "memory:leaf-b",
      origin: "DETERMINISTIC_TFIDF",
      confidence: 0.82,
      evidence: "Shared TF-IDF terms: memory."
    });
    expect(tagStyle).not.toEqual(semanticStyle);
    expect(tagStyle.label).toBe("Explicit tag");
    expect(semanticStyle.label).toBe("Semantic similarity");
  });

  it("keeps the overview readable while distinguishing explicit tags from derived topics", () => {
    const nodes = [
      node("source:canonical", "SOURCE"),
      node("memory:one"),
      node("memory:two"),
      node("topic:explicit", "TOPIC"),
      node("topic:derived", "TOPIC")
    ];
    const edges: MemoryGraphEdge[] = [{
      id: "edge:explicit",
      type: "TAGGED_WITH",
      source: "memory:one",
      target: "topic:explicit",
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Explicit canonical tag."
    }, {
      id: "edge:derived",
      type: "TAGGED_WITH",
      source: "memory:two",
      target: "topic:derived",
      origin: "DERIVED_TFIDF",
      confidence: 0.84,
      evidence: "Deterministic TF-IDF topic."
    }, {
      id: "edge:semantic",
      type: "SEMANTICALLY_RELATED",
      source: "memory:one",
      target: "memory:two",
      origin: "DETERMINISTIC_TFIDF",
      confidence: 0.72,
      evidence: "Shared terms."
    }];

    expect(memoryGraphTaxonomySummary(nodes, edges)).toEqual({
      explicitTags: 1,
      derivedTopics: 1,
      semanticLinks: 1
    });
    expect(shouldForceMemoryGraphLabel(nodes[0]!, null, 3, 0)).toBe(true);
    expect(shouldForceMemoryGraphLabel(nodes[3]!, "EXPLICIT_TAG", 2, 1)).toBe(false);
    expect(shouldForceMemoryGraphLabel(nodes[4]!, "DERIVED_TFIDF", 1, 2)).toBe(false);
    expect(shouldForceMemoryGraphLabel(nodes[1]!, null, 4, 3)).toBe(true);
    expect(shouldForceMemoryGraphLabel(nodes[1]!, null, 4, 4)).toBe(false);
    expect(memoryGraphNodeStyle(nodes[3]!, "EXPLICIT_TAG")).toMatchObject({ label: "Explicit tag" });
    expect(memoryGraphNodeStyle(nodes[4]!, "DERIVED_TFIDF")).toMatchObject({ label: "Derived topic" });
  });
});
