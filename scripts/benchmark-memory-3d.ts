/**
 * Frame-time and overview harness for the 3D memory graph.
 * Writes /tmp/memory-3d-benchmark.json. Does not commit results.
 *
 *   npx tsx scripts/benchmark-memory-3d.ts
 *   npx tsx scripts/benchmark-memory-3d.ts --cpu
 *   npx tsx scripts/benchmark-memory-3d.ts --api
 *   npx tsx scripts/benchmark-memory-3d.ts --browser
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { selectMemoryLabels } from "../apps/web/src/features/memory-workspace/memory-3d-labels.js";
import { createProjectedMemoryNodes, SpatialPickIndex } from "../apps/web/src/features/memory-workspace/memory-3d-pick.js";
import { prepareMemoryGraph } from "../apps/web/src/features/memory-workspace/memory-3d-buffers.js";
import { createSyntheticMemoryGraph } from "../apps/web/src/demo/synthetic-memory-graph.js";

const args = new Set(process.argv.slice(2));
const runCpu = args.size === 0 || args.has("--cpu");
const runApi = args.size === 0 || args.has("--api");
const runBrowser = args.size === 0 || args.has("--browser");

function cpuinfo() {
  const text = readFileSync("/proc/cpuinfo", "utf8");
  return text.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? "unknown";
}

function meminfo() {
  const text = readFileSync("/proc/meminfo", "utf8");
  return text.match(/^MemTotal:\s*(.+)$/m)?.[1] ?? "unknown";
}

function percentile(samples: number[], ratio: number) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

async function cpuSection() {
  const sizes = [
    { nodes: 2_000, edges: 6_000 },
    { nodes: 50_000, edges: 150_000 }
  ];
  const graphs = [];
  for (const size of sizes) {
    const started = performance.now();
    const graph = createSyntheticMemoryGraph(size.nodes, size.edges);
    const generatedMs = performance.now() - started;
    const preparedStarted = performance.now();
    const prepared = prepareMemoryGraph(graph.nodes, graph.edges, {
      totalMatchingNodes: graph.nodeCount,
      totalMatchingEdges: graph.edgeCount,
      recordCount: graph.nodes.filter(node => node.type === "MEMORY").length
    });
    const prepareMs = performance.now() - preparedStarted;
    const stepSamples: number[] = [];
    const layoutStarted = performance.now();
    while (!prepared.simulation.done) {
      const stepStarted = performance.now();
      prepared.simulation.advance(1);
      stepSamples.push(performance.now() - stepStarted);
    }
    const layoutMs = performance.now() - layoutStarted;
    const projected = createProjectedMemoryNodes(prepared.packed.count);
    for (let index = 0; index < prepared.packed.count; index++) {
      projected.x[index] = (index % 250) * 8;
      projected.y[index] = Math.floor(index / 250) * 8;
      projected.z[index] = index;
      projected.radius[index] = 4;
    }
    const pick = new SpatialPickIndex();
    const rebuildStarted = performance.now();
    pick.rebuild(projected, prepared.packed.kinds);
    const rebuildMs = performance.now() - rebuildStarted;
    const queries = 40;
    const querySamples: number[] = [];
    for (let query = 0; query < queries; query++) {
      const target = (query * 997) % prepared.packed.count;
      const queryStarted = performance.now();
      pick.find(projected.x[target] ?? 0, projected.y[target] ?? 0);
      querySamples.push(performance.now() - queryStarted);
    }
    const candidates = pick.labelCandidates(1280, 800, 256);
    let measured = 0;
    const labels = selectMemoryLabels({
      showTitles: true,
      zoom: 1,
      focus: -1,
      width: 1280,
      height: 800,
      candidates: candidates.map(index => ({
        index,
        x: projected.x[index] ?? 0,
        y: projected.y[index] ?? 0,
        kind: prepared.packed.kinds[index] ?? 0,
        text: "space.md"
      })),
      measure: () => { measured += 1; return 48; }
    });
    graphs.push({
      requestedNodes: size.nodes,
      requestedEdges: size.edges,
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      layoutMode: prepared.simulation.mode,
      generatedMs: round(generatedMs),
      prepareMs: round(prepareMs),
      layoutMs: round(layoutMs),
      layoutSteps: prepared.simulation.step,
      stepP95Ms: round(percentile(stepSamples, 0.95)),
      stepMaxMs: round(Math.max(...stepSamples)),
      pickRebuildMs: round(rebuildMs),
      pickQueryP95Ms: round(percentile(querySamples, 0.95)),
      labelCandidates: candidates.length,
      labelsMeasured: measured,
      labelsDrawn: labels.length
    });
  }
  return { note: "CPU-only timings. They are not frame times.", graphs };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function apiSection() {
  execFileSync("npx", ["vitest", "run", "tests/overview-limit-bench.test.ts"], {
    cwd: new URL("../apps/api", import.meta.url).pathname,
    env: { ...process.env, MEMORY_3D_BENCH: "1" },
    stdio: "inherit"
  });
  return JSON.parse(readFileSync("/tmp/memory-3d-api.json", "utf8")) as unknown;
}

function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      fetch(url).then(response => {
        if (response.ok || response.status < 500) resolve();
        else if (Date.now() - started > timeoutMs) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(tick, 250);
      }).catch(() => {
        if (Date.now() - started > timeoutMs) reject(new Error(`Timed out waiting for ${url}`));
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function browserSample(port: number, nodes: number, edges: number) {
  const debugPort = 9222 + (nodes === 50_000 ? 1 : 0);
  const userData = `/tmp/chrome-memory-${nodes}`;
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--window-size=1280,800",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userData}`,
    "about:blank"
  ], { stdio: "ignore" });
  let browser: WebSocket | undefined;
  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 20_000);
    const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.json()) as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    browser = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("Chrome DevTools socket failed.")));
    });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let next = 0;
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (message.id && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      } else if (message.method) events.push({ method: message.method, params: message.params ?? {} });
    });
    const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const id = ++next;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    };
    const target = await call("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const attached = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true }) as { sessionId: string };
    const sessionId = attached.sessionId;
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
    const url = `http://127.0.0.1:${port}/demo-workspace?memoryNodes=${nodes}&memoryEdges=${edges}&benchmark=1`;
    await call("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + (nodes >= 50_000 ? 240_000 : 120_000);
    let sample: unknown = null;
    let last = "";
    let loggedFrames = 0;
    while (Date.now() < deadline) {
      const evaluated = await call("Runtime.evaluate", {
        expression: "JSON.stringify({ benchmark: window.__spaceMemoryBenchmark ?? null, frames: window.__spaceMemoryFrames ?? 0, split: window.__spaceMemorySplit ?? null, uploadMs: window.__spaceMemoryUploadMs ?? null, handlerMs: window.__spaceMemoryHandlerMs ?? null, positionMs: window.__spaceMemoryPositionMs ?? null, longTask: window.__spaceMemoryLongTask ?? null, longTasks: (window.__spaceMemoryLongTasks ?? []).slice(0, 8), marks: window.__spaceMemoryMarks ?? null, longTaskMs: window.__spaceMemoryLongTaskMs ?? null, warmMs: window.__spaceMemoryWarmMs ?? null, glError: window.__spaceMemoryGLError ?? null, renderer: document.querySelector('[data-renderer]')?.getAttribute('data-renderer') ?? null, layoutReady: document.querySelector('#memory-atlas')?.getAttribute('data-layout-ready') ?? null, canvas: (() => { const canvas = document.querySelector('.memory-3d-surface canvas'); const rect = canvas?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height } : null; })() })",
        returnByValue: true
      }, sessionId) as { result?: { value?: string } };
      last = evaluated.result?.value ?? "";
      if (last) {
        const parsed = JSON.parse(last) as { benchmark?: { status?: string } | null; frames?: number; split?: unknown };
        if (parsed.frames && parsed.frames !== loggedFrames) {
          loggedFrames = parsed.frames;
          console.log(last);
        }
        if (process.env.FRAME_PROBE === "1" && (parsed.frames ?? 0) >= 3) {
          sample = parsed;
          break;
        }
        if (parsed.benchmark?.status === "done" || parsed.benchmark?.status === "error") {
          sample = parsed;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!sample) throw new Error(`Benchmark did not finish for ${nodes} nodes. Last probe: ${last}`);
    return sample;
  } finally {
    browser?.close();
    chrome.kill("SIGKILL");
  }
}

async function browserSection() {
  const port = 4911;
  let server: ChildProcess | null = null;
  let startedHere = false;
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 1_000);
  } catch {
    server = spawn("npm", ["run", "dev", "-w", "@space/web"], { stdio: "ignore", cwd: new URL("..", import.meta.url).pathname });
    startedHere = true;
    await waitForHttp(`http://127.0.0.1:${port}/`, 60_000);
  }
  try {
    const twoThousand = await browserSample(port, 2_000, 6_000);
    const fiftyThousand = await browserSample(port, 50_000, 150_000);
    return { twoThousand, fiftyThousand, swiftShader: true };
  } finally {
    if (startedHere) server?.kill("SIGTERM");
  }
}

const report: Record<string, unknown> = {
  hardware: {
    cpu: cpuinfo(),
    memory: meminfo(),
    gpuDevice: existsSync("/dev/dri") ? "present" : "absent",
    rendererNote: "Browser frames use headless Chrome with ANGLE SwiftShader. These are software-GL numbers, not a discrete GPU."
  }
};

if (runCpu) report.cpu = await cpuSection();
if (runApi) report.api = await apiSection();
if (runBrowser) report.browser = await browserSection();
writeFileSync("/tmp/memory-3d-benchmark.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
