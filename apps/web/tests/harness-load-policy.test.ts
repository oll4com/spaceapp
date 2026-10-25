import { describe, expect, it } from "vitest";
import { shouldLoadHarnessPane } from "../src/features/harness-pane/harness-load-policy.js";

describe("Harness pane load policy", () => {
  it("defers a hidden Harness pane while terminal PREFILL is pending", () => {
    expect(shouldLoadHarnessPane("hidden", false)).toBe(false);
  });

  it("loads a hidden Harness pane after terminal PREFILL is ready", () => {
    expect(shouldLoadHarnessPane("hidden", true)).toBe(true);
  });

  it.each(["preparing", "held", "displayed"] as const)(
    "loads a %s Harness pane immediately",
    (presentationState) => {
      expect(shouldLoadHarnessPane(presentationState, false)).toBe(true);
    }
  );
});
