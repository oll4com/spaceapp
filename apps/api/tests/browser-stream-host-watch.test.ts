import { describe, expect, it, vi } from "vitest";
import { createBrowserStreamHostWatch, type BrowserStreamHostIdentity } from "../src/browser-stream-host-watch.js";
import { apiDomainMetrics } from "../src/api-metrics.js";

const hostA: BrowserStreamHostIdentity = { hostPid: 101, startedAt: "2026-10-27T10:00:00.000Z" };
const hostB: BrowserStreamHostIdentity = { hostPid: 202, startedAt: "2026-10-27T10:05:00.000Z" };

function recoveries(outcome: "SCHEDULED" | "FAILED"): number {
  const line = apiDomainMetrics.render().split("\n")
    .find((row) => row.startsWith(`space_recovery_events_total{kind="browser_stream_host",outcome="${outcome}"}`));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("browser stream host watch", () => {
  it("ends a viewer when the Browser Host restarts with a new identity, and keeps it while the host stays", async () => {
    let current: BrowserStreamHostIdentity = hostA;
    const health = vi.fn(async () => current);
    const watch = createBrowserStreamHostWatch({ health, intervalMs: 20 });
    const onEnd = vi.fn();
    const unwatch = watch.watch(onEnd);
    await until(() => health.mock.calls.length >= 3);
    expect(onEnd).not.toHaveBeenCalled();
    current = hostB;
    await until(() => onEnd.mock.calls.length > 0);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("restarted");
    expect(watch.size()).toBe(0);
    unwatch();
  });

  it("ends viewers only after two failed health reads in a row", async () => {
    const outcomes: Array<"ok" | "fail"> = ["ok", "fail", "ok", "fail", "fail"];
    const health = vi.fn(async () => {
      const next = outcomes.shift() ?? "fail";
      if (next === "fail") throw new Error("Browser Host unavailable");
      return hostA;
    });
    const watch = createBrowserStreamHostWatch({ health, intervalMs: 10 });
    const onEnd = vi.fn();
    watch.watch(onEnd);
    await until(() => onEnd.mock.calls.length > 0);
    expect(health).toHaveBeenCalledTimes(5);
    expect(onEnd).toHaveBeenCalledExactlyOnceWith("unavailable");
  });

  it("never takes its identity from a health read that started before the viewer registered", async () => {
    let release: ((value: BrowserStreamHostIdentity) => void) | undefined;
    const health = vi.fn()
      .mockImplementationOnce(() => new Promise<BrowserStreamHostIdentity>((resolve) => { release = resolve; }))
      .mockImplementation(async () => hostB);
    const watch = createBrowserStreamHostWatch({ health, intervalMs: 10_000 });
    const first = vi.fn();
    watch.watch(first);
    await until(() => release !== undefined);
    // The stream of the second viewer was started on the restarted host while the old host's read was in flight.
    const second = vi.fn();
    watch.watch(second);
    release?.(hostA);
    await until(() => health.mock.calls.length >= 2);
    await until(() => first.mock.calls.length > 0);
    expect(first).toHaveBeenCalledExactlyOnceWith("restarted");
    expect(second).not.toHaveBeenCalled();
    expect(watch.size()).toBe(1);
  });

  it("stops polling once the last viewer leaves", async () => {
    const health = vi.fn(async () => hostA);
    const watch = createBrowserStreamHostWatch({ health, intervalMs: 10 });
    const unwatch = watch.watch(() => undefined);
    await until(() => health.mock.calls.length >= 2);
    unwatch();
    const calls = health.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(health.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
  it("counts one browser_stream_host recovery per host restart or outage, not one per viewer (OBS-001)", async () => {
    let current: BrowserStreamHostIdentity | null = hostA;
    const health = vi.fn(async () => {
      if (!current) throw new Error("Browser Host unavailable");
      return current;
    });
    const watch = createBrowserStreamHostWatch({ health, intervalMs: 10 });
    const scheduled = recoveries("SCHEDULED");
    const failed = recoveries("FAILED");
    const ended: string[] = [];
    watch.watch((reason) => ended.push(reason));
    watch.watch((reason) => ended.push(reason));
    await until(() => health.mock.calls.length >= 3);
    current = hostB;
    await until(() => ended.length === 2);
    expect(ended).toEqual(["restarted", "restarted"]);
    expect(recoveries("SCHEDULED")).toBe(scheduled + 1);

    watch.watch((reason) => ended.push(reason));
    watch.watch((reason) => ended.push(reason));
    await until(() => health.mock.calls.length >= 8);
    current = null;
    await until(() => ended.length === 4);
    expect(ended.slice(2)).toEqual(["unavailable", "unavailable"]);
    expect(recoveries("FAILED")).toBe(failed + 1);
    expect(recoveries("SCHEDULED")).toBe(scheduled + 1);
  });
});
