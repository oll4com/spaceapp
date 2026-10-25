import { describe, it, expect, beforeEach } from "vitest";
import {
  cleanTerminalAnsi,
  appendTerminalPreviewChunk,
  seedTerminalPreviewLines,
  getTerminalPreviewLines,
  registerTerminalPreviewGetter,
  subscribeTerminalPreview,
  getTerminalPreviewSummary,
  summarizeTerminalPreviewLines,
  classifyTerminalPreviewLine
} from "../src/features/terminal-pane/terminal-preview-service.js";

describe("terminal-preview-service", () => {
  const paneId = "test-pane-1";

  beforeEach(() => {
    // Reset by registering a dummy getter that clears or seeds
  });

  it("cleans ANSI escape sequences from text correctly", () => {
    const ansiString = "\x1b[32m✔ Success\x1b[0m: file created at \x1b[1;34m/opt/spaceapp\x1b[0m\r\n";
    const cleaned = cleanTerminalAnsi(ansiString);
    expect(cleaned).toBe("✔ Success: file created at /opt/spaceapp\r\n");
  });

  it("seeds and retrieves terminal preview lines", () => {
    seedTerminalPreviewLines(paneId, ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
    const preview = getTerminalPreviewLines(paneId, 5);
    expect(preview).toHaveLength(5);
    expect(preview).toEqual(["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
  });

  it("streams new chunks and appends them in real time", () => {
    seedTerminalPreviewLines(paneId, ["Ready"]);
    appendTerminalPreviewChunk(paneId, "Starting task...\r\n");
    appendTerminalPreviewChunk(paneId, "\x1b[33mProcessing...\x1b[0m\r\n");

    const preview = getTerminalPreviewLines(paneId, 5);
    expect(preview).toEqual(["Ready", "Starting task...", "Processing..."]);
  });

  it("handles carriage returns without newline as line overwrites (spinner/progress)", () => {
    seedTerminalPreviewLines(paneId, ["Idle"]);
    appendTerminalPreviewChunk(paneId, "Download: 10%");
    expect(getTerminalPreviewLines(paneId, 5)).toEqual(["Idle", "Download: 10%"]);

    appendTerminalPreviewChunk(paneId, "\rDownload: 50%");
    expect(getTerminalPreviewLines(paneId, 5)).toEqual(["Idle", "Download: 50%"]);

    appendTerminalPreviewChunk(paneId, "\rDownload: 100%\r\nDone!\r\n");
    expect(getTerminalPreviewLines(paneId, 5)).toEqual(["Idle", "Download: 100%", "Done!"]);
  });

  it("notifies listeners when new output arrives", async () => {
    let notified = false;
    const unsubscribe = subscribeTerminalPreview((updatedPaneId) => {
      if (updatedPaneId === "pane-listener-test") {
        notified = true;
      }
    });

    seedTerminalPreviewLines("pane-listener-test", ["Init"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notified).toBe(true);

    notified = false;
    appendTerminalPreviewChunk("pane-listener-test", "New chunk\r\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notified).toBe(true);

    unsubscribe();
  });
});

describe("terminal-preview-service TUI summaries", () => {
  const claudeFrame = [
    "● Updated the minimized bar preview.\r\n",
    "  ⎿  Wrote 42 lines to src/App.tsx\r\n",
    "\r\n",
    "✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)\r\n",
    "\r\n",
    "────────────────────────────────────────\r\n",
    "❯ \r\n",
    "────────────────────────────────────────\r\n",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)\r\n",
    "*"
  ].join("");

  it("drops Claude Code input box and footer chrome and keeps the real output", () => {
    seedTerminalPreviewLines("tui-claude", ["Starting"]);
    appendTerminalPreviewChunk("tui-claude", claudeFrame);
    // Ink-style redraw: erase the previous frame with cursor-up moves, then write it again.
    appendTerminalPreviewChunk("tui-claude", "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G" + claudeFrame.replace("12s", "13s"));

    const summary = getTerminalPreviewSummary("tui-claude", 5);
    expect(summary.lines).toEqual([
      "Starting",
      "● Updated the minimized bar preview.",
      "  └  Wrote 42 lines to src/App.tsx"
    ]);
    expect(summary.activity).toEqual({ label: "Thinking…", elapsed: "13s" });
    expect(summary.activityAt).toBeGreaterThan(0);
    expect(summary.attention).toBeNull();
  });

  it("flags an approval prompt as needing input", () => {
    seedTerminalPreviewLines("tui-approval", ["● Bash(rm -rf dist)"]);
    appendTerminalPreviewChunk(
      "tui-approval",
      [
        "Do you want to proceed?\r\n",
        "❯ 1. Yes\r\n",
        "  2. Yes, and don't ask again for rm commands\r\n",
        "  3. No, and tell Claude what to do differently (esc)\r\n"
      ].join("")
    );

    const summary = getTerminalPreviewSummary("tui-approval", 5);
    expect(summary.attention).toBe("Do you want to proceed?");
    expect(summary.lines).toContain("❯ 1. Yes");
  });

  it("splits cursor-positioned Codex frames and ignores the composer and key hints", () => {
    seedTerminalPreviewLines("tui-codex", ["• Ran npm test"]);
    appendTerminalPreviewChunk(
      "tui-codex",
      "\x1b[5;1H• Working (12s • esc to interrupt)\x1b[6;1H\x1b[K\x1b[7;1H› Ask Codex to do anything" +
        "\x1b[9;1H  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit\x1b[10;1H"
    );

    const summary = getTerminalPreviewSummary("tui-codex", 5);
    expect(summary.lines).toEqual(["• Ran npm test"]);
    expect(summary.activity).toEqual({ label: "Working", elapsed: "12s" });
  });

  it("strips Gemini box borders, placeholder and status footer", () => {
    const summary = summarizeTerminalPreviewLines([
      "╭──────────────────────────────╮",
      "│ ✓  ReadFile src/App.tsx      │",
      "╰──────────────────────────────╯",
      "⠼ Reticulating splines (esc to cancel, 5s)",
      "╭──────────────────────────────╮",
      "│ >   Type your message or @path/to/file │",
      "╰──────────────────────────────╯",
      "~/opt/spaceapp (main*)       no sandbox (see /docs)       gemini-2.5-pro (99% context left)"
    ]);
    expect(summary.lines).toEqual(["✓  ReadFile src/App.tsx"]);
    expect(summary.activity).toEqual({ label: "Reticulating splines", elapsed: "5s" });
    expect(summary.activityAt).toBe(0);
  });

  it("classifies single rows", () => {
    expect(classifyTerminalPreviewLine("❯ ").kind).toBe("chrome");
    expect(classifyTerminalPreviewLine("──────────").kind).toBe("chrome");
    expect(classifyTerminalPreviewLine("13s").kind).toBe("chrome");
    expect(classifyTerminalPreviewLine("✶ Spelunking… (esc to interrupt)").kind).toBe("activity");
    expect(classifyTerminalPreviewLine("Starting task...").kind).toBe("content");
    expect(classifyTerminalPreviewLine("$ npm run build").kind).toBe("content");
    expect(classifyTerminalPreviewLine("128k context · mode: autonomous").kind).toBe("chrome");
    expect(classifyTerminalPreviewLine("✦ 99.2% tokens remaining · Connected").kind).toBe("chrome");
    expect(classifyTerminalPreviewLine("― Worked for 1m 08s ――――――――").text).toBe("― Worked for 1m 08s");
  });
});

// Byte patterns captured from the real CLIs in a PTY (paths sanitised).
describe("terminal-preview-service real CLI byte streams", () => {
  it("keeps Claude Code rows that end in \\r\\r\\n and turns column jumps into spaces", () => {
    appendTerminalPreviewChunk(
      "real-claude",
      "\r\r\n\x1b[38;2;255;193;7m" + "─".repeat(60) + "\x1b[39m\r\r\n" +
        "\x1b[2G\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\r\r\n\r\r\n" +
        "\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gtrust?\r\r\n" +
        "\x1b[2G\x1b[36m❯\x1b[4G1.\x1b[7GYes,\x1b[12GI\x1b[14Gtrust\x1b[20Gthis\x1b[25Gfolder\x1b[39m\r\r\n" +
        "\x1b[4G2.\x1b[7GNo,\x1b[11Gexit\r\r\n\r\r\n" +
        "\x1b[2G\x1b[2mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[22m\r\r\n"
    );
    appendTerminalPreviewChunk("real-claude", "\x1b[>0q\x1b[c");

    const summary = getTerminalPreviewSummary("real-claude", 5);
    expect(summary.lines.map((line) => line.trim())).toEqual([
      "Accessing workspace:",
      "Quick safety check: Is this a project you trust?",
      "❯ 1. Yes, I trust this folder",
      "2. No, exit"
    ]);
    expect(summary.attention).toBe("Quick safety check: Is this a project you trust?");
    expect(summary.activity).toBeNull();
  });

  it("joins OpenCode runs placed on one row and reads its busy bar as activity", () => {
    appendTerminalPreviewChunk(
      "real-opencode",
      "\x1b[20;27H\x1b[38;2;238;238;238mReply with exactly: preview check ok\x1b[0m" +
        "\x1b[22;27H\x1b[38;2;92;156;245m▣  \x1b[22;30HBuild\x1b[22;36H·\x1b[22;38HBig Pickle\x1b[0m" +
        "\x1b[24;27Hpreview check ok" +
        "\x1b[26;25H■⬝⬝⬝⬝⬝⬝⬝\x1b[26;35Hesc \x1b[26;39Hinterrupt\x1b[26;72Htab \x1b[26;76Hagents\x1b[26;84Hctrl+p \x1b[26;91Hcommands" +
        "\x1b[27;3H/work/demo\x1b[27;60H29.0K (14%)\x1b]12;#eeeeee\x07"
    );

    const summary = getTerminalPreviewSummary("real-opencode", 5);
    expect(summary.lines).toEqual(["Reply with exactly: preview check ok", "preview check ok"]);
    expect(summary.activity).toEqual({ label: null, elapsed: null });
    expect(summary.activityAt).toBeGreaterThan(0);
  });

  it("strips Codex cursor-style and keyboard-protocol sequences and its composer", () => {
    appendTerminalPreviewChunk(
      "real-codex",
      "\x1b[0 q\x1b[<1u\x1b[>4;0m\x1b[3;3H\x1b[1m>_ OpenAI Codex\x1b[22m" +
        "\x1b[37;1H\x1b[1m›\x1b[37;3H\x1b[2mAsk Codex to do anything" +
        "\x1b[39;3HGPT-5 high · ~/work/demo" +
        "\x1b[40;3H\x1b[1m?\x1b[40;5H\x1b[22mfor\x1b[40;9Hshortcuts\x1b[1;1H\x1b[0 q\x1b[?2026l"
    );

    const summary = getTerminalPreviewSummary("real-codex", 5);
    expect(summary.lines).toEqual([">_ OpenAI Codex"]);
  });

  it("reads a Gemini braille spinner with a multi-word label as activity", () => {
    expect(classifyTerminalPreviewLine("⠋ Waiting for authentication... (Press Esc or Ctrl+C to cancel)")).toEqual({
      kind: "activity",
      text: "⠋ Waiting for authentication... (Press Esc or Ctrl+C to cancel)",
      activity: { label: "Waiting for authentication...", elapsed: null }
    });
  });

  it("clears a pending choice once the spinner is redrawn after it", async () => {
    seedTerminalPreviewLines("real-resume", ["Do you want to proceed?", "❯ 1. Yes", "  2. No"]);
    expect(getTerminalPreviewSummary("real-resume").attention).toBe("Do you want to proceed?");
    await new Promise((resolve) => setTimeout(resolve, 5));
    appendTerminalPreviewChunk("real-resume", "\x1b[2K\x1b[1A\x1b[2K\x1b[G✻ Running… (2s · esc to interrupt)\r\n");
    expect(getTerminalPreviewSummary("real-resume").attention).toBeNull();
  });

  it("cleans CSI sequences with private and intermediate bytes", () => {
    expect(cleanTerminalAnsi("\x1b[>0q\x1b[<1u\x1b[0 q\x1b[?2026h\x1b7\x1b8\x1b(Bok")).toBe("ok");
  });
});
