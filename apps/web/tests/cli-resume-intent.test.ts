import { describe, expect, it } from "vitest";
import {
  hasCliResumeIntent,
  registerCliResumeIntent,
  takeCliResumeIntent,
  hasPendingThreadOpen,
  registerPendingThreadOpen,
  takePendingThreadOpen
} from "../src/features/terminal-pane/cli-resume-intent.js";

describe("cli-resume-intent registry", () => {
  it("registers, detects, and consumes a CLI resume intent exactly once", () => {
    registerCliResumeIntent("pane:one", { taskId: "task:a" });
    expect(hasCliResumeIntent("pane:one")).toBe(true);
    expect(takeCliResumeIntent("pane:one")).toEqual({ taskId: "task:a" });
    expect(takeCliResumeIntent("pane:one")).toBeNull();
    expect(hasCliResumeIntent("pane:one")).toBe(false);
  });

  it("supports codex thread intents", () => {
    registerCliResumeIntent("pane:codex", { threadId: "019f-thread" });
    expect(hasCliResumeIntent("pane:codex")).toBe(true);
    expect(takeCliResumeIntent("pane:codex")).toEqual({ threadId: "019f-thread" });
    expect(hasCliResumeIntent("pane:codex")).toBe(false);
  });

  it("returns null for unknown pane ids and ignores other panes", () => {
    registerCliResumeIntent("pane:one", { taskId: "task:a" });
    expect(takeCliResumeIntent("pane:other")).toBeNull();
    expect(hasCliResumeIntent("pane:other")).toBe(false);
    expect(takeCliResumeIntent("pane:one")).toEqual({ taskId: "task:a" });
  });

  it("allows independent concurrent intents per pane", () => {
    registerCliResumeIntent("pane:one", { taskId: "task:a" });
    registerCliResumeIntent("pane:two", { taskId: "task:b" });
    expect(takeCliResumeIntent("pane:two")).toEqual({ taskId: "task:b" });
    expect(takeCliResumeIntent("pane:one")).toEqual({ taskId: "task:a" });
  });

  it("registers, detects, and consumes a pending thread open exactly once", () => {
    registerPendingThreadOpen("pane:chat", "thread:xyz");
    expect(hasPendingThreadOpen("pane:chat")).toBe(true);
    expect(takePendingThreadOpen("pane:chat")).toBe("thread:xyz");
    expect(takePendingThreadOpen("pane:chat")).toBeNull();
    expect(hasPendingThreadOpen("pane:chat")).toBe(false);
  });
});