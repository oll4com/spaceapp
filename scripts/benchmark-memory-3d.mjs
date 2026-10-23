#!/usr/bin/env node
// Frame-time harness for the WebGL2 3D memory graph (#62).
//
// Drives the real app in a headless Chrome over the DevTools protocol (no test-only
// dependencies): /demo-workspace → Memory → 3D → synthetic demo graph at 2k/10k/50k →
// rotate + zoom + hover, recording rAF frame times per phase (rotate / zoom / overall),
// main-thread long tasks and pick latency. Default Chrome flags select SwiftShader
// software GL so the harness runs on any machine; set CHROME_GPU_FLAGS="" to measure
// real hardware, and name the hardware (and this flag choice) when reporting results.
//
// Usage:
//   npm run dev:web                        # in another shell (or point BASE_URL at it)
//   node scripts/benchmark-memory-3d.mjs
//
// Env: BASE_URL (default http://127.0.0.1:4911), SIZES (default 2000,10000,50000),
// DURATION_MS (default 8000), CHROME_BIN, CHROME_GPU_FLAGS (default SwiftShader flags),
// RESULTS_FILE, SCREENSHOT_DIR (a directory; screenshots land in it per size).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4911";
const SIZES = (process.env.SIZES ?? "2000,10000,50000").split(",").map(value => Number.parseInt(value, 10)).filter(Number.isSafeInteger);
const DURATION_MS = Number.parseInt(process.env.DURATION_MS ?? "8000", 10);
const CHROME_BIN = process.env.CHROME_BIN ?? "chromium-browser";
const GPU_FLAGS = process.env.CHROME_GPU_FLAGS === "" ? [] :
  (process.env.CHROME_GPU_FLAGS ?? "--enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader").split(" ");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectDevTools(port, url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(entry => entry.type === "page" && entry.url.startsWith(BASE_URL));
      if (!page) throw new Error("no page target");
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let messageId = 0;
      const pending = new Map();
      const traceEvents = [];
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.method === "Tracing.dataCollected") { for (const item of message.params.value ?? []) traceEvents.push(item); return; }
        if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++messageId;
        pending.set(id, message => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
        socket.send(JSON.stringify({ id, method, params }));
      });
      return { socket, send, traceEvents };
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome DevTools endpoint never became reachable.");
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "spaceapp-memory3d-bench-"));
  const child = spawn(CHROME_BIN, [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-port=0",
    ...GPU_FLAGS, `--user-data-dir=${profile}`, "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const debugPort = await new Promise((resolve, reject) => {
    child.stderr.on("data", chunk => {
      const match = String(chunk).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number.parseInt(match[1], 10));
    });
    child.on("exit", () => reject(new Error("Chrome exited immediately — check CHROME_BIN.")));
    setTimeout(() => reject(new Error("Chrome DevTools port timeout.")), 30000).unref();
  });
  try {
    const devtools = await connectDevTools(debugPort, `${BASE_URL}/demo-workspace`);
    await devtools.send("Page.enable");
    await devtools.send("Runtime.enable");
    const evaluate = async expression => {
      const outcome = await devtools.send("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression });
      if (outcome.result?.subtype === "error" || outcome.result?.exceptionDetails) {
        throw new Error(`page evaluation failed: ${JSON.stringify(outcome.result.exceptionDetails ?? outcome.result).slice(0, 400)}`);
      }
      return outcome.result?.value;
    };
    const waitForDom = async (expression, timeoutMs, label) => {
      const started = Date.now();
      for (;;) {
        if (await evaluate(expression)) return;
        if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(500);
      }
    };
    let screenshotDir = process.env.SCREENSHOT_DIR ?? tmpdir();
    try { if (!statSync(screenshotDir).isDirectory()) screenshotDir = tmpdir(); } catch { screenshotDir = tmpdir(); }
    mkdirSync(screenshotDir, { recursive: true });
    const results = [];
    for (const size of SIZES) {
      console.error(`\n=== benchmarking ${size.toLocaleString()} nodes (${DURATION_MS}ms rotate + zoom + hover) ===`);
      await devtools.send("Page.navigate", { url: `${BASE_URL}/demo-workspace` });
      await sleep(6000);
      await evaluate(`(() => {
        const workspaceMenu = document.querySelector('[aria-label="Workspace"]') || [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Workspace");
        workspaceMenu?.click();
        return "ok";
      })()`);
      await sleep(800);
      await evaluate(`(() => {
        const search = document.querySelector('input[aria-label="Find an action"]');
        if (search) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(search, "memory");
          search.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return "ok";
      })()`);
      await sleep(600);
      const opened = await evaluate(`(() => {
        const opener = document.querySelector('[aria-label="Open memory workspace"]');
        if (!opener) return "missing";
        opener.click();
        return "opened";
      })()`);
      if (opened !== "opened") throw new Error("Open memory workspace control not found (searched the workspace menu).");
      // Close the workspace menu overlay so screenshots show the memory workspace itself.
      await evaluate(`(() => {
        document.querySelector('input[aria-label="Find an action"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        return "ok";
      })()`);
      await sleep(500);
      console.error("memory workspace opened");
      await waitForDom(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Atlas")`, 30000, "Atlas mode pill");
      await evaluate(`(() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Atlas").click(); return "ok"; })()`);
      await waitForDom(`Boolean(document.querySelector('[aria-label="Toggle 3D memory view"]'))`, 30000, "3D toggle");
      await evaluate(`(() => { document.querySelector('[aria-label="Toggle 3D memory view"]').click(); return "ok"; })()`);
      console.error("3D view enabled");
      await waitForDom(`Boolean(document.querySelector('[aria-label="Load ${size} node demo graph"]'))`, 30000, "size preset button");
      await evaluate(`(() => { document.querySelector('[aria-label="Load ${size} node demo graph"]').click(); return "ok"; })()`);
      console.error(`synthetic ${size} node graph requested; waiting for layout…`);
      await waitForDom(`document.getElementById("memory-atlas")?.dataset.layoutReady === "true" && document.querySelector(".memory-3d-surface canvas:not(.memory-3d-webgl)")?.getAttribute("aria-busy") === "false"`,
        Math.max(DURATION_MS * 2 + 300000, 320000), "layout completion");
      console.error("layout complete; measuring…");
      await sleep(2500);
      const tracing = Boolean(process.env.TRACE);
      if (tracing) {
        devtools.traceEvents.length = 0;
        await devtools.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "v8.execute", "disabled-by-default-devtools.timeline"] } });
        await devtools.send("Profiler.enable");
        await devtools.send("Profiler.setSamplingInterval", { interval: 2000 });
        await devtools.send("Profiler.start");
      }
      const measurement = `(async () => {
        try {
        window.__memory3dLongTasks = [];
        try {
          new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__memory3dLongTasks.push({ duration: Math.round(entry.duration), start: Math.round(entry.startTime) }); }).observe({ entryTypes: ["longtask"] });
        } catch {}
        const canvas = document.querySelector(".memory-3d-surface canvas:not(.memory-3d-webgl)");
        if (!canvas) throw new Error("3D canvas not mounted");
        const rects = canvas.getBoundingClientRect();
        const samples = [], pickTimes = [];
        const phaseMarks = { rotateStart: 0, zoomStart: 0, hoverStart: 0 };
        let lastFrame = performance.now();
        let raf = 0;
        let tickDone = false;
        const totalMs = ${DURATION_MS} * 2 + 2500;
        const startedAt = performance.now();
        const tick = now => {
          const t = now - startedAt;
          samples.push({ delta: now - lastFrame, t });
          lastFrame = now;
          if (t < totalMs) raf = requestAnimationFrame(tick); else tickDone = true;
        };
        raf = requestAnimationFrame(tick);
        phaseMarks.rotateStart = performance.now() - startedAt;
        const rotateStart = performance.now();
        while (performance.now() - rotateStart < ${DURATION_MS}) {
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
          await new Promise(r => setTimeout(r, 16));
        }
        phaseMarks.zoomStart = performance.now() - startedAt;
        const zoomStart = performance.now();
        let zoomDirection = 1;
        while (performance.now() - zoomStart < ${DURATION_MS}) {
          canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 90 * zoomDirection, clientX: rects.left + rects.width / 2, clientY: rects.top + rects.height / 2, cancelable: true }));
          if (Math.random() < 0.06) zoomDirection *= -1;
          await new Promise(r => setTimeout(r, 16));
        }
        phaseMarks.hoverStart = performance.now() - startedAt;
        const hoverStart = performance.now();
        while (performance.now() - hoverStart < 2500) {
          canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: rects.left + Math.random() * rects.width, clientY: rects.top + Math.random() * rects.height, bubbles: true }));
          await new Promise(r => setTimeout(r, 33));
          if (canvas.dataset.pickMs) pickTimes.push(Number(canvas.dataset.pickMs));
        }
        cancelAnimationFrame(raf);
        const percentile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] * 100) / 100; };
        const frameStats = (from, to) => {
          const deltas = samples.filter(sample => sample.t >= from && (to === undefined || sample.t < to)).map(sample => sample.delta).slice(1);
          if (!deltas.length) return null;
          return { samples: deltas.length, p50: percentile(deltas, 0.5), p95: percentile(deltas, 0.95), max: Math.round(Math.max(...deltas) * 100) / 100 };
        };
        return {
          nodes: ${size},
          renderer: canvas.dataset.renderer,
          unmaskedRenderer: (() => { try { const c = document.querySelector(".memory-3d-webgl").getContext("webgl2"); const ext = c && c.getExtension("WEBGL_debug_renderer_info"); return ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null; } catch { return null; } })(),
          webgl2: (() => { try { return Boolean(document.querySelector(".memory-3d-webgl").getContext("webgl2")); } catch { return false; } })(),
          visibleNodes: Number(document.querySelector("[data-visible-node-count]")?.getAttribute("data-visible-node-count") ?? -1),
          visibleEdges: Number(document.querySelector("[data-visible-edge-count]")?.getAttribute("data-visible-edge-count") ?? -1),
          rotation: canvas.dataset.rotation,
          layoutVolume: canvas.dataset.layoutVolume,
          rotate: frameStats(phaseMarks.rotateStart, phaseMarks.zoomStart),
          zoom: frameStats(phaseMarks.zoomStart, phaseMarks.hoverStart),
          overall: frameStats(0),
          longTasksOver100ms: (window.__memory3dLongTasks ?? []).filter(entry => entry.duration > 100),
          pickP95: percentile(pickTimes, 0.95), pickMax: pickTimes.length ? Math.round(Math.max(...pickTimes) * 100) / 100 : null, pickSamples: pickTimes.length
        };
        } catch (error) {
          return { error: String(error?.stack ?? error).slice(0, 600) };
        }
      })()`;
      const result = await evaluate(measurement);
      if (tracing) {
        await devtools.send("Tracing.end").catch(() => {});
        await sleep(1500);
        const events = devtools.traceEvents;
        const heavy = new Map();
        for (const event of events) {
          if (event.ph !== "X" || !(event.dur > 15000)) continue;
          const entry = heavy.get(event.name) ?? { count: 0, totalMs: 0, maxMs: 0 };
          entry.count++; entry.totalMs += event.dur / 1000; entry.maxMs = Math.max(entry.maxMs, event.dur / 1000);
          heavy.set(event.name, entry);
        }
        const summary = [...heavy.entries()].map(([name, entry]) => ({ name, count: entry.count, totalMs: Math.round(entry.totalMs), maxMs: Math.round(entry.maxMs) }))
          .sort((a, b) => b.totalMs - a.totalMs).slice(0, 15);
        result.traceHeavyTasks = summary;
        result.traceEventCount = events.length;
        const traceSummaryPath = join(screenshotDir, `trace-summary-${size}.json`);
        writeFileSync(traceSummaryPath, JSON.stringify({ size, summary, eventsOver10ms: [...heavy.entries()].map(([name, entry]) => ({ name, count: entry.count, totalMs: Math.round(entry.totalMs), maxMs: Math.round(entry.maxMs) })) }, null, 2));
        console.error(`trace summary: ${traceSummaryPath}`);
      }
      if (tracing) {
        try {
          const profileResult = await devtools.send("Profiler.stop");
          const profile = profileResult?.profile;
          if (profile) {
            const selfTime = new Map();
            for (const node of profile.nodes) {
              const hitCount = (node.hitCount ?? 0) + (node.callFrame && (node.callFrame.functionName || node.callFrame.url) ? 0 : 0);
              if (!hitCount) continue;
              const key = `${node.callFrame.functionName || "(anonymous)"} @ ${(node.callFrame.url || "").split("/").pop()}:${node.callFrame.lineNumber + 1}`;
              selfTime.set(key, (selfTime.get(key) ?? 0) + node.hitCount);
            }
            const total = [...selfTime.values()].reduce((a, b) => a + b, 0);
            const hot = [...selfTime.entries()].map(([name, hits]) => ({ name, ms: Math.round(hits * 2), share: Math.round(hits / Math.max(1, total) * 1000) / 10 }))
              .sort((a, b) => b.ms - a.ms).slice(0, 20);
            result.cpuProfileTop = hot;
            const profilePath = join(screenshotDir, `cpu-profile-${size}.json`);
            writeFileSync(profilePath, JSON.stringify({ nodes: profile.nodes, timeDeltas: profile.timeDeltas, samples: profile.samples }));
            console.error(`cpu profile: ${profilePath} (total ${Math.round(total * 2)}ms sampled)`);
            console.error(`cpu profile: ${profilePath}`);
          }
        } catch (error) {
          console.error(`cpu profile skipped: ${error.message}`);
        }
      }
      if (!result || !result.renderer) throw new Error(`measurement incomplete: ${JSON.stringify(result).slice(0, 300)}`);
      results.push(result);
      console.log(JSON.stringify(result));
      const screenshotPath = join(screenshotDir, `memory3d-${size}.png`);
      try {
        const screenshot = await devtools.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
        console.error(`screenshot: ${screenshotPath}`);
      } catch (error) {
        console.error(`screenshot skipped: ${error.message}`);
      }
    }
    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify(results, null, 2));
    writeFileSync(process.env.RESULTS_FILE ?? "benchmark-memory-3d-results.json", JSON.stringify(results, null, 2));
  } finally {
    child.kill("SIGKILL");
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch (error) {
      console.error(`profile cleanup skipped (${error?.code ?? error})`);
    }
  }
}

await main();
