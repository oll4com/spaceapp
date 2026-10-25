import { describe, expect, it, vi, beforeEach } from "vitest";

const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args)
}));

import {
  runSystemServicesCollector,
  createSystemServicesProvider,
  SPACE_SERVICE_UNIT_PREFIXES,
  SYSTEM_SERVICES_COMMAND
} from "../src/service-services.js";
import type { SystemServicesResponse } from "@space/contracts";

describe("system services listing", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("uses the systemctl command without arguments beyond allowlisted flags", () => {
    expect(SYSTEM_SERVICES_COMMAND).toEqual({
      command: "/usr/bin/systemctl",
      args: []
    });
  });

  it("allowlists the expected Space and memory unit prefixes", () => {
    expect(SPACE_SERVICE_UNIT_PREFIXES).toEqual([
      "space-",
      "codex-",
      "vm207-",
      "mc-browser-proxy",
      "promtail",
      "pulseaudio"
    ]);
  });

  it("parses running services, timers and enabled state into a bounded response", async () => {
    mockExecFile
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, {
          stdout: JSON.stringify([
            { unit: "space-api.service", description: "Space API", load: "loaded", active: "active", sub: "running" },
            { unit: "space-memory-maintenance.timer", description: "Run Space Memory Graph Maintenance Daily", load: "loaded", active: "active", sub: "waiting" },
            { unit: "space-cli-vpn-network.service", description: "Space CLI VPN network setup", load: "loaded", active: "active", sub: "exited" },
            { unit: "unrelated.service", description: "Unrelated", load: "loaded", active: "active", sub: "running" }
          ])
        });
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, {
          stdout: JSON.stringify([
            { unit: "space-memory-maintenance.timer", activates: "space-memory-maintenance.service", next: "2026-07-15T01:30:00.000Z", last: "2026-07-14T01:30:00.000Z" }
          ])
        });
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, {
          stdout: [
            "Id=space-api.service",
            "UnitFileState=enabled",
            "Id=space-memory-maintenance.timer",
            "UnitFileState=enabled",
            "Id=space-cli-vpn-network.service",
            "UnitFileState=static"
          ].join("\n")
        });
      });

    const result = await runSystemServicesCollector();

    expect(result.summary).toEqual({
      total: 3,
      active: 3,
      inactive: 0,
      failed: 0,
      services: 2,
      timers: 1,
      enabled: 2,
      disabled: 0
    });
    expect(result.units).toHaveLength(3);
    expect(result.units.map((unit) => unit.unit)).toEqual([
      "space-api.service",
      "space-cli-vpn-network.service",
      "space-memory-maintenance.timer"
    ]);
    const apiUnit = result.units.find((unit) => unit.unit === "space-api.service");
    expect(apiUnit).toMatchObject({
      type: "service",
      activeState: "active",
      subState: "running",
      unitFileState: "enabled"
    });
    const timerUnit = result.units.find((unit) => unit.unit === "space-memory-maintenance.timer");
    expect(timerUnit).toMatchObject({
      type: "timer",
      timerActivates: "space-memory-maintenance.service",
      timerNextElapse: "2026-07-15T01:30:00.000Z",
      timerLastTrigger: "2026-07-14T01:30:00.000Z"
    });
    expect(JSON.stringify(result)).not.toMatch(/unrelated\.service/);
    expect(JSON.stringify(result)).not.toMatch(/secret|token/);
  });

  it("marks failed units and caches the response for the provider TTL", async () => {
    const now = vi.fn(() => new Date("2026-07-14T12:00:00.000Z"));
    const response: SystemServicesResponse = {
      units: [{
        unit: "space-api.service",
        description: "Space API",
        type: "service",
        loadState: "loaded",
        activeState: "failed",
        subState: "failed",
        unitFileState: "enabled",
        timerActivates: null,
        timerNextElapse: null,
        timerLastTrigger: null
      }],
      summary: { total: 1, active: 0, inactive: 0, failed: 1, services: 1, timers: 0, enabled: 1, disabled: 0 },
      sampledAt: "2026-07-14T12:00:00.000Z"
    };
    const collect = vi.fn().mockResolvedValue(response);
    const provider = createSystemServicesProvider({ collect, now, cacheTtlMs: 10_000 });
    const first = await provider();
    const second = await provider();
    expect(first).toEqual(second);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(first.summary.failed).toBe(1);
  });
});
