import { writeFile } from "node:fs/promises";
import { cpus, loadavg, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";
import { largeMemoryGraph } from "../tests/fixtures/large-memory-graph.js";

// Run from the repository root after npm run check:
// node --import tsx apps/api/scripts/measure-memory-graph-overview.ts [report.json]
// app.inject exercises actual authentication, route selection, redaction, contract
// validation and JSON serialization. It measures no network or snapshot-building time.
const graphSnapshot = largeMemoryGraph();
const sessionSecret = "synthetic-benchmark-session-secret";
const sessionToken = signSession({ id: "user:benchmark", email: "benchmark@space.test", role: "OPERATOR" }, sessionSecret);
const app = await createApp({
  store: new InMemorySpaceStore(),
  config: getApiConfig({ SPACE_MEMORY_GRAPH_ENABLED: "true", SPACE_BROWSER_EVIDENCE_ENABLED: "false" }),
  auth: { sessionSecret, devLogin: false, secureCookies: false },
  canonicalMemory: {
    async list() { return []; },
    async save() { throw new Error("Synthetic benchmark never writes canonical memory."); }
  },
  memoryGraphService: {
    async getSnapshot() { return { snapshot: graphSnapshot, isStale: false }; },
    async getCachedSnapshot() { return graphSnapshot; },
    async invalidateCachedSnapshot() {},
    async getArchiveSnapshot() { return graphSnapshot; },
    async listAvailableMonths() { return []; },
    async getSourceContent() { throw new Error("Synthetic benchmark never reads canonical memory."); }
  }
});

try {
  await app.ready();
  const loadAtStart = loadavg();
  const samples: Array<{ milliseconds: number; bytes: number }> = [];
  for (let index = 0; index < 6; index += 1) {
    const started = performance.now();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/memory/graph/overview?limit=50000",
      headers: { cookie: `space_session=${sessionToken}`, "accept-encoding": "identity" }
    });
    const milliseconds = performance.now() - started;
    if (response.statusCode !== 200) throw new Error(`Unexpected status ${response.statusCode}: ${response.body.slice(0, 200)}`);
    const { data } = response.json();
    if (data.nodes.length !== 50_000 || data.edges.length !== 150_000 || data.truncated) {
      throw new Error("Benchmark did not return the complete 50k/150k fixture.");
    }
    if (response.body.includes("fixture-node-secret") || response.body.includes("fixture-edge-secret")) {
      throw new Error("Benchmark response failed redaction.");
    }
    samples.push({ milliseconds, bytes: Buffer.byteLength(response.body, "utf8") });
  }
  const sortedWarmTimes = samples.slice(1).map(sample => sample.milliseconds).sort((a, b) => a - b);
  const report = {
    measuredAt: new Date().toISOString(),
    command: "node --import tsx apps/api/scripts/measure-memory-graph-overview.ts",
    environment: {
      node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model,
      logicalCpus: cpus().length, loadAverageAtStart: loadAtStart, loadAverageAtEnd: loadavg()
    },
    fixture: { synthetic: true, nodes: 50_000, edges: 150_000 },
    method: "Six sequential in-process Fastify injections of the real authenticated overview route; first cold sample plus five warm samples. Includes filtering, selection, redaction, schema validation and JSON serialization. Excludes snapshot construction, process startup and network transfer. Response bytes are uncompressed UTF-8.",
    samples,
    coldMilliseconds: samples[0]!.milliseconds,
    warmMedianMilliseconds: sortedWarmTimes[Math.floor(sortedWarmTimes.length / 2)],
    warmMaxMilliseconds: sortedWarmTimes[sortedWarmTimes.length - 1],
    responseBytes: samples[0]!.bytes,
    passed: true
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.argv[2]) await writeFile(process.argv[2], json);
  process.stdout.write(json);
} finally {
  await app.close();
}
