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

  it("reads a prompt row holding only the finished turn's status as empty, never a draft (28/10: Bruno/Kate, Bruno/Finn)", () => {
    // 31/10: an accented verb ("Sautéed") made Alex/Emma's idle prompt read as a draft, so no brief kickoff was typed.
    for (const row of ["❯ Cogitated for 18s · done 5:49 PM", "❯ Churned for 45s · done 6:46 PM · 1 sh↓ to managr", "❯ Worked for 2m 3s", "❯ Sautéed for 41m 12s · done 8:18 PM", "❯ Flambéed for 1h 2m 3s"]) {
      expect(roomComposerEmpty([rule, row, rule, footer].join("\n")), row).toBe(true);
    }
    for (const draft of ["❯ Cogitated for a while, then fix the tests", "❯ fix the tests for 18s", "❯ cogitated for 18s"]) {
      expect(roomComposerEmpty([rule, draft, rule, footer].join("\n")), draft).toBe(false);
    }
  });

  it("reads the last prompt row however many rows Claude lists under its footer (31/10 Alex/Emma, idle 7 h with briefs waiting)", () => {
    // Nous read Emma's screen at 01:4x UTC: this status row above an empty composer, a background shell listed under the footer.
    const panel = ["  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell", "  ● main", "  ◯ npx serve dist -l 8099   2h 10m", "  ◯ shell 2", "  ◯ shell 3"];
    const emma = ["⏺ Done: 0.2.4 is built.", "✻ Sautéed for 40s · done 3:31 AM · 1 shell still running", rule, "❯ ", rule, ...panel].join("\n");
    expect(roomComposerEmpty(emma)).toBe(true);
    expect(roomComposerEmpty([rule, "❯ Sautéed for 40s · done 3:31 AM · 1 shell still running", rule, ...panel].join("\n"))).toBe(true);
    // The composer is the last prompt row: an older empty prompt above a real draft is no empty composer, and a panel row is none.
    expect(roomComposerEmpty(["❯ ", "⏺ Working on it.", rule, "❯ fix the tests", rule, ...panel].join("\n"))).toBe(false);
    expect(roomComposerEmpty([rule, "❯ ", rule, footer, "❯ ● main"].join("\n"))).toBe(true);
    expect(roomComposerEmpty([rule, "❯ fix the tests", rule, footer, "❯ ● main"].join("\n"))).toBe(false);
  });

  it("reads Codex's placeholder row as an empty composer, never a draft (R15-1, 29/10 Alex/Kate)", () => {
    const codexFooter = ["  gpt-6.1-sol xhigh · /opt/spaceapp", "  esc again to edit previous message"];
    for (const row of ["› Ask Codex to do anything", "› Explain this codebase", "› Implement {feature}", "› Use /skills to list available skills"]) {
      expect(roomComposerEmpty(["• Done.", "", row, "", ...codexFooter].join("\n")), row).toBe(true);
    }
    for (const draft of ["› Ask Codex to do anything about the tests", "› explain this codebase", "❯ Ask Codex to do anything"]) {
      expect(roomComposerEmpty(["• Done.", "", draft, "", ...codexFooter].join("\n")), draft).toBe(false);
    }
  });

  it("reads Claude Code's /clear hint and OpenCode 2's empty input box as empty composers (31/10 Cleo/Kate, 30/10 Alex/Bob)", () => {
    expect(roomComposerEmpty([rule, "❯ new task? /clear to save 122.2k tokens", rule, footer].join("\n"))).toBe(true);
    expect(roomComposerEmpty([rule, "❯ new task? /clear to save 1.1M tokens", rule, footer].join("\n"))).toBe(true);
    expect(roomComposerEmpty([rule, "❯ new task? /clear to save the notes, then commit", rule, footer].join("\n"))).toBe(false);
    const status = "  ┃ Build · Claude Sonnet 5.5 (API credits) Space Gateway Claude (API credits) · low";
    const bottom = ["  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", "             esc interrupt   41.2K (20%)  ctrl+p commands"];
    expect(roomComposerEmpty(["• Done.", "  ┃", "  ┃", status, ...bottom].join("\n"))).toBe(true);
    expect(roomComposerEmpty(["• Done.", '  ┃  Ask anything… "Fix a TODO in the codebase"', "  ┃", status, ...bottom].join("\n"))).toBe(true);
    expect(roomComposerEmpty(["• Done.", "  ┃  fix the failing test", "  ┃", status, ...bottom].join("\n"))).toBe(false);
    expect(roomComposerEmpty(["• Done.", status, ...bottom].join("\n"))).toBe(false);
  });

  it("reads Antigravity's mode hint in its empty composer as empty (1/11 Crypto/Andy: task VCLveLP_3o8g waited on an idle Gemini pane)", () => {
    // Antigravity CLI 1.4.12 (cli:gemini) idle, as Space Control read it on a fresh pane (1/11 20:00 UTC).
    const line = "─".repeat(100);
    const agy = (row: string) => ["      ▄▀▀▄        Antigravity CLI 1.4.12", "", line, row, line,
      "? for shortcuts                                               accept-edits · Gemini 3.8 Flash · high"].join("\n");
    expect(roomComposerEmpty(agy("> Accept-edits mode: file edits auto-approved (shift+tab to cycle)"))).toBe(true);
    expect(roomComposerEmpty(agy("> Plan mode: read-only research (shift+tab to cycle)"))).toBe(true);
    // 2/11: every mode hint the 1.4.12 binary holds (its Default approval mode shows none, the plain "> " row).
    expect(roomComposerEmpty(agy("> Plan mode: research & plan only (shift+tab to cycle)"))).toBe(true);
    expect(roomComposerEmpty(agy("> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)"))).toBe(true);
    expect(roomComposerEmpty(agy("> Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)"))).toBe(true);
    expect(roomComposerEmpty(agy("> Accept-edits mode"))).toBe(true);
    expect(roomComposerEmpty(agy("> "))).toBe(true);
    expect(roomComposerEmpty(agy("> run the host-a isolation check"))).toBe(false);
    expect(roomComposerEmpty(agy("> Accept-edits mode: file edits auto-approved, then run the tests"))).toBe(false);
  });
});
