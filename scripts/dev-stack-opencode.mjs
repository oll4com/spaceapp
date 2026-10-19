#!/usr/bin/env node
// Copied into the state directory; provider data never uses the user's home.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const state = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(state, "config.json"), "utf8"));
if (config.state !== state || config.version !== 1) throw new Error("Invalid dev-stack provider state.");
const binary = join(state, "vendor", "node_modules", ".bin", "opencode");
await stat(binary);
const args = process.argv.slice(2);
if (args[0] === "--run-inner") args.shift();
if (args[0] === "credential-status") { console.log("READY"); process.exit(0); }
if (args[0] === "credential-observation") { console.log(`OBSERVATION:${createHash("sha256").update(`opencode:${config.opencode}`).digest("hex")}`); process.exit(0); }
const providerHome = join(state, "providers", "opencode");
const env = {
  PATH: process.env.PATH, TERM: process.env.TERM || "xterm-256color", COLORTERM: "truecolor", LANG: process.env.LANG || "en_US.UTF-8",
  HOME: providerHome, TMPDIR: join(providerHome, "tmp"), XDG_CONFIG_HOME: join(providerHome, "config"), XDG_DATA_HOME: join(providerHome, "data"), XDG_CACHE_HOME: join(providerHome, "cache"), XDG_STATE_HOME: join(providerHome, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "true"
};
for (const path of [providerHome, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) await mkdir(path, { recursive: true, mode: 0o700 });
const smoke = args[0] === "credential-smoke";
const child = spawn(binary, smoke ? ["--version"] : args, { env, cwd: process.cwd(), stdio: smoke ? ["ignore", "ignore", "inherit"] : "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(`OpenCode could not start: ${error.message}`); process.exit(1); });
child.on("exit", (code, signal) => {
  if (smoke && code === 0) console.log("SPACE_OPENCODE_OK");
  process.exit(code ?? (signal ? 1 : 0));
});
