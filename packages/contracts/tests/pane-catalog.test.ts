import { describe, expect, it } from "vitest";
import { CLI_PANE_TYPES, PANE_TYPES, PANE_CATALOG_VERSION, cliTurnInterruptKey, paneCountsSchema, roomPaneCommandSchema } from "../src/pane-catalog.js";

describe("room command catalog", () => {
  it("contains every menu type and separates Harness from DeepSeek CLI", () => {
    expect(CLI_PANE_TYPES).toHaveLength(16);
    expect(PANE_TYPES).toHaveLength(31);
    expect(new Set(PANE_TYPES.map(type => type.typeId)).size).toBe(31);
    expect(PANE_TYPES.find(type => type.typeId === "deepseek")?.mode).toBe("TERMINAL");
    expect(PANE_TYPES.find(type => type.typeId === "harness")?.mode).toBe("HARNESS");
    expect(PANE_TYPES.find(type => type.typeId === "live")?.mode).toBe("LIVE");
    expect(PANE_TYPES.find(type => type.typeId === "files")?.mode).toBe("FILES");
    expect(PANE_TYPES.find(type => type.typeId === "databases")?.mode).toBe("DATABASES");
    expect(PANE_TYPES.find(type => type.typeId === "demos")?.mode).toBe("DEMOS");
    expect(PANE_TYPES.find(type => type.typeId === "t3code")?.mode).toBe("T3CODE");
    expect(PANE_TYPES.find(type => type.typeId === "jobs")?.mode).toBe("JOB_APPLY");
    expect(PANE_TYPES.find(type => type.typeId === "mail")?.mode).toBe("MAIL_COPILOT");
    expect(PANE_TYPES.find(type => type.typeId === "marketing")?.mode).toBe("MARKETING_COPILOT");
    expect(PANE_TYPES.find(type => type.typeId === "freelance")?.mode).toBe("FREELANCE_COPILOT");
    expect(PANE_TYPES.find(type => type.typeId === "design")?.mode).toBe("DESIGN");
  });
  it.each([{}, { codex: 0 }, { codex: -1 }, { codex: 1.5 }, { codex: "2" }, { codex: 17 }, { codex: 8, gemini: 9 }, { root: 1 }, { nope: 1 }])("rejects invalid counts %j", counts => {
    expect(paneCountsSchema.safeParse(counts).success).toBe(false);
  });
  it("accepts mixed groups through sixteen and rejects model-owned routing context", () => {
    const command = { requestId: "request:valid", catalogVersion: PANE_CATALOG_VERSION,
      action: { type: "OPEN_PANES", counts: { codex: 2, gemini: 3, browser: 1, vnc: 10 } } };
    expect(roomPaneCommandSchema.safeParse(command).success).toBe(true);
    for (const extra of [{ roomId: "room:other" }, { actorId: "user:other" }, { cwd: "/root" }])
      expect(roomPaneCommandSchema.safeParse({ ...command, ...extra }).success).toBe(false);
    expect(roomPaneCommandSchema.safeParse({ ...command, catalogVersion: "old" }).success).toBe(false);
  });
  it("interrupts each CLI turn with the key its own TUI documents", () => {
    for (const runtimeId of ["cli:codex", "cli:claude", "cli:muse", "cli:omp", "cli:droid"]) expect(cliTurnInterruptKey(runtimeId)).toBe("escape");
    for (const runtimeId of ["cli:gemini", "cli:opencode", "cli:qwen", "cli:hermes", "cli:deepseek", "cli:qoder"]) {
      expect(cliTurnInterruptKey(runtimeId)).toBe("ctrl_c");
    }
    expect(cliTurnInterruptKey(null)).toBe("ctrl_c");
  });
});
