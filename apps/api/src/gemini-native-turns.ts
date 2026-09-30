import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findGeminiProcessTree, readPaneStateRecord } from "./gemini-session-verification.js";
import { geminiNativeConversationIdPattern, normalizeGeminiPaneId } from "./gemini-native-session.js";
import type { NativeTaskExecution } from "./room-task-telemetry.js";

// Antigravity 1.2.11 gemini_coder.Step protobuf. Unknown formats fail closed.
// Only user input, public response and timing/model metadata are decoded.
type Fields = Map<number, Array<number | Uint8Array>>;
function fields(bytes: Uint8Array): Fields {
  if (bytes.length > 1_048_576) throw Error("Native step is too large");
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 56; shift += 7) {
      if (offset >= bytes.length) throw Error("Truncated native protobuf");
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw Error("Invalid native integer");
      if (!(byte & 128)) return value;
    }
    throw Error("Invalid native varint");
  };
  for (let count = 0; offset < bytes.length; count++) {
    if (count >= 512) throw Error("Too many native fields");
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (field < 1) throw Error("Invalid native field");
    let value: number | Uint8Array;
    if (wire === 0) value = varint();
    else if (wire === 2 || wire === 1 || wire === 5) {
      const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (size > bytes.length - offset) throw Error("Truncated native field");
      value = bytes.subarray(offset, offset + size); offset += size;
      if (wire !== 2) continue;
    } else throw Error("Unsupported native wire type");
    const values = result.get(field) ?? []; values.push(value); result.set(field, values);
  }
  return result;
}
const one = (value: Fields, field: number) => value.get(field)?.[0];
function text(value: Fields, field: number, max = 20_000): string | null {
  const bytes = one(value, field);
  return bytes instanceof Uint8Array && bytes.length <= max ? Buffer.from(bytes).toString("utf8") : null;
}
function nested(value: Fields, field: number): Fields {
  const bytes = one(value, field);
  return fields(bytes instanceof Uint8Array ? bytes : new Uint8Array());
}
function timestamp(value: Fields, field: number): string | null {
  const time = nested(value, field), seconds = one(time, 1), nanos = one(time, 2) ?? 0;
  if (typeof seconds !== "number" || typeof nanos !== "number" || seconds <= 0 || seconds > 100_000_000_000 || nanos >= 1e9) return null;
  return new Date(seconds * 1000 + nanos / 1e6).toISOString();
}

export interface GeminiNativeTurn extends NativeTaskExecution {
  inputText: string;
  finalResponse: string | null;
  aborted: boolean;
}
interface StepRow { idx: number; step_type: number; status: number; step_format: number; metadata: Uint8Array; step_payload: Uint8Array }

export function geminiNativeTurnsFromRows(rows: StepRow[]): GeminiNativeTurn[] {
  const turns = new Map<string, GeminiNativeTurn>();
  const turnByStepId = new Map<string, GeminiNativeTurn>();
  let activeTurn: GeminiNativeTurn | null = null;
  for (const row of rows) {
    if (row.step_format !== 0) throw Error("Unsupported native step format");
    const payload = fields(row.step_payload), metadata = fields(row.metadata);
    if (one(payload, 1) !== row.step_type || (one(payload, 4) ?? 0) !== row.status) throw Error("Native step columns disagree");
    const id = text(metadata, 12), createdAt = timestamp(metadata, 1);
    if (!id || !geminiNativeConversationIdPattern.test(id)) continue;
    if (row.step_type === 14) {
      if (turns.has(id)) throw Error("Duplicate native execution identity");
      const input = nested(payload, 19), title = text(input, 2) ?? text(input, 1);
      if (!title || !createdAt) continue;
      const newTurn: GeminiNativeTurn = { taskId: id, title: title.slice(0, 2000), inputText: title, status: "RUNNING", finalResponse: null, aborted: false,
        timing: { startedAt: createdAt, completedAt: null, durationMs: null, source: "NATIVE", observedAt: createdAt }, modelsUsed: [] };
      turns.set(id, newTurn);
      turnByStepId.set(id, newTurn);
      activeTurn = newTurn;
      continue;
    }
    if (row.step_type === 101) {
      if (activeTurn) {
        turnByStepId.set(id, activeTurn);
        activeTurn.finalResponse = null;
        activeTurn.status = "RUNNING";
        activeTurn.timing.completedAt = null;
        activeTurn.timing.durationMs = null;
        if (createdAt) activeTurn.timing.observedAt = createdAt;
      }
      continue;
    }
    const turn = turnByStepId.get(id) ?? turns.get(id);
    if (!turn) continue; // A bounded tail without its user input is not evidence.
    turnByStepId.set(id, turn);
    activeTurn = turn;
    turn.finalResponse = null; turn.status = "RUNNING";
    turn.timing.completedAt = null; turn.timing.durationMs = null;
    const completedAt = timestamp(metadata, 8);
    const lastAt = completedAt ?? timestamp(metadata, 7) ?? createdAt;
    if (lastAt) turn.timing.observedAt = lastAt;
    const modelInfo = nested(metadata, 24), model = text(modelInfo, 8, 200) ?? text(modelInfo, 12, 200);
    // Numeric placeholder model enums are not resolved from pane settings.
    if (model && turn.modelsUsed.at(-1)?.modelId !== model) turn.modelsUsed.push({ providerId: null, modelId: model,
      reasoningEffort: null, turnId: id, startedAt: timestamp(metadata, 32) ?? createdAt, completedAt, source: "NATIVE" });
    if (row.step_type !== 132 && [6, 12].includes(row.status)) { turn.status = "INTERRUPTED"; turn.aborted = true; continue; }
    if (row.step_type !== 132 && [4, 7].includes(row.status)) { turn.status = "UNKNOWN"; turn.aborted = true; continue; }
    if (row.step_type === 17) { turn.status = "UNKNOWN"; continue; } // DONE error messages may precede retries.
    const response = nested(payload, 20), answer = text(response, 1);
    // STOP_PATTERN=2 is the verified native final reply. Tool calls, errors,
    // max-token stops, FINISH guesses, idle screens and partial output are not.
    if (!turn.aborted && row.step_type === 15 && row.status === 3 && one(response, 12) === 2 &&
        !response.has(7) && answer?.trim() && completedAt && Date.parse(completedAt) >= Date.parse(turn.timing.startedAt!)) {
      turn.status = "COMPLETED"; turn.finalResponse = answer;
      turn.timing.completedAt = completedAt;
      turn.timing.durationMs = Date.parse(completedAt) - Date.parse(turn.timing.startedAt!);
    }
  }
  return [...turns.values()];
}

/** Read one already-bound DB, in a bounded, consistent read-only snapshot. */
export function readGeminiTurnDatabase(path: string): GeminiNativeTurn[] | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=25; BEGIN");
    const size = db.prepare("SELECT sum(size) AS bytes FROM (SELECT length(metadata)+length(step_payload) AS size FROM steps ORDER BY idx DESC LIMIT 512)").get();
    if (typeof size?.bytes === "number" && size.bytes > 8_388_608) return null;
    const rows = db.prepare("SELECT idx,step_type,status,step_format,metadata,step_payload FROM steps ORDER BY idx DESC LIMIT 512").all() as unknown as StepRow[];
    return geminiNativeTurnsFromRows(rows.reverse());
  } catch { return null; }
  finally { db?.close(); }
}

/** Pane maps and profile-wide history cannot prove current session ownership. */
export async function readGeminiNativeTurns(input: { paneId: string; sessionId: string; rootPid: number | null }, procRoot = "/proc") {
  if (!input.rootPid) return null;
  let process = await findGeminiProcessTree(input.rootPid, procRoot);
  if (!process?.sessionId || !process.conversationId) {
    // sudo owns the host's root process; its children list may be unreadable
    // even to the native CLI user. The launcher record provides only a PID
    // hint: verify ancestry, then re-read identity and DB handles from /proc.
    const record = await readPaneStateRecord(normalizeGeminiPaneId(input.paneId));
    if (!record?.pid || !Number.isSafeInteger(record.pid) || record.pid <= 1 ||
        record.sessionId !== input.sessionId || record.paneId !== input.paneId) return null;
    let ancestor = record.pid;
    for (let depth = 0; ancestor !== input.rootPid && depth < 8 && ancestor > 1; depth++) {
      const stat = await readFile(join(procRoot, String(ancestor), "stat"), "utf8").catch(() => "");
      ancestor = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }
    if (ancestor !== input.rootPid) return null;
    process = await findGeminiProcessTree(record.pid, procRoot);
  }
  if (!process?.home || process.sessionId !== input.sessionId || !process.paneId ||
      normalizeGeminiPaneId(process.paneId) !== normalizeGeminiPaneId(input.paneId) ||
      !process.conversationId || !geminiNativeConversationIdPattern.test(process.conversationId)) return null;
  const turns = readGeminiTurnDatabase(join(process.home, ".gemini", "antigravity-cli", "conversations", `${process.conversationId}.db`));
  return turns ? { conversationId: process.conversationId, turns } : null;
}

export function validGeminiTurnReadIdentity(input: { paneId: string; sessionId: string; rootPid: number | null }): boolean {
  return /^pane:[A-Za-z0-9_-]{6,80}$/.test(input.paneId) && /^cli_session:[A-Za-z0-9_-]{6,80}$/.test(input.sessionId) &&
    Number.isSafeInteger(input.rootPid) && input.rootPid! > 1 && input.rootPid! < 2 ** 31;
}

/** Fixed launcher read adapter; private native databases keep their permissions. */
export async function loadGeminiNativeTurns(input: { paneId: string; sessionId: string; rootPid: number | null }) {
  if (!validGeminiTurnReadIdentity(input)) return null;
  try {
    const { stdout } = await promisify(execFile)("/opt/spaceapp/bin/gemini-vscode-parity",
      ["native-turns", input.paneId, input.sessionId, String(input.rootPid)],
      { timeout: 2000, maxBuffer: 8_388_608, env: { PATH: "/usr/bin:/bin" } });
    return JSON.parse(stdout) as Awaited<ReturnType<typeof readGeminiNativeTurns>>;
  } catch { return null; }
}

export function geminiTurnActivity(turns: GeminiNativeTurn[], marker: string, recovery: { markerAtMs: number; turnId?: string | null; inputMarker?: string }) {
  const matching = recovery.turnId ? turns.filter(turn => turn.taskId === recovery.turnId) : turns.filter(turn =>
    turn.inputText.includes(recovery.inputMarker ?? marker) && Date.parse(turn.timing.startedAt!) >= recovery.markerAtMs - 1000);
  if (matching.length !== 1) return { marker, status: matching.length || recovery.turnId ? "UNAVAILABLE" as const : "PENDING" as const, turnId: null };
  const turn = matching[0]!;
  return { marker, turnId: turn.taskId, status: turn.aborted ? "ABORTED" as const : turn.status === "COMPLETED" ? "COMPLETED" as const : "RUNNING" as const,
    lastActivityAtMs: Date.parse(turn.timing.observedAt) };
}
