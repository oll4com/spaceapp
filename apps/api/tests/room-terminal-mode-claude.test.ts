import { describe, expect, it } from "vitest";
import { projectRoomTerminalScreen, roomAnswerInput, roomComposerEmpty, roomComposerHolds, roomTerminalMode } from "../src/room-terminal-screen.js";

// Footers as Claude Code 2.1.296 draws them; background shells replace the "(shift+tab to cycle)" hint.
const prompt = ["────", "❯ ", "────"];
const panel = [
  "",
  "  ● main",
  "  ◯ Plan      Inspecting space-queue…  7m 13s · ↓ 231.2k tokens",
  "  ◯ Explore   Counting MCP servers…    4m 59s · ↓ 125.1k tokens",
  "  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens · 1 queued"
];
const screen = (...lines: string[]) => [...prompt, ...lines].join("\n");

describe("Room Agent mode readback for Claude Code", () => {
  it("reads the mode while background shells and agents run", () => {
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …"))).toBe("bypass permissions");
    expect(roomTerminalMode("cli:claude", screen("  ⏸ plan mode on (shift+tab to cycle) · ← for agents · ↓ …", ...panel))).toBe("plan");
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ accept edits on · 1 shell · esc to interrupt", ...panel))).toBe("accept edits");
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for a…"))).toBe("auto");
    expect(roomTerminalMode("cli:claude", screen("  ? for shortcuts · ← for agents", ...panel))).toBe("default");
  });

  it("reads the projected screen and ignores a footer quoted in the conversation", async () => {
    const projected = await projectRoomTerminalScreen([
      [...prompt, "  \u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[39m\u001b[38;2;153;153;153m · 3 shells · ← for agents\u001b[39m", ...panel].join("\r\n")
    ], 100, 20);
    expect(roomTerminalMode("cli:claude", projected)).toBe("bypass permissions");
    expect(roomTerminalMode("cli:claude", ["⏵⏵ accept edits on · 3 shells", "⏺ That was the earlier footer.", ...prompt].join("\n"))).toBeNull();
    expect(roomTerminalMode("cli:claude", ["⏺ Branches:", "  ● main", "  ◯ feature", ...prompt, "  ⏸ plan mode on · 1 shell"].join("\n"))).toBe("plan");
  });
});

describe("Room answers and Space Control prompts typed into Claude Code", () => {
  // A scheduled task's text and its Enter read in one chunk left the task as a draft (2026-10-20).
  it("types a submitted answer as a bracketed paste and keeps menu keys raw", () => {
    const task = "Scheduled task “DOCX normalizer stop-gap” (Every day at 07:25 (Asia/Bangkok), Space task task:_fdSRB0WwPyA): Run the check.";
    expect(roomAnswerInput(task, true)).toBe(`\u001b[200~${task}\u001b[201~`);
    expect(roomAnswerInput("continue", true)).toBe("\u001b[200~continue\u001b[201~");
    expect(roomAnswerInput("1", true)).toBe("1");
    expect(roomAnswerInput("2", false)).toBe("2");
    expect(roomAnswerInput(task, false)).toBe(task);
  });
});

describe("A prompt Claude Code keeps as a draft after its Enter", () => {
  // Screens as Claude Code 2.1.303 draws them (Clara/Emma 2026-10-20 01:18 UTC, and a PTY capture after a submit).
  const typed = "Scheduled task “Space Memory: check first real AI audit” (Once, Space task task:50tMPbYRzG0I): Report with " +
    "node /opt/spaceapp/scripts/space-progress.mjs done|failed --plan clipboard:yAtbVyHE5s4T --step 3. If aiStatus is DEGRADED, " +
    "report its evidence.reason; rollback is removing the five SPACE_MEMORY_AI_AUDIT_* lines from /opt/spaceapp/.env and " +
    "restarting only space-memory-maintenance-worker, and needs Nous's yes.";
  const rule = "─".repeat(100);
  const footer = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  const draft = [
    "  Not re-run: the gateway and API tests. Nothing changed since they passed.", "", "✻ Churned for 30s · done Monday 11:00 PM", "", rule,
    "❯ default -w space-memory-maintenance:2026-10-20 (expect COMPLETED). Report with node /opt/spaceapp/scripts/space-progress.mjs",
    "  done|failed --plan clipboard:yAtbVyHE5s4T --step 3. If aiStatus is DEGRADED, report its evidence.reason;",
    "  rollback is removing the five SPACE_MEMORY_AI_AUDIT_* lines from /opt/spaceapp/.env and restarting",
    "  only space-memory-maintenance-worker, and needs Nous's yes.", rule, footer
  ].join("\n");
  const sent = [
    "❯ Scheduled task “Space Memory: check first real AI audit” (Once, Space task task:50tMPbYRzG0I): Report with",
    "  rollback is removing the five SPACE_MEMORY_AI_AUDIT_* lines from /opt/spaceapp/.env and restarting",
    "  only space-memory-maintenance-worker, and needs Nous's yes.",
    "✻ Gallivanting… (esc to interrupt)", rule, "❯ ", rule, footer
  ].join("\n");

  it("sees the typed text still in the composer, inline or as a paste placeholder, and not once it was sent", () => {
    expect(roomComposerHolds(draft, typed)).toBe(true);
    expect(roomComposerHolds(sent, typed)).toBe(false);
    expect(roomComposerHolds([rule, "❯ [Pasted text #1]", rule, footer].join("\n"), typed)).toBe(true);
    expect(roomComposerHolds([rule, "❯ [Pasted text #1 +3 lines]", rule, footer].join("\n"), "line one\nline two")).toBe(true);
  });

  it("never reads a menu row or another draft as the typed prompt", () => {
    const menu = ["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No"].join("\n");
    expect(roomComposerHolds(menu, "Yes, proceed")).toBe(false);
    expect(roomComposerEmpty(menu)).toBe(false);
    expect(roomComposerEmpty(sent)).toBe(true);
    expect(roomComposerEmpty(draft)).toBe(false);
    expect(roomComposerHolds([rule, "❯ the operator's own half-written note", rule].join("\n"), typed)).toBe(false);
  });
});
