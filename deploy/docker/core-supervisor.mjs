import { spawn } from "node:child_process";
import process from "node:process";

const services = [
  ["api", "apps/api/dist/server.js"],
  ["worker", "apps/worker/dist/worker.js"],
  ["web", "apps/web/server.mjs"]
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

for (const [name, entrypoint] of services) {
  const child = spawn(process.execPath, [entrypoint], {
    env: process.env,
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
