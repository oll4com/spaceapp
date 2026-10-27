import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const postgresImage = "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b";
function docker(args, input) {
  try {
    return execFileSync("docker", args, { input, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`docker ${args[0]} failed: ${String(error.stderr ?? error.message).slice(-8000)}`, { cause: error });
  }
}
async function until(check, name) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try { return check(); } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${name} did not become ready: ${lastError?.message}`);
}

async function coreRuntimeProbe() {
  // These lazy paths do not run during readiness: exercise PDF.js's native
  // polyfill/worker and Temporal's platform bridge/workflow bundler as well.
  const { createRequire } = await import("node:module");
  const require = createRequire(`${process.cwd()}/package.json`);
  require(require("@temporalio/core-bridge/common").getPrebuiltPath());
  const { bundleWorkflowCode } = await import("@temporalio/worker");
  for (const name of ["workflows", "memory-mutation-workflows", "memory-maintenance-workflows"]) {
    await bundleWorkflowCode({ workflowsPath: `${process.cwd()}/apps/worker/dist/${name}.js` });
  }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const content = "BT /F1 12 Tf 20 50 Td (Container runtime) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const task = getDocument({ data: new Uint8Array(Buffer.from(pdf)), verbosity: 0 });
  try {
    const document = await task.promise;
    const page = await document.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => item.str ?? "").join(" ");
    if (!text.includes("Container runtime")) throw new Error("PDF text extraction failed");
  } finally { await task.destroy(); }
}

export async function smokeContainer({ target, image, platform }) {
  if (!["core", "browser", "cli"].includes(target) || !image || !/^linux\/(amd64|arm64)$/.test(platform)) {
    throw new Error("Usage: container-smoke.mjs <core|browser|cli> <image> <linux/amd64|linux/arm64>");
  }
  const id = `space-smoke-${randomBytes(6).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), id));
  const names = [];
  let network = false;
  try {
    docker(["network", "create", "--label", `com.spaceapp.container-smoke=${id}`, id]);
    network = true;
    const password = randomBytes(24).toString("hex");
    const secrets = join(directory, "secrets");
    await mkdir(secrets, { mode: 0o755 });
    for (const [name, value] of Object.entries({
      "database-url": `postgres://space:${password}@${id}-db:5432/space`,
      "session-secret": randomBytes(48).toString("hex"),
      "setup-token": randomBytes(32).toString("hex")
    })) await writeFile(join(secrets, name), value, { mode: 0o444 });
    if (target !== "cli") {
      docker(["run", "-d", "--name", `${id}-db`, "--network", id, "--label", `com.spaceapp.container-smoke=${id}`,
        "-e", "POSTGRES_USER=space", "-e", "POSTGRES_DB=space", "-e", `POSTGRES_PASSWORD=${password}`, postgresImage]);
      names.push(`${id}-db`);
      await until(() => docker(["exec", `${id}-db`, "pg_isready", "-U", "space", "-d", "space"]), "PostgreSQL");
      if (target === "browser") {
        // The browser connects to the existing installation's schema. The core
        // smoke separately exercises the application's migration runner.
        const migrations = join(root, "packages/db/migrations");
        for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
          docker(["exec", "-i", `${id}-db`, "psql", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-U", "space", "-d", "space"], await readFile(join(migrations, name)));
        }
      }
    }
    const environment = {
      SPACE_PUBLIC_DISTRIBUTION: "true", SPACE_RUNTIME_STORE: "postgres",
      SPACE_TELEMETRY_ENABLED: "false", SPACE_AGENT_TOOLS_WRITER: "disabled",
      SPACE_DEV_LOGIN: "false", SPACEAPP_WORKFLOWS_ENABLED: "false",
      SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: "4910",
      SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: "4911",
      SPACE_API_ORIGIN: "http://127.0.0.1:4910",
      SPACE_BROWSER_SESSIONS_ENABLED: target === "browser" ? "true" : "false",
      SPACE_BROWSER_HOST_SOCKET: "/run/spaceapp-browser/browser-host.sock",
      SPACE_CLI_HOST_SOCKET: "/run/spaceapp-cli/host.sock"
    };
    docker(["create", "--name", id, "--platform", platform, "--network", id,
      "--label", `com.spaceapp.container-smoke=${id}`,
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]), image]);
    names.push(id);
    docker(["cp", secrets, `${id}:/run/secrets`]);
    docker(["start", id]);
    const execute = (source) => docker(["exec", "--user", "10001:10001", id, "node", "--input-type=module", "-e", source]);
    if (target === "core") {
      await until(() => execute("const r=await fetch('http://127.0.0.1:4911/readyz'); const body=await r.json(); if(!r.ok||body.ok!==true)throw new Error(JSON.stringify(body));"), "core /readyz");
      execute(`await (${coreRuntimeProbe.toString()})();`);
    } else {
      const socket = target === "cli" ? "/run/spaceapp-cli/host.sock" : "/run/spaceapp-browser/browser-host.sock";
      const probe = `import net from 'node:net'; const socket=net.createConnection(${JSON.stringify(socket)}); socket.setTimeout(5000,()=>socket.destroy(new Error('socket timeout'))); socket.on('error',error=>{console.error(error.message);process.exitCode=1;}); socket.on('connect',()=>socket.end());`;
      await until(() => execute(probe), `${target} socket`);
      if (target === "browser") {
        await until(() => execute("import net from 'node:net'; const s=net.createConnection('/run/spaceapp-browser/browser-host.sock');let data='';s.setTimeout(5000,()=>s.destroy(new Error('health timeout')));s.on('error',e=>{console.error(e.message);process.exitCode=1;});s.on('connect',()=>s.write(JSON.stringify({kind:'request',requestId:'smoke',method:'health',params:{}})+'\\n'));s.on('data',chunk=>{data+=chunk;if(data.includes('\\n')){const reply=JSON.parse(data.split('\\n')[0]);if(reply.ok!==true)process.exitCode=1;s.end();}});"), "Browser Host health");
        const html = docker(["exec", "--user", "10001:10001", id, "chromium", "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--user-data-dir=/tmp/container-smoke-chromium", "--dump-dom", "data:text/html,<title>space-container-smoke</title>"]);
        if (!html.includes("space-container-smoke")) throw new Error("Chromium did not render the smoke page");
      }
    }
    return { target, platform, passed: true };
  } catch (error) {
    if (names.includes(id)) {
      try { process.stderr.write(`${docker(["logs", "--tail", "60", id])}\n`); } catch { /* preserve original failure */ }
    }
    throw error;
  } finally {
    for (const name of names.reverse()) docker(["rm", "-f", "-v", name]);
    if (network) docker(["network", "rm", id]);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, image, platform] = process.argv.slice(2);
  console.log(JSON.stringify(await smokeContainer({ target, image, platform })));
}
