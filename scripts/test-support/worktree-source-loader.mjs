// Preload for a Space process that an integration test starts from this checkout:
//   node --import scripts/test-support/worktree-source-loader.mjs <entry>.ts
// TypeScript runs through tsx, and every @space/<name> import resolves to
// packages/<name>/src/index.ts of this checkout, never to a shared
// node_modules link or a built dist. The entry point itself is unchanged.
// SPACE_TEST_RESOLVE_LOG, when set, receives one JSON line per redirected import.
import { register } from "node:module";
import { register as registerTsx } from "tsx/esm/api";

registerTsx();
// Registered after tsx, so these hooks run first and hand .ts files to tsx.
register("./worktree-source-hooks.mjs", import.meta.url, {
  data: { resolveLog: process.env.SPACE_TEST_RESOLVE_LOG ?? null }
});
