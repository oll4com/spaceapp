import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { smartCrush, type SmartCrusherConfig } from "../src/compression/smart-crusher/index.js";

interface Fixture {
  config: Record<string, number | boolean>;
  input: { content: string; query: string; bias: number };
  output: { compressed: string; original: string; was_modified: boolean; strategy: string };
}

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "smart_crusher");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => ({
  name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture)
}));

/** Headroom's snake_case `SmartCrusherConfig` fields → this port's camelCase config. */
const toConfig = (raw: Fixture["config"]): Partial<SmartCrusherConfig> =>
  Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value]));

describe("smart crusher (Headroom 0.37 parity fixtures)", () => {
  it("has the upstream fixtures", () => expect(fixtures.length).toBe(17));
  for (const fixture of fixtures) {
    it(`matches ${fixture.name}`, () => {
      const result = smartCrush(fixture.input, toConfig(fixture.config));
      expect(result.compressed).toBe(fixture.output.compressed);
      expect(result.original).toBe(fixture.output.original);
      expect(result.wasModified).toBe(fixture.output.was_modified);
      expect(result.strategy).toBe(fixture.output.strategy);
    });
  }
});

describe("smart crusher behaviour", () => {
  it("stores the full original behind the dropped-rows marker", () => {
    const stored = new Map<string, string>();
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 5 === 0 ? "error" : "ok", msg: `line ${i}` }));
    const result = smartCrush({ content: JSON.stringify(rows) }, {}, { ccrStore: { put: (hash, payload) => stored.set(hash, payload) } });
    const marker = /<<ccr:([0-9a-f]{12}) 15_rows_offloaded>>/.exec(result.compressed);
    expect(marker).not.toBeNull();
    expect(stored.get(marker![1]!)).toBe(JSON.stringify(rows));
  });

  it("keeps number formatting and key order from the source", () => {
    const result = smartCrush({ content: '{"2": 1.50, "1": 1e5, "a": -0}' });
    expect(result.compressed).toBe('{"2":1.50,"1":1e5,"a":-0}');
  });

  it("offloads long opaque strings and leaves short ones", () => {
    const blob = "A".repeat(200) + "bcdefghijklmnopqrstuvwxyz0123456789+/".repeat(3);
    const result = smartCrush({ content: JSON.stringify({ blob, note: "short" }) });
    expect(result.compressed).toMatch(/^\{"blob":"<<ccr:[0-9a-f]{12},base64,311B>>","note":"short"\}$/);
    expect(result.strategy).toBe("string_ccr:base64");
  });

  it("crushes a 5,000-row (~500 KB) array well within budget", () => {
    // Regression guard: ~100-150 ms of CPU here, against several seconds for the unoptimized port. It measures this
    // thread's CPU time, not wall-clock time, so a busy host running the suite in parallel does not fail it.
    const cpuMs = () => {
      const usage = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.() ?? process.cpuUsage();
      return (usage.user + usage.system) / 1000;
    };
    const statuses = ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "error", "timeout"];
    const paths = ["/api/users", "/api/orders", "/api/items", "/health", "/api/search"];
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: i, status: statuses[i % 10], latency: 20 + ((i * 37) % 180), path: paths[i % 5], note: `request ${i} handled by worker ${i % 8}`
    }));
    const content = JSON.stringify(rows);
    let fastest = Number.POSITIVE_INFINITY;
    let result: ReturnType<typeof smartCrush> | null = null;
    for (let run = 0; run < 2; run += 1) {
      const started = cpuMs();
      result = smartCrush({ content }, { enableCcrMarker: false });
      fastest = Math.min(fastest, cpuMs() - started);
    }
    expect(result!.wasModified).toBe(true);
    expect(fastest).toBeLessThan(1000);
  }, 30_000);

  it("drops rows without a marker when CCR markers are disabled, and never in lossless-only mode", () => {
    const rows = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i, status: i % 5 === 0 ? "error" : "ok", msg: `line ${i}` })));
    expect(smartCrush({ content: rows }, { enableCcrMarker: false }).compressed).not.toContain("_ccr_dropped");
    expect(smartCrush({ content: rows }, { losslessOnly: true }).strategy).toBe("lossless_only:uncompacted(30->30)");
  });
});
