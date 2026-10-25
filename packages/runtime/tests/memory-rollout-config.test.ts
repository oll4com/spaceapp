import { describe, expect, it } from "vitest";
import { memoryRolloutEnvironmentState, renderMemoryRolloutEnvironment } from "../src/memory-rollout-config.js";

describe("memory rollout environment", () => {
  const source = [
    "SPACE_API_PORT=4910",
    "SPACE_MEMORY_GRAPH_ENABLED=false",
    "SPACE_MEMORY_MAINTENANCE_ENABLED=false",
    "UNRELATED_SECRET=preserved-verbatim",
    ""
  ].join("\n");

  it.each([
    ["disabled", ["false", "false", "false"]],
    ["read-only", ["true", "true", "false"]],
    ["mutations", ["true", "true", "true"]]
  ] as const)("renders the %s mode without changing unrelated values", (mode, values) => {
    const rendered = renderMemoryRolloutEnvironment(source, mode);

    expect(rendered).toContain(`SPACE_MEMORY_GRAPH_ENABLED=${values[0]}`);
    expect(rendered).toContain(`SPACE_MEMORY_MAINTENANCE_ENABLED=${values[1]}`);
    expect(rendered).toContain(`SPACE_MEMORY_MUTATIONS_ENABLED=${values[2]}`);
    expect(rendered).toContain("UNRELATED_SECRET=preserved-verbatim");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("rejects duplicate flag declarations instead of guessing precedence", () => {
    expect(() => renderMemoryRolloutEnvironment(
      `${source}SPACE_MEMORY_GRAPH_ENABLED=true\n`,
      "read-only"
    )).toThrow(/duplicate/i);
  });

  it("redacts unexpected flag values from status output", () => {
    expect(memoryRolloutEnvironmentState("SPACE_MEMORY_GRAPH_ENABLED=unexpected-sensitive-value\n"))
      .toMatchObject({ SPACE_MEMORY_GRAPH_ENABLED: "invalid" });
  });
});
