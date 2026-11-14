import { z } from "zod";
import { controlTargetSchema } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { makeSpaceId } from "@space/runtime";

/**
 * Held dispatch (plan clipboard:VZEewZRaodZR step R2): text Nous sends with when "calm" waits here until the server's
 * load allows it (normal: CALM; light: CALM or BUSY; urgent is never held), first in, first out per pane. Each pane's queue
 * is one Space Control record (kind nous_held, actor = owner, key = pane), so a restart or deploy drops nothing; a text
 * that cannot be delivered goes back to Nous's inbox, never away silently.
 */

export type NousLoadLevel = "CALM" | "BUSY" | "OVERLOADED";
export type HeldPriority = "normal" | "light";
/** R22-2: a model change held for a CLI still starting, applied at its first empty prompt instead of a typed text. */
export interface HeldModel { modelId: string; reasoningEffort?: string }
/** R84 12/11: a space_execute configure (account, effort, mode) held for a CLI still starting, run again once its session exists. */
export type HeldConfigure = Record<string, unknown>;
export interface HeldText { id: string; text: string; priority: HeldPriority; heldAt: string; attempts: number; model?: HeldModel; configure?: HeldConfigure }
export interface HeldQueue { status: "HELD" | "EMPTY"; roomId: string; roomName: string; paneId: string; paneName: string; items: HeldText[] }
export interface HeldDelivery { owner: string; roomId: string; paneId: string; paneName: string; text: string; model?: HeldModel; configure?: HeldConfigure }

/** Safety: a pane that is never ready gets 3 tries, then the text goes back to Nous with a line (R18-6), never lost. */
export const HELD_MAX_ATTEMPTS = 3;

/** The pane's last native turn when it already runs the held model (and effort, when one is asked), else null: such an item is dropped. */
export function heldModelRunning(model: HeldModel, seen: { tasks?: Array<{ modelsUsed: Array<{ modelId: string; reasoningEffort: string | null }> }> } | null) {
  const last = seen?.tasks?.at(-1)?.modelsUsed.at(-1);
  if (!last || last.modelId.replace(/\[[^\]]*\]$/, "") !== model.modelId) return null;
  return !model.reasoningEffort || last.reasoningEffort === model.reasoningEffort ? last : null;
}

export function mayDeliver(level: NousLoadLevel, priority: HeldPriority): boolean {
  return level === "CALM" || (level === "BUSY" && priority === "light");
}

export interface HeldDispatchDeps {
  repository: Pick<ControlRepository, "get" | "list" | "write" | "listActive">;
  level(): Promise<NousLoadLevel>;
  /** Sends the text to the pane as its next prompt (after its current turn), or sets its model; throws or returns ok false when it cannot. */
  deliver(item: HeldDelivery): Promise<{ ok: boolean; result: string }>;
  notice(owner: string, key: string, line: string): Promise<void>;
  now?(): string;
}

export function createHeldDispatch(deps: HeldDispatchDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const kind = "nous_held" as const;

  /** Changes one pane's queue with the record's version check, retried on a concurrent change. */
  async function change(owner: string, target: Omit<HeldQueue, "status" | "items">, edit: (items: HeldText[]) => HeldText[]): Promise<HeldQueue> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await deps.repository.get(kind, owner, target.paneId);
      const current = record?.value as HeldQueue | undefined;
      const items = edit([...(current?.items ?? [])]);
      const next: HeldQueue = { ...target, ...(current ? { roomName: current.roomName, paneName: current.paneName } : {}), status: items.length ? "HELD" : "EMPTY", items };
      const version = record?.version ?? 0;
      if (await deps.repository.write({ kind, actorId: owner, key: target.paneId, roomId: target.roomId, version: version + 1, value: next }, version)) return next;
    }
    throw new Error("The held queue kept changing; try again.");
  }

  async function queues(owner: string | null): Promise<Array<{ owner: string; queue: HeldQueue }>> {
    const records = deps.repository.listActive ? await deps.repository.listActive(kind, ["HELD"]) : await deps.repository.list(kind, owner);
    return records.filter((record) => owner === null || record.actorId === owner)
      .map((record) => ({ owner: record.actorId, queue: record.value as HeldQueue })).filter(({ queue }) => queue.status === "HELD" && queue.items.length > 0);
  }

  return {
    /** Holds a text for the pane; returns how many wait for it now. */
    async hold(owner: string, target: Omit<HeldQueue, "status" | "items">, text: string, priority: HeldPriority = "normal", model?: HeldModel, configure?: HeldConfigure): Promise<{ id: string; waiting: number }> {
      const id = makeSpaceId("nous_held");
      const queue = await change(owner, target, (items) => [...items, { id, text, priority, heldAt: now(), attempts: 0, ...(model ? { model } : {}), ...(configure ? { configure } : {}) }]);
      return { id, waiting: queue.items.length };
    },

    /** One line for Nous's world, or null when nothing is held. */
    async summary(owner: string): Promise<string | null> {
      const held = await queues(owner);
      if (!held.length) return null;
      const total = held.reduce((sum, { queue }) => sum + queue.items.length, 0);
      return `Held for a calm server: ${total} text${total === 1 ? "" : "s"} (${held.map(({ queue }) =>
        `${queue.roomName}/${queue.paneName} ${queue.items.length} since ${queue.items[0]!.heldAt.slice(11, 16)} UTC`).join(", ")}).`;
    },

    /** Delivers the oldest held text of each pane the load allows, one per pane per tick. */
    async tick(): Promise<{ delivered: number; failed: number }> {
      const held = await queues(null);
      if (!held.length) return { delivered: 0, failed: 0 };
      const level = await deps.level();
      const delivered = new Map<string, string[]>();
      let failed = 0;
      for (const { owner, queue } of held) {
        const item = queue.items[0]!;
        if (!mayDeliver(level, item.priority)) continue;
        const target = { roomId: queue.roomId, roomName: queue.roomName, paneId: queue.paneId, paneName: queue.paneName };
        let error: string | null = null;
        try {
          const outcome = await deps.deliver({ owner, roomId: queue.roomId, paneId: queue.paneId, paneName: queue.paneName, text: item.text, ...(item.model ? { model: item.model } : {}), ...(item.configure ? { configure: item.configure } : {}) });
          if (!outcome.ok) error = outcome.result;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        if (error === null) {
          await change(owner, target, (items) => items.filter((entry) => entry.id !== item.id));
          delivered.set(owner, [...(delivered.get(owner) ?? []), `${queue.roomName}/${queue.paneName}`]);
          continue;
        }
        // R65-1: waiting for a model's empty prompt is not a failed delivery. Keep it across long turns/drafts and startup.
        // A menu that did not confirm is a failed try (5/11 Bruno/Bob: kept forever, each minute's try ended in an Esc "Kept model").
        if ((item.model || item.configure) && /Native state is unknown|Pane has no active session|Send or clear the current CLI draft|not confirmed ready for input|Wait for (?:the OpenCode|this CLI) turn to finish|is working; change its model after the current turn|Live (?:Codex|OpenCode) model control is unavailable/i.test(error)) continue;
        // 31/10 Alex/Max: a text left as an unsent draft is in the composer and Nous already has its line; typing it again would double it.
        const drafted = /unsent draft/.test(error);
        const attempts = drafted ? HELD_MAX_ATTEMPTS : item.attempts + 1;
        await change(owner, target, (items) => attempts >= HELD_MAX_ATTEMPTS ? items.filter((entry) => entry.id !== item.id)
          : items.map((entry) => entry.id === item.id ? { ...entry, attempts } : entry));
        // 2026-10-30 REVIEW (Alex/Dana: held texts failed 3 tries twice while its Codex read UNKNOWN): a pane not ready on 2 tries is named once, before the last try.
        const what = item.model ? "model change" : item.configure ? "configure" : "text";
        if (attempts === HELD_MAX_ATTEMPTS - 1 && /not confirmed ready for input|UNKNOWN/i.test(error)) {
          await deps.notice(owner, `held-stuck:${item.id}`, `${queue.roomName}/${queue.paneName} was not ready for input on ${attempts} tries of a ${what} held since ${item.heldAt.slice(11, 16)} UTC `
            + `(${error}): read it (space_read_pane); if its CLI is stuck, restart it (space_restart_pane) and the ${what} goes after. One try is left.`);
        }
        if (attempts >= HELD_MAX_ATTEMPTS) failed++;
        if (attempts >= HELD_MAX_ATTEMPTS && !drafted) {
          await deps.notice(owner, `held-failed:${item.id}`, `A ${what} held for ${queue.roomName}/${queue.paneName} since ${item.heldAt.slice(11, 16)} UTC could not be delivered `
            + `(${HELD_MAX_ATTEMPTS} tries: ${error}). ${item.model || item.configure ? `It was: ${item.text}. Set it again or drop it.` : `Its text: "${item.text}". Send it again or drop it.`}`);
        }
      }
      for (const [owner, panes] of delivered) {
        await deps.notice(owner, "held-delivered", `The server is ${level}: delivered ${panes.length} held text${panes.length === 1 ? "" : "s"} to ${panes.join(", ")}.`);
      }
      return { delivered: [...delivered.values()].reduce((sum, panes) => sum + panes.length, 0), failed };
    }
  };
}

export type HeldDispatch = ReturnType<typeof createHeldDispatch>;

/** A space_execute pane prompt held until the server's load allows it (Space Control's own actions know only NOW and AFTER_TURN). */
export const calmPromptActionSchema = z.object({
  // Daily Nous errors F (7-8/11: 3 calls refused "when: expected NOW|AFTER_TURN; Unrecognized key: priority"): a calm prompt names its
  // panes like any prompt (names, state); the handler turns names into ids before the hold.
  kind: z.literal("pane"), operation: z.literal("prompt"), target: controlTargetSchema.extend({ state: controlTargetSchema.shape.state.unwrap().optional() }),
  text: z.string().trim().min(1).max(20_000), when: z.literal("calm"), priority: z.enum(["normal", "light", "urgent"]).optional()
}).strict().describe("A pane prompt sent once the server's load allows it: normal waits for CALM, light also goes when BUSY, urgent at once.");

/** What Nous's tools need: the load level now and the hold. */
export interface NousHeld { level(): Promise<NousLoadLevel>; hold: HeldDispatch["hold"] }
export type HeldTarget = Omit<HeldQueue, "status" | "items">;
export type HeldPriorityArg = HeldPriority | "urgent";

/** space_send_to_pane with when "calm": holds the text for each pane when the load does not allow it now; null when it may go now. */
export async function holdUnlessAllowed(held: NousHeld, owner: string, targets: HeldTarget[], text: string, priority: HeldPriorityArg = "normal"): Promise<string | null> {
  if (priority === "urgent") return null;
  const level = await held.level();
  if (mayDeliver(level, priority)) return null;
  const waiting = await Promise.all(targets.map((target) => held.hold(owner, target, text, priority)));
  return `The server is ${level}: held for ${targets.map((target, index) => `${target.paneName} (${waiting[index]!.waiting} waiting)`).join(", ")}. `
    + "It goes when the server allows and you hear back in the inbox; priority \"urgent\" sends at once.";
}

/**
 * space_execute: pane prompt actions with when "calm" (and an optional priority) are held like space_send_to_pane's;
 * when the load allows they run now after the pane's turn. The rest of the batch is returned as it came.
 */
export async function holdCalmPrompts(held: NousHeld, owner: string, room: { id: string; name: string }, panes: Array<{ id: string; paneName?: string | null; title: string }>,
  actions: Array<Record<string, unknown>>): Promise<{ actions: Array<Record<string, unknown>>; held: string[] }> {
  const run: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  for (const action of actions) {
    const paneIds = (action.target as { paneIds?: unknown } | undefined)?.paneIds;
    if (action.kind !== "pane" || action.operation !== "prompt" || action.when !== "calm" || typeof action.text !== "string") { run.push(action); continue; }
    // A name the room has no open pane for goes on after the turn, so Space Control names it.
    const rest = Object.fromEntries(Object.entries(action).filter(([key]) => key !== "priority"));
    if (!Array.isArray(paneIds) || !paneIds.length || (action.target as { paneNames?: unknown[] }).paneNames?.length) { run.push({ ...rest, when: "AFTER_TURN" }); continue; }
    const targets = paneIds.map((paneId) => { const pane = panes.find((entry) => entry.id === paneId);
      return { roomId: room.id, roomName: room.name, paneId: String(paneId), paneName: pane ? pane.paneName ?? pane.title : String(paneId) }; });
    const priority = action.priority === "light" || action.priority === "urgent" ? action.priority : "normal";
    const note = await holdUnlessAllowed(held, owner, targets, action.text, priority);
    if (note) notes.push(note);
    else run.push({ kind: "pane", operation: "prompt", target: { paneIds }, text: action.text, when: "AFTER_TURN" });
  }
  return { actions: run, held: notes };
}
