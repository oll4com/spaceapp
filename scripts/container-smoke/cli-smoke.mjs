#!/usr/bin/env node
// CLI image smoke check (#64): the image starts the CLI host and accepts a
// framed ping on its pane-host socket.
// Usage: node scripts/container-smoke/cli-smoke.mjs <image>
// Environment: SMOKE_TIMEOUT_MS (default 120000).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const containerName = "spaceapp-smoke-cli";
const socketPath = "/run/space-codex-pane-host/pane-host.sock";

function sh(args, options = {}) {
  // "input" only reaches the child when stdin is a pipe: with stdio[0]
  // forced to "ignore", a piped program (docker exec -i node) reads EOF.
  return execFileSync(args[0], args.slice(1), { stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"], encoding: "utf8", ...options });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const image = process.argv[2];
  if (!image) {
    throw new Error("Usage: node scripts/container-smoke/cli-smoke.mjs <image>");
  }
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
  const socketDir = mkdtempSync(join(tmpdir(), "spaceapp-smoke-cli-socket-"));
  // The pane host runs as the image's spaceapp user (uid 10001); a bind-mounted
  // host directory is owned by whoever runs the smoke, so make it writable.
  chmodSync(socketDir, 0o777);
  try {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    sh(["docker", "run", "-d", "--name", containerName,
      "-v", `${socketDir}:/run/space-codex-pane-host`,
      image]);
    const deadline = Date.now() + timeoutMs;
    let socketUp = false;
    while (Date.now() < deadline) {
      await sleep(1_000);
      try {
        sh(["docker", "exec", containerName, "test", "-S", socketPath]);
        socketUp = true;
        break;
      } catch {}
    }
    if (!socketUp) {
      let logs = "";
      try {
        // Merge stderr: a crashed entrypoint reports on stderr, stdout alone stays empty.
        logs = sh(["bash", "-c", `docker logs --tail 60 ${containerName} 2>&1`]);
      } catch {}
      throw new Error(`CLI smoke failed: pane host socket did not appear\nContainer logs:\n${logs}`);
    }
    const pingScript = "const net = require(\"node:net\");\nconst socket = net.createConnection(\"/run/space-codex-pane-host/pane-host.sock\");\nconst payload = Buffer.from(JSON.stringify({ kind: \"request\", requestId: \"smoke-ping\", method: \"ping\", params: {} }), \"utf8\");\nconst frame = Buffer.allocUnsafe(4 + payload.length);\nframe.writeUInt32BE(payload.length, 0);\npayload.copy(frame, 4);\nlet buffer = Buffer.alloc(0);\nconst timeout = setTimeout(() => { console.error(\"SMOKE-TIMEOUT\"); process.exit(1); }, 20000);\nsocket.on(\"connect\", () => socket.write(frame));\nsocket.on(\"data\", (chunk) => {\n  buffer = Buffer.concat([buffer, chunk]);\n  if (buffer.length < 4) return;\n  const length = buffer.readUInt32BE(0);\n  if (buffer.length < 4 + length) return;\n  const value = JSON.parse(buffer.subarray(4, 4 + length).toString(\"utf8\"));\n  if (value.kind === \"response\" && value.requestId === \"smoke-ping\") {\n    if (value.ok !== true) { console.error(\"SMOKE-ERROR \" + JSON.stringify(value.error)); process.exit(1); }\n    console.log(\"SMOKE-OK\");\n    clearTimeout(timeout);\n    socket.end();\n    process.exit(0);\n  }\n});\nsocket.on(\"error\", (error) => { console.error(\"SMOKE-SOCKET-ERROR \" + error.message); process.exit(1); });";
    const output = sh(["docker", "exec", "-i", containerName, "node"], { input: pingScript });
    if (!output.includes("SMOKE-OK")) {
      throw new Error(`CLI smoke failed: ping response was not ok\n${output}`);
    }
    process.stdout.write("cli smoke: pane host accepted a framed ping\n");
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    // Best effort: the pane host owns the bind-mounted socket directory and may
    // retighten its permissions, so an unremovable temp directory must not fail
    // an otherwise passed smoke check.
    try { rmSync(socketDir, { recursive: true, force: true }); } catch {}
  }
}

await main();
