import { randomBytes, createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

export const stateName = ".dev-stack";
export const secretNames = ["postgres-password", "session-secret", "setup-token", "opencode-password"];
export async function privateWrite(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** Only a directory created for this canonical checkout can be managed or reset. */
export async function readState(root) {
  const dir = join(root, stateName);
  let stat;
  try { stat = await lstat(dir); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing a linked or non-directory .dev-stack.");
  const marker = join(dir, "owner.json");
  if (!(await lstat(marker)).isFile() || (await lstat(marker)).isSymbolicLink()) throw new Error("Invalid stack ownership marker.");
  const state = JSON.parse(await readFile(marker, "utf8"));
  const project = `spaceapp-dev-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
  if (state.version !== 1 || state.root !== root || state.project !== project || !/^[a-f0-9]{32}$/.test(state.id)) {
    throw new Error("Refusing state owned by another checkout. Move the checkout back before resetting it.");
  }
  if (typeof state.sockets !== "string" || !state.sockets.startsWith(resolve(tmpdir()) + "/space-dev-")) throw new Error("Invalid socket directory.");
  const socketStat = await lstat(state.sockets);
  if (!socketStat.isDirectory() || socketStat.isSymbolicLink() || await readFile(join(state.sockets, "owner"), "utf8") !== state.id) throw new Error("Socket ownership differs.");
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
    return existing;
  }
  const ports = portsFromEnv(env);
  const dir = join(root, stateName);
  await mkdir(dir, { mode: 0o700 }); // exclusive: never adopt another creator's directory
  const sockets = await mkdtemp(join(resolve(tmpdir()), "space-dev-"));
  const state = { version: 1, root, project: `spaceapp-dev-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`, id: randomBytes(16).toString("hex"), sockets, ports };
  await privateWrite(join(sockets, "owner"), state.id);
  for (const sub of ["secrets", "home", "tmp", "bin", "vendor", "workspaces", "memory", "artifacts", "logs"]) await mkdir(join(dir, sub), { mode: 0o700 });
  for (const name of secretNames) await privateWrite(join(dir, "secrets", name), randomBytes(32).toString("hex"));
  await privateWrite(join(dir, "owner.json"), JSON.stringify(state, null, 2));
  return { ...state, dir };
}

/** Reset never follows a caller-supplied directory or deletes an unmarked socket tree. */
export async function removeState(state) {
  const verified = await readState(state.root);
  if (!verified || verified.id !== state.id) throw new Error("Stack ownership changed during reset.");
  await rm(verified.sockets, { recursive: true });
  await rm(verified.dir, { recursive: true });
}
