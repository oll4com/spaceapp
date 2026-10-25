import { describe, expect, it } from "vitest";
import {
  cliTaskHistoryItemSchema,
  cliTaskHistoryQuerySchema,
  resumePaneCliSessionResponseSchema
} from "../src/index.js";

describe("logical CLI task history contracts", () => {
  it("accepts a provider-scoped logical history query", () => {
    expect(cliTaskHistoryQuerySchema.parse({ page: "1", pageSize: "50", runtimeId: "cli:claude" })).toMatchObject({
      page: 1,
      pageSize: 50,
      runtimeId: "cli:claude"
    });
    expect(() => cliTaskHistoryQuerySchema.parse({ runtimeId: "cli:root" })).toThrow();
  });

  it("identifies the current revision without exposing a native provider reference", () => {
    const item = cliTaskHistoryItemSchema.parse({
      id: "cli_task:one",
      taskId: "cli_task:one",
      revisionId: "cli_revision:two",
      title: "Independent task",
      runtimeId: "cli:claude",
      providerId: "anthropic",
      providerLabel: "Claude Code",
      modelProvider: "anthropic",
      preview: "Latest output",
      firstUserMessage: "Original request",
      cwd: "/etc",
      model: null,
      reasoningEffort: "medium",
      updatedAt: "2026-07-22T00:00:00.000Z",
      recencyAt: "2026-07-22T00:00:00.000Z",
      archived: false,
      source: "space",
      threadSource: "cli:claude",
      rolloutPath: null
    });

    expect(item.revisionId).toBe("cli_revision:two");
    expect(item).not.toHaveProperty("nativeTaskRef");
  });

  it("reports the exact continuation mode used by the server", () => {
    expect(resumePaneCliSessionResponseSchema.shape.mode.options).toEqual([
      "NATIVE_RESUME",
      "CROSS_RUNTIME_SHARE",
      "SPACE_FALLBACK"
    ]);
  });
});
