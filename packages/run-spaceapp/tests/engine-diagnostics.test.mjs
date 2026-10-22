import assert from "node:assert/strict";
import test from "node:test";
import { rootlessStatus } from "../src/engine-diagnostics.mjs";

test("engine-specific rootless booleans take priority over Docker options", () => {
  assert.equal(rootlessStatus({ host: { security: { rootless: true } }, SecurityOptions: [] }), true);
  assert.equal(rootlessStatus({ host: { security: { rootless: false } }, SecurityOptions: ["name=rootless"] }), false);
});

test("Docker SecurityOptions recognizes name=rootless", () => {
  assert.equal(rootlessStatus({ SecurityOptions: ["name=seccomp,profile=default", "name=rootless"] }), true);
});

test("available SecurityOptions without rootless reports false; missing data remains unknown", () => {
  assert.equal(rootlessStatus({ SecurityOptions: ["name=seccomp"] }), false);
  assert.equal(rootlessStatus({}), null);
  assert.equal(rootlessStatus({ SecurityOptions: "name=rootless" }), null);
});

test("Podman rootless diagnostics remain available", () => {
  assert.equal(rootlessStatus({ host: { security: { rootless: true } } }), true);
});
