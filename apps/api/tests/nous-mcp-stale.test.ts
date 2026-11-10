import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createMcpStaleWatch, mcpServersChangedAt } from "../src/nous/mcp-stale.js";

const room = { id: "room:cleo0001", name: "Cleo" } as Room;
const pane = (id: string, name: string) => ({ id, paneName: name, title: name, roomId: room.id, mode: "JOB_APPLY", isClosed: false }) as unknown as Pane;

describe("CLI panes whose MCP servers are older than stable's (R11-6 (a))", () => {
  it("reads when stable's checkout last wrote an MCP server script, and which ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-stale-"));
    try {
      await mkdir(join(root, "scripts"));
      for (const name of ["space-browser-mcp.mjs", "space-job-apply-mcp.mjs", "space-progress.mjs"]) await writeFile(join(root, "scripts", name), "//");
      await utimes(join(root, "scripts", "space-browser-mcp.mjs"), new Date("2026-10-28T08:10:00Z"), new Date("2026-10-28T08:10:00Z"));
      await utimes(join(root, "scripts", "space-job-apply-mcp.mjs"), new Date("2026-10-28T08:10:30Z"), new Date("2026-10-28T08:10:30Z"));
      await utimes(join(root, "scripts", "space-progress.mjs"), new Date("2026-10-28T09:00:00Z"), new Date("2026-10-28T09:00:00Z"));
      expect(await mcpServersChangedAt(root)).toEqual({ at: Date.parse("2026-10-28T08:10:30Z"), files: ["space-browser-mcp.mjs", "space-job-apply-mcp.mjs"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tells Nous once per change which open CLI panes started before it, never on the first look after a start", async () => {
    // 28/10 15:10 BKK promote: Cleo/Finn kept the old space_browser_cloudflare for 35 minutes.
    let changed = { at: Date.parse("2026-10-28T07:00:00Z"), files: ["space-browser-mcp.mjs"] };
    let now = Date.parse("2026-10-28T08:00:00Z");
    const panes = [{ owner: "user:operator", room, pane: pane("pane:finn0001", "Finn"), startedAt: "2026-10-28T05:05:00Z" },
      { owner: "user:operator", room, pane: pane("pane:kate0001", "Kate"), startedAt: "2026-10-28T08:20:00Z" }];
    const watch = createMcpStaleWatch({ changedAt: async () => changed, panes: async () => panes, now: () => now });
    expect([...(await watch.check())]).toEqual([]);
    changed = { at: Date.parse("2026-10-28T08:10:30Z"), files: ["space-browser-mcp.mjs", "space-job-apply-mcp.mjs"] };
    now += 10 * 60_000;
    const lines = await watch.check();
    expect(lines.get("user:operator")).toBe("Space's MCP tools changed on stable at 08:10 UTC (space-browser-mcp.mjs, space-job-apply-mcp.mjs): 1 open CLI pane started before and still runs "
      + "the old code: Finn in Cleo (pane:finn0001). Restart each at an empty prompt (space_restart_pane; a copilot pane: space_copilot_control stop_agent then start_agent) so its tools load the new code.");
    now += 10 * 60_000;
    expect([...(await watch.check())]).toEqual([]);
  });
});
