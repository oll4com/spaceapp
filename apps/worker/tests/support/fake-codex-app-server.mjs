// A fake Codex App Server for the worker hard-kill proof. It speaks the JSON-RPC
// subset that the Space worker sends over stdio (`<command> app-server`) and
// makes no model or network call. Thread state and an append-only ledger live
// under $CODEX_HOME/fake-codex, so a process started after the previous worker
// was killed sees what happened before, as a real app-server does through its
// rollout files.
//
// Turn behaviour, chosen by markers in the prompt:
// - "[fake-codex:hold]": the turn starts and stays in progress until the client
//   goes away (stdin closes). Then it ends "interrupted", or "completed" with an
//   answer when the prompt also has "[fake-codex:finish-on-disconnect]" (a
//   runtime that finished the turn on its own after its client died).
// - any other prompt (for example the worker's recovery prompt) completes at once.
// A turn still "inProgress" whose owning process is gone is reported as
// "interrupted" on the next read, like an unfinished rollout.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";

const home = process.env.CODEX_HOME;
if (!home || !path.isAbsolute(home)) process.exit(2);
const root = path.join(home, "fake-codex");
const threadsDir = path.join(root, "threads");
mkdirSync(threadsDir, { recursive: true });
const ledgerPath = path.join(root, "ledger.jsonl");
const owned = new Set();
let closing = false;

function ledger(event) {
  appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`);
}
const threadFile = (threadId) => path.join(threadsDir, `${threadId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
function save(thread) {
  const target = threadFile(thread.id);
  writeFileSync(`${target}.tmp`, JSON.stringify(thread));
  renameSync(`${target}.tmp`, target);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
function load(threadId) {
  let thread;
  try { thread = JSON.parse(readFileSync(threadFile(threadId), "utf8")); } catch { return null; }
  let changed = false;
  for (const turn of thread.turns) {
    if (turn.status === "inProgress" && turn.ownerPid !== process.pid && !alive(turn.ownerPid)) {
      turn.status = "interrupted";
      changed = true;
      ledger({ event: "turn-orphan-interrupted", threadId, turnId: turn.id });
    }
  }
  if (changed) save(thread);
  return thread;
}
const promptHash = (text) => createHash("sha256").update(text).digest("hex");
const tag = (text) => /\[proof:([a-z0-9-]+)\]/.exec(text)?.[1] ?? null;
const publicTurn = (turn) => ({ id: turn.id, status: turn.status, items: turn.items });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function complete(thread, turn, text) {
  const item = { id: `item_${randomBytes(6).toString("hex")}`, type: "agentMessage", phase: "final_answer", text };
  turn.items.push(item);
  turn.status = "completed";
  save(thread);
  return item;
}

function handle(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return; // notifications such as "initialized"
  const reply = (result) => send({ id, result });
  const fail = (code, text) => send({ id, error: { code, message: text } });
  switch (method) {
    case "initialize": return reply({ userAgent: "fake-codex-app-server/1" });
    case "configRequirements/read": return reply({ requirements: null });
    case "thread/start": {
      const thread = { id: `thr_${randomBytes(8).toString("hex")}`, turns: [] };
      save(thread);
      ledger({ event: "thread/start", threadId: thread.id });
      return reply({ thread: { id: thread.id }, model: "fake-model" });
    }
    case "thread/resume": {
      const thread = load(String(params.threadId ?? ""));
      ledger({ event: "thread/resume", threadId: params.threadId ?? null, found: Boolean(thread) });
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      return reply({ thread: { id: thread.id }, model: "fake-model" });
    }
    case "thread/read": {
      const thread = load(String(params.threadId ?? ""));
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      ledger({ event: "thread/read", threadId: thread.id, turns: thread.turns.map((turn) => `${turn.id}:${turn.status}`) });
      return reply({ thread: { id: thread.id, turns: thread.turns.map(publicTurn) } });
    }
    case "turn/start": {
      const thread = load(String(params.threadId ?? ""));
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      const text = (params.input ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
      const turn = {
        id: `turn_${randomBytes(8).toString("hex")}`, status: "inProgress", ownerPid: process.pid,
        hold: text.includes("[fake-codex:hold]"), finishOnDisconnect: text.includes("[fake-codex:finish-on-disconnect]"),
        tag: tag(text), items: [{ id: `item_${randomBytes(6).toString("hex")}`, type: "userMessage", content: [{ type: "text", text }] }]
      };
      thread.turns.push(turn);
      save(thread);
      owned.add(`${thread.id}/${turn.id}`);
      // The side effect under test: one line per prompt handed to the runtime.
      ledger({ event: "turn/start", threadId: thread.id, turnId: turn.id, tag: turn.tag, promptSha256: promptHash(text),
        recoveryPrompt: text.includes("Space worker restarted"), hold: turn.hold });
      reply({ turn: { id: turn.id, status: "inProgress" } });
      send({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } } });
      if (!turn.hold) {
        const answer = turn.tag ? `fake-codex answer for ${turn.tag}` : "fake-codex continued the interrupted turn after the worker restart.";
        const item = complete(thread, turn, answer);
        send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
        send({ method: "turn/completed", params: { threadId: thread.id, turn: { id: turn.id, status: "completed" } } });
      }
      return;
    }
    case "turn/interrupt": {
      const thread = load(String(params.threadId ?? ""));
      const turn = thread?.turns.find((candidate) => candidate.id === params.turnId);
      if (thread && turn && turn.status === "inProgress") {
        turn.status = "interrupted";
        save(thread);
        ledger({ event: "turn/interrupt", threadId: thread.id, turnId: turn.id });
      }
      reply({});
      if (thread && turn) send({ method: "turn/completed", params: { threadId: thread.id, turn: { id: turn.id, status: turn.status } } });
      return;
    }
    default:
      return fail(-32601, `unsupported method ${method}`);
  }
}

/** The client is gone (its worker died or it closed the session). */
function disconnect(reason) {
  if (closing) return;
  closing = true;
  for (const key of owned) {
    const [threadId, turnId] = key.split("/");
    const thread = load(threadId);
    const turn = thread?.turns.find((candidate) => candidate.id === turnId);
    if (!thread || !turn || turn.status !== "inProgress") continue;
    if (turn.finishOnDisconnect) {
      complete(thread, turn, `fake-codex answer for ${turn.tag ?? "turn"}, finished after the client disconnected`);
    } else {
      turn.status = "interrupted";
      save(thread);
    }
    ledger({ event: "turn-client-gone", threadId, turnId, reason, outcome: turn.status });
  }
  ledger({ event: "process-exit", reason });
  process.exit(0);
}

ledger({ event: "process-start", ppid: process.ppid, args: process.argv.slice(2) });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch { send({ id: null, error: { code: -32700, message: "parse error" } }); }
});
lines.on("close", () => disconnect("stdin-closed"));
process.on("SIGTERM", () => disconnect("SIGTERM"));
process.stdout.on("error", () => disconnect("stdout-closed"));
