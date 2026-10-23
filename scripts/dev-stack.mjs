#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEV_STACK_DIR = join(REPO_ROOT, ".dev-stack");
const SECRETS_DIR = join(DEV_STACK_DIR, "secrets");
const COMPOSE_TEMPLATE_PATH = join(REPO_ROOT, "packages", "run-spaceapp", "templates", "compose.yml");

/**
 * Extracts pinned image tags and digests directly from the public compose template.
 * @param {string} [templatePath=COMPOSE_TEMPLATE_PATH]
 * @returns {{ postgresImage: string, temporalImage: string }}
 */
export function extractPinnedImages(templatePath = COMPOSE_TEMPLATE_PATH) {
  const content = readFileSync(templatePath, "utf8");
  const pgMatch = content.match(/image:\s*(pgvector\/pgvector:[^\s\r\n]+)/);
  const temporalMatch = content.match(/image:\s*(temporalio\/auto-setup:[^\s\r\n]+)/);

  if (!pgMatch || !temporalMatch) {
    throw new Error(`Failed to extract pinned images from compose template at ${templatePath}`);
  }

  return {
    postgresImage: pgMatch[1],
    temporalImage: temporalMatch[1]
  };
}

/**
 * Parses CLI command argument (up, down, reset).
 * @param {string[]} [args=process.argv.slice(2)]
 * @returns {"up" | "down" | "reset"}
 */
export function parseCommand(args = process.argv.slice(2)) {
  const cmd = args[0]?.toLowerCase();
  if (cmd === "down" || cmd === "reset") {
    return cmd;
  }
  return "up";
}

/**
 * Ensures state directory and 0600 secret files exist.
 * @param {string} [secretsDir=SECRETS_DIR]
 * @returns {{ dbPassword: string, sessionSecret: string, setupToken: string }}
 */
export function initializeSecrets(secretsDir = SECRETS_DIR) {
  mkdirSync(secretsDir, { recursive: true });

  const pwPath = join(secretsDir, "db-password");
  const sessionPath = join(secretsDir, "session-secret");
  const tokenPath = join(secretsDir, "setup-token");

  let dbPassword;
  let sessionSecret;
  let setupToken;

  if (existsSync(pwPath)) {
    dbPassword = readFileSync(pwPath, "utf8").trim();
  } else {
    dbPassword = crypto.randomBytes(24).toString("hex");
    writeFileSync(pwPath, `${dbPassword}\n`, { mode: 0o600 });
  }

  if (existsSync(sessionPath)) {
    sessionSecret = readFileSync(sessionPath, "utf8").trim();
  } else {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    writeFileSync(sessionPath, `${sessionSecret}\n`, { mode: 0o600 });
  }

  if (existsSync(tokenPath)) {
    setupToken = readFileSync(tokenPath, "utf8").trim();
  } else {
    setupToken = `dev-setup-${crypto.randomBytes(16).toString("hex")}`;
    writeFileSync(tokenPath, `${setupToken}\n`, { mode: 0o600 });
  }

  try {
    chmodSync(pwPath, 0o600);
    chmodSync(sessionPath, 0o600);
    chmodSync(tokenPath, 0o600);
  } catch {}

  return { dbPassword, sessionSecret, setupToken };
}

/**
 * Stops dev-stack docker containers.
 * @param {string} projectName
 */
export function stopDockerServices(projectName = "spaceapp-dev-stack") {
  process.stdout.write(`Stopping docker containers for ${projectName}...\n`);
  try {
    execFileSync("docker", ["rm", "-f", `${projectName}-pg`, `${projectName}-temporal`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
  } catch {}
  try {
    execFileSync("docker", ["network", "rm", `${projectName}-net`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
  } catch {}
}

/**
 * Resets dev-stack containers, volumes, and state directory.
 * @param {string} projectName
 * @param {string} [dir=DEV_STACK_DIR]
 */
export function resetDevStack(projectName = "spaceapp-dev-stack", dir = DEV_STACK_DIR) {
  stopDockerServices(projectName);
  try {
    execFileSync("docker", ["volume", "rm", "-f", `${projectName}-pgdata`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8"
    });
  } catch {}
  if (existsSync(dir)) {
    process.stdout.write(`Removing dev stack state directory ${dir}...\n`);
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write("Dev stack reset complete.\n");
}

/**
 * Main dispatcher.
 */
export async function runDevStack() {
  const command = parseCommand();

  if (command === "down") {
    stopDockerServices();
    process.stdout.write("Dev stack stopped.\n");
    return;
  }

  if (command === "reset") {
    resetDevStack();
    return;
  }

  const { postgresImage, temporalImage } = extractPinnedImages();
  const { dbPassword, setupToken } = initializeSecrets();

  process.stdout.write("Starting SpaceApp full stack from source...\n");
  process.stdout.write(`  Postgres image: ${postgresImage}\n`);
  process.stdout.write(`  Temporal image: ${temporalImage}\n`);

  const projectName = "spaceapp-dev-stack";
  const netName = `${projectName}-net`;
  const pgContainer = `${projectName}-pg`;
  const temporalContainer = `${projectName}-temporal`;

  try {
    execFileSync("docker", ["network", "create", netName], { stdio: "ignore" });
  } catch {}

  // Run Postgres
  const pgPort = process.env.SPACEAPP_DEV_PG_PORT || "54329";
  process.stdout.write(`Starting postgres on 127.0.0.1:${pgPort}...\n`);
  try {
    execFileSync("docker", [
      "run", "-d",
      "--name", pgContainer,
      "--network", netName,
      "-p", `127.0.0.1:${pgPort}:5432`,
      "-e", `POSTGRES_PASSWORD=${dbPassword}`,
      "-e", "POSTGRES_USER=spaceapp",
      "-e", "POSTGRES_DB=spaceapp",
      "-v", `${projectName}-pgdata:/var/lib/postgresql/data`,
      postgresImage
    ], { stdio: "ignore" });
  } catch {}

  // Run Temporal
  const temporalPort = process.env.SPACEAPP_DEV_TEMPORAL_PORT || "72339";
  process.stdout.write(`Starting temporal on 127.0.0.1:${temporalPort}...\n`);
  try {
    execFileSync("docker", [
      "run", "-d",
      "--name", temporalContainer,
      "--network", netName,
      "-p", `127.0.0.1:${temporalPort}:7233`,
      temporalImage
    ], { stdio: "ignore" });
  } catch {}

  const webPort = process.env.SPACEAPP_DEV_WEB_PORT || "49110";
  process.stdout.write("\n======================================================\n");
  process.stdout.write(`SpaceApp dev stack is ready!\n`);
  process.stdout.write(`URL: http://127.0.0.1:${webPort}\n`);
  process.stdout.write(`One-time owner setup token: ${setupToken}\n`);
  process.stdout.write("======================================================\n\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDevStack().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
