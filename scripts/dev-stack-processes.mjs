import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { saveState } from "./dev-stack-state.mjs";

export function processTable() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], { encoding: "utf8" });
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields.slice(3, 8).join(" "), stat: fields[8] };
  });
}

export function processIdentity(pid, table = processTable()) {
  const record = table.find((entry) => entry.pid === pid && !/[ZX]/.test(entry.stat));
  if (!record) return null;
  let start = record.start;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch { return null; }
  }
  return { pid, pgid: record.pgid, start };
}

export function isSameProcess(record, table) {
  return Boolean(record && processIdentity(record.pid, table ?? processTable())?.start === record.start);
}

export function descendants(pid, table) {
  const found = new Set([pid]);
  for (;;) {
    const previous = found.size;
    for (const entry of table) if (found.has(entry.ppid)) found.add(entry.pid);
    if (previous === found.size) return table.filter((entry) => found.has(entry.pid));
  }
}

function send(pid, signal) {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function stopRecords(records, timeout = 8000) {
  if (!records.length) return;
  records = records.flatMap((record) => [record, ...(record.descendants ?? [])]);
  const table = processTable();
  const children = [];
  const groups = new Set();
  for (const record of records) {
    const actual = processIdentity(record.pid, table);
    if (actual && actual.start !== record.start) throw new Error(`Refusing to signal reused PID ${record.pid}.`);
    // Require a live, authenticated member before signaling a saved group.
    // Its numeric ID alone is not an identity after a long host outage.
    if (record.pgid === record.pid && record.pgid !== processIdentity(process.pid, table)?.pgid && records.some((member) => member.pgid === record.pgid && isSameProcess(member, table))) groups.add(record.pgid);
    for (const child of actual ? descendants(record.pid, table) : []) {
      const identity = processIdentity(child.pid, table);
      if (identity) children.push(identity);
    }
  }
  const signalAll = (signal) => {
    for (const group of groups) send(-group, signal);
    const current = processTable();
    // PTY children create new sessions, so group signaling alone misses them.
    for (const child of children) if (isSameProcess(child, current)) send(child.pid, signal);
  };
  const alive = () => {
    const current = processTable();
    return current.some((entry) => groups.has(entry.pgid) && !/[ZX]/.test(entry.stat)) || children.some((entry) => isSameProcess(entry, current));
  };
  signalAll("SIGTERM");
  let deadline = Date.now() + timeout;
  while (alive() && Date.now() < deadline) await delay(100);
  if (alive()) {
    signalAll("SIGKILL");
    deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await delay(100);
  }
  if (alive()) throw new Error("Some managed processes could not be stopped; preserving recovery state.");
}

export class ProcessSupervisor {
  constructor(state, secrets, onFailure) {
    this.state = state;
    this.redactions = Object.values(secrets).filter(Boolean);
    this.onFailure = onFailure;
    this.expected = new Set();
    this.children = new Map();
    this.closed = new Map();
    this.tracker = null;
  }

  captureDescendants() {
    const table = processTable();
    let changed = false;
    for (const record of this.state.processes) {
      const known = new Map((record.descendants ?? []).filter((child) => isSameProcess(child, table)).map((child) => [child.pid, child]));
      if (isSameProcess(record, table)) for (const child of descendants(record.pid, table)) {
        const identity = processIdentity(child.pid, table);
        if (identity && identity.pid !== record.pid) known.set(identity.pid, identity);
      }
      const captured = [...known.values()];
      if (JSON.stringify(record.descendants ?? []) !== JSON.stringify(captured)) {
        record.descendants = captured;
        changed = true;
      }
    }
    if (changed) saveState(this.state);
  }

  start(name, command, args, options = {}, required = true) {
    const log = join(this.state.directory, "logs", `${name}.log`);
    const child = spawn(command, args, { cwd: this.state.root, stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
    const record = child.pid ? { name, ...processIdentity(child.pid) } : null;
    if (record?.pid) {
      this.state.processes.push(record);
      saveState(this.state);
    }
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      const write = (value) => {
        for (const secret of this.redactions) value = value.replaceAll(secret, "[redacted]");
        appendFileSync(log, value, { mode: 0o600 });
      };
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const end = pending.lastIndexOf("\n");
        if (end >= 0) { write(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
      });
      stream.on("end", () => { if (pending) write(pending); });
    }
    this.children.set(name, child);
    if (!this.tracker) {
      // PTY children create new sessions and are reparented when their host
      // crashes. Retain identities while ancestry is still observable.
      this.tracker = setInterval(() => {
        try { this.captureDescendants(); }
        catch (error) { this.onFailure(new Error(`Process identity tracking failed: ${error.message}`)); }
      }, 200);
      this.tracker.unref();
    }
    this.closed.set(name, new Promise((resolve) => child.once("close", resolve)));
    child.once("error", (error) => { if (required && !this.expected.has(name)) this.onFailure(new Error(`${name} could not start: ${error.message}`)); });
    child.once("exit", (code, signal) => {
      if (required && !this.expected.has(name)) this.onFailure(new Error(`${name} exited unexpectedly (${signal ?? code}); see logs/${name}.log`));
    });
    return child;
  }

  async run(name, command, args, options = {}) {
    const child = this.start(name, command, args, options, false);
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} failed (${signal ?? code}); see logs/${name}.log`)));
    });
    // Keep completed records until their whole process group has drained.
    await this.stop([name]);
  }

  async stop(names = [...this.children.keys()]) {
    for (const name of names) this.expected.add(name);
    this.captureDescendants();
    await stopRecords(this.state.processes.filter((entry) => names.includes(entry.name)));
    await Promise.all(names.map((name) => this.closed.get(name)));
    this.state.processes = this.state.processes.filter((entry) => !names.includes(entry.name));
    for (const name of names) { this.children.delete(name); this.closed.delete(name); this.expected.delete(name); }
    if (!this.children.size) { clearInterval(this.tracker); this.tracker = null; }
    saveState(this.state);
  }
}
