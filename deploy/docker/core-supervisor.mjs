import { spawn } from "node:child_process";
import process from "node:process";
import { childProcessEnv } from "../../packages/runtime/dist/child-process-env.js";

// The web proxy reads no Space credential, so it starts without them (INT5-C-F5); the api needs them, the worker only
// the database URL (EXT-C-F8), never the pane bridge's signing secret (1.2.0).
const { SPACE_SESSION_SECRET: _sessionSecret, SPACE_AGENT_TOKEN_SECRET: _agentTokenSecret, ...workerEnv } = process.env;
const services = [
  ["api", "apps/api/dist/server.js", process.env],
  ...(process.env.SPACEAPP_WORKFLOWS_ENABLED === "false" ? [] : [["worker", "apps/worker/dist/worker.js", workerEnv]]),
  ["web", "apps/web/server.mjs", childProcessEnv()]
];
const children = new Map();
let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    child.kill(signal);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => stop(signal));
}

for (const [name, entrypoint, env] of services) {
  const child = spawn(process.execPath, [entrypoint], {
    env,
    stdio: "inherit"
  });
  children.set(name, child);
  child.once("error", (error) => {
    process.stderr.write(`spaceapp ${name} failed to start: ${error.message}\n`);
    process.exitCode = 1;
    stop();
  });
  child.once("exit", (code, signal) => {
    children.delete(name);
    if (!stopping) {
      process.stderr.write(`spaceapp ${name} exited unexpectedly (${code ?? signal}).\n`);
      process.exitCode = code || 1;
      stop();
    }
    if (children.size === 0) {
      process.exit(process.exitCode || 0);
    }
  });
}
