// @vitest-environment node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { readMemoryOverviewResponse } from "../src/features/memory-workspace/memory-overview-response.js";
import type { MemoryOverviewParseMessage, MemoryOverviewParseRequest } from "../src/features/memory-workspace/memory-overview-parser.js";

it("parses a 50k/150k response in a real separate thread and returns only bounded topology chunks", async () => {
  const require = createRequire(import.meta.url), threads: NodeWorker[] = [], terminations: Promise<number>[] = [];
  const parseThreads: number[] = [], chunkSizes: number[] = [];
  class ThreadBackedWorker {
    onmessage: ((event: { data: MemoryOverviewParseMessage }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    private readonly thread: NodeWorker;
    constructor(url: URL) {
      this.thread = new NodeWorker(`
        const { parentPort, workerData, threadId } = require("node:worker_threads");
        require(workerData.register);
        global.self = { onmessage: null, postMessage(message) { parentPort.postMessage(message); } };
        require(workerData.entry);
        const parse = JSON.parse;
        JSON.parse = (raw, ...args) => {
          if (raw.length > 1000000) parentPort.postMessage({ probe: "parse", threadId });
          return parse(raw, ...args);
        };
        parentPort.on("message", data => global.self.onmessage({ data }));
      `, { eval: true, execArgv: [], workerData: { register: require.resolve("tsx/cjs"), entry: fileURLToPath(url) } });
      threads.push(this.thread);
      this.thread.on("message", (message: MemoryOverviewParseMessage | { probe: "parse"; threadId: number }) => {
        if ("probe" in message) { parseThreads.push(message.threadId); return; }
        if (message.kind === "nodes") chunkSizes.push(message.nodes.length);
        if (message.kind === "edges") chunkSizes.push(message.edges.length);
        this.onmessage?.({ data: message });
      });
      this.thread.on("error", error => this.onerror?.({ message: error instanceof Error ? error.message : String(error) }));
    }
    postMessage(request: MemoryOverviewParseRequest, transfer: ArrayBuffer[]) { this.thread.postMessage(request, transfer); }
    terminate() { terminations.push(this.thread.terminate()); }
  }
  const nodes = Array.from({ length: 50_000 }, (_, index) => ({ id: `node:${index}`, label: `Synthetic memory ${index}`, type: "MEMORY", sourcePath: null, recordId: null }));
  const edges = Array.from({ length: 150_000 }, (_, index) => ({ id: `edge:${index}`, source: `node:${index % nodes.length}`, target: `node:${(index + 1) % nodes.length}`, type: "CONTAINS" }));
  const body = JSON.stringify({ data: { nodes, edges, totalMatchingNodes: nodes.length, truncated: false } });
  expect(body.length).toBeGreaterThan(10_000_000);
  const response = new Response(body, { headers: { "content-type": "application/json" } });
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 1);
  const mainParse = vi.spyOn(JSON, "parse");
  vi.stubGlobal("Worker", ThreadBackedWorker);
  try {
    const payload = await readMemoryOverviewResponse("/api/admin/memory/graph/overview?limit=50000", response, () => { throw new Error("Unexpected main-thread parser fallback"); }) as { data: { nodes: unknown[]; edges: unknown[] } };
    expect(payload.data.nodes).toHaveLength(50_000); expect(payload.data.edges).toHaveLength(150_000);
    expect(payload.data.nodes[0]).toEqual(nodes[0]); expect(payload.data.edges.at(-1)).toEqual(edges.at(-1));
    expect(parseThreads).toHaveLength(1); expect(parseThreads[0]).toBeGreaterThan(0);
    expect(mainParse.mock.calls.some(([raw]) => typeof raw === "string" && raw.length > 1_000_000)).toBe(false);
    expect(heartbeat).toBeGreaterThan(0); expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(2000);
  } finally {
    clearInterval(timer); mainParse.mockRestore(); vi.unstubAllGlobals();
    await Promise.all([...terminations, ...threads.map(thread => thread.terminate())]);
  }
}, 30_000);
