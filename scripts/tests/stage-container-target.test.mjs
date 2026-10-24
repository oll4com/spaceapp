import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { computeTargetDependencyClosure } from "../stage-container-target.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("cli target closure includes only @space/cli-host and node-pty", async () => {
  const closure = await computeTargetDependencyClosure(root, "cli");
  assert.deepEqual(closure.workspaces, ["packages/cli-host"]);
  assert.ok(closure.nodeModulePaths.includes("node_modules/node-pty"));
  assert.ok(!closure.nodeModulePaths.some((p) => p.includes("@temporalio") || p.includes("pdfjs-dist") || p.includes("fastify")));
});

test("browser target closure includes Browser Host runtime deps and excludes Temporal, PDF, web, and node-pty", async () => {
  const closure = await computeTargetDependencyClosure(root, "browser");
  assert.ok(closure.workspaces.includes("apps/api"));
  assert.ok(closure.workspaces.includes("packages/browser-host"));
  assert.ok(closure.workspaces.includes("packages/db"));
  assert.ok(!closure.workspaces.includes("apps/web"));
  assert.ok(!closure.workspaces.includes("apps/worker"));
  assert.ok(closure.nodeModulePaths.includes("node_modules/pg"));
  assert.ok(closure.nodeModulePaths.includes("node_modules/zod"));
  assert.ok(!closure.nodeModulePaths.some((p) => p.includes("@temporalio") || p.includes("pdfjs-dist") || p.includes("@napi-rs/canvas") || p.includes("node-pty")));
});

test("core target closure includes API, worker, and DB deps while excluding node-pty and web client-only deps", async () => {
  const closure = await computeTargetDependencyClosure(root, "core");
  assert.ok(closure.workspaces.includes("apps/api"));
  assert.ok(closure.workspaces.includes("apps/worker"));
  assert.ok(closure.workspaces.includes("apps/web"));
  assert.ok(closure.nodeModulePaths.includes("node_modules/fastify"));
  assert.ok(closure.nodeModulePaths.includes("node_modules/@temporalio/worker"));
  assert.ok(closure.nodeModulePaths.includes("node_modules/pdfjs-dist"));
  assert.ok(!closure.nodeModulePaths.includes("node_modules/node-pty"));
  assert.ok(!closure.nodeModulePaths.includes("node_modules/react"));
  assert.ok(!closure.nodeModulePaths.includes("node_modules/sigma"));
});
