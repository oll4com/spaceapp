import { describe, expect, it } from "vitest";
import { apiDomainMetrics } from "../src/api-metrics.js";
import { observeMemoryWorkers, readHostProcessStats, recordBrowserHostHealth, recordCliHostHealth } from "../src/host-metrics.js";

function procFiles(cmdline: string) {
  const files: Record<string, string> = {
    "/proc/3567/cmdline": cmdline,
    "/proc/3567/statm": "424530 75891 12283 9674 0 122990 0\n",
    // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
    "/proc/3567/stat": "3567 (node main.js) S 1 3567 3567 0 -1 4194560 100 0 0 0 1234 566 0 0 20 0 11 0\n"
  };
  return (path: string) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path]!;
  };
}

const rendered = () => apiDomainMetrics.renderLines({ includeDropped: false }).join("\n");

describe("host metrics observed from the API", () => {
  it("reads /proc memory and CPU only for a process whose command line is that host", () => {
    expect(readHostProcessStats("cli-main", 3567, procFiles("/usr/local/bin/node\0packages/cli-host/dist/main.js\0")))
      .toEqual({ residentBytes: 75891 * 4096, cpuSeconds: 18 });
    expect(readHostProcessStats("browser", 3567, procFiles("/usr/local/bin/node\0packages/cli-host/dist/main.js\0"))).toBeNull();
    expect(readHostProcessStats("cli-main", 3567, procFiles("/usr/bin/bash\0-c\0sleep 1\0"))).toBeNull();
    expect(readHostProcessStats("cli-main", 1, procFiles("x"))).toBeNull();
    expect(readHostProcessStats("cli-main", 999, procFiles("x"))).toBeNull();
  });

  it("records CLI host availability, start time, sessions by status and attachments", () => {
    const stats = () => ({ residentBytes: 1_048_576, cpuSeconds: 42.5 });
    recordCliHostHealth("cli-main", {
      hostPid: 3567, startedAt: "2026-10-12T05:00:00.000Z", buildCommit: "abc",
      sessions: [
        { status: "RUNNING", attachmentCount: 2 }, { status: "RUNNING", attachmentCount: 1 },
        { status: "EXITED", attachmentCount: 0 }
      ] as never
    }, stats, Date.parse("2026-10-12T06:00:00.000Z"));
    const text = rendered();
    expect(text).toContain('space_host_up{host="cli-main"} 1');
    expect(text).toContain(`space_host_start_time_seconds{host="cli-main"} ${Date.parse("2026-10-12T05:00:00.000Z") / 1000}`);
    expect(text).toContain('space_cli_host_sessions{host="cli-main",status="RUNNING"} 2');
    expect(text).toContain('space_cli_host_sessions{host="cli-main",status="EXITED"} 1');
    expect(text).toContain('space_cli_host_sessions{host="cli-main",status="ERROR"} 0');
    expect(text).toContain('space_cli_host_attachments{host="cli-main"} 3');
    expect(text).toContain('space_host_resident_memory_bytes{host="cli-main"} 1048576');
    expect(text).toContain('space_host_cpu_seconds{host="cli-main"} 42.5');

    // A failed check marks the host down and keeps the time of the observation.
    recordCliHostHealth("cli-main", null, stats, Date.parse("2026-10-12T06:00:30.000Z"));
    expect(rendered()).toContain('space_host_up{host="cli-main"} 0');
    expect(rendered()).toContain(`space_host_observed_timestamp_seconds{host="cli-main"} ${Date.parse("2026-10-12T06:00:30.000Z") / 1000}`);
  });

  it("records Browser Host capacity", () => {
    recordBrowserHostHealth({
      hostPid: 4000, startedAt: "2026-10-12T05:00:00.000Z", buildCommit: null, status: {} as never,
      capacity: { activeSessions: 3, maxSessions: 8, activeLiveWorkloads: 1, maxLiveWorkloads: 2 },
      captureMetrics: {} as never
    }, () => null);
    const text = rendered();
    expect(text).toContain('space_host_up{host="browser"} 1');
    expect(text).toContain('space_browser_host_sessions{kind="active"} 3');
    expect(text).toContain('space_browser_host_sessions{kind="max"} 8');
    expect(text).toContain('space_browser_host_live_workloads{kind="active"} 1');
  });

  it("finds the memory workers in /proc by command line and marks a missing one down", () => {
    const files: Record<string, string> = {
      "/proc/stat": "cpu  1 2 3\nbtime 1791700000\nprocesses 9\n",
      "/proc/10/cmdline": "/usr/bin/bash\0-c\0sleep 1\0",
      "/proc/2222/cmdline": "/usr/local/bin/node\0apps/worker/dist/memory-maintenance-worker.js\0",
      "/proc/2222/statm": "200000 50000 1000 10 0 1000 0\n",
      // ... utime stime cutime cstime priority nice threads itrealvalue starttime
      "/proc/2222/stat": "2222 (node) S 1 2222 2222 0 -1 4194560 100 0 0 0 300 200 0 0 20 0 11 0 500000\n"
    };
    const read = (path: string) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path]!;
    };
    observeMemoryWorkers({ listPids: () => [10, 2222, 2223], read, now: Date.parse("2026-10-12T15:00:00.000Z"), force: true });
    const text = rendered();
    expect(text).toContain('space_host_up{host="memory-maintenance"} 1');
    expect(text).toContain(`space_host_resident_memory_bytes{host="memory-maintenance"} ${50000 * 4096}`);
    expect(text).toContain('space_host_cpu_seconds{host="memory-maintenance"} 5');
    expect(text).toContain(`space_host_start_time_seconds{host="memory-maintenance"} ${1791700000 + 5000}`);
    expect(text).toContain('space_host_up{host="memory-mutation"} 0');
    expect(text).toContain(`space_host_observed_timestamp_seconds{host="memory-mutation"} ${Date.parse("2026-10-12T15:00:00.000Z") / 1000}`);

    // Within 15 s the scan is skipped, so a scrape storm does not walk /proc each time.
    observeMemoryWorkers({ listPids: () => { throw new Error("scanned again"); }, read, now: Date.parse("2026-10-12T15:00:10.000Z") });
  });
});
