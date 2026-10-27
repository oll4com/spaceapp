import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const stateName = ".dev-stack";
export const secretNames = ["postgres-password", "session-secret", "setup-token", "opencode-password"];
export async function privateWrite(path, content) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function checkSockets(state, create = false) {
  if (typeof state.sockets !== "string" || dirname(state.sockets) !== resolve(tmpdir()) || !/^space-dev-[a-zA-Z0-9]+$/.test(basename(state.sockets))) throw new Error("Invalid socket directory.");
  let socketStat;
  try { socketStat = await lstat(state.sockets); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) return; // down/reset can still manage Compose after OS temp cleanup
    await mkdir(state.sockets, { mode: 0o700 });
    try { await privateWrite(join(state.sockets, "owner"), state.id); }
    catch (writeError) { await rm(state.sockets, { recursive: true }); throw writeError; }
    socketStat = await lstat(state.sockets);
  }
  if (!socketStat.isDirectory() || socketStat.isSymbolicLink() || await readFile(join(state.sockets, "owner"), "utf8") !== state.id) throw new Error("Socket ownership differs.");
}

/** Only a directory created for this canonical checkout can be managed or reset. */
export async function readState(root) {
  const dir = join(root, stateName);
  let stat;
  try { stat = await lstat(dir); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing a linked or non-directory .dev-stack.");
  const marker = join(dir, "owner.json");
  let markerStat;
  try { markerStat = await lstat(marker); }
  catch (error) { if (error.code === "ENOENT") throw new Error("Missing stack ownership marker; inspect and move the incomplete .dev-stack aside before retrying. No resources were removed.", { cause: error }); throw error; }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error("Invalid stack ownership marker.");
  const state = JSON.parse(await readFile(marker, "utf8"));
  const project = `spaceapp-dev-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  if (state.version !== 1 || state.root !== root || state.project !== project || !/^[a-f0-9]{32}$/.test(state.id)) {
    throw new Error("Refusing state owned by another checkout. Move the checkout back before resetting it.");
  }
  await checkSockets(state);
  return { ...state, dir };
}

export function portsFromEnv(env) {
  const result = {};
  for (const [name, fallback] of Object.entries({ API: 14910, WEB: 14911, POSTGRES: 15432, TEMPORAL: 17233, OPENCODE: 14747 })) {
    const raw = env[`SPACE_DEV_${name}_PORT`] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535 || [4910, 4911].includes(Number(raw))) throw new Error(`Invalid SPACE_DEV_${name}_PORT (use1024–65535, excluding4910/4911).`);
    result[name.toLowerCase()] = Number(raw);
  }
  if (new Set(Object.values(result)).size !== 5) throw new Error("Stack ports must be distinct.");
  return result;
}

export async function createState(root, env) {
  root = await realpath(root);
  const existing = await readState(root);
  if (existing) {
    for (const [name, port] of Object.entries(existing.ports)) {
      const override = env[`SPACE_DEV_${name.toUpperCase()}_PORT`];
      if (override !== undefined && Number(override) !== port) throw new Error("Port configuration changed; reset this stack before choosing new ports.");
    }
    await checkSockets(existing, true);
    return existing;
  }
  const ports = portsFromEnv(env);
  const dir = join(root, stateName);
  // Publish a complete state atomically while the checkout lock is held. A crash
  // before rename may leave staging files, but cannot block the next startup.
  const staging = await mkdtemp(join(root, ".dev-stack-init-"));
  let sockets;
  try {
    sockets = await mkdtemp(join(resolve(tmpdir()), "space-dev-"));
    const state = { version: 1, root, project: `spaceapp-dev-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`, id: randomBytes(16).toString("hex"), sockets, ports };
    await privateWrite(join(sockets, "owner"), state.id);
    for (const sub of ["secrets", "home", "tmp", "bin", "vendor", "workspaces", "memory", "artifacts", "logs"]) await mkdir(join(staging, sub), { mode: 0o700 });
    for (const name of secretNames) await privateWrite(join(staging, "secrets", name), randomBytes(32).toString("hex"));
    await privateWrite(join(staging, "owner.json"), JSON.stringify(state, null, 2));
    await rename(staging, dir);
    return { ...state, dir };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (sockets) await rm(sockets, { recursive: true, force: true });
    throw error;
  }
}

/** Reset never follows a caller-supplied directory or deletes an unmarked socket tree. */
export async function removeState(state) {
  const verified = await readState(state.root);
  if (!verified || verified.id !== state.id) throw new Error("Stack ownership changed during reset.");
  await rm(verified.sockets, { recursive: true, force: true });
  await rm(verified.dir, { recursive: true });
}
