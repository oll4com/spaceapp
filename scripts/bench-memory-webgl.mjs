/* global window, document, requestAnimationFrame, KeyboardEvent, WheelEvent, PointerEvent */
/** Run against dev:web with an optional, separately installed Playwright package. */
import { writeFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const base = process.env.MEMORY_BENCH_URL || "http://127.0.0.1:4911";
const browser = await chromium.launch({ channel: "chrome", headless: false });
const output = { browser: browser.version(), viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, results: [] };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function openMemory(page, count) {
  await page.goto(`${base}/demo-workspace?memoryNodes=${count}`);
  await page.getByRole("button", { name: "Admin mode", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("tab", { name: "Utilities", exact: true }).click();
  await page.getByRole("button", { name: "Open memory workspace", exact: true }).click();
  await page.getByRole("button", { name: "Atlas", exact: true }).click();
  await page.waitForSelector("[data-layout-ready=true]");
}
try {
  const counts = process.env.MEMORY_BENCH_COUNTS === undefined ? [2000, 10000, 50000] : process.env.MEMORY_BENCH_COUNTS.split(",").filter(Boolean).map(Number);
  for (const count of counts) {
    const page = await browser.newPage({ viewport: output.viewport, deviceScaleFactor: 1 });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await openMemory(page, count);
    await page.evaluate(() => {
      window.memoryBenchTasks = [];
      window.memoryBenchObserver = new PerformanceObserver(list => window.memoryBenchTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
      window.memoryBenchObserver.observe({ type: "longtask" });
      window.memoryBenchStart = performance.now();
    });
    await page.getByRole("button", { name: "Toggle 3D memory view" }).click();
    await page.waitForSelector(`[data-renderer=webgl2][data-scene-node-count="${count}"]`, { timeout: 60000 });
    const firstSceneMs = await page.evaluate(() => performance.now() - window.memoryBenchStart);
    // Verify interaction during convergence, including a pending frame's camera change.
    const canvas = page.locator("canvas[data-renderer=webgl2]");
    const before = await canvas.getAttribute("data-rotation");
    await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("+");
    await page.waitForFunction(rotation => document.querySelector("canvas[data-renderer=webgl2]").dataset.rotation !== rotation, before);
    await page.waitForSelector("[data-layout-complete=true]", { timeout: 180000 });
    const result = await page.evaluate(async () => {
      const tasks = [...window.memoryBenchTasks], layoutMs = performance.now() - window.memoryBenchStart;
      window.memoryBenchObserver.disconnect();
      const c = document.querySelector("canvas[data-renderer=webgl2]"), gl = c.getContext("webgl2"), info = gl.getExtension("WEBGL_debug_renderer_info");
      const frames = [], picks = [];
      let previous;
      for (let i = 0; i < 420; i++) {
        await new Promise(resolve => requestAnimationFrame(time => {
          if (previous !== undefined && i >= 60) frames.push(time - previous);
          previous = time;
          c.dispatchEvent(new KeyboardEvent("keydown", { key: i % 2 ? "ArrowRight" : "ArrowUp", bubbles: true }));
          c.dispatchEvent(new WheelEvent("wheel", { deltaY: Math.sin(i / 25) * 12, bubbles: true, cancelable: true }));
          const rect = c.getBoundingClientRect(), start = performance.now();
          c.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: rect.left + rect.width * (.5 + .25 * Math.sin(i)), clientY: rect.top + rect.height * (.5 + .25 * Math.cos(i)), bubbles: true }));
          if (i >= 60) picks.push(performance.now() - start);
          resolve();
        }));
      }
      return { frames, picks, tasks, layoutMs, gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), edges: Number(document.querySelector("[data-visible-edge-count]").dataset.visibleEdgeCount) };
    });
    // Titles and actual click-to-detail remain functional at this size.
    await page.getByRole("button", { name: "Toggle memory titles" }).click();
    if (await canvas.getAttribute("data-titles-visible") !== "false") throw new Error("Title toggle failed");
    await page.getByRole("button", { name: "Toggle memory titles" }).click();
    await page.getByRole("button", { name: "Reset 3D memory view" }).click();
    const bounds = await canvas.boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.waitForSelector(".memory-atlas-detail");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".memory-atlas-detail", { state: "detached" });
    await canvas.focus(); await page.keyboard.press("Enter");
    await page.waitForSelector(".memory-atlas-detail");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".memory-atlas-detail", { state: "detached" });
    const extension = await canvas.evaluate(c => !!c.getContext("webgl2").getExtension("WEBGL_lose_context"));
    if (!extension) throw new Error("Context loss extension unavailable");
    await page.evaluate(async () => {
      const { api } = await import("/src/api.ts");
      const overview = api.memoryGraphOverview;
      window.memoryBenchRecoveryRequests = 0;
      api.memoryGraphOverview = (...args) => {
        window.memoryBenchRecoveryRequests++;
        return overview(...args);
      };
    });
    await canvas.evaluate(c => { window.memoryBenchLoss = c.getContext("webgl2").getExtension("WEBGL_lose_context"); window.memoryBenchLoss.loseContext(); });
    await page.waitForSelector("canvas[data-renderer=canvas2d]");
    await page.waitForFunction(expected => Number(document.querySelector("[data-visible-node-count]").dataset.visibleNodeCount) === expected, count);
    if (Number(await page.locator("canvas[data-renderer=canvas2d]").getAttribute("data-scene-node-count")) > 2000) throw new Error("Context-loss fallback exceeded node cap");
    await page.evaluate(() => window.memoryBenchLoss.restoreContext());
    await page.waitForSelector(`canvas[data-renderer=webgl2][data-scene-node-count="${count}"]`, { timeout: 60000 });
    const recoveryRequests = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return window.memoryBenchRecoveryRequests;
    });
    const entry = { count, ...result, firstSceneMs, frameP95Ms: percentile(result.frames, .95), pickP95Ms: percentile(result.picks, .95), pickMaxMs: Math.max(...result.picks), longestLoadLayoutTaskMs: Math.max(0, ...result.tasks.map(t => t.duration)), interactionDuringLayout: true, titleToggle: true, keyboardSelection: true, pointerSelection: true, contextLossFallbackAndRestore: true, recoveryRequests, errors };
    output.results.push(entry);
    console.log(JSON.stringify({ count, frameP95Ms: entry.frameP95Ms, pickMaxMs: entry.pickMaxMs, longestLoadLayoutTaskMs: entry.longestLoadLayoutTaskMs }));
    if (entry.frameP95Ms > (count === 2000 ? 16.7 : 33.3) || entry.pickMaxMs > 4 || entry.longestLoadLayoutTaskMs > 100 || errors.length || recoveryRequests) throw new Error(`Rendering or recovery budget failed at ${count} nodes`);
    await page.close();
  }
  // Exercise the actual live HTTP decoder separately from the synthetic demo store.
  // Response generation and module loading finish before long-task measurement starts.
  const livePage = await browser.newPage({ viewport: output.viewport });
  const liveNodes = Array.from({ length: 50000 }, (_,i) => ({ id: `memory:${i}`, type: "MEMORY", label: `Synthetic memory ${i} ${"x".repeat(256)}`, sourcePath: null, recordId: null }));
  const liveEdges = liveNodes.flatMap((node,i) => [1,2,3].map(k => ({ id: `edge:${i}:${k}`, source: node.id, target: liveNodes[(i+k)%50000].id, type: "SEMANTICALLY_RELATED", origin: "DETERMINISTIC_TFIDF", confidence: 0.8, evidence: "Synthetic benchmark relation" })));
  const liveBody = JSON.stringify({ data: { nodes: liveNodes, edges: liveEdges, truncated: false, totalMatchingNodes: 50000, totalMatchingEdges: 150000 } });
  await livePage.route("**/api/admin/memory/graph/overview?*", route => route.fulfill({ status: 200, contentType: "application/json", body: liveBody }));
  await livePage.route("**/memory-decode-benchmark", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Memory response benchmark</title>" }));
  await livePage.goto(`${base}/memory-decode-benchmark`);
  await livePage.evaluate(async () => {
    const { default: refresh } = await import("/@react-refresh");
    refresh.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    window.memoryBenchLiveApi = (await import("/src/live-api.ts")).api;
    window.memoryBenchSynthetic = (await import("/src/demo/synthetic-memory-graph.ts")).loadSyntheticMemoryGraph;
  });
  output.coldSyntheticConstruction = await livePage.evaluate(async () => {
    const tasks = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
    observer.observe({ type: "longtask" });
    const started = performance.now();
    const graph = await window.memoryBenchSynthetic(50000);
    const elapsedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 100));
    observer.disconnect();
    return { nodes: graph.nodes.length, edges: graph.edges.length, elapsedMs, tasks, longestTaskMs: Math.max(0, ...tasks.map(t => t.duration)) };
  });
  if (output.coldSyntheticConstruction.nodes !== 50000 || output.coldSyntheticConstruction.longestTaskMs > 100) throw new Error("Cold synthetic construction budget failed");
  output.liveResponseDecode = await livePage.evaluate(async () => {
    const tasks = [];
    const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))));
    observer.observe({ type: "longtask" });
    const started = performance.now();
    const graph = await window.memoryBenchLiveApi.memoryGraphOverview({ limit: 50000 });
    const elapsedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 100));
    observer.disconnect();
    return { nodes: graph.data.nodes.length, edges: graph.data.edges.length, elapsedMs, tasks, longestTaskMs: Math.max(0, ...tasks.map(t => t.duration)) };
  });
  output.liveResponseDecode.uncompressedBytes = Buffer.byteLength(liveBody);
  if (output.liveResponseDecode.nodes !== 50000 || output.liveResponseDecode.edges !== 150000 || output.liveResponseDecode.longestTaskMs > 100) throw new Error("Live response decode budget failed");
  console.log(JSON.stringify({ liveResponseDecode: output.liveResponseDecode }));
  await livePage.close();
  const fallbackBrowser = await chromium.launch({ channel: "chrome", headless: false, args: ["--disable-webgl"] });
  try {
    const page = await fallbackBrowser.newPage({ viewport: output.viewport });
    await openMemory(page, 50000);
    await page.getByRole("button", { name: "Toggle 3D memory view" }).click();
    await page.waitForSelector("canvas[data-renderer=canvas2d]");
    await page.waitForFunction(() => Number(document.querySelector("[data-visible-node-count]").dataset.visibleNodeCount) <= 2000);
    output.noWebGLFallback = true;
  } finally { await fallbackBrowser.close(); }
} finally {
  await writeFile(process.env.MEMORY_BENCH_OUTPUT || "memory-webgl-benchmark.json", JSON.stringify(output, null, 2) + "\n");
  await browser.close();
}
