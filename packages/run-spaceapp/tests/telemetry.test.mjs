import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallPing,
  isTelemetryEnabled,
  normalizeOs,
  reportFirstInstallPing,
  sendInstallPing
} from "../src/telemetry.mjs";

test("normalizeOs maps Node platform names to launcher names", () => {
  assert.equal(normalizeOs("win32"), "windows");
  assert.equal(normalizeOs("darwin"), "macos");
  assert.equal(normalizeOs("linux"), "linux");
  assert.equal(normalizeOs("freebsd"), "freebsd");
  assert.equal(normalizeOs(undefined), "other");
});

test("buildInstallPing carries os, version, runtime, and install date", () => {
  const ping = buildInstallPing({
    platform: "darwin",
    arch: "arm64",
    launcherVersion: "0.1.15",
    runtimeVersion: "0.1.15",
    now: new Date("2026-08-05T12:34:56Z")
  });
  assert.equal(ping.app, "spaceapp");
  assert.match(ping.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(ping.os, "macos");
  assert.equal(ping.arch, "arm64");
  assert.equal(ping.version, "0.1.15");
  assert.equal(ping.runtime, "0.1.15");
  assert.equal(ping.install_date, "2026-08-05");
});

test("telemetry is on by default and opt-out via SPACEAPP_TELEMETRY", () => {
  assert.equal(isTelemetryEnabled({}), true);
  assert.equal(isTelemetryEnabled({ SPACEAPP_TELEMETRY: "" }), true);
  assert.equal(isTelemetryEnabled({ SPACEAPP_TELEMETRY: "0" }), false);
  assert.equal(isTelemetryEnabled({ SPACEAPP_TELEMETRY: "false" }), false);
  assert.equal(isTelemetryEnabled({ SPACEAPP_TELEMETRY: "OFF" }), false);
  assert.equal(isTelemetryEnabled({ SPACEAPP_TELEMETRY: "1" }), true);
});

test("sendInstallPing POSTs JSON and accepts a 204", async () => {
  const calls = [];
  const fakeRequest = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 204 };
  };
  const payload = {
    app: "spaceapp",
    uid: "00000000-0000-4000-8000-000000000000",
    os: "linux",
    arch: "x64",
    version: "0.1.15",
    runtime: "0.1.15",
    install_date: "2026-08-05"
  };
  const sent = await sendInstallPing(payload, { request: fakeRequest });
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://spaceapp.dev/install-ping.php");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
});

test("sendInstallPing rejects non-2xx responses", async () => {
  const fakeRequest = async () => ({ ok: false, status: 429 });
  await assert.rejects(
    sendInstallPing({}, { request: fakeRequest }),
    /HTTP 429/
  );
});

test("sendInstallPing returns false when no request implementation exists", async () => {
  const sent = await sendInstallPing({}, { request: null });
  assert.equal(sent, false);
});

test("reportFirstInstallPing only pings fresh installs with telemetry on", async () => {
  const calls = [];
  const fakeRequest = async () => {
    calls.push(1);
    return { ok: true, status: 204 };
  };
  const base = {
    env: {},
    platform: "linux",
    arch: "x64",
    launcherVersion: "0.1.15",
    runtimeVersion: "0.1.15"
  };
  const fresh = await reportFirstInstallPing(base, { request: fakeRequest });
  assert.ok(fresh);
  assert.equal(calls.length, 1);

  const reinstall = await reportFirstInstallPing(
    { ...base, existingConfig: { version: "0.1.14" } },
    { request: fakeRequest }
  );
  assert.equal(reinstall, null);
  assert.equal(calls.length, 1);

  const optedOut = await reportFirstInstallPing(
    { ...base, env: { SPACEAPP_TELEMETRY: "0" } },
    { request: fakeRequest }
  );
  assert.equal(optedOut, null);
  assert.equal(calls.length, 1);
});
