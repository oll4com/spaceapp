import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { claudeAgentPanelStart, claudeBackgroundAgentRunning, claudeWaitingForBackgroundWork } from "../src/features/terminal-pane/claude-agent-panel.js";

// Colours as Claude Code 2.1.296 draws them in its dark theme: dimColor is a gray RGB foreground.
const GRAY = "\u001b[38;2;153;153;153m";
const GREEN = "\u001b[38;2;78;186;101m";
const RED = "\u001b[38;2;255;107;128m";
const LIGHT_GREEN = "\u001b[38;2;44;122;57m";
const YELLOW = "\u001b[38;2;255;193;7m";
const RESET = "\u001b[39m";
const FOOTER = "  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …";

const agentRow = (bullet: string, rest: string, prefix = "  ") => `${prefix}${bullet}◯ ${RESET}${GRAY}${rest}${RESET}`;
const claudeScreen = (rows: string[], footer = FOOTER) =>
  ["⏺ Started the review agent.", "", "─".repeat(60), "❯ ", "─".repeat(60), footer, "", "  \u001b[1m● main\u001b[22m", ...rows].join("\r\n");

async function terminalShowing(content: string, rows = 16) {
  const terminal = new Terminal({ cols: 100, rows });
  await new Promise<void>((resolve) => terminal.write(content, resolve));
  return terminal;
}

describe("Claude Code background agent panel", () => {
  it("counts an agent with an uncoloured bullet as running, a green or red one as finished", async () => {
    const running = agentRow(GRAY, `general-purpose  1h 58m 48s · ↓ 893.4k tokens${YELLOW} · 1 queued`);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([running])))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(GREEN, "Plan  Wrote the plan  7m 13s · ↓ 231.2k tokens")])))).toBe(false);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(RED, "Explore  Counting MCP servers  4m 59s · ↓ 125.1k tokens")])))).toBe(false);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(LIGHT_GREEN, "Plan  Wrote the plan  7m 13s")])))).toBe(false);
    expect(
      claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(GREEN, "Plan  Wrote the plan  7m 13s"), agentRow(GRAY, "Explore  Inspecting space-queue…  25s")])))
    ).toBe(true);
  });

  it("counts selected, viewed, nested and ANSI-palette rows by their bullet colour", async () => {
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow("", "Explore  Inspecting…  25s · ↓ 1.2k tokens", "❯ ")])))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([`  \u001b[1m● Plan  Checking roomAgentSess…  7m 42s${RESET}`])))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(GREEN, "Plan  done  2m"), agentRow(GRAY, "Explore  Reading files  12s", "    └─ ")])))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow("\u001b[90m", "Explore  Reading files  12s")])))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow("\u001b[32m", "Explore  Reading files  12s")])))).toBe(false);
  });

  it("does not count idle teammates or agents waiting for a message", async () => {
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(GRAY, "@researcher  idle")])))).toBe(false);
    expect(claudeBackgroundAgentRunning(await terminalShowing(claudeScreen([agentRow(GRAY, `reviewer  Review the diff  waiting${YELLOW} · 2 queued`)])))).toBe(false);
  });

  it("ignores a main row that is not below Claude's footer and screens without a panel", async () => {
    const transcript = ["⏺ Branches:", "  ● main", agentRow(GRAY, "feature  12s"), "", "─".repeat(60), "❯ ", "─".repeat(60), FOOTER].join("\r\n");
    expect(claudeBackgroundAgentRunning(await terminalShowing(transcript))).toBe(false);
    expect(claudeBackgroundAgentRunning(await terminalShowing(["─".repeat(60), "❯ ", "─".repeat(60), FOOTER].join("\r\n")))).toBe(false);
  });

  it("counts a turn that ended waiting for background agents, also without an agent panel", async () => {
    // Dana's pane: the agent works, Claude shows no panel, only its turn status above the prompt.
    const dana = [
      "● Το inventory είναι έτοιμο. Περιμένω την έρευνα και μετά γράφω το νέο πλάνο.",
      "",
      `${GRAY}✻${RESET} ${GRAY}Waiting for ${RESET}\u001b[1m1\u001b[22m${GRAY} background agent to finish${RESET}`,
      "",
      "──────────────────────────── room-agent-monitoring-context ─",
      "❯ ",
      "─".repeat(60),
      "  ⏸ plan mode on (shift+tab to cycle) · ← for agents · ↓ to manage"
    ].join("\r\n");
    expect(claudeBackgroundAgentRunning(await terminalShowing(dana))).toBe(true);
    const workflows = dana.replace("1\u001b[22m", "2\u001b[22m").replace("agent to finish", "agents and 1 dynamic workflow to finish");
    expect(claudeBackgroundAgentRunning(await terminalShowing(workflows))).toBe(true);
    expect(claudeBackgroundAgentRunning(await terminalShowing(dana.replace(/Waiting for .*to finish/, "Baked for 1h 34m 12s · done 7:56 AM")))).toBe(false);
  });

  it("does not count a waiting status further up the conversation or a selection menu", async () => {
    const prompt = ["", "─".repeat(60), "❯ ", "─".repeat(60), FOOTER];
    const history = ["✻ Waiting for 1 background agent to finish", "", "● The agent reported back; the plan is ready.", ...prompt];
    expect(claudeWaitingForBackgroundWork(history)).toBe(false);
    expect(claudeBackgroundAgentRunning(await terminalShowing(history.join("\r\n")))).toBe(false);
    expect(claudeWaitingForBackgroundWork(["✻ Waiting for 1 background agent to finish", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"])).toBe(false);
    expect(claudeWaitingForBackgroundWork(["⏺ Waiting for 1 background agent to finish is what I expect.", ...prompt])).toBe(false);
  });

  it("finds the panel below a truncated footer only", () => {
    const lines = ["❯ ", "────", "  ⏸ plan mode on (shift+tab to cycle) · ← for a…", "", "  ● main", "  ◯ Plan  Inspecting…  7m 13s"];
    expect(claudeAgentPanelStart(lines)).toBe(4);
    expect(claudeAgentPanelStart(["  ⏵⏵ bypass permissions on · 3 shells · …", "", "  ◯ main  ↑ 2 more", "  ● Explore  12s"])).toBe(2);
    expect(claudeAgentPanelStart(["⏺ git branch", "  ● main", "  ◯ feature"])).toBe(-1);
  });
});
