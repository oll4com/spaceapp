import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInstallTelemetryRoutes, summarizeInstallPings } from "../src/install-telemetry-routes.js";

const base = { app: "spaceapp", arch: "x64", version: "1.1.5", runtime: "1.1.5", install_date: "2026-10-20" };
const line = (t: string, fields: Record<string, unknown>) => JSON.stringify({ t, uid: `uid-${t}`, ...base, ...fields });
const linked = "a1b2c3d4-0000-4000-8000-000000000001";
const log = [
  line("2026-10-14T06:10:24Z", { os: "windows", version: "1.1.3", runtime: "1.1.3", event: "install" }),
  line("2026-10-20T10:00:00Z", { os: "linux", event: "install_started", install_id: linked, os_version: "Ubuntu 24.04", cpus: 8, ram_gb: 16, profile: "light", country: "GR" }),
  line("2026-10-20T10:04:00Z", { os: "linux", event: "install_completed", install_id: linked, duration_s: 240, country: "GR" }),
  line("2026-10-20T10:06:00Z", { os: "unknown", event: "setup_completed", install_id: linked }),
  line("2026-10-20T10:07:00Z", { os: "unknown", event: "active", install_id: linked, screen: "1920x1080", browser: "chrome 141", lang: "el-GR" }),
  line("2026-10-20T10:08:00Z", { os: "unknown", event: "first_cli", install_id: linked, cli: "opencode" }),
  line("2026-10-20T10:09:00Z", { os: "unknown", event: "first_answer", install_id: linked }),
  line("2026-10-21T09:00:00Z", { os: "unknown", event: "active", install_id: linked, version: "1.1.6", screen: "2560x1440" }),
  line("2026-10-21T11:00:00Z", { os: "macos", event: "install_failed", install_id: "b1b2c3d4-0000-4000-8000-000000000002", stage: "pull", duration_s: 30 }),
  line("2026-10-21T12:00:00Z", { os: "unknown", event: "first_answer" }),
  line("2026-10-21T13:00:00Z", { os: "macos", event: "install", internal: true }),
  line("2026-10-21T13:05:00Z", { os: "unknown", event: "first_answer", internal: true }),
  "not json",
  ""
].join("\n");

describe("install pings summary", () => {
  it("links an installation's funnel by install id and keeps older single pings as their own rows", () => {
    const result = summarizeInstallPings(log, Date.parse("2026-10-22T00:00:00Z"));
    expect(result.summary).toEqual({ installs: 3, completed: 2, failed: 1, setupCompleted: 1, firstCli: 1, firstAnswer: 2, active7d: 1, internal: 1 });
    const [lab, failed, funnel, legacy] = result.installs;
    expect(lab).toMatchObject({ internal: true, os: "macos", status: "COMPLETED" });
    expect(failed).toMatchObject({ status: "FAILED", failedStage: "pull", durationSeconds: 30, os: "macos" });
    expect(funnel).toMatchObject({
      installId: linked, linked: true, status: "COMPLETED", durationSeconds: 240, country: "GR", os: "linux", osVersion: "Ubuntu 24.04",
      cpus: 8, ramGb: 16, profile: "light", version: "1.1.6", screen: "2560x1440", browser: "chrome 141", lang: "el-GR",
      firstCli: "opencode", setupCompletedAt: "2026-10-20T10:06:00Z", firstAnswerAt: "2026-10-20T10:09:00Z",
      lastActiveAt: "2026-10-21T09:00:00Z", activeDays: 2
    });
    expect(legacy).toMatchObject({ linked: false, internal: false, status: "COMPLETED", os: "windows", version: "1.1.3", country: null });
  });
});

describe("install telemetry routes", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function appFor(role: string, installPingsPath: string) {
    const onActive = vi.fn();
    const app = Fastify();
    app.addHook("preHandler", async (request) => { (request as { user?: unknown }).user = { id: "user:1", role }; });
    registerInstallTelemetryRoutes(app, { onActive, installPingsPath });
    await app.ready();
    return { app, onActive };
  }

  it("forwards the browser's screen and language with the browser named from its User-Agent", async () => {
    const { app, onActive } = await appFor("OPERATOR", "/nonexistent");
    const ok = await app.inject({
      method: "POST", url: "/api/telemetry/active",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36" },
      payload: { screen: "1920x1080", dpr: "1.5", lang: "el-GR" }
    });
    expect(ok.statusCode).toBe(204);
    expect(onActive).toHaveBeenCalledWith({ screen: "1920x1080", dpr: "1.5", lang: "el-GR", browser: "chrome 141" });
    const bad = await app.inject({ method: "POST", url: "/api/telemetry/active", payload: { screen: "1920x1080", note: "hello" } });
    expect(bad.statusCode).not.toBe(204);
    expect(onActive).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("shows the installs to ADMIN only and reports when this server has no pings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "install-pings-"));
    dirs.push(dir);
    const path = join(dir, "install-pings.log");
    await writeFile(path, log);
    const operator = await appFor("OPERATOR", path);
    expect((await operator.app.inject({ method: "GET", url: "/api/admin/system-analytics/installs" })).statusCode).toBe(403);
    await operator.app.close();
    const admin = await appFor("ADMIN", path);
    const body = (await admin.app.inject({ method: "GET", url: "/api/admin/system-analytics/installs" })).json();
    expect(body).toMatchObject({ available: true, summary: { installs: 3 } });
    await admin.app.close();
    const empty = await appFor("ADMIN", join(dir, "missing.log"));
    expect((await empty.app.inject({ method: "GET", url: "/api/admin/system-analytics/installs" })).json()).toMatchObject({ available: false, installs: [] });
    await empty.app.close();
  });
});
