import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexInputReady } from "../src/cli-terminal.js";

// READINESS-001: Codex screens captured from the real binary (codex-cli 0.165.0, the version Space runs on 2026-10-29)
// in tmux with a throwaway CODEX_HOME, a dummy API key and two MCP servers that never answer. Nothing was sent to a
// model. Captured with a 0.2 s poll: the sandbox warning comes first, the header, composer and footer about a second
// later. Evidence and the replay scripts: ~/agent-workspace/reports/20261029-readiness-001/.
const warning = [
  "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temp",
  'dir "/home/user/.codex/tmp" (codex_home: AbsolutePathBuf("/home/user/.codex/tmp/home"))'
].join("\r\n");
const readyScreen = [
  "  >_ OpenAI Codex (v0.165.0)",
  "     ~/proj",
  "",
  "› Ask Codex to do anything",
  "  GPT-5.5 default · ~/proj",
  "  ← for agents · ? for shortcuts"
].join("\r\n");

// codex-cli 0.166.0 (the version installed on 2026-10-30), same method with two real MCP servers that answer initialize after 6 s and 9 s:
// it printed no "Starting MCP servers" text in 20 s; the header shows "loading" in place of the model until the footer appears
// (about 3 s), then the composer footer shows "GPT-5.5 default · dir".
const loadingScreen = [
  "  >_ OpenAI Codex (v0.166.0)",
  "     loading",
  "",
  "› Ask Codex to do anything",
  "  ? for shortcuts"
].join("\r\n");
const readyScreen166 = readyScreen.replace("v0.165.0", "v0.166.0");

describe("Codex 0.166.0 startup with slow MCP servers", () => {
  it("is not ready while the header shows loading, and ready once the footer names the model", () => {
    expect(codexInputReady(loadingScreen)).toBe(false);
    expect(codexInputReady(`${loadingScreen}\r\n${readyScreen166}`)).toBe(true);
  });
});

describe("Codex 0.165.0 screens as the host sees them", () => {
  it("is not ready on the startup warning alone and ready once the header, composer and footer are drawn", () => {
    expect(codexInputReady(warning)).toBe(false);
    expect(codexInputReady(`${warning}\r\n${readyScreen}`)).toBe(true);
  });

  it("stays ready after the screen is redrawn (a restarted conversation repeats the header)", () => {
    expect(codexInputReady(`${warning}\r\n${readyScreen}\r\n${readyScreen}\r\n${readyScreen}`)).toBe(true);
  });

  it("an earlier partial MCP startup line does not block a newer header with its composer", () => {
    const stale = "Starting MCP servers (1/2)";
    expect(codexInputReady(`${stale}\r\n${readyScreen}`)).toBe(true);
    expect(codexInputReady(`${warning}\r\n${stale}\r\n${readyScreen}\r\n${stale}\r\n${readyScreen}`)).toBe(true);
  });

  it("a partial MCP startup line drawn after the header still blocks input", () => {
    expect(codexInputReady(`${readyScreen}\r\nStarting MCP servers (1/2)`)).toBe(false);
  });
});

// codex-cli 0.144.1 (still installed under /opt/node-v22.23.0 on 2026-11-02): the raw PTY bytes of one start, as Space's transcript and
// startupOutput keep them, with two MCP servers answering after 0.5 s and 1.5 s (throwaway CODEX_HOME, dummy key, dead local base URL, no
// model call). It writes "Starting MCP servers (0/2)" whole once, before it redraws the header with the loaded model; later progress is
// drawn cell by cell, so the partial text stays in the stream. Evidence: ~/agent-workspace/reports/20261102-readiness-001/.
describe("Codex 0.144.1 raw startup stream", () => {
  const raw = readFileSync(new URL("./fixtures/codex-0.144.1-mcp-startup.raw", import.meta.url), "utf8");
  const partial = raw.indexOf("Starting MCP servers (0/2)");
  const newerHeader = raw.indexOf("OpenAI Codex", partial);

  it("blocks while the partial line follows the latest header, and is ready once a newer header and composer follow it", () => {
    expect(partial).toBeGreaterThan(raw.indexOf("OpenAI Codex"));
    expect(newerHeader).toBeGreaterThan(partial);
    expect(codexInputReady(raw.slice(0, newerHeader))).toBe(false);
    expect(codexInputReady(raw)).toBe(true);
  });
});
