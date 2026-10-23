import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { pidAlive, run, sleep } from "./dev-stack-lib.mjs";

const unsafeOverrideKeys = ["SPACE_DEV_STACK_DIR", "SPACE_DEV_COMPOSE_PROJECT"];
const ownershipVersion = 1;
const processRecordVersion = 1;
const spawnedChildren = new WeakMap();

export function spawnOwnedProcess(ownership, command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    env: { ...(options.env ?? process.env), SPACE_DEV_PROCESS_TOKEN: ownership.token },
    detached: process.platform !== "win32"
  });
  if (Number.isInteger(child.pid) && child.pid > 1) {
    spawnedChildren.set(child, { pid: child.pid, token: ownership.token });
  }
  return child;
}

export function assertSafeDevStackOverrides(env = process.env) {
  for (const key of unsafeOverrideKeys) {
    if (env[key] != null && env[key] !== "") {
      throw new Error(`${key} is intentionally unsupported: dev-stack state and Compose ownership are derived from this checkout so reset cannot target unrelated resources.`);
    }
  }
}

function validateOwnership(config, record) {
  if (!record || record.version !== ownershipVersion || record.rootHash !== config.rootHash || !/^[a-f0-9]{48}$/.test(record.token || "")) {
    throw new Error("The dev-stack ownership record is missing, damaged, or belongs to another checkout; refusing destructive lifecycle operations.");
  }
  return record;
}

export async function readStateOwnership(config, { allowMissing = false } = {}) {
  if (!existsSync(config.stateRoot)) return null;
  if (!existsSync(config.ownerFile)) {
    if (allowMissing) return null;
    throw new Error(`Refusing to adopt pre-existing state directory ${config.stateRoot}: it was not initialized by this dev-stack.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(config.ownerFile, "utf8"));
  } catch {
    throw new Error("The dev-stack ownership record is unreadable; refusing cleanup so recovery material is preserved.");
  }
  return validateOwnership(config, parsed);
}

export async function claimStateOwnership(config) {
  if (existsSync(config.stateRoot)) return readStateOwnership(config);

  let created = false;
  try {
    await mkdir(config.stateRoot, { mode: 0o700 });
    created = true;
    const record = {
      version: ownershipVersion,
      rootHash: config.rootHash,
      token: randomBytes(24).toString("hex")
    };
    await writeFile(config.ownerFile, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(config.ownerFile, 0o600);
    return record;
  } catch (error) {
    if (created) await rm(config.stateRoot, { recursive: true, force: true }).catch(() => {});
    if (error?.code === "EEXIST") return readStateOwnership(config);
    throw error;
  }
}

function isZombie(identity) {
  return typeof identity?.state === "string" && identity.state.startsWith("Z");
}

async function psField(pid, field) {
  const result = await run("ps", ["-p", String(pid), "-o", `${field}=`], { capture: true, allowFailure: true });
  if (result.code !== 0 || !result.stdout) return null;
  return result.stdout.trim();
}

export async function processIdentity(pid) {
  if (!pidAlive(pid)) return null;
  const [startedAt, args, state] = await Promise.all([
    psField(pid, "lstart"),
    psField(pid, "args"),
    psField(pid, "stat")
  ]);
  if (!startedAt || !args || !state) return null;
  return { startedAt, args, state };
}

export function supervisorRecordMatches(config, record, identity) {
  if (!record || !identity || record.legacy === true || isZombie(identity)) return false;
  if (!Number.isInteger(record.pid) || record.pid <= 1) return false;
  if (record.rootHash !== config.rootHash || record.startedAt !== identity.startedAt) return false;
  return /(?:^|[\\/\s])dev-stack\.mjs(?:\s|$)/.test(identity.args);
}

export async function readSupervisorRecord(config) {
  if (!existsSync(config.pidFile)) return null;
  const raw = (await readFile(config.pidFile, "utf8")).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed)) return { pid: parsed, legacy: true };
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? { pid, legacy: true } : null;
  }
}

export async function isOwnedSupervisor(config, record = null, identityProvider = processIdentity) {
  const candidate = record ?? await readSupervisorRecord(config);
  if (!candidate || !pidAlive(candidate.pid)) return false;
  const identity = await identityProvider(candidate.pid);
  return supervisorRecordMatches(config, candidate, identity);
}

export async function ownedSupervisorPid(config, { strict = true, identityProvider = processIdentity } = {}) {
  const record = await readSupervisorRecord(config);
  if (!record) return null;
  if (!pidAlive(record.pid)) {
    await rm(config.pidFile, { force: true });
    return null;
  }
  const identity = await identityProvider(record.pid);
  if (isZombie(identity)) {
    await rm(config.pidFile, { force: true });
    return null;
  }
  if (supervisorRecordMatches(config, record, identity)) return record.pid;
  if (strict) {
    throw new Error(`Refusing to signal PID ${record.pid}: the pidfile does not identify this checkout's dev-stack supervisor.`);
  }
  return null;
}

export async function claimSupervisor(config, identityProvider = processIdentity) {
  const existing = await readSupervisorRecord(config);
  if (existing) {
    if (!pidAlive(existing.pid)) {
      await rm(config.pidFile, { force: true });
    } else {
      const identity = await identityProvider(existing.pid);
      if (isZombie(identity)) {
        await rm(config.pidFile, { force: true });
      } else if (supervisorRecordMatches(config, existing, identity)) {
        throw new Error(`Dev stack is already running under supervisor ${existing.pid}.`);
      } else {
        throw new Error("A stale or unverified dev-stack supervisor record exists. Run `npm run dev:stack -- status` (or `down`) to clear a dead record before starting again; live unowned PIDs are never signalled or replaced.");
      }
    }
  }

  const identity = await identityProvider(process.pid);
  if (!identity?.startedAt || isZombie(identity)) throw new Error("Could not establish dev-stack supervisor process identity.");
  const record = { pid: process.pid, rootHash: config.rootHash, startedAt: identity.startedAt };
  try {
    await writeFile(config.pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another dev-stack supervisor claimed this checkout while startup was in progress.");
    throw error;
  }
  return record;
}

export async function releaseSupervisor(config, pid = process.pid) {
  const record = await readSupervisorRecord(config);
  if (record?.pid === pid) await rm(config.pidFile, { force: true });
}

function validateProcessRecord(record) {
  if (!record || typeof record.name !== "string" || !Number.isInteger(record.pid) || record.pid <= 1 || record.pgid !== record.pid || record.sid !== record.pid) {
    throw new Error("Invalid persisted dev-stack process-group record; refusing to signal it.");
  }
  return record;
}

export async function writeProcessRecords(config, ownership, records) {
  validateOwnership(config, ownership);
  const normalized = records.map(validateProcessRecord);
  const payload = {
    version: processRecordVersion,
    rootHash: config.rootHash,
    token: ownership.token,
    groups: normalized
  };
  const temporary = `${config.processFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, config.processFile);
}

export async function readProcessRecords(config, ownership) {
  validateOwnership(config, ownership);
  if (!existsSync(config.processFile)) return [];
  let parsed;
  try {
    parsed = JSON.parse(await readFile(config.processFile, "utf8"));
  } catch {
    throw new Error("The dev-stack process ownership record is unreadable; refusing to signal any process.");
  }
  if (parsed?.version !== processRecordVersion || parsed.rootHash !== config.rootHash || parsed.token !== ownership.token || !Array.isArray(parsed.groups)) {
    throw new Error("The dev-stack process ownership record does not match this state; refusing to signal any process.");
  }
  return parsed.groups.map(validateProcessRecord);
}

export async function clearProcessRecords(config) {
  await rm(config.processFile, { force: true });
}

async function listGroupMembers(record, runner = run) {
  // Match the entire group that kill(-pgid) targets. Darwin's `sess` is not a
  // session-leader PID; filtering on it can silently hide owned live members.
  const result = await runner("ps", ["-axo", "pid=,pgid=,stat=,lstart="], {
    capture: true, allowFailure: true, env: { ...process.env, LC_ALL: "C" }
  });
  if (result.code !== 0) throw new Error("Could not inventory local processes; refusing to signal a dev-stack process group.");
  const members = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.+))?$/);
    if (!match) throw new Error("Could not parse local process inventory; refusing to signal a dev-stack process group.");
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const stat = match[3];
    if (pgid !== record.pgid || stat.startsWith("Z")) continue;
    const startedAt = match[4]?.trim();
    if (!/^[A-Za-z?]/.test(stat) || !/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(startedAt || "")) {
      throw new Error(`Could not establish start identity for PID ${pid}; refusing to signal its process group.`);
    }
    members.push({ pid, stat, startedAt });
  }
  return members;
}

async function processHasToken(pid, token, runner = run) {
  const result = await runner("ps", ["eww", "-p", String(pid), "-o", "command="], { capture: true, allowFailure: true });
  if (result.code !== 0 || !result.stdout) return false;
  return result.stdout.includes(`SPACE_DEV_PROCESS_TOKEN=${token}`);
}

async function snapshotLiveGroup(record, ownership, child, runner) {
  const isLiveChild = () => child?.pid === record.pid && child.exitCode === null && child.signalCode === null;
  if (!isLiveChild()) return new Map();
  const spawned = spawnedChildren.get(child);
  const spawnedHere = spawned?.pid === record.pid && spawned.token === ownership.token;
  const members = await listGroupMembers(record, runner);
  // npm rewrites process.title; Darwin ps can then omit its environment.
  // Only our exact, still-live spawned handle supplies alternative provenance.
  // A persisted record or another object with the same PID cannot supply it.
  if (!members.some((member) => member.pid === child.pid) || (!spawnedHere && !await processHasToken(child.pid, ownership.token, runner)) || !isLiveChild()) {
    return new Map();
  }
  // The current supervisor's live child anchors this session. Descendants may
  // intentionally drop the token; retain their start identities before signalling.
  // Neither persisted records nor an already-exited child grant this trust.
  return new Map(members.map((member) => [member.pid, member.startedAt]));
}

async function verifiedGroupMembers(record, ownership, runner = run, trustedMembers = new Map()) {
  const members = await listGroupMembers(record, runner);
  for (const member of members) {
    if (trustedMembers.get(member.pid) === member.startedAt) continue;
    if (!await processHasToken(member.pid, ownership.token, runner)) {
      throw new Error(`Refusing to signal process group ${record.pgid}: PID ${member.pid} does not carry this dev-stack ownership token.`);
    }
  }
  return members;
}

async function signalVerifiedGroup(record, ownership, signal, runner, signaler, trustedMembers) {
  const members = await verifiedGroupMembers(record, ownership, runner, trustedMembers);
  if (!members.length) return false;
  try {
    if (process.platform === "win32") {
      for (const member of members) signaler(member.pid, signal);
    } else {
      signaler(-record.pgid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return true;
}

export async function terminateOwnedProcessGroups(config, ownership, {
  records = null,
  liveChildren = [],
  timeoutMs = 7000,
  runner = run,
  signaler = process.kill
} = {}) {
  validateOwnership(config, ownership);
  const groups = (records ?? await readProcessRecords(config, ownership)).map(validateProcessRecord);
  for (const record of groups) {
    const child = records == null ? null : liveChildren.find((candidate) => candidate.pid === record.pid);
    const trustedMembers = await snapshotLiveGroup(record, ownership, child, runner);
    const members = () => verifiedGroupMembers(record, ownership, runner, trustedMembers);
    if (!await signalVerifiedGroup(record, ownership, "SIGTERM", runner, signaler, trustedMembers)) continue;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await members()).length) break;
      await sleep(100);
    }
    if ((await members()).length) {
      await signalVerifiedGroup(record, ownership, "SIGKILL", runner, signaler, trustedMembers);
      const killDeadline = Date.now() + 2000;
      while (Date.now() < killDeadline && (await members()).length) await sleep(50);
      if ((await members()).length) {
        throw new Error(`Owned process group ${record.pgid} did not terminate; process ownership state was preserved for retry.`);
      }
    }
  }
  if (records == null) await clearProcessRecords(config);
}
