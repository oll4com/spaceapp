import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI_PANE_TYPES, type Pane, type Room } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { quotaGroupForModel } from "@space/gateway";
import { longQuotaWait, waitsForQuota } from "../agents-dashboard.js";
import type { DashboardAgentsSample } from "../room-routes.js";
import { paneLabel } from "./digest.js";
import { nousProviderAdvice, type NousProviderRoom } from "./tokens.js";

/**
 * Operator 14/11 19:56 BKK (nous_msg:f0d48b42f0594abea09e2bca): «Codex tokens are exhausted, so the Codex tasks should go to Claude …
 * Close the Codex panes and give the tasks to other providers! Always work this way.» A CLI pane stopped on its provider's quota while
 * that pool has no room hands its task to a pool with room (code: Claude Opus 5.5, else Antigravity Gemini 4 Neon when Claude has no
 * room — operator 22/11 nous_msg:719620b3a7bb46fd8d85f717 — else GPT-6 Astra while Codex has room, never Sol; other work: Gemini),
 * then closes. Nous's tools refuse to put work onto a pool the provider advice marks "avoid (no room now)".
 */

/** nousProviderAdvice's own minimum: under it a pool has "no room now". */
const ROOM_PERCENT = 10;
/** space_send_to_pane's text maximum (its schema): the one bound on the handover text. */
const SEND_MAX = 20_000;
export const HANDOVER_TURN = "quota-handover";

/** The quota pool (tokens.ts POOLS) a CLI's work draws on; null for runtimes Space reads no quota for. Antigravity serves Claude and GPT from its own pool. */
export function quotaPool(runtimeId: string | null | undefined, modelId?: string | null): string | null {
  if (runtimeId === "cli:codex") return "codex";
  if (runtimeId === "cli:claude") return "claude";
  if (runtimeId === "cli:gemini") {
    const group = quotaGroupForModel(modelId);
    return group === "gemini" ? group : `antigravity-${group}`;
  }
  // nous_msg:35d3e36f8d414784bde8e43f: a space-gateway-claude model on OpenCode and other non-Claude-Code CLIs bills the Claude API key.
  if (/^space-gateway-claude[/:]/i.test(modelId ?? "")) return "anthropic";
  return null;
}

/** A pane type id or alias (space_open_panes, Space Control's panes.open counts) as its CLI runtime; Codex light runs Codex. */
export function runtimeOfType(type: string): string | null {
  const key = type.trim().toLowerCase();
  if (key === "codex-light") return "cli:codex";
  return CLI_PANE_TYPES.find((entry) => entry.typeId === key || (entry.aliases as readonly string[]).includes(key))?.id ?? null;
}

/** The pools Space's provider advice marks "avoid (no room now)". A pool holding reset credits is never one (only the operator spends them). */
export const noRoomPools = (rooms: NousProviderRoom[]): NousProviderRoom[] =>
  nousProviderAdvice(rooms, ROOM_PERCENT).avoid.filter((entry) => entry.why === "no room now" || entry.why === "quota unknown").map((entry) => entry.room);

/**
 * Operator 17/11 (nous_msg:a0e6a7a4da2944d0af75ce09, nous_msg:35d3e36f8d414784bde8e43f; 11:20 BKK set_pane_model said "Max has room" while
 * noRoomGuard said "no room now"): the one "Claude Max has no room" test both guards use. True when no Max account is usable or the advice
 * marks Claude Max "avoid (no room now)": then the Claude API key serves code panes; otherwise Max goes first.
 */
export function claudeMaxHasNoRoom(rooms: NousProviderRoom[]): boolean {
  const max = rooms.find((room) => room.key === "claude");
  return !max?.accounts || noRoomPools(rooms).includes(max);
}

/** The API pools the advice marks "avoid (no balance left)": the Claude API key out of budget takes no pane's work. */
export const noBalancePools = (rooms: NousProviderRoom[]): NousProviderRoom[] =>
  nousProviderAdvice(rooms, ROOM_PERCENT).avoid.filter((entry) => entry.why === "no balance left").map((entry) => entry.room);

export interface HandoverTarget { pool: string; type: string; modelId: string | null; name: string; runtimeId: string }
const ROUTES: Record<"code" | "other", HandoverTarget[]> = {
  code: [{ pool: "claude", type: "claude", modelId: "claude-opus-5-5", name: "Claude Opus 5.5", runtimeId: "cli:claude" },
    { pool: "gemini", type: "gemini", modelId: "gemini-4-neon", name: "Gemini 4 Neon", runtimeId: "cli:gemini" },
    { pool: "codex", type: "codex", modelId: "gpt-6-astra", name: "GPT-6 Astra", runtimeId: "cli:codex" }],
  other: [{ pool: "gemini", type: "gemini", modelId: null, name: "Gemini", runtimeId: "cli:gemini" },
    { pool: "claude", type: "claude", modelId: "claude-opus-5-5", name: "Claude Opus 5.5", runtimeId: "cli:claude" }]
};
const hasRoom = (room: NousProviderRoom | undefined): boolean => Boolean(room?.accounts && (room.nowLeft ?? 0) >= ROOM_PERCENT);

/** The first route whose pool has room now (an account with at least 10% of its window), or null when none has. */
export function handoverTarget(rooms: NousProviderRoom[], code: boolean): HandoverTarget | null {
  return ROUTES[code ? "code" : "other"].find((route) => hasRoom(rooms.find((room) => room.key === route.pool))) ?? null;
}

/** Where work goes instead, for a refusal: the code and the other route with room, or that none has. */
export function withRoomText(rooms: NousProviderRoom[]): string {
  const code = handoverTarget(rooms, true);
  const other = handoverTarget(rooms, false);
  if (!code && !other) return "No provider Space routes work to has room now either: the work waits for a reset.";
  const route = (target: HandoverTarget) => `${target.name} (pane type ${target.type}${target.modelId ? `, model ${target.modelId}` : ""})`;
  return `Give the work to a provider with room: ${[code && `code → ${route(code)}`, other && `other work → ${route(other)}`].filter(Boolean).join("; ")}`
    + " (GPT-6 Astra only while Codex has room, never Sol).";
}

/** Code work: the pane works inside a git checkout (a worktree's .git is a file). */
export function insideGit(cwd: string | null | undefined): boolean {
  for (let dir = cwd?.trim() || ""; dir && dir !== "."; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
  return false;
}

export function handoverText(from: Pane, roomName: string, pool: string, target: HandoverTarget, reports: string, code: boolean): string {
  const task = from.taskMetadata;
  const head = [`Handover from ${paneLabel(from)} in room "${roomName}": its ${pool} quota is used up (Space's provider advice: no room now), so its task is yours now `
    + `on ${target.name}. Continue it from where it stopped; do not start over, and report with space-progress as it did.`,
  `Task: ${from.title}${task?.description ? `\n${task.description}` : ""}`,
  ...(task?.steps.length ? [`Steps: ${task.steps.map((step, index) => `${index + 1}. ${step}`).join(" ")}`] : []),
  ...(task?.planId ? [`Plan: ${task.planId}`] : []),
  ...(from.cwd ? [code ? `Working directory: ${from.cwd}. Its uncommitted work is there: read \`git -C ${from.cwd} status --short\` and \`git -C ${from.cwd} diff\` first, and keep working in that checkout.`
    : `Working directory: ${from.cwd}.`] : []),
  ""].join("\n");
  const cut = `\n… (cut at the ${SEND_MAX}-character limit of one prompt; the rest of ${paneLabel(from)}'s reports stays in its pane reports in Space)`;
  return head + (head.length + reports.length > SEND_MAX ? reports.slice(0, SEND_MAX - head.length - cut.length) + cut : reports);
}

export interface QuotaHandoverRecord { status: "HANDING_OVER" | "HANDED_OVER" | "NO_ROOM"; since: string | null; at: string; to?: string }
export interface QuotaHandoverOutcome { ok: boolean; result: string }
export interface QuotaHandoverDeps {
  /** Owners whose Nous works on their behalf. */
  owners(): Promise<string[]>;
  /** The owner's live rooms, agents' test rooms left out. */
  rooms(owner: string): Promise<Room[]>;
  readActivity(roomId: string): Promise<DashboardAgentsSample>;
  providerRooms(owner: string): Promise<NousProviderRoom[]>;
  listPanes(roomId: string): Promise<Pane[]>;
  /** A Nous tool run as Space (turn HANDOVER_TURN): open, set model, send and close go through the tools' own guards and held queue. */
  execute(owner: string, tool: string, args: Record<string, unknown>): Promise<QuotaHandoverOutcome>;
  /** The pane's progress reports as text, newest first. */
  reports(owner: string, pane: Pane): Promise<string>;
  record: { get(paneId: string): Promise<{ version: number; value: QuotaHandoverRecord } | null>; write(pane: Pane, value: QuotaHandoverRecord, expectedVersion: number): Promise<boolean> };
  notice(owner: string, key: string, text: string): Promise<void>;
  isCode?(cwd: string | null): boolean;
  now?(): number;
}

/** The handover records in Space Control's pane_state, as claude-limit-move.ts keeps its pace holds. */
export function controlQuotaHandovers(records: Pick<ControlRepository, "get" | "write">): QuotaHandoverDeps["record"] {
  const key = (paneId: string) => `quota-handover:${paneId}`;
  return {
    async get(paneId) {
      const record = await records.get("pane_state", "space", key(paneId));
      return record ? { version: record.version, value: record.value as QuotaHandoverRecord } : null;
    },
    write: (pane, value, expectedVersion) => records.write({ kind: "pane_state", actorId: "space", key: key(pane.id), roomId: pane.roomId, version: expectedVersion + 1, value }, expectedVersion)
  };
}

/** A claim older than this is a handover a restart cut off: it runs again. */
const CLAIM_STALE_MS = 30 * 60_000;

export function createQuotaHandover(deps: QuotaHandoverDeps) {
  const isCode = deps.isCode ?? insideGit;
  const now = () => deps.now?.() ?? Date.now();
  let running = false;

  async function handOver(owner: string, room: Room, sample: DashboardAgentsSample, pane: Pane, rooms: NousProviderRoom[], pool: NousProviderRoom, taken: Set<string>): Promise<void> {
    const since = sample.details[pane.id]?.since ?? null;
    const record = await deps.record.get(pane.id);
    const same = record?.value.since === since ? record!.value : null;
    if (same?.status === "HANDED_OVER" || (same?.status === "HANDING_OVER" && now() - Date.parse(same.at) < CLAIM_STALE_MS)) return;
    const code = isCode(pane.cwd);
    const target = handoverTarget(rooms, code);
    const at = new Date(now()).toISOString();
    if (!target) {
      if (same?.status === "NO_ROOM") return;
      if (await deps.record.write(pane, { status: "NO_ROOM", since, at }, record?.version ?? 0)) {
        await deps.notice(owner, `quota-handover:${pane.id}`, `Room "${room.name}" pane ${paneLabel(pane)} stopped on its ${pool.name} quota and no provider with room can take its `
          + `${code ? "code " : ""}task now (${withRoomText(rooms)}). It waits for its reset; Space hands it over once a provider has room.`);
      }
      return;
    }
    if (!await deps.record.write(pane, { status: "HANDING_OVER", since, at }, record?.version ?? 0)) return;
    let version = (record?.version ?? 0) + 1;
    /** The quota pane closed first, its slot given to its successor in a room at its pane cap. */
    let freed = false;
    const fail = async (why: string) => {
      await deps.notice(owner, `quota-handover:${pane.id}`, `Room "${room.name}" pane ${paneLabel(pane)} stopped on its ${pool.name} quota; Space could not hand its task to ${target.name}: ${why}. `
        + (freed ? `It was closed to make room for its successor: reopen it with its history (space_execute {kind: "pane", operation: "reopen"}).` : "It stays open and waits for its reset."));
    };
    // The record is what lets the quota guard pass the close (wiring quotaWaits' handedOver).
    const handed = async (status: QuotaHandoverRecord["status"], to?: string) => {
      if (await deps.record.write(pane, { status, since, at: new Date(now()).toISOString(), ...(to ? { to } : {}) }, version)) version += 1;
    };
    const close = () => deps.execute(owner, "space_close_pane", { room: room.id, panes: [pane.id] });
    // Reuse a pane of the target's CLI at its prompt with no task (not one this pass already gave a task); else open one in the same room.
    const idle = sample.data.find((entry) => !entry.isClosed && !taken.has(entry.id) && entry.mode === "TERMINAL" && entry.terminalRuntimeId === target.runtimeId
      && sample.details[entry.id]?.status === "idle" && !sample.details[entry.id]?.reason);
    let to = idle ?? null;
    if (!to) {
      const open = async () => {
        const before = new Set((await deps.listPanes(room.id)).map((entry) => entry.id));
        const opened = await deps.execute(owner, "space_open_panes", { room: room.id, panes: [{ type: target.type, count: 1 }] });
        return { opened, to: opened.ok ? (await deps.listPanes(room.id)).find((entry) => !before.has(entry.id) && !entry.isClosed) ?? null : null };
      };
      let { opened, to: fresh } = await open();
      // Cleo 14/11 (16 of 16 panes): the open was refused at the room's pane cap and Dana and Finn stayed open on Codex 0%; the quota pane's own slot takes its successor.
      if (!opened.ok && /is capped at \d+ active panes/.test(opened.result)) {
        await handed("HANDED_OVER");
        const closed = await close();
        if (!closed.ok) {
          await handed("HANDING_OVER");
          return fail(`the room is at its pane cap and ${paneLabel(pane)} could not close to make room: ${closed.result}`);
        }
        freed = true;
        ({ opened, to: fresh } = await open());
      }
      to = fresh;
      if (!to) return fail(opened.ok ? "the opened pane was not found" : opened.result);
    }
    taken.add(to.id);
    const model = target.modelId ? await deps.execute(owner, "space_set_pane_model", { room: room.id, pane: to.id, modelId: target.modelId, when: "after_turn" }) : null;
    if (model && !model.ok) return fail(model.result);
    const sent = await deps.execute(owner, "space_send_to_pane", { room: room.id, panes: [to.id],
      text: handoverText(pane, room.name, pool.name, target, await deps.reports(owner, pane).catch(() => ""), code), when: "after_turn" });
    if (!sent.ok) return fail(sent.result);
    await handed("HANDED_OVER", to.id);
    const closed = freed ? { ok: true, result: "" } : await close();
    await deps.notice(owner, `quota-handover:${pane.id}`, `Room "${room.name}": ${paneLabel(pane)} stopped on its ${pool.name} quota (no room now), so Space handed its `
      + `${code ? "code " : ""}task to ${paneLabel(to)} on ${target.name}${idle ? "" : " (opened for it)"}`
      + ", "
      + (closed.ok ? `and closed ${paneLabel(pane)}${freed ? " first to make room (the room was at its pane cap)" : ""} (reopenable with its history).` : `and left ${paneLabel(pane)} open: ${closed.result}`));
  }

  return {
    /** One pass over every room of every owner whose Nous works on their behalf; a pass still running skips this one. */
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        const taken = new Set<string>();
        for (const owner of await deps.owners()) {
          const rooms = await deps.providerRooms(owner).catch(() => [] as NousProviderRoom[]);
          for (const room of await deps.rooms(owner)) {
            const sample = await deps.readActivity(room.id).catch(() => null);
            // shortcut: plain CLI terminals only; a copilot pane on an exhausted pool keeps waiting (its own CLI, rail and memory), until copilots get a model switch here.
            for (const pane of sample?.data.filter((entry) => !entry.isClosed && entry.mode === "TERMINAL" && waitsForQuota(sample.details[entry.id])) ?? []) {
              const key = quotaPool(pane.terminalRuntimeId, sample!.details[pane.id]?.modelId ?? pane.modelId);
              const pool = rooms.find((entry) => entry.key === key);
              // 22/11 (~25 panes at "resets in 64-70h"): a pane whose own reset is over an hour away is out until then, whatever its pool reads.
              if (pool && (!hasRoom(pool) || longQuotaWait(sample!.details[pane.id]?.resetsAt, now()))) await handOver(owner, room, sample!, pane, rooms, pool, taken);
            }
          }
        }
      } finally { running = false; }
    }
  };
}
