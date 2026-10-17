#!/usr/bin/env node
// This host-only wrapper intentionally supports OpenCode alone. It never reads
// the user's provider home or runs a paid model probe to open a terminal UI.
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [state, ...input] = process.argv.slice(2);
const args = input[0] === "--run-inner" ? input.slice(1) : input;
const tool = join(state, "tools", "node_modules", ".bin", "opencode");
const home = join(state, "data", "providers", "opencode");
const env = {};
for (const key of ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "USER", "LOGNAME", "SPACE_CLI_WORKSPACE", "SPACE_ROOM_ID", "SPACE_PANE_ID", "SPACE_CLI_SESSION_ID"]) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  HOME: home, TMPDIR: join(home, "tmp"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true"
});
for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) mkdirSync(path, { recursive: true, mode: 0o700 });

switch (args[0]) {
  case "credential-status":
    console.log(existsSync(tool) ? "READY" : "NOT_READY");
    process.exitCode = existsSync(tool) ? 0 : 1;
    break;
  case "credential-observation":
    // No provider inference has been verified by this local UI wrapper.
    process.exitCode = 1;
    break;
  case "credential-smoke":
    console.error("The source stack does not probe external AI models. Open the OpenCode UI to configure a provider.");
    process.exitCode = 1;
    break;
  case "inspect-env":
    console.log("runtime=opencode\nhome=isolated\ncredential=not-probed");
    break;
  default: {
    const child = spawn(tool, args, { env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => child.kill(signal));
    child.once("error", (error) => { console.error(`OpenCode could not start: ${error.message}`); process.exitCode = 1; });
    child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  }
}
