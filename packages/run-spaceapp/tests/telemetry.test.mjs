import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInstallPing,
  createInstallFunnel,
  describeOsVersion,
  installFunnelFacts,
  isInstallPingAllowed,
  normalizeOs,
  sendInstallPing,
  telemetryEnvPreference
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
    launcherVersion: "0.1.17",
    runtimeVersion: "0.1.17",
    now: new Date("2026-08-05T12:34:56Z")
  });
  assert.equal(ping.app, "spaceapp");
  assert.match(ping.uid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(ping.os, "macos");
  assert.equal(ping.arch, "arm64");
  assert.equal(ping.version, "0.1.17");
  assert.equal(ping.runtime, "0.1.17");
  assert.equal(ping.install_date, "2026-08-05");
});

test("SPACEAPP_TELEMETRY is an explicit preference or unset", () => {
  assert.equal(telemetryEnvPreference({}), null);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "" }), null);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "maybe" }), null);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "0" }), false);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "false" }), false);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "OFF" }), false);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: "1" }), true);
  assert.equal(telemetryEnvPreference({ SPACEAPP_TELEMETRY: " Yes " }), true);
});

test("the install ping needs consent; an explicit environment choice wins", () => {
  assert.equal(isInstallPingAllowed({ consent: true, env: {} }), true);
  assert.equal(isInstallPingAllowed({ consent: false, env: {} }), false);
  assert.equal(isInstallPingAllowed({ consent: undefined, env: {} }), false);
  assert.equal(isInstallPingAllowed({ consent: true, env: { SPACEAPP_TELEMETRY: "0" } }), false);
  assert.equal(isInstallPingAllowed({ consent: false, env: { SPACEAPP_TELEMETRY: "1" } }), true);
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
    version: "0.1.17",
    runtime: "0.1.17",
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

test("describeOsVersion names the distribution, macOS or Windows version with safe characters only", () => {
  assert.equal(describeOsVersion("linux", { readOsRelease: () => 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n' }), "ubuntu 24.04");
  assert.equal(describeOsVersion("linux", { osRelease: "6.12.95+deb13-amd64", readOsRelease: () => { throw new Error("none"); } }), "linux 6.12.95+deb13-amd64");
  assert.equal(describeOsVersion("darwin", { osRelease: "24.1.0" }), "macOS 15.1");
  assert.equal(describeOsVersion("win32", { osRelease: "10.0.26100" }), "Windows 11 (10.0.26100)");
  assert.equal(describeOsVersion("win32", { osRelease: "10.0.19045" }), "Windows 10 (10.0.19045)");
  assert.equal(describeOsVersion("linux", { readOsRelease: () => 'ID="evil;rm"\nVERSION_ID="1/2"' }), "evilrm 12");
});

test("the install funnel links its events by install id and sends the facts only with install_started", async () => {
  const bodies = [];
  const request = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  let now = 1_000;
  const facts = installFunnelFacts({ platform: "linux", resources: { cpuCount: 8, totalMemoryBytes: 16 * 2 ** 30 }, profile: "light", accessMode: "isolated" },
    { readOsRelease: () => "ID=debian\nVERSION_ID=13" });
  assert.deepEqual(facts, { os_version: "debian 13", cpus: 8, ram_gb: 16, profile: "light", access: "isolated" });
  assert.equal(installFunnelFacts({ platform: "linux", resources: { cpuCount: 0 } }).cpus, undefined);
  const report = createInstallFunnel({ installId: "abcdefgh-1234", platform: "linux", arch: "x64", launcherVersion: "1.1.6", runtimeVersion: "1.1.6", facts, request, now: () => now });
  assert.equal(await report("install_started"), true);
  now += 95_400;
  assert.equal(await report("install_failed", { stage: "pull" }), true);
  assert.deepEqual(bodies.map((body) => [body.event, body.install_id, body.cpus, body.stage, body.duration_s]),
    [["install_started", "abcdefgh-1234", 8, undefined, undefined], ["install_failed", "abcdefgh-1234", undefined, "pull", 95]]);
  assert.notEqual(bodies[0].uid, bodies[1].uid);
  const offline = createInstallFunnel({ installId: "abcdefgh-1234", platform: "linux", request: async () => { throw new Error("offline"); } });
  assert.equal(await offline("install_completed"), false);
});
