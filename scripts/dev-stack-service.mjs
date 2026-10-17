import { spawn } from "node:child_process";
import { join } from "node:path";

const [role, root] = process.argv.slice(2);
const commands = {
  api: ["--watch", "--import", "tsx", "apps/api/src/server.ts"],
  worker: ["--watch", "apps/worker/dist/worker.js"],
  cli: ["--watch", "packages/cli-host/dist/main.js"],
  web: [join(root, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--strictPort"]
};
if (!commands[role] || !process.send) throw new Error("Dev-stack services must be started by their supervisor.");
const child = spawn(process.execPath, commands[role], { cwd: role === "web" ? join(root, "apps/web") : root, env: process.env, stdio: "inherit" });
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  // The supervisor created this dedicated process group. Also reaches the
  // watch-mode child; never uses an installed service's PID or name.
  process.kill(-process.pid, "SIGTERM");
  setTimeout(() => process.kill(-process.pid, "SIGKILL"), 5000).unref();
}
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("disconnect", stop);
child.on("error", error => { console.error(`${role} could not start: ${error.message}`); process.exit(1); });
child.on("exit", (code, signal) => { process.exit(closing ? 0 : code || (signal ? 1 : 0)); });
