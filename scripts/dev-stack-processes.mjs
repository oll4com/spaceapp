import { spawn, execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { privateDirectory, privateFileStat, saveState } from "./dev-stack-state.mjs";

/**
 * Read PID, parent, group, birth time and state using the ps fields shared by Linux and macOS.
 * Use C/UTC for stable birth columns; retain zombies so identity checks can explicitly reject them.
 */
export function processTable() {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" } });
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields.slice(3, 8).join(" "), stat: fields[8] };
  });
}

/**
 * Identify a live process by PID and birth time, returning null once it disappears.
 * Linux start ticks avoid the one-second resolution of the portable ps birth timestamp.
 * @returns {{pid: number, pgid: number, start: string} | null} A snapshot, not a permanent PID lease.
 */
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

/**
 * Check a saved birth identity against a current snapshot before treating its PID as owned.
 */
export function isSameProcess(record, table) {
  return Boolean(record && processIdentity(record.pid, table ?? processTable())?.start === record.start);
}

/**
 * Collect the transitive child tree, including its root, from one consistent process snapshot.
 */
export function descendants(pid, table) {
  const found = new Set([pid]);
  for (;;) {
    const previous = found.size;
    for (const entry of table) if (found.has(entry.ppid)) found.add(entry.pid);
    if (previous === found.size) return table.filter((entry) => found.has(entry.pid));
  }
}

/**
 * Deliver a signal, tolerating a process that exited between observation and delivery.
 * Permission and other delivery failures propagate so recovery state is preserved.
 */
function send(pid, signal) {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

/**
 * Stop only processes authenticated by saved birth identities, including persisted PTY descendants.
 * Recheck group membership before TERM/KILL; a reused PID or group must not block other cleanup.
 * @param {Array<object>} records Saved process identities and optional descendant identities.
 * @param {number} timeout Grace period in milliseconds before escalating to SIGKILL.
 * @throws {Error} If authenticated processes survive or signal delivery fails; callers must retain state.
 */
export async function stopRecords(records, timeout = 8000) {
  if (!records.length) return;
  records = records.flatMap((record) => [record, ...(record.descendants ?? [])]);
  const table = processTable();
  const children = [];
  const groups = new Set();
  for (const record of records) {
    const actual = processIdentity(record.pid, table);
    // The saved process is gone; leave the PID's new owner untouched and
    // continue cleaning up the remaining authenticated processes.
    if (actual && actual.start !== record.start) continue;
    // Require a live, authenticated member before signaling a saved group.
    // Its numeric ID alone is not an identity after a long host outage.
    if (record.pgid === record.pid && record.pgid !== processIdentity(process.pid, table)?.pgid && records.some((member) => member.pgid === record.pgid && isSameProcess(member, table))) groups.add(record.pgid);
    for (const child of actual ? descendants(record.pid, table) : []) {
      const identity = processIdentity(child.pid, table);
      if (identity) children.push(identity);
    }
  }
  // Group IDs can be reused between TERM and KILL. Authenticate a captured
  // live member in the group again before every group signal and liveness check.
  /**
   * Require a captured live identity still in this group; its numeric ID alone cannot establish ownership.
   */
  const ownsGroup = (group, current) => children.some((child) => {
    const actual = processIdentity(child.pid, current);
    return actual?.start === child.start && actual.pgid === group;
  });
  /**
   * Authenticate group membership and individual birth identities again at each escalation step.
   */
  const signalAll = (signal) => {
    const table = processTable();
    for (const group of groups) if (ownsGroup(group, table)) send(-group, signal);
    const current = processTable();
    // PTY children create new sessions, so group signaling alone misses them.
    for (const child of children) if (isSameProcess(child, current)) send(child.pid, signal);
  };
  /**
   * Wait only for authenticated identities, ignoring zombies and subsequently reused numeric groups.
   */
  const alive = () => {
    const current = processTable();
    return [...groups].some((group) => ownsGroup(group, current)) || children.some((entry) => isSameProcess(entry, current));
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
  /**
   * Track children, their private logs and persistent recovery identities for one stack.
   * Required child failures are reported through onFailure; expected shutdown exits are suppressed.
   */
  constructor(state, secrets, onFailure) {
    this.state = state;
    this.redactions = Object.values(secrets).filter(Boolean).sort((a, b) => b.length - a.length);
    this.redactionTail = Math.max(0, ...this.redactions.map((secret) => secret.length - 1));
    this.onFailure = onFailure;
    this.expected = new Set();
    this.children = new Map();
    this.closed = new Map();
    this.tracker = null;
  }

  /**
   * Persist observable descendant identities while ancestry is available, retaining live orphans after a crash.
   */
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

  /**
   * Spawn a detached service and persist its identity before tracking descendants.
   * Hold an owned log descriptor and bound each stream's partial line, retaining split secrets for redaction.
   * @returns {import("node:child_process").ChildProcess} The child, whose unexpected exit is supervised.
   */
  start(name, command, args, options = {}, required = true) {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error("Invalid private log name.");
    const log = join(privateDirectory(this.state.directory, "logs"), `${name}.log`);
    privateFileStat(log);
    const descriptor = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    let child;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) throw new Error("Expected an owned single-link private log.");
      fchmodSync(descriptor, 0o600);
      child = spawn(command, args, { cwd: this.state.root, stdio: ["ignore", "pipe", "pipe"], detached: true, ...options });
    } catch (error) { closeSync(descriptor); throw error; }
    child.once("close", () => closeSync(descriptor));
    const record = child.pid ? { name, ...processIdentity(child.pid) } : null;
    if (record?.pid) {
      this.state.processes.push(record);
      saveState(this.state);
    }
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      /**
       * Redact every generated secret before appending a complete output fragment to the private log.
       */
      const write = (value) => {
        for (const secret of this.redactions) value = value.replaceAll(secret, "[redacted]");
        writeFileSync(descriptor, value);
      };
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        let end = pending.lastIndexOf("\n") + 1;
        // Generated credentials have no newlines. For a long partial line, keep
        // enough lookahead to recognize a secret split across the next chunk.
        if (!end && pending.length > 65_536 + this.redactionTail) end = pending.length - this.redactionTail;
        // Never cut a known complete match in half at the flush boundary.
        for (;;) {
          const previous = end;
          for (const secret of this.redactions) {
            const start = pending.lastIndexOf(secret, end - 1);
            if (start >= 0 && start < end && start + secret.length > end) end = start;
          }
          if (end === previous) break;
        }
        // String offsets are UTF-16 code units; splitting a surrogate pair
        // would turn a valid UTF-8 character into two replacement characters.
        if (end > 0 && /[\uD800-\uDBFF]/.test(pending[end - 1]) && /[\uDC00-\uDFFF]/.test(pending[end] ?? "")) end--;
        if (end) { write(pending.slice(0, end)); pending = pending.slice(end); }
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

  /**
   * Run a finite setup command, reject unsuccessful exits and drain its descendants before returning.
   */
  async run(name, command, args, options = {}) {
    const child = this.start(name, command, args, options, false);
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${name} failed (${signal ?? code}); see logs/${name}.log`)));
    });
    // Keep completed records until their whole process group has drained.
    await this.stop([name]);
  }

  /**
   * Mark selected exits as expected, stop their process trees and remove records only after successful cleanup.
   */
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
