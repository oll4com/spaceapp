// Second preload for the worker under scripts/test-support/worktree-source-loader.mjs:
//   node --import <source loader> --import <this file> apps/worker/src/worker.ts
// Only apps/worker/src/worker.ts gets the bundler-aware @temporalio/worker
// wrapper (worktree-temporal-worker.mjs); every other import is unchanged.
import { register } from "node:module";

register("./worktree-temporal-worker-hooks.mjs", import.meta.url, {
  data: { resolveLog: process.env.SPACE_TEST_RESOLVE_LOG ?? null }
});
