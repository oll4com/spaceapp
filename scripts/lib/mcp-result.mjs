import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** Technical: one MCP text answer stays under what the CLIs take as a tool result (Claude Code: 25,000 tokens). */
export const MCP_TEXT_MAX_CHARS = 40_000;

/**
 * A tool answer as text, whole (until 31/10 every Space MCP cut it at 20,000 characters, the rest lost to the agent): past one page the
 * whole answer is written to a private file the agent reads with its own file tools, and the text names it.
 */
export function mcpText(payload, dir = join(tmpdir(), "space-mcp-results")) {
  const text = JSON.stringify(payload, null, 2);
  if (text.length <= MCP_TEXT_MAX_CHARS) return text;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(file, text, { mode: 0o600 });
  const tail = (shown) => `\n…(${text.length - shown} more characters: the whole answer is in ${file}; read it with your file tools)`;
  const shown = MCP_TEXT_MAX_CHARS - tail(0).length - 10;
  return `${text.slice(0, shown)}${tail(shown)}`;
}
