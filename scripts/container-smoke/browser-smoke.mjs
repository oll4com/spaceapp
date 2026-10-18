#!/usr/bin/env node
// Browser image smoke check (#64): the image runs the database migrations,
// starts the Browser Host, answers a framed health ping on its socket and
// launches headless Chromium once.
// Usage: node scripts/container-smoke/browser-smoke.mjs <image>
// Environment: SMOKE_DATABASE_URL (default spaceapp user on 127.0.0.1:5432),
// SMOKE_TIMEOUT_MS (default 240000),
// SMOKE_SKIP_CHROMIUM_LAUNCH ("true": assert the shipped Chromium binary is
// present and executable instead of launching it - used for arm64 jobs
// emulated under QEMU, where Chromium crashes during startup).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const containerName = "spaceapp-smoke-browser";
const socketPath = "/run/spaceapp-browser/browser-host.sock";

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
    throw new Error("Usage: node scripts/container-smoke/browser-smoke.mjs <image>");
  }
  const databaseUrl = process.env.SMOKE_DATABASE_URL ?? "postgres://spaceapp:spaceapp@127.0.0.1:5432/spaceapp";
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 240_000);
  const secrets = mkdtempSync(join(tmpdir(), "spaceapp-smoke-browser-secrets-"));
  const socketDir = mkdtempSync(join(tmpdir(), "spaceapp-smoke-browser-socket-"));
  // The Browser Host runs as the image's spaceapp user (uid 10001); a bind-mounted
  // host directory is owned by whoever runs the smoke, so make it writable.
  chmodSync(socketDir, 0o777);
  try {
    writeFileSync(join(secrets, "database-url"), databaseUrl);
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    // Migrations first: the Browser Host opens the store when it starts.
    // migrate.js resolves its database URL from the environment only.
    sh(["docker", "run", "--rm", "--network", "host",
      "-v", `${secrets}:/run/secrets:ro`,
      "-e", `SPACE_DATABASE_URL=${databaseUrl}`,
      "--entrypoint", "node",
      image, "packages/db/dist/migrate.js"]);
    sh(["docker", "run", "-d", "--name", containerName, "--network", "host",
      "-v", `${secrets}:/run/secrets:ro`,
      "-v", `${socketDir}:/run/spaceapp-browser`,
      "-e", "SPACE_PUBLIC_DISTRIBUTION=true",
      "-e", "SPACE_RUNTIME_STORE=postgres",
      "-e", "SPACE_ARTIFACT_ROOT=/var/lib/spaceapp/artifacts",
      "-e", "SPACE_BROWSER_SESSIONS_ENABLED=true",
      "-e", `SPACE_BROWSER_HOST_SOCKET=${socketPath}`,
      "-e", "SPACE_BROWSER_SESSIONS_DEFAULT_URL=about:blank",
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
      throw new Error(`Browser smoke failed: Browser Host socket did not appear\nContainer logs:\n${logs}`);
    }
    const healthScript = "const net = require(\"node:net\");\nconst socket = net.createConnection(\"/run/spaceapp-browser/browser-host.sock\");\nconst payload = Buffer.from(JSON.stringify({ kind: \"request\", requestId: \"smoke-health\", method: \"health\", params: {} }), \"utf8\");\nconst frame = Buffer.allocUnsafe(4 + payload.length);\nframe.writeUInt32BE(payload.length, 0);\npayload.copy(frame, 4);\nlet buffer = Buffer.alloc(0);\nconst timeout = setTimeout(() => { console.error(\"SMOKE-TIMEOUT\"); process.exit(1); }, 20000);\nsocket.on(\"connect\", () => socket.write(frame));\nsocket.on(\"data\", (chunk) => {\n  buffer = Buffer.concat([buffer, chunk]);\n  if (buffer.length < 4) return;\n  const length = buffer.readUInt32BE(0);\n  if (buffer.length < 4 + length) return;\n  const value = JSON.parse(buffer.subarray(4, 4 + length).toString(\"utf8\"));\n  if (value.kind === \"response\" && value.requestId === \"smoke-health\") {\n    if (value.ok !== true) { console.error(\"SMOKE-ERROR \" + JSON.stringify(value.error)); process.exit(1); }\n    console.log(\"SMOKE-OK\");\n    clearTimeout(timeout);\n    socket.end();\n    process.exit(0);\n  }\n});\nsocket.on(\"error\", (error) => { console.error(\"SMOKE-SOCKET-ERROR \" + error.message); process.exit(1); });";
    const healthOutput = sh(["docker", "exec", "-i", containerName, "node"], { input: healthScript });
    if (!healthOutput.includes("SMOKE-OK")) {
      throw new Error(`Browser smoke failed: health response was not ok\n${healthOutput}`);
    }
    // Headless Chromium once: proves the shipped browser binary starts in
    // this image (same user, same paths the Browser Host uses). Under QEMU
    // user-mode emulation (arm64 job on an amd64 runner) Chromium dies
    // during startup with SIGTRAP (crashpad prctl fails), which reflects
    // the emulator, not the image, so SMOKE_SKIP_CHROMIUM_LAUNCH=true only
    // asserts the binary is present and executable.
    if (process.env.SMOKE_SKIP_CHROMIUM_LAUNCH === "true") {
      sh(["docker", "exec", containerName, "test", "-x", "/usr/bin/chromium"]);
      process.stdout.write("browser smoke: Browser Host healthy; headless Chromium launch skipped under QEMU (binary present and executable at /usr/bin/chromium)\n");
    } else {
      const dom = sh(["docker", "exec", containerName,
        "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
        "--disable-dev-shm-usage", "--dump-dom", "about:blank"]);
      if (!dom.includes("<html")) {
        throw new Error(`Browser smoke failed: headless Chromium did not render about:blank\n${dom.slice(0, 400)}`);
      }
      process.stdout.write("browser smoke: Browser Host healthy and headless Chromium launched\n");
    }
  } finally {
    try {
      sh(["docker", "rm", "-f", containerName]);
    } catch {}
    // Best effort: the Browser Host owns the bind-mounted socket directory and
    // may retighten its permissions, so an unremovable temp directory must not
    // fail an otherwise passed smoke check.
    try { rmSync(secrets, { recursive: true, force: true }); } catch {}
    try { rmSync(socketDir, { recursive: true, force: true }); } catch {}
  }
}

await main();
