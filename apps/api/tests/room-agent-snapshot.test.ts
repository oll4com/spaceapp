import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@space/contracts";
import { roomAgentSessionSchema } from "@space/contracts";
import {
  buildRoomAgentSnapshot, createRoomAgentSnapshotProvider, formatRoomActivityHeadline, formatRoomPaneLines,
  roomAgentPaneStrip, roomSnapshotFallbackAnswer
} from "../src/room-agent-snapshot.js";
import type { DashboardActivityDetail } from "../src/agents-dashboard.js";

const at = "2026-10-13T05:00:00.000Z";

function pane(id: string, order: number, overrides: Partial<Pane> = {}): Pane {
  return {
    id, roomId: "room:alpha1", title: `Pane ${id}`, titleSource: "auto", paneName: null, mode: "TERMINAL", status: "IDLE",
    providerId: null, modelId: null, terminalRuntimeId: "cli:codex", reasoningEffort: "medium", cwd: null, order,
    columnSpan: 1, isMaximized: false, isMinimized: false, isClosed: false, split: "NONE", categoryColor: null, vncTarget: null,
    createdAt: at, updatedAt: at, ...overrides
  } as Pane;
}

const details: Record<string, DashboardActivityDetail> = {
  "pane:bob": { status: "waiting", reason: "Permission prompt", since: at, source: "native", modelId: "claude-opus-5-5" },
  "pane:dana": { status: "working", since: at, source: "native" },
  "pane:emma": { status: "done", since: at, source: "screen" }
};

const panes = [
  pane("pane:andy", 0, { paneName: "Andy", mode: "BROWSER", terminalRuntimeId: null }),
  pane("pane:bob", 1, {
    paneName: "Bob", terminalRuntimeId: "cli:claude", cwd: "/opt/spaceapp/var/worktrees/space/wt-a", isMinimized: true,
    taskMetadata: {
      taskKey: "k", version: 1, description: "Old description", steps: ["Read code", "Fix redirect"], earlierWork: "", source: "ai",
      generationStatus: "ready", nativeSyncStatus: "synced", providerId: null, modelId: null, updatedAt: at,
      topics: [{ title: "Fix login redirect", summary: "Fixes the redirect loop after sign-in.", source: "ai", at }]
    }
  }),
  pane("pane:dana", 2, { paneName: "Dana", mode: "CHAT", terminalRuntimeId: null, providerId: "openai" }),
  pane("pane:emma", 3, { paneName: "Emma" }),
  pane("pane:finn", 4, { paneName: "Finn" }),
  pane("pane:closed", 5, { paneName: "Hugo", isClosed: true })
];

describe("room agent snapshot", () => {
  it("covers every open pane type with live activity, task text and model", () => {
    const snapshot = buildRoomAgentSnapshot("room:alpha1", panes, details);
    expect(snapshot.panes.map((item) => [item.paneName, item.activity])).toEqual([
      ["Andy", "NONE"], ["Bob", "WAITING"], ["Dana", "WORKING"], ["Emma", "DONE"], ["Finn", "UNKNOWN"]
    ]);
    expect(snapshot.counts).toEqual({ total: 5, working: 1, waiting: 1, done: 1, idle: 0 });
    expect(snapshot.panes[1]).toMatchObject({
      reason: "Permission prompt", modelId: "claude-opus-5-5", taskTitle: "Fix login redirect",
      taskSummary: "Fixes the redirect loop after sign-in.", steps: ["Read code", "Fix redirect"], isMinimized: true
    });
  });

  it("puts panes that need attention first and keeps compact lines short", () => {
    const snapshot = buildRoomAgentSnapshot("room:alpha1", panes, details);
    const headline = formatRoomActivityHeadline(snapshot);
    expect(headline).toContain("5 open panes");
    expect(headline).toContain("waiting 1 (Bob: Permission prompt)");
    expect(headline).toContain("working 1 (Dana)");
    const compact = formatRoomPaneLines(snapshot, "compact");
    expect(compact[0]).toMatch(/^- Bob \[paneId=pane:bob; TERMINAL cli:claude; model=claude-opus-5-5; minimized\]: WAITING \(Permission prompt\)/);
    expect(compact[0]).toContain('task "Fix login redirect" — Fixes the redirect loop');
    expect(compact.every((line) => line.length < 420)).toBe(true);
    const full = formatRoomPaneLines(snapshot, "full").join("\n");
    expect(full).toContain("steps: Read code | Fix redirect");
    expect(full).toContain("cwd: /opt/spaceapp/var/worktrees/space/wt-a");
  });

  it("returns a dock strip that the session contract accepts and that carries no task text", () => {
    const strip = roomAgentPaneStrip(buildRoomAgentSnapshot("room:alpha1", panes, details));
    expect(strip).toHaveLength(5);
    expect(strip[1]).not.toHaveProperty("taskSummary");
    expect(strip[1]).not.toHaveProperty("cwd");
    const session = roomAgentSessionSchema.parse({
      roomId: "room:alpha1", paneId: null, sessionId: null, threadId: null, status: "IDLE", statusReason: "Ready.", modelId: "m",
      messages: [], activeMission: null, queuedMissionCount: 0, currentPaneId: null, paneStrip: strip,
      capabilities: { canSend: true, canStop: false }
    });
    expect(session.paneStrip?.[1]?.activity).toBe("WAITING");
  });

  it("answers from the live state when no model replies", () => {
    const snapshot = buildRoomAgentSnapshot("room:alpha1", panes, details);
    expect(roomSnapshotFallbackAnswer(snapshot, false)).toBe([
      "I see 5 open panes: 1 working, 1 waiting, 1 done, 0 idle.",
      "- **Andy** (BROWSER): open",
      "- **Bob** (cli:claude): waiting (Permission prompt) — Fix login redirect",
      "- **Dana** (openai): working",
      "- **Emma** (cli:codex): done",
      "- **Finn** (cli:codex): unknown"
    ].join("\n"));
    expect(roomSnapshotFallbackAnswer(snapshot, true)).toContain("- **Bob** (cli:claude): περιμένει (Permission prompt) — Fix login redirect");
  });

  it("caches briefly per room and falls back to pane metadata when activity cannot be read", async () => {
    let now = 1_000;
    const readActivity = vi.fn(async () => { throw new Error("reader down"); });
    const listPanes = vi.fn(async () => panes);
    const provider = createRoomAgentSnapshotProvider({ listPanes, readActivity, now: () => now });
    const first = await provider.snapshot("room:alpha1");
    expect(first.panes.find((item) => item.paneName === "Bob")?.activity).toBe("UNKNOWN");
    await provider.snapshot("room:alpha1");
    expect(readActivity).toHaveBeenCalledTimes(1);
    now += 5_000;
    await provider.snapshot("room:alpha1");
    expect(readActivity).toHaveBeenCalledTimes(2);
  });
});
