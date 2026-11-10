import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { optedOut, track } from "./telemetry.mjs";

// optedOut() reads ~/.hyperframes/config.json and env vars. Point HOME at a temp
// dir so the run never touches the real config, and pin the env opt-outs to a
// neutral state; restore both afterwards.
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HYPERFRAMES_NO_TELEMETRY",
  "DO_NOT_TRACK",
  "CI",
  "NODE_ENV",
  "MEDIA_USE_POSTHOG_KEY",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const home = mkdtempSync(join(tmpdir(), "mu-telemetry-"));
const configPath = join(home, ".hyperframes", "config.json");

function writeConfig(contents) {
  if (contents === null) {
    rmSync(configPath, { force: true });
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, contents);
  }
}

test.before(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = process.env.USERPROFILE = home;
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

test("optedOut is false with no config and no opt-out env", () => {
  writeConfig(null);
  assert.equal(optedOut(), false);
});

test("optedOut honors telemetryEnabled: false from the shared config", () => {
  writeConfig(JSON.stringify({ telemetryEnabled: false }));
  assert.equal(optedOut(), true);
});

test("optedOut is false when the shared config enables telemetry", () => {
  writeConfig(JSON.stringify({ telemetryEnabled: true }));
  assert.equal(optedOut(), false);
});

test("optedOut treats an unreadable shared config as no opt-out", () => {
  writeConfig("{not json");
  assert.equal(optedOut(), false);
});

test("optedOut still honors the env opt-outs", () => {
  writeConfig(JSON.stringify({ telemetryEnabled: true }));
  process.env.DO_NOT_TRACK = "1";
  try {
    assert.equal(optedOut(), true);
  } finally {
    delete process.env.DO_NOT_TRACK;
  }
});

// Space: no PostHog project key ships, so track() sends nothing unless MEDIA_USE_POSTHOG_KEY names one.
test("track sends nothing without MEDIA_USE_POSTHOG_KEY and posts to the named project with it", async () => {
  writeConfig(null);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}"); };
  try {
    await track("media_resolved", { kind: "image" });
    assert.equal(calls.length, 0);
    process.env.MEDIA_USE_POSTHOG_KEY = "phc_test";
    await track("media_resolved", { kind: "image" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.api_key, "phc_test");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.MEDIA_USE_POSTHOG_KEY;
  }
});
