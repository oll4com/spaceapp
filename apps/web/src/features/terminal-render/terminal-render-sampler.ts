import type { TerminalRenderObservation } from "@space/contracts";
import { observeTerminalRender } from "./terminal-render-observer.js";

// This module creates no timers/listeners. Only the existing active diagnostics RAF calls tick.
const latest = new Map<string, TerminalRenderObservation>();
export function retainedTerminalRender(roomId: string): TerminalRenderObservation[] {
  return [...latest.values()].filter(s => s.roomId === roomId && Date.now() - s.observedAt < 60_000).slice(-64);
}
function retain(sample: TerminalRenderObservation) {
  const key = `${sample.roomId}/${sample.paneId}`;
  latest.delete(key); latest.set(key, sample);
  while (latest.size > 256) latest.delete(latest.keys().next().value!);
}
export function auditTerminalRender(roomId: string, paneId: string) {
  const sample = observeTerminalRender(roomId, paneId, latest.get(`${roomId}/${paneId}`));
  retain(sample); return sample;
}
interface SamplerDependencies {
  now(): number;
  targets(): Array<{roomId:string;paneId:string;focused?:boolean}>;
  sample(roomId:string,paneId:string): TerminalRenderObservation;
}
export function createTerminalRenderSampler(onSample: (sample: TerminalRenderObservation, anomaly: boolean) => void, dependencies: SamplerDependencies = {
  now: () => performance.now(),
  targets: () => [...document.querySelectorAll<HTMLElement>('.room-runtime-layer[data-presentation-state="displayed"] .pane-card[data-pane-mode="TERMINAL"][data-space-pane-id]')]
    .map(e => ({ roomId: e.dataset.spaceRoomId!, paneId: e.dataset.spacePaneId!, focused: e.classList.contains("is-target") })),
  sample: auditTerminalRender
}) {
  let stopped = false, next = 0, windowStart = -Infinity, cost = 0, count = 0, cursor = 0;
  const sampled = new Map<string, number>(), anomalies = new Map<string, number>();
  const ring: TerminalRenderObservation[] = [];
  return {
    tick(timestamp: number) {
      if (stopped || timestamp < next) return;
      next = timestamp + 250;
      if (timestamp - windowStart >= 1000) { windowStart = timestamp; cost = 0; count = 0; }
      if (count >= 4 || cost >= 10) return;
      const before = dependencies.now();
      const targets = dependencies.targets();
      if (!targets.length) return;
      const priority = count === 0 ? targets.find(target => target.focused) : undefined;
      for (let i = 0; i < targets.length + (priority ? 1 : 0); i++) {
        const target = i === 0 && priority ? priority : targets[cursor++ % targets.length]!;
        const key = `${target.roomId}/${target.paneId}`;
        if (timestamp - (sampled.get(key) ?? -Infinity) < 1000) continue;
        const sample = dependencies.sample(target.roomId, target.paneId);
        count++; sampled.delete(key); sampled.set(key, timestamp);
        const elapsed = dependencies.now() - before;
        cost += elapsed;
        if (elapsed > 2 || cost >= 10) { sample.reasons = [...sample.reasons, "BUDGET_LIMITED"]; next = Math.max(next, windowStart + 1000); }
        ring.push(sample); if (ring.length > 256) ring.shift();
        const anomalyKey = `${key}/${sample.surfaceGeneration}/${sample.verdict}`;
        const anomaly = sample.verdict === "FAULT" && timestamp - (anomalies.get(anomalyKey) ?? -Infinity) >= 10_000;
        if (anomaly) { anomalies.delete(anomalyKey); anomalies.set(anomalyKey, timestamp); }
        while (sampled.size > 256) sampled.delete(sampled.keys().next().value!);
        while (anomalies.size > 256) anomalies.delete(anomalies.keys().next().value!);
        onSample(sample, anomaly);
        break;
      }
    },
    records: () => [...ring],
    stop() { stopped = true; sampled.clear(); anomalies.clear(); ring.length = 0; }
  };
}
