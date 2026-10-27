import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserFromUserAgent, buildInstallTelemetryPing, createFirstAnswerWatch, createInstallTelemetry, createInstallTelemetryReporter, installTelemetryEnabled,
  installTelemetryId
} from "../src/install-telemetry.js";

const dirs: string[] = [];
async function marker() {
  const dir = await mkdtemp(join(tmpdir(), "install-telemetry-"));
  dirs.push(dir);
  return join(dir, "telemetry", "first-answer.json");
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("install telemetry", () => {
  it("is on only in public images after the owner's telemetry Yes", () => {
    expect(installTelemetryEnabled({ SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_TELEMETRY_ENABLED: "true" })).toBe(true);
    expect(installTelemetryEnabled({ SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_TELEMETRY_ENABLED: "false" })).toBe(false);
    expect(installTelemetryEnabled({ SPACE_PUBLIC_DISTRIBUTION: "true" })).toBe(false);
    expect(installTelemetryEnabled({ SPACE_TELEMETRY_ENABLED: "true" })).toBe(false);
    expect(installTelemetryId({ SPACE_INSTALL_ID: "0d3c2a6e-1111-4222-8333-944455556666" })).toBe("0d3c2a6e-1111-4222-8333-944455556666");
    expect(installTelemetryId({ SPACE_INSTALL_ID: "bad id; x" })).toBeNull();
    expect(installTelemetryId({})).toBeNull();
  });

  it("names the browser family and major version only", () => {
    expect(browserFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe("chrome 141");
    expect(browserFromUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57")).toBe("edge 141");
    expect(browserFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0")).toBe("firefox 143");
    expect(browserFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15")).toBe("safari 18");
    expect(browserFromUserAgent("curl/8.0")).toBeUndefined();
  });

  it("sends only the event, version, architecture and date with a fresh random id", () => {
    const ping = buildInstallTelemetryPing({ event: "first_answer", version: "v1.1.4", arch: "x64", now: new Date("2026-10-20T10:00:00Z") })!;
    expect(ping).toMatchObject({ app: "spaceapp", event: "first_answer", os: "unknown", arch: "x64", version: "1.1.4", runtime: "1.1.4", install_date: "2026-10-20" });
    expect(Object.keys(ping).sort()).toEqual(["app", "arch", "event", "install_date", "os", "runtime", "uid", "version"]);
    expect(buildInstallTelemetryPing({ event: "first_answer", version: "v1.1.4", arch: "x64" })!.uid).not.toBe(ping.uid);
    expect(buildInstallTelemetryPing({ event: "first_answer", version: "not-a-version", arch: "x64" })).toBeNull();
  });

  it("adds the install id and only the optional fields that match the collector's patterns", () => {
    const ping = buildInstallTelemetryPing({
      event: "active", version: "1.1.5", arch: "arm64", installId: "0d3c2a6e-1111-4222-8333-944455556666",
      fields: { screen: "1920x1080", dpr: "1.5", browser: "chrome 141", lang: "el-GR", cli: "Open Code; x" }
    })!;
    expect(ping).toMatchObject({ event: "active", install_id: "0d3c2a6e-1111-4222-8333-944455556666", screen: "1920x1080", dpr: "1.5", browser: "chrome 141", lang: "el-GR" });
    expect(ping).not.toHaveProperty("cli");
  });

  it("reports once, records it in the data volume and never again", async () => {
    const markerFile = await marker();
    const send = vi.fn().mockResolvedValue(true);
    const reporter = createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile, version: "1.1.4", arch: "x64", send });
    reporter.observe();
    reporter.observe();
    await settle();
    reporter.observe();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(reporter.state()).toBe("done");
    expect(JSON.parse(await readFile(markerFile, "utf8")).sentAt).toBeTruthy();
    const afterRestart = createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile, version: "1.1.4", send });
    afterRestart.observe();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a failed send no more than every ten minutes and does nothing when off", async () => {
    let now = 0;
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
    const reporter = createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile: await marker(), version: "1.1.4", send, now: () => now });
    reporter.observe();
    await settle();
    reporter.observe();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    now += 10 * 60 * 1000;
    reporter.observe();
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(reporter.state()).toBe("done");

    const off = vi.fn();
    const disabled = createInstallTelemetryReporter({ enabled: false, event: "first_answer", markerFile: await marker(), version: "1.1.4", send: off });
    disabled.observe();
    await settle();
    expect(off).not.toHaveBeenCalled();
  });

  it("sends a daily event once a day and keeps a marker written before daily events counting as sent", async () => {
    let now = Date.parse("2026-10-20T10:00:00Z");
    const markerFile = await marker();
    const send = vi.fn().mockResolvedValue(true);
    const reporter = createInstallTelemetryReporter({ enabled: true, event: "active", daily: true, markerFile, version: "1.1.5", installId: "abcdefgh-1", send, now: () => now });
    reporter.observe({ screen: "1920x1080" });
    await settle();
    reporter.observe({ screen: "1920x1080" });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ event: "active", install_id: "abcdefgh-1", screen: "1920x1080", install_date: "2026-10-20" });
    now += 24 * 60 * 60 * 1000;
    reporter.observe();
    // The marker is written after send resolves; under load that takes longer than one settle (rc2 gates, 2026-10-20).
    await vi.waitFor(async () => {
      expect(send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(await readFile(markerFile, "utf8")).period).toBe("2026-10-21");
    });

    const legacy = await marker();
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify({ sentAt: "2026-10-13T00:00:00Z" }));
    const old = vi.fn().mockResolvedValue(true);
    createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile: legacy, version: "1.1.5", send: old }).observe();
    await settle();
    expect(old).not.toHaveBeenCalled();
  });

  it("enables only first_answer without the launcher's install id, and reports the first spawned CLI with it", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    try {
      const env = { SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_TELEMETRY_ENABLED: "true", SPACE_APP_VERSION: "1.1.6" };
      const legacy = createInstallTelemetry(env, dirname(await marker()));
      expect([legacy.firstAnswer.state(), legacy.setupCompleted.state(), legacy.active.state()]).toEqual(["unknown", "done", "done"]);
      const linked = createInstallTelemetry({ ...env, SPACE_INSTALL_ID: "abcdefgh-1" }, dirname(await marker()));
      linked.observeCliEvent({ reason: "SESSION_REFRESH", runtimeId: "cli:codex" });
      linked.observeCliEvent({ reason: "INITIAL_ATTACH", runtimeId: "cli:opencode" });
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ event: "first_cli", cli: "opencode", install_id: "abcdefgh-1", version: "1.1.6" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("sees the first finished answer on the server, without a dashboard read, and then stops", async () => {
    const send = vi.fn().mockResolvedValue(true);
    const reporter = createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile: await marker(), version: "1.1.7", arch: "x64", send });
    // The second room's agent finishes its answer on the third read; that read reports it, as readDashboardAgents does.
    let reads = 0;
    const readRoom = vi.fn(async (roomId: string) => {
      if (roomId === "room:b" && ++reads === 3) reporter.observe();
    });
    const watch = createFirstAnswerWatch({ reporter, rooms: async () => [{ id: "room:a" }, { id: "room:b" }], readRoom, intervalMs: 5 });
    await watch.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await reporter.pending()).toBe(false));
    const callsWhenSent = readRoom.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readRoom.mock.calls.length).toBeLessThanOrEqual(callsWhenSent + 2);
    const settled = readRoom.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readRoom.mock.calls.length).toBe(settled);
    expect(send.mock.calls[0]![0]).toMatchObject({ event: "first_answer", version: "1.1.7" });
    watch.stop();
  });

  it("never reads rooms when telemetry is off or first_answer was sent before a restart", async () => {
    const readRoom = vi.fn();
    const off = createInstallTelemetryReporter({ enabled: false, event: "first_answer", markerFile: await marker(), version: "1.1.7" });
    const offWatch = createFirstAnswerWatch({ reporter: off, rooms: async () => [{ id: "room:a" }], readRoom, intervalMs: 1 });
    await offWatch.start();
    const markerFile = await marker();
    await mkdir(dirname(markerFile), { recursive: true });
    await writeFile(markerFile, `${JSON.stringify({ sentAt: "2026-10-18T00:00:00.000Z", period: "once" })}\n`);
    const sent = createInstallTelemetryReporter({ enabled: true, event: "first_answer", markerFile, version: "1.1.7" });
    expect(await sent.pending()).toBe(false);
    const sentWatch = createFirstAnswerWatch({ reporter: sent, rooms: async () => [{ id: "room:a" }], readRoom, intervalMs: 1 });
    await sentWatch.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readRoom).not.toHaveBeenCalled();
    offWatch.stop();
    sentWatch.stop();
  });
});
