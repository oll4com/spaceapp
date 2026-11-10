import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Pane, Room } from "@space/contracts";
import { paneLabel } from "./digest.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * R11-6 (a) (28/10 15:10 BKK promote: Cleo/Finn kept the OLD space_browser_cloudflare 35 minutes: a pane's MCP servers load their code
 * when its CLI starts): when stable's `scripts/space-*-mcp.mjs` change (a promote or a hotfix writes them), Space tells Nous once which open
 * CLI panes started before, so it restarts them at an empty prompt. Same shape as the Browser Host line of round 9 item 4.
 */
const MCP_SERVER = /^space-[\w-]+-mcp\.mjs$/;

/** When stable's checkout last wrote an MCP server script, and which ones changed then (within a minute of the newest); null when none. */
export async function mcpServersChangedAt(root = SPACE_INSTALL_ROOT): Promise<{ at: number; files: string[] } | null> {
  const dir = join(root, "scripts");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((name) => MCP_SERVER.test(name));
  const times = (await Promise.all(files.map(async (name) => ({ name, at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })))).filter((file) => file.at > 0);
  if (!times.length) return null;
  const at = Math.max(...times.map((file) => file.at));
  return { at, files: times.filter((file) => at - file.at < 60_000).map((file) => file.name).sort() };
}

export interface McpStalePane { owner: string; room: Room; pane: Pane; startedAt: string }

export function createMcpStaleWatch(deps: { changedAt(): Promise<{ at: number; files: string[] } | null>; panes(): Promise<McpStalePane[]>; now?: () => number }) {
  let told = 0;
  let checkedAt = 0;
  return {
    /** Per owner, the line to send now (once per change of the scripts), checked at most every 10 minutes. */
    async check(): Promise<Map<string, string>> {
      const now = deps.now?.() ?? Date.now();
      const lines = new Map<string, string>();
      if (now - checkedAt < 10 * 60_000) return lines;
      checkedAt = now;
      const changed = await deps.changedAt().catch(() => null);
      if (!changed || changed.at <= told) return lines;
      // The first look after an API start only remembers the scripts' time: panes started before it are not the promote's.
      if (!told) { told = changed.at; return lines; }
      told = changed.at;
      const stale = (await deps.panes().catch(() => [] as McpStalePane[])).filter((entry) => Date.parse(entry.startedAt) < changed.at);
      const hhmm = new Date(changed.at).toISOString().slice(11, 16);
      for (const owner of new Set(stale.map((entry) => entry.owner))) {
        const mine = stale.filter((entry) => entry.owner === owner);
        lines.set(owner, `Space's MCP tools changed on stable at ${hhmm} UTC (${changed.files.join(", ")}): ${mine.length} open CLI `
          + `pane${mine.length === 1 ? "" : "s"} started before and still run${mine.length === 1 ? "s" : ""} the old code: ${mine.slice(0, 12).map((entry) => `${paneLabel(entry.pane)} in ${entry.room.name} (${entry.pane.id})`).join(", ")}`
          + `${mine.length > 12 ? ", …" : ""}. Restart each at an empty prompt (space_restart_pane; a copilot pane: space_copilot_control stop_agent then start_agent) so its tools load the new code.`);
      }
      return lines;
    }
  };
}
