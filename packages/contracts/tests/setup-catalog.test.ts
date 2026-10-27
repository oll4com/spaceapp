import { describe, expect, it } from "vitest";
import {
  SETUP_CATALOG,
  buildSetupSelection,
  resolveSetupSelection,
  type SetupAvailability,
  type SetupFeatureId
} from "../src/setup-catalog.js";

const available = Object.fromEntries(
  SETUP_CATALOG.map((feature) => [feature.id, "AVAILABLE"])
) as Record<SetupFeatureId, SetupAvailability>;

const ids = (persona: "everyday" | "creator" | "developer", level: "minimal" | "balanced" | "full") =>
  buildSetupSelection(persona, level, available, []).requestedIds;

const baseline: SetupFeatureId[] = [
  "agent:opencode", "pane:chat", "dock:rooms", "dock:tasks", "dock:agent-files", "dock:settings"
];

describe("first setup catalog", () => {
  it("names every ID uniquely and keeps OpenCode first among agents", () => {
    expect(SETUP_CATALOG[0]?.id).toBe("agent:opencode");
    expect(new Set(SETUP_CATALOG.map((feature) => feature.id)).size).toBe(SETUP_CATALOG.length);
    expect(SETUP_CATALOG.filter((feature) => feature.kind === "agent").map((feature) => feature.id)).toEqual([
      "agent:opencode", "agent:codex", "agent:claude", "agent:gemini", "agent:autohand", "agent:qwen",
      "agent:kimi", "agent:grok", "agent:deepseek", "agent:cursor", "agent:copilot", "agent:hermes",
      "agent:omp", "agent:qoder", "agent:muse", "agent:droid"
    ]);
    for (const feature of SETUP_CATALOG) {
      expect(feature.label.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(0);
      expect(feature.details.length).toBeGreaterThan(0);
      expect(feature.readinessCheckId.length).toBeGreaterThan(0);
      expect(feature.availabilityRuleId.length).toBeGreaterThan(0);
      expect(feature.dataUse.length).toBeGreaterThan(0);
    }
  });

  for (const persona of ["everyday", "creator", "developer"] as const) {
    for (const level of ["minimal", "balanced", "full"] as const) {
      it(`${persona} ${level} always has the essential free starting tools`, () => {
        const selected = ids(persona, level);
        for (const id of baseline) expect(selected).toContain(id);
        expect(selected.filter((id) => id.startsWith("agent:"))).toEqual(["agent:opencode"]);
        const resolved = resolveSetupSelection(selected, available);
        expect(resolved.issues).toEqual([]);
        expect(resolved.effectiveIds).toEqual([...new Set(resolved.effectiveIds)]);
      });
    }
  }

  it("Everyday Minimal and Balanced leave File Manager and Databases off", () => {
    for (const level of ["minimal", "balanced"] as const) {
      const selected = ids("everyday", level);
      expect(selected).not.toContain("pane:files");
      expect(selected).not.toContain("pane:databases");
    }
    expect(ids("everyday", "full")).toContain("pane:files");
    expect(ids("everyday", "full")).toContain("pane:databases");
  });

  it("Balanced adds common tools and only persona-specific additions", () => {
    const common = ["pane:browser", "dock:clipboard", "dock:links", "dock:agent-sessions", "widget:clock", "widget:countdown-timer"];
    for (const persona of ["everyday", "creator", "developer"] as const) {
      for (const feature of common) expect(ids(persona, "balanced")).toContain(feature);
    }
    for (const feature of ["dock:media", "pane:youtube", "utility:snip"]) {
      expect(ids("creator", "balanced")).toContain(feature);
      expect(ids("developer", "balanced")).not.toContain(feature);
    }
    for (const feature of ["pane:files", "pane:demos", "dock:source-control", "dock:cli", "utility:worktrees"]) {
      expect(ids("developer", "balanced")).toContain(feature);
      expect(ids("creator", "balanced")).not.toContain(feature);
    }
    expect(ids("developer", "balanced")).not.toContain("pane:databases");
  });

  it("Full includes eligible workspace tools but never mass-selects agents", () => {
    const selected = ids("everyday", "full");
    expect(selected.filter((id) => id.startsWith("agent:"))).toEqual(["agent:opencode"]);
    for (const feature of SETUP_CATALOG.filter((item) => item.kind !== "agent")) {
      expect(selected).toContain(feature.id);
    }
  });

  it("skips unavailable optional defaults but reports selected unavailable tools", () => {
    const availability = { ...available, "utility:snip": "UNAVAILABLE", "pane:live": "FORBIDDEN" } as const;
    expect(buildSetupSelection("creator", "balanced", availability, []).requestedIds).not.toContain("utility:snip");
    expect(buildSetupSelection("everyday", "full", availability, []).requestedIds).not.toContain("pane:live");
    const selected = resolveSetupSelection(["agent:opencode", "pane:live"], availability);
    expect(selected.effectiveIds).not.toContain("pane:live");
    expect(selected.issues).toContainEqual({ featureId: "pane:live", reason: "FORBIDDEN" });
  });

  it("adds a shared dependency once and keeps explicit selection distinct", () => {
    const resolved = resolveSetupSelection(["widget:streaming-metrics", "dock:streaming"], available);
    expect(resolved.effectiveIds.filter((id) => id === "dock:streaming")).toHaveLength(1);
    expect(resolved.dependencyIds).not.toContain("dock:streaming");
    const automatic = resolveSetupSelection(["widget:streaming-metrics"], available);
    expect(automatic.dependencyIds).toEqual(["dock:streaming"]);
    expect(automatic.effectiveIds).toContain("dock:streaming");
  });

  it("fails closed when a dependency is unavailable", () => {
    const resolved = resolveSetupSelection(["widget:streaming-metrics"], {
      ...available, "dock:streaming": "UNAVAILABLE"
    });
    expect(resolved.issues).toContainEqual({ featureId: "dock:streaming", reason: "UNAVAILABLE" });
    expect(resolved.effectiveIds).not.toContain("widget:streaming-metrics");
  });

  it("rejects unknown IDs and dependency cycles deterministically", () => {
    expect(() => resolveSetupSelection(["pane:unknown" as SetupFeatureId], available)).toThrow(/Unknown setup feature/);
    const cyclicCatalog = SETUP_CATALOG.map((feature) => feature.id === "dock:streaming"
      ? { ...feature, dependencies: ["widget:streaming-metrics" as SetupFeatureId] }
      : feature);
    expect(() => resolveSetupSelection(["widget:streaming-metrics"], available, cyclicCatalog)).toThrow(/cycle/i);
  });

  it("keeps required OpenCode selected even when unavailable so setup cannot claim Ready", () => {
    const selection = buildSetupSelection("everyday", "minimal", {
      ...available, "agent:opencode": "UNAVAILABLE"
    }, []);
    expect(selection.requestedIds).toContain("agent:opencode");
    expect(selection.issues).toContainEqual({ featureId: "agent:opencode", reason: "UNAVAILABLE" });
  });

  it("maps agent choices to the existing CLI runtime setting IDs", () => {
    for (const agent of SETUP_CATALOG.filter((entry) => entry.kind === "agent")) {
      expect(agent.settingsBinding).toEqual({ kind: "agent", id: `cli:${agent.id.slice("agent:".length)}` });
    }
    expect(SETUP_CATALOG.find((entry) => entry.id === "dock:settings")?.settingsBinding).toEqual({ kind: "dock", id: "settings" });
  });

  it("adds only explicitly selected extra agents and reports unavailable selections", () => {
    const selection = buildSetupSelection("everyday", "full", {
      ...available, "agent:codex": "INSTALLABLE", "agent:claude": "UNAVAILABLE"
    }, ["agent:codex", "agent:claude"]);
    expect(selection.requestedIds.filter((id) => id.startsWith("agent:"))).toEqual([
      "agent:opencode", "agent:codex", "agent:claude"
    ]);
    expect(selection.issues).toContainEqual({ featureId: "agent:claude", reason: "UNAVAILABLE" });
  });
});
