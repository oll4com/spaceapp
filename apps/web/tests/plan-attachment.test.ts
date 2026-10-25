import { expect, it } from "vitest";
import { formatPlanAttachment } from "../src/features/terminal-pane/plan-attachment.js";

it("includes model and reasoning in the plan sent to a CLI without changing the saved text", () => {
  const plan = { title: "Database", text: "# Database\n\nOriginal steps", minimumModel: "gpt-6.1-sol", minimumReasoning: "high" as const };
  expect(formatPlanAttachment(plan)).toBe("Minimum capable model: gpt-6.1-sol\nRecommended reasoning: high\n\n# Database\n\nOriginal steps");
  expect(plan.text).toBe("# Database\n\nOriginal steps");
});

it("keeps legacy plan contents readable when no recommendations exist", () => {
  expect(formatPlanAttachment({ title: "Legacy", text: "Steps", minimumModel: null })).toBe("# Legacy\n\nSteps");
});
