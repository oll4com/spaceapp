import { Session } from "node:inspector/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const RESOLUTION_MS = 20;
// The histogram records the time between timer ticks, so it includes the sampling resolution itself.
const lateMs = (nanoseconds: number) => Math.max(0, Math.round(nanoseconds / 1e5 - RESOLUTION_MS * 10) / 10);

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
export interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] }

// Frames name files relative to the checkout this module runs from (src/ and dist/ sit two levels below it), so stable,
// dev and a public install all log "apps/api/dist/app.js:10" without naming a host path.
const CHECKOUT_URL = new URL("../../../", import.meta.url).href;

function frameLabel(node: ProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const file = (url.startsWith(CHECKOUT_URL) ? url.slice(CHECKOUT_URL.length) : url).replace(/^file:\/\//, "");
  return `${functionName || "(anonymous)"}${file ? ` ${file}:${lineNumber + 1}` : ""}`;
}

/**
 * What a V8 CPU profile says about the event loop: busy and GC time, the longest stretch without an
 * idle sample (a block every request waited behind) with the stack seen most in it, and the frames
 * with the most self time. Only code locations, never data.
 */
export function summarizeCpuProfile(profile: CpuProfile, top = 6) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const selfUs = new Map<string, number>();
  let busyUs = 0;
  let gcUs = 0;
  let runUs = 0;
  let runStart = 0;
  let longest = { us: 0, start: 0, end: -1 };
  samples.forEach((id, index) => {
    const node = nodes.get(id);
    const us = Math.max(0, deltas[index + 1] ?? 0);
    const name = node?.callFrame.functionName;
    // Node reports the wait in libuv as (idle) or (program); either ends a block.
    if (!node || name === "(idle)" || name === "(program)") {
      runUs = 0;
      runStart = index + 1;
      return;
    }
    busyUs += us;
    if (name === "(garbage collector)") gcUs += us;
    const label = frameLabel(node);
    selfUs.set(label, (selfUs.get(label) ?? 0) + us);
    runUs += us;
    if (runUs > longest.us) longest = { us: runUs, start: runStart, end: index };
  });
  const counts = new Map<number, number>();
  for (let index = longest.start; index <= longest.end; index += 1) counts.set(samples[index]!, (counts.get(samples[index]!) ?? 0) + 1);
  const blockStack: string[] = [];
  let id = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  while (id !== undefined && blockStack.length < 12) {
    const node = nodes.get(id);
    if (!node || node.callFrame.functionName === "(root)") break;
    blockStack.push(frameLabel(node));
    id = parents.get(id);
  }
  return {
    busyMs: Math.round(busyUs / 1000),
    gcMs: Math.round(gcUs / 1000),
    longestBlockMs: Math.round(longest.us / 1000),
    blockStack,
    topSelf: [...selfUs].sort((a, b) => b[1] - a[1]).slice(0, top).map(([frame, us]) => ({ frame, ms: Math.round(us / 1000) }))
  };
}

/**
 * One log line per interval with the API process's event-loop utilization and delay percentiles.
 * Slow requests are logged one by one; this tells whether the single Node thread itself was busy
 * (stable ran at 36-46% of a core with no such figure, 2026-10-24). The first interval, and the interval after one
 * that blocked the loop for `profileAfterBlockMs` (at most once per `profileEveryMs`), also run V8's sampling profiler
 * (10 ms) and log `event_loop.profile`: no other profiler reaches the API. A profiled interval ran at ~50% event-loop
 * utilization against ~4% without (dev, 2026-10-24), so it no longer runs every hour.
 */
export function reportEventLoopLoad(
  log: { info: (fields: object, message: string) => void },
  intervalMs = 300_000,
  { profileEveryMs = 3_600_000, profileAfterBlockMs = 1_000 }: { profileEveryMs?: number; profileAfterBlockMs?: number } = {}
): () => void {
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  delay.enable();
  let last = performance.eventLoopUtilization();
  let session: Session | null = null;
  let nextProfileAt = 0;
  let profilerFailed = false;
  let stopped = false;

  const startProfile = async () => {
    if (stopped || profilerFailed || Date.now() < nextProfileAt) return;
    nextProfileAt = Date.now() + profileEveryMs;
    const started = new Session();
    try {
      started.connect();
      await started.post("Profiler.enable");
      await started.post("Profiler.setSamplingInterval", { interval: 10_000 });
      await started.post("Profiler.start");
      session = started;
    } catch {
      profilerFailed = true;
      started.disconnect();
    }
  };
  const finishProfile = async () => {
    const running = session;
    session = null;
    if (!running) return;
    try {
      const { profile } = await running.post("Profiler.stop");
      log.info({ event: "event_loop.profile", ...summarizeCpuProfile(profile) }, "Event loop profile");
    } catch {
      profilerFailed = true;
    } finally {
      running.disconnect();
    }
  };

  void startProfile();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    const { utilization } = performance.eventLoopUtilization(current, last);
    last = current;
    const blocked = lateMs(delay.max) >= profileAfterBlockMs;
    log.info({
      event: "event_loop.load",
      utilization: Math.round(utilization * 1000) / 1000,
      delayP50Ms: lateMs(delay.percentile(50)),
      delayP99Ms: lateMs(delay.percentile(99)),
      delayMaxMs: lateMs(delay.max)
    }, "Event loop load");
    delay.reset();
    void finishProfile().then(() => blocked ? startProfile() : undefined);
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    delay.disable();
    void finishProfile();
  };
}
