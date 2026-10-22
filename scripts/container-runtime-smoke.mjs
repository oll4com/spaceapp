#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Runs only disposable containers and volumes with a unique name. No host data,
// provider credentials, public ports, or installed SpaceApp instance are used.
const prefix = `spaceapp-smoke-${randomUUID().slice(0, 8)}`;
const imagePrefix = process.argv[2] || "spaceapp-ci";
const arch = process.argv[3] || "amd64";
if (!["amd64", "arm64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
const names = Object.fromEntries(["postgres", "core", "browser", "cli"].map((name) => [name, `${prefix}-${name}`]));
const network = `${prefix}-network`;
const socketVolume = `${prefix}-cli-socket`;
const postgresImage = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";
const databaseUrl = `postgresql://spaceapp:smoke-only-password@${names.postgres}:5432/spaceapp`;
const platform = `linux/${arch}`;
const licenses = readdirSync(resolve(import.meta.dirname, "../THIRD_PARTY_LICENSES"));
const containers = [];
let createdNetwork = false;
let createdVolume = false;

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options }).trim();
}
function image(target) { return `${imagePrefix}:${target}-${arch}`; }
function run(target, args = []) {
  const name = names[target];
  docker(["run", "--detach", "--name", name, "--platform", platform, "--network", network, ...args]);
  containers.push(name);
}
async function until(label, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { check(); console.log(`${label}: passed`); return; } catch (error) { lastError = error; }
    await delay(2_000);
  }
  throw new Error(`${label} timed out: ${lastError?.message}`);
}
function execNode(target, source, options = {}) {
  return docker(["exec", "--user", "10001:10001", names[target], "node", "--input-type=module", "-e", source], { timeout: 15_000, ...options });
}
function ipcHealth(socketPath, method) {
  return `
    import { createConnection } from 'node:net';
    const payload=Buffer.from(JSON.stringify({kind:'request',requestId:'runtime-smoke',method:${JSON.stringify(method)},params:{}}));
    const frame=Buffer.alloc(4+payload.length); frame.writeUInt32BE(payload.length); payload.copy(frame,4);
    const socket=createConnection(${JSON.stringify(socketPath)});
    let buffer=Buffer.alloc(0);
    const timer=setTimeout(()=>{console.error('IPC timeout');process.exit(1)},5000);
    socket.on('error',error=>{console.error(error.message);process.exit(1)});
    socket.on('connect',()=>socket.write(frame));
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(buffer.length<4||buffer.length<4+buffer.readUInt32BE(0))return;
      const response=JSON.parse(buffer.subarray(4,4+buffer.readUInt32BE(0)));
      if(response.kind!=='response'||response.requestId!=='runtime-smoke'||response.ok!==true)throw Error(JSON.stringify(response));
      if(!response.result||typeof response.result!=='object')throw Error('Missing health result');
      clearTimeout(timer);socket.end();console.log(JSON.stringify(response.result));
    });`;
}

try {
  docker(["network", "create", network]); createdNetwork = true;
  docker(["volume", "create", socketVolume]); createdVolume = true;
  run("postgres", ["--env", "POSTGRES_USER=spaceapp", "--env", "POSTGRES_DB=spaceapp", "--env", "POSTGRES_PASSWORD=smoke-only-password", postgresImage]);
  await until("pgvector PostgreSQL", () => docker(["exec", names.postgres, "pg_isready", "-U", "spaceapp", "-d", "spaceapp"]));

  run("cli", ["--volume", `${socketVolume}:/run/spaceapp-cli`, "--env", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock", image("cli")]);
  await until("CLI Unix socket ping", () => execNode("cli", ipcHealth("/run/spaceapp-cli/host.sock", "ping")));
  execNode("cli", `import pty from 'node-pty'; const p=pty.spawn('/bin/sh',['-c','printf pty-runtime-ok'],{name:'xterm',cols:80,rows:24,cwd:'/tmp',env:process.env});let output='';p.onData(x=>output+=x);p.onExit(e=>process.exit(e.exitCode || (output.includes('pty-runtime-ok') ? 0 : 1)));setTimeout(()=>process.exit(2),5000).unref();`);
  console.log("CLI native PTY execution: passed");

  const makeSecrets = `mkdir -p /run/secrets; printf '%s' '${databaseUrl}' > /run/secrets/database-url; printf '%s' 'smoke-only-session-secret-32-characters-long' > /run/secrets/session-secret; printf '%s' 'smoke-only-setup-token-32-characters-long' > /run/secrets/setup-token; exec /app/deploy/docker/core-entrypoint.sh`;
  run("core", [
    "--volume", `${socketVolume}:/run/spaceapp-cli`,
    "--env", "SPACE_PUBLIC_DISTRIBUTION=true", "--env", "SPACE_AGENT_TOOLS_WRITER=disabled",
    "--env", "SPACE_RUNTIME_STORE=postgres", "--env", "SPACEAPP_WORKFLOWS_ENABLED=false",
    "--env", "SPACE_API_HOST=127.0.0.1", "--env", "SPACE_API_PORT=4910",
    "--env", "SPACE_WEB_HOST=0.0.0.0", "--env", "SPACE_WEB_PORT=4911", "--env", "SPACE_API_ORIGIN=http://127.0.0.1:4910",
    "--env", "SPACE_CLI_ENABLED=true", "--env", "SPACE_CLI_HOST_SOCKET=/run/spaceapp-cli/host.sock",
    "--env", "SPACE_BROWSER_SESSIONS_ENABLED=false", "--entrypoint", "/bin/sh", image("core"), "-ec", makeSecrets
  ]);
  await until("core migrations and /readyz", () => execNode("core", `const r=await fetch('http://127.0.0.1:4911/readyz');const body=await r.json();if(!r.ok||body.ok!==true)throw Error(JSON.stringify(body));console.log(JSON.stringify(body));`));
  execNode("core", `import { bundleWorkflowCode } from '@temporalio/worker'; for(const name of ['workflows','memory-maintenance-workflows','memory-mutation-workflows'])await bundleWorkflowCode({workflowsPath:'/app/apps/worker/dist/'+name+'.js'});`, { timeout: 120_000 });
  console.log("Temporal workflow bundles from deployed files: passed");
  docker(["exec", names.postgres, "psql", "-U", "spaceapp", "-d", "spaceapp", "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION IF NOT EXISTS vector; SELECT '[1,2,3]'::vector;"]);

  run("browser", ["--env", "SPACE_RUNTIME_STORE=postgres", "--env", "SPACE_PUBLIC_DISTRIBUTION=true",
    "--env", "SPACE_BROWSER_SESSIONS_ENABLED=true", "--env", "SPACE_BROWSER_HOST_SOCKET=/run/spaceapp-browser/browser-host.sock",
    "--entrypoint", "/bin/sh", image("browser"), "-ec", `mkdir -p /run/secrets; printf '%s' '${databaseUrl}' > /run/secrets/database-url; exec /app/deploy/docker/browser-entrypoint.sh`]);
  await until("BrowserHost Unix socket health", () => execNode("browser", ipcHealth("/run/spaceapp-browser/browser-host.sock", "health")));
  for (const target of ["core", "cli", "browser"]) {
    execNode(target, `import { accessSync, readFileSync } from 'node:fs'; for(const file of ${JSON.stringify(["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", ...licenses.map((name) => `THIRD_PARTY_LICENSES/${name}`)])})accessSync('/app/'+file);const manifest=JSON.parse(readFileSync('/app/container-manifest.json','utf8'));if(manifest.target!==${JSON.stringify(target)}||manifest.arch!==process.arch)throw Error('Wrong deploy manifest');`);
  }
  console.log("runtime licenses and target manifests: passed");
  const dom = docker(["exec", "--user", "10001:10001", names.browser, "/usr/bin/chromium", "--headless", "--no-sandbox", "--disable-dev-shm-usage", "--dump-dom", "data:text/html,<title>spaceapp-runtime-smoke</title><p>chromium-ok</p>"], { timeout: 60_000 });
  if (!dom.includes("spaceapp-runtime-smoke") || !dom.includes("chromium-ok")) throw new Error("Chromium did not render the smoke document");
  console.log(`headless Chromium: passed (${platform}); all runtime smoke checks passed`);
} catch (error) {
  for (const name of containers) {
    try { console.error(`--- ${name} ---\n${docker(["logs", "--tail", "100", name])}`); } catch { /* report the primary failure */ }
  }
  throw error;
} finally {
  for (const name of containers.reverse()) {
    try { docker(["rm", "--force", "--volumes", name]); } catch { /* best effort for our disposable resources */ }
  }
  if (createdVolume) docker(["volume", "rm", socketVolume]);
  if (createdNetwork) docker(["network", "rm", network]);
}
