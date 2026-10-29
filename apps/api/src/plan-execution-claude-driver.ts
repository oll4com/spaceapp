import { randomUUID } from "node:crypto";
import { CodexManagedTurnDeliveryError, CodexSettingsRejectedError, type CodexAcceptedTurnSelection, type CodexManagedTurnEvidence,
  type CodexNativeThread, type CodexNativeTurn } from "@space/codex-app-server";
import type { Pane, PaneCliModelSettings, PaneCliSession } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { ClaudeNativeTurns } from "./claude-native-turns.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { ManagedTurnDriver } from "./plan-execution-controller.js";
import { atEmptyPrompt } from "./room-agent-autopilot.js";
import type { RoomPaneObservation } from "./room-pane-control.js";

/** What the Claude driver needs from one validated live Claude Code pane session (wired in app.ts). */
export interface ClaudeManagedTurnDeps {
  cwd: string;
  /** The native-turns reader; `fresh` skips its few-second cache. */
  turns(fresh?: boolean): Promise<ClaudeNativeTurns | null>;
  /** The pane as Space Control sees it (idle, empty composer, usage limit); `fresh` skips its cache. */
  inspect(fresh?: boolean): Promise<RoomPaneObservation>;
  settings(): Promise<PaneCliModelSettings>;
  /** The pane's native /model picker, session only ("s"), with screen readback. */
  applyModel(modelId: string, reasoningEffort: string): Promise<void>;
  /** Runs terminal input exclusively (no other model switch or prompt interleaves). */
  serialize<T>(work: () => Promise<T>): Promise<T>;
  /** submitCliPrompt: bracketed paste, Enter, confirmed out of the composer. */
  submit(text: string): Promise<void>;
  /** Sends keys to the pane: Esc interrupts a turn, Ctrl+C clears the composer. */
  press(keys: string): Promise<void>;
  /** The screen with faint cells blanked (Claude's prompt suggestion is no draft). */
  screen(): Promise<string>;
  wait?(ms: number): Promise<void>;
  /** The controller keeps only a fixed status reason; the driver's own failure text goes to the API log. */
  log?(step: string, error: unknown): void;
  now?(): number;
}

const NOTIFICATION_TITLE = "Background task notification";
const IDLE_SETTLED_MS = 5_000;
// Claude has no clientUserMessageId: the START command id leads its prompt and the transcript's user record.
const planMarker = (commandId: string) => `[space-plan:${commandId}]`;
const markerPattern = /^\[space-plan:([A-Za-z0-9-]{1,80})\]/;
const family = (modelId: string | null | undefined) => modelId?.toLowerCase().match(/\b(opus|sonnet|haiku|fable)\b/)?.[1] ?? null;

export function claudePlanPrompt(commandId: string, prompt: string, outputSchema: Record<string, unknown> | undefined): string {
  return [planMarker(commandId), prompt.trim(),
    `Finish your answer with exactly one fenced \`\`\`json block holding the stage result, valid against this JSON schema:\n${JSON.stringify(outputSchema ?? {})}`].join("\n\n");
}

/** Claude's composer (from its last ❯ line to the rule under it) ends with this prompt, or holds it as a pasted-text placeholder. */
export function composerHolds(screen: string, prompt: string): boolean {
  const lines = screen.split("\n");
  const at = lines.findLastIndex((line) => /^[ \t\u00a0]*❯/.test(line));
  if (at < 0) return false;
  const end = lines.findIndex((line, index) => index > at && /^[\s─━]+$/.test(line) && /[─━]/.test(line));
  const held = lines.slice(at, end < 0 ? undefined : end).join("").replace(/\s+/g, "").slice(1);
  return held !== "" && (held.endsWith(prompt.replace(/\s+/g, "").slice(-48)) || /^\[Pastedtext#\d+/.test(held));
}

/** The last ```json block of a turn's final answer. */
export function claudePlanResultText(answer: string | null | undefined): string | null {
  return [...(answer ?? "").matchAll(/```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].at(-1)?.[1]?.trim() || null;
}

type Pending = { threadId: string; modelId: string; reasoningEffort: string; observedAt: string; evidence: CodexManagedTurnEvidence; text: string; turnId?: string };
// Observations outlive one driver: the controller resolves a new driver per step and keeps the observation per START.
const pendingTurns = new Map<string, Pending>();

/** Maps Claude's transcript to the native thread the controller reads; also settles the evidence of observed START turns. */
export function claudeNativeThread(native: ClaudeNativeTurns, input: { cwd: string; modelId: string; reasoningEffort: string; atEmptyPrompt: boolean; now?: number }): CodexNativeThread {
  const results = new Map((native.turnResults ?? []).map((result) => [result.taskId, result]));
  const statusAt = native.statusUpdatedAt ? Date.parse(native.statusUpdatedAt) : NaN;
  const live = native.busy || native.status === "waiting";
  const now = input.now ?? Date.now();
  const tasks = native.tasks.filter((task) => task.title !== NOTIFICATION_TITLE).slice(-64);
  const turns = tasks.map((task, index): CodexNativeTurn => {
    const result = results.get(task.taskId);
    const commandId = task.title.match(markerPattern)?.[1];
    let status: CodexNativeTurn["status"];
    if (result?.ended === "INTERRUPTED") status = "interrupted";
    else if (result?.ended === "COMPLETED") status = result.apiError ? "failed" : "completed";
    else if (!result) status = task.status === "RUNNING" ? "inProgress" : task.status === "COMPLETED" ? "completed" : "interrupted";
    // Open in the transcript: running while Claude is busy or waiting, and until its idle status, newer than the prompt,
    // has settled (Claude flushes the transcript after it writes idle; a turn_duration is occasionally never written).
    else if (index === tasks.length - 1 && (live || !(statusAt >= Date.parse(task.timing.startedAt ?? "")) || now - statusAt < IDLE_SETTLED_MS)) status = "inProgress";
    // Idle with no answer at all: Esc cancelled it before its first answer, which Claude Code records nowhere.
    else status = result.apiError ? "failed" : !result.answer && task.modelsUsed.length === 0 ? "interrupted" : "completed";
    const retryAfterMs = result?.apiError === "rate_limit" && result.resetsAt ? Math.max(0, Date.parse(result.resetsAt) - now) : undefined;
    const pending = commandId ? pendingTurns.get(commandId) : undefined;
    if (pending && pending.evidence.status === "OBSERVING" && status !== "inProgress") {
      // Claude records the model and effort each answer used: every one must be the stage's selection.
      const consistent = task.modelsUsed.every((used) => family(used.modelId) !== null && family(used.modelId) === family(pending.modelId) &&
        (!used.reasoningEffort || used.reasoningEffort === pending.reasoningEffort));
      const selection: CodexAcceptedTurnSelection = { source: "NATIVE_ACCEPTED_TURN_CONFIGURATION", modelId: pending.modelId,
        reasoningEffort: pending.reasoningEffort, threadId: pending.threadId, turnId: task.taskId, commandId: commandId!,
        observedAt: pending.observedAt, completedAt: task.timing.completedAt ?? new Date(now).toISOString(),
        transport: "CONTINUOUS_NATIVE_NOTIFICATIONS", providerTelemetry: false };
      pending.evidence = consistent ? { status: "VERIFIED", selection } : { status: "INVALID", selection: null };
    }
    return { id: task.taskId, status, clientUserMessageIds: commandId ? [commandId] : [], userMessageCount: 1,
      resultText: status === "completed" ? claudePlanResultText(result?.answer) : null, itemsComplete: status !== "inProgress",
      ...(status === "failed" ? { retryableFailure: retryAfterMs === undefined ? {} : { retryAfterMs } } : {}) };
  });
  return { id: native.nativeSessionId, cwd: input.cwd, modelId: input.modelId, reasoningEffort: input.reasoningEffort,
    // A draft, a menu, a question on screen or a usage limit: the controller waits as it does behind the operator's turn.
    status: live || !input.atEmptyPrompt ? "active" : "idle",
    activeFlags: native.status === "waiting" ? ["waitingOnApproval"] : [], turns };
}

/** The managed plan controller's driver for a Claude Code pane: its PTY, native /model picker and transcript. */
export function createClaudeManagedTurnDriver(deps: ClaudeManagedTurnDeps): ManagedTurnDriver {
  const wait = deps.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const read = async (threadId: string, fresh = false) => {
    const native = await deps.turns(fresh) ?? (fresh ? null : await deps.turns(true));
    if (!native || native.nativeSessionId !== threadId) throw new Error("The Claude session is not the managed one.");
    return native;
  };
  const current = async () => (await deps.settings()).current;
  // Claude draws a prompt suggestion as faint text in its empty composer: only the undimmed screen tells it from a draft.
  const emptyPrompt = async (observed: RoomPaneObservation) => atEmptyPrompt({ ...observed, text: await deps.screen() });
  return {
    async readThread(threadId) {
      const native = await read(threadId);
      const live = native.busy || native.status === "waiting";
      const [selection, observed] = await Promise.all([current(), live ? null : deps.inspect()]);
      return claudeNativeThread(native, { cwd: deps.cwd, modelId: selection?.modelId ?? "", reasoningEffort: selection?.reasoningEffort ?? "",
        atEmptyPrompt: Boolean(observed && await emptyPrompt(observed)), now: deps.now?.() });
    },
    async readThreadSettings(threadId) {
      const native = await read(threadId);
      const settings = await deps.settings();
      return { modelId: settings.current?.modelId ?? "", reasoningEffort: settings.current?.reasoningEffort ?? "", cwd: deps.cwd,
        isTurnActive: settings.isTurnActive || native.busy || native.status === "waiting" };
    },
    listModels: async () => (await deps.settings()).models,
    async updateThreadSettings(input) {
      await deps.serialize(async () => {
        await input.beforeSend?.();
        // The controller writes the stage settings before every attempt: a session whose transcript (and the readback the
        // controller confirms with) already shows them keeps its terminal untouched.
        const [native, now] = await Promise.all([read(input.threadId, true), current()]);
        const shown = native.modelPick ?? { model: family(native.modelId), effort: native.reasoningEffort };
        if (shown.model !== null && shown.model === family(input.model) && shown.effort === input.reasoningEffort &&
          now?.modelId === input.model && now.reasoningEffort === input.reasoningEffort) return;
        try {
          await deps.applyModel(input.model, input.reasoningEffort);
        } catch (error) {
          deps.log?.("settings", error);
          // The account's menu has no such model: a rejection, not an uncertain write.
          if (error instanceof Error && /not available in this Claude account|not advertised/i.test(error.message)) throw new CodexSettingsRejectedError();
          throw error;
        }
      });
    },
    async startManagedTurn(input) {
      const commandId = input.clientUserMessageId;
      if (!input.model || !input.reasoningEffort) throw new Error("Invalid managed Claude turn configuration.");
      const delivered = (native: ClaudeNativeTurns | null) => native?.tasks.find((task) => task.title.startsWith(planMarker(commandId)));
      const before = await read(input.threadId, true);
      // Never twice: a prompt carrying this START's marker means it was already delivered.
      if (delivered(before)) throw new CodexManagedTurnDeliveryError("UNKNOWN");
      const observed = await deps.inspect(true);
      if (!await emptyPrompt(observed)) {
        const resetsAt = before.rateLimit?.resetsAt ? Date.parse(before.rateLimit.resetsAt) - Date.now() : NaN;
        throw new CodexManagedTurnDeliveryError("NOT_SENT", { retryAfterMs: observed.usageLimited ? (resetsAt > 0 ? resetsAt : 300_000) : 15_000 });
      }
      const text = claudePlanPrompt(commandId, input.prompt, input.outputSchema);
      const pending: Pending = { threadId: input.threadId, modelId: input.model, reasoningEffort: input.reasoningEffort,
        observedAt: new Date().toISOString(), evidence: { status: "OBSERVING", selection: null }, text };
      pendingTurns.set(commandId, pending);
      const observation = {
        read: (): CodexManagedTurnEvidence => pending.evidence.selection ? { ...pending.evidence, selection: { ...pending.evidence.selection } } : { ...pending.evidence },
        close: () => {
          if (pending.evidence.status === "OBSERVING") pending.evidence = { status: "INVALID", selection: null };
          if (pendingTurns.get(commandId) === pending) pendingTurns.delete(commandId);
        }
      };
      let sent = false;
      try {
        await deps.serialize(async () => {
          await input.beforeSend?.();
          sent = true;
          await deps.submit(text);
        });
        for (let attempt = 0; attempt < 40; attempt++) {
          const turn = delivered(await deps.turns(true));
          if (turn) {
            pending.turnId = turn.taskId;
            return { turnId: turn.taskId, status: "inProgress" as const, observation };
          }
          await wait(500);
        }
      } catch (error) { deps.log?.("start", error); }
      observation.close();
      throw new CodexManagedTurnDeliveryError(sent ? "UNKNOWN" : "NOT_SENT");
    },
    async interruptTurn(input) {
      const prompt = [...pendingTurns.values()].find((pending) => pending.turnId === input.turnId)?.text
        ?? (await read(input.threadId)).tasks.find((task) => task.taskId === input.turnId)?.title;
      await deps.serialize(async () => {
        await input.beforeSend?.();
        await deps.press("\u001b");
        // Cancelled before its first answer, Claude Code puts the prompt back into the composer: the plan's text, no operator draft.
        for (let attempt = 0; prompt && attempt < 6; attempt++) {
          await wait(500);
          if (!composerHolds(await deps.screen(), prompt)) continue;
          await deps.press("\u0003");
          break;
        }
      });
    }
  };
}

/** planExecutionTarget for a Claude pane: the Claude session UUID is the native thread; turnResults marks a reader that returns stage results. */
/** A cached read can predate the session Claude Code writes once it starts (an inspection 1 s before a plan start, stable
 * 2026-10-21): a read without the session is read once more, fresh; a cached confirmed session is used as is (every tick). */
export async function claudePlanTarget(session: PaneCliSession, read: (options: { fresh?: boolean }) => Promise<ClaudeNativeTurns | null>) {
  let native = await read({});
  if (!native?.turnResults) native = await read({ fresh: true });
  if (!native?.turnResults || !session.cwd) throw new SpaceConflictError("The Claude Code session has no confirmed native session and working directory.");
  return { paneId: session.paneId, sessionId: session.sessionId, threadId: native.nativeSessionId, cwd: session.cwd };
}

/** The driver of one execution's Claude pane, on the API's terminal manager, transcript reader, pane inspection and native picker. */
export function claudePaneManagedTurnDriver(input: {
  store: Pick<SpaceStore, "getActivePaneCliSession">;
  terminal: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "observeRoomScreenUndimmed">;
  pane: Pane; session: PaneCliSession; executionId: string; cwd: string;
  readTurns(session: PaneCliSession, options: { fresh?: boolean }): Promise<ClaudeNativeTurns | null>;
  inspect(pane: Pane, freshness: { fresh?: boolean }): Promise<RoomPaneObservation>;
  settings(session: PaneCliSession): Promise<PaneCliModelSettings>;
  applyModel(input: { pane: Pane; active: PaneCliSession; modelId: string; reasoningEffort: string; traceId: string;
    assertControl: (current: PaneCliSession) => Promise<void> }): Promise<unknown>;
  log?(fields: Record<string, unknown>, message: string): void;
}): ManagedTurnDriver {
  const { pane, session, terminal } = input;
  const traceId = `trace:managed-plan:${input.executionId}`;
  const assertCurrent = async () => {
    const current = await input.store.getActivePaneCliSession(pane.id);
    if (current?.sessionId !== session.sessionId || !current.isActive || current.status !== "RUNNING") throw new SpaceConflictError("The CLI session changed.");
  };
  return createClaudeManagedTurnDriver({
    cwd: input.cwd,
    turns: (fresh) => input.readTurns(session, { fresh }),
    inspect: (fresh) => input.inspect(pane, { fresh }),
    settings: () => input.settings(session),
    applyModel: async (modelId, reasoningEffort) => {
      // The picker keys its keystrokes by trace and step: a trace shared by two switches makes the pane host drop the
      // second "/model" as an input it already accepted (stable 2026-10-21, stage 2 never switched).
      await input.applyModel({ pane, active: session, modelId, reasoningEffort, traceId: `${traceId}:${randomUUID()}`, assertControl: assertCurrent });
    },
    serialize: (work) => terminal.runSerializedTerminalMutation(session.sessionId, work),
    submit: (text) => submitCliPrompt(terminal, session.sessionId, text, traceId, `${traceId}:${randomUUID()}`, { assertCurrent }),
    press: async (keys) => { await terminal.sendInput(session.sessionId, keys, traceId, null, `${traceId}:keys:${randomUUID()}`); },
    screen: () => terminal.observeRoomScreenUndimmed(session.sessionId),
    log: (step, error) => input.log?.({ event: "managed_plan.claude_driver_failed", step, paneId: pane.id, sessionId: session.sessionId,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown" }, "Managed plan Claude driver step failed.")
  });
}
