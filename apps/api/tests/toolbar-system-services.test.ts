import { describe, expect, it, vi } from "vitest";
import {
  collectCliSessionStats,
  createHostMemoryDetailsProvider,
  MEMORY_RECLAIM_COMMAND
} from "../src/toolbar-system-services.js";

const sampledAt = "2026-07-14T12:00:00.000Z";

describe("toolbar system telemetry services", () => {
  it("runs the no-argument reclaim helper from the writable root-owned Space bin", () => {
    expect(MEMORY_RECLAIM_COMMAND).toEqual({
      command: "/usr/bin/sudo",
      args: ["-n", "/opt/spaceapp/bin/space-memory-reclaim"]
    });
  });

  it("classifies cleanup eligibility from host-owned attachment state and the fixed grace", async () => {
    const result = await collectCliSessionStats({
      now: () => new Date(sampledAt),
      readRssBytes: async (pid) => pid * 1024,
      hosts: [
        {
          hostId: "main",
          health: {
            sessions: [
              {
                cliSessionId: "cli_session:eligible",
                paneId: "pane:eligible",
                roomId: "room:one",
                runtimeId: "cli:codex",
                pid: 100,
                status: "RUNNING",
                attachmentCount: 0,
                startedAt: "2026-07-14T11:00:00.000Z",
                detachedAt: "2026-07-14T11:54:59.000Z"
              },
              {
                cliSessionId: "cli_session:attached",
                paneId: "pane:attached",
                roomId: "room:one",
                runtimeId: "cli:codex",
                pid: 101,
                status: "RUNNING",
                attachmentCount: 1,
                startedAt: "2026-07-14T11:00:00.000Z",
                detachedAt: null
              }
            ]
          }
        },
        {
          hostId: "root",
          health: {
            sessions: [
              {
                cliSessionId: "cli_session:recent",
                paneId: "pane:recent",
                roomId: "room:root",
                runtimeId: "cli:root",
                pid: 102,
                status: "RUNNING",
                attachmentCount: 0,
                startedAt: "2026-07-14T11:30:00.000Z",
                detachedAt: "2026-07-14T11:55:01.000Z"
              }
            ]
          }
        }
      ]
    });

    expect(result.summary).toEqual({ running: 3, attached: 1, detached: 2, cleanupEligible: 1 });
    expect(result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: "main", pid: 100, rssBytes: 102_400, cleanupEligible: true }),
        expect.objectContaining({ hostId: "root", pid: 102, cleanupEligible: false })
      ])
    );
  });

  it("reports pressure, page cache, and only safe top-process fields from a cached on-demand sample", async () => {
    const readMeminfo = vi.fn(async () => [
      "MemTotal:        1048576 kB",
      "MemAvailable:     131072 kB",
      "Cached:           393216 kB",
      "Shmem:             65536 kB",
      "SwapTotal:        262144 kB",
      "SwapFree:         196608 kB"
    ].join("\n"));
    const readProcessTable = vi.fn(async () => [
      "101 262144 2.5 S codex",
      "202 131072 150.0 R postgres"
    ].join("\n"));
    const provider = createHostMemoryDetailsProvider({
      readMeminfo,
      readProcessTable,
      cliSessions: async () => ({
        summary: { running: 1, attached: 0, detached: 1, cleanupEligible: 1 },
        sessions: [{ pid: 101, cleanupEligible: true, sessionId: "cli_session:one", paneId: "pane:one" }]
      }),
      resolveSessionTitle: async () => "Fix the dashboard",
      now: () => new Date(sampledAt)
    });

    const [first, second] = await Promise.all([provider(), provider()]);
    expect(second).toEqual(first);
    expect(readMeminfo).toHaveBeenCalledTimes(1);
    expect(readProcessTable).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      memory: {
        totalBytes: 1_073_741_824,
        availableBytes: 134_217_728,
        pageCacheBytes: 335_544_320,
        reclaimableBytes: 335_544_320
      },
      pressure: { isUnderPressure: true, availablePercent: 12.5, canDropPageCache: true },
      topProcesses: [
        { pid: 101, name: "codex", taskTitle: "Fix the dashboard", rssBytes: 268_435_456, cpuPercent: 2.5, state: "S", isSpaceManaged: true, cleanupEligible: true },
        { pid: 202, name: "postgres", taskTitle: null, rssBytes: 134_217_728, cpuPercent: 100, state: "R", isSpaceManaged: false, cleanupEligible: false }
      ]
    });
    expect(JSON.stringify(first)).not.toMatch(/commandLine|env/);
  });

  it("groups serve and attach processes of the same CLI session into one titled row", async () => {
    const readMeminfo = vi.fn(async () => [
      "MemTotal:        1048576 kB",
      "MemAvailable:     131072 kB",
      "Cached:           393216 kB",
      "Shmem:             65536 kB",
      "SwapTotal:        262144 kB",
      "SwapFree:         196608 kB"
    ].join("\n"));
    const readProcessTable = vi.fn(async () => [
      "910809 262144 2.5 S /var/lib/spaceapp-user/.npm-global/bin/opencode serve --hostname 0.0.0.0 --port 35161",
      "911171 131072 3.5 R /var/lib/spaceapp-user/.npm-global/bin/opencode attach http://127.0.0.1:35161 --dir /etc --session ses_02a553e22ffeeTSIB56s3tgT65",
      "920001 65536 1.0 S nginx"
    ].join("\n"));
    const provider = createHostMemoryDetailsProvider({
      readMeminfo,
      readProcessTable,
      cliSessions: async () => ({
        summary: { running: 1, attached: 1, detached: 0, cleanupEligible: 0 },
        sessions: [{ pid: 910809, cleanupEligible: false, sessionId: "ses_02a553e22ffeeTSIB56s3tgT65", paneId: "pane:opencode" }]
      }),
      resolveSessionTitle: async () => "Refactor the toolbar",
      now: () => new Date(sampledAt)
    });

    const result = await provider();
    expect(result.topProcesses).toEqual([
      { pid: 910809, name: "opencode", taskTitle: "Refactor the toolbar", rssBytes: 402_653_184, cpuPercent: 6, state: "S", isSpaceManaged: true, cleanupEligible: false },
      { pid: 920001, name: "nginx", taskTitle: null, rssBytes: 67_108_864, cpuPercent: 1, state: "S", isSpaceManaged: false, cleanupEligible: false }
    ]);
  });
});
