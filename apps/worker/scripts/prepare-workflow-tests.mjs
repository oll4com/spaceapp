import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run this script through npm.");
// The Temporal bundler follows package exports, outside Vitest's source aliases.
for (const name of ["contracts", "streaming", "opencode-control", "memory-graph", "codex-app-server", "runtime", "db"]) {
  const result = spawnSync(process.execPath, [npm, "run", "build", "-w", `@space/${name}`], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
