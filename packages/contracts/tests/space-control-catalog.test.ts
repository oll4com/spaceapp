import { describe, expect, it } from "vitest";
import { controlActionCatalog, controlActionSchema, controlResourceOperations } from "../src/space-control.js";

// What Space Control's execute runs: each kind with its operations, plus every resource operation.
function executable(): Set<string> {
  const runs = new Set<string>(controlResourceOperations);
  for (const option of controlActionSchema.options) {
    const shape = option.shape as Record<string, { value?: string; options?: string[]; unwrap?: () => { options?: string[] }; def?: { innerType?: { options?: string[] } } }>;
    const kind = shape.kind!.value!;
    runs.add(kind);
    const operation = shape.operation;
    const operations = operation?.options ?? operation?.def?.innerType?.options ?? [];
    for (const name of operations) runs.add(`${kind}.${name}`);
  }
  return runs;
}

// Catalogue names that are spelled differently from the action they run.
const catalogueToAction: Record<string, string> = { "pane.open": "panes.open", "watches.register": "watch.register", visual_audit: "pane.visual_audit" };

describe("Space Control action catalogue", () => {
  it("lists only actions execute can run (cleanup plan clipboard:mJxMBg0sQ8hi step 7)", () => {
    const runs = executable();
    const listed = controlActionCatalog.map((item) => item.action);
    expect(listed.filter((action) => !runs.has(catalogueToAction[action] ?? action))).toEqual([]);
    expect(listed).not.toContain("room.delete");
    expect(listed).toContain("room.activate");
  });
});
