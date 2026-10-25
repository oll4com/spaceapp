import type { RoomTaskModelUsage, RoomTaskTiming } from "@space/contracts";
import type { RolloutReducer } from "./codex-rollout-reader.js";

export interface NativeTaskExecution {
  taskId: string;
  title: string;
  status: "RUNNING" | "COMPLETED" | "INTERRUPTED" | "WAITING_FOR_INPUT" | "UNKNOWN";
  timing: RoomTaskTiming;
  modelsUsed: RoomTaskModelUsage[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function time(value: unknown): string | null {
  const ms = typeof value === "number" ? value * (value < 1e12 ? 1000 : 1) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Space prepends tool/attachment context to native Chat prompts. Extract the
// operator input before bounding the title, or FIND sees only internal tools.
// Keep recovery markers intact: native completion matching uses this text.
function taskTitle(input: string): string {
  const delimiter = "\n\nUser prompt:\n";
  const wrapped = /^(?:Space (?:private clipboard|private task|shared chat|managed browser) tools selected:|Attached Space artifacts for this user message:)/.test(input);
  const split = wrapped ? input.indexOf(delimiter) : -1;
  return (split >= 0 ? input.slice(split + delimiter.length) : input).slice(0, 2000);
}

/** Native event timestamps, never the reader's polling clock. */
export function codexTaskTimelineReducer(limit = 256): RolloutReducer<NativeTaskExecution[]> {
  let tasks: NativeTaskExecution[] = [];
  let currentId: string | null = null;
  let providerId: string | null = null;
  let pendingStart: string | null = null;
  const current = (id: string | null) => tasks.find((task) => task.taskId === id);
  function ensure(id: string, at: string | null, started: boolean): NativeTaskExecution {
    let task = current(id);
    if (!task) {
      task = { taskId: id, title: "Untitled task", status: "RUNNING", timing: {
        startedAt: started ? at : null, completedAt: null, durationMs: null,
        source: "NATIVE", observedAt: at ?? new Date(0).toISOString()
      }, modelsUsed: [] };
      tasks.push(task);
      if (tasks.length > limit) tasks.splice(0, tasks.length - limit);
    }
    if (started && at && (!task.timing.startedAt || at < task.timing.startedAt)) task.timing.startedAt = at;
    if (at) task.timing.observedAt = at;
    return task;
  }
  return {
    accept(content) {
      for (const line of content.split(/\r?\n/)) {
        let entry: Record<string, unknown>;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        const payload = record(entry.payload);
        const at = time(entry.timestamp);
        if (entry.type === "session_meta") { providerId = text(payload.model_provider); continue; }
        const event = payload.type;
        const id = text(payload.turn_id) ?? currentId;
        if (entry.type === "event_msg" && event === "task_started" && !text(payload.turn_id)) {
          pendingStart = at; currentId = null; continue;
        }
        if (entry.type === "event_msg" && event === "task_started" && id) {
          currentId = id;
          ensure(id, at, true);
          continue;
        }
        if (entry.type === "turn_context" && id) {
          currentId = id;
          const task = ensure(id, pendingStart ?? at, pendingStart !== null);
          pendingStart = null;
          const modelId = text(payload.model);
          const reasoningEffort = text(payload.effort) ?? text(payload.reasoning_effort);
          const prior = task.modelsUsed.at(-1);
          if (modelId && (prior?.modelId !== modelId || prior.reasoningEffort !== reasoningEffort)) {
            if (prior && !prior.completedAt) prior.completedAt = at;
            task.modelsUsed.push({ providerId: text(payload.model_provider) ?? providerId, modelId,
              reasoningEffort, turnId: id, startedAt: at, completedAt: null, source: "NATIVE" });
          }
          continue;
        }
        const task = current(id);
        if (task && entry.type === "response_item" && payload.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
          const title = payload.content.map(record).map(part => text(part.text) ?? "").filter(Boolean).join("\n");
          if (title) task.title = taskTitle(title);
        }
        if (!task || entry.type !== "event_msg") continue;
        if (event === "user_message") {
          task.title = taskTitle(text(payload.message) ?? text(payload.text) ?? task.title);
        }
        if (event === "task_complete" || event === "turn_aborted") {
          const end = at ?? time(payload.completed_at);
          task.status = event === "task_complete" ? "COMPLETED" : "INTERRUPTED";
          task.timing.completedAt = end;
          task.timing.durationMs = end && task.timing.startedAt
            ? Math.max(0, Date.parse(end) - Date.parse(task.timing.startedAt)) : null;
          if (end) task.timing.observedAt = end;
          const usage = task.modelsUsed.at(-1);
          if (usage) usage.completedAt = end;
        }
      }
    },
    result: () => structuredClone(tasks),
    checkpoint: () => structuredClone({ tasks, currentId, providerId, pendingStart }),
    restore(checkpoint) {
      const saved = checkpoint as { tasks: NativeTaskExecution[]; currentId: string | null; providerId: string | null; pendingStart?: string | null };
      tasks = structuredClone(saved.tasks); currentId = saved.currentId; providerId = saved.providerId; pendingStart = saved.pendingStart ?? null;
    }
  };
}

export function summarizeNativeTasks(tasks: NativeTaskExecution[], sinceMs: number, observedAt: string): {
  timing: RoomTaskTiming; modelsUsed: RoomTaskModelUsage[];
} {
  const relevant = tasks.filter((task) => task.timing.startedAt !== null && Date.parse(task.timing.startedAt) >= sinceMs);
  const starts = relevant.flatMap((task) => task.timing.startedAt ? [task.timing.startedAt] : []).sort();
  const ends = relevant.flatMap((task) => task.timing.completedAt ? [task.timing.completedAt] : []).sort();
  const startedAt = starts[0] ?? null;
  const completedAt = relevant.length && relevant.every((task) => (task.status === "COMPLETED" || task.status === "INTERRUPTED") && task.timing.completedAt)
    ? ends.at(-1) ?? null : null;
  return {
    timing: { startedAt, completedAt, durationMs: startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null,
      source: relevant.length ? "NATIVE" : "UNKNOWN", observedAt },
    modelsUsed: relevant.flatMap((task) => task.modelsUsed).slice(-256)
  };
}

/** Groups OpenCode assistant steps under their native user message, including model changes. */
export function openCodeTaskTimeline(messages: unknown[], busy: boolean, observedAt: string): NativeTaskExecution[] {
  const tasks = new Map<string, NativeTaskExecution>();
  const sorted = messages.map(record).sort((a, b) => Number(record(record(a.info).time).created ?? 0) - Number(record(record(b.info).time).created ?? 0));
  for (const message of sorted) {
    const info = record(message.info), timestamps = record(info.time);
    const id = text(info.id);
    if (!id) continue;
    if (info.role === "user") {
      const parts = Array.isArray(message.parts) ? message.parts.map(record) : [];
      tasks.set(id, { taskId: id, title: taskTitle(parts.filter((part) => part.type === "text").map((part) => text(part.text) ?? "").join("\n")),
        status: "RUNNING", timing: { startedAt: null, completedAt: null, durationMs: null, source: "NATIVE", observedAt }, modelsUsed: [] });
      continue;
    }
    const task = tasks.get(text(info.parentID) ?? "");
    if (!task || info.role !== "assistant") continue;
    const startedAt = time(timestamps.created), completedAt = time(timestamps.completed);
    if (!task.timing.startedAt) task.timing.startedAt = startedAt;
    task.timing.completedAt = completedAt;
    const modelId = text(info.modelID);
    if (modelId) task.modelsUsed.push({ providerId: text(info.providerID), modelId,
      reasoningEffort: text(info.variant), turnId: id, startedAt, completedAt, source: "NATIVE" });
    task.status = info.error ? "INTERRUPTED" : completedAt && info.finish && info.finish !== "tool-calls" ? "COMPLETED" : "RUNNING";
  }
  const result = [...tasks.values()].slice(-256);
  const latest = result.at(-1);
  if (latest && busy) { latest.status = "RUNNING"; latest.timing.completedAt = null; }
  for (const task of result) {
    if (task.status === "RUNNING") task.timing.completedAt = null;
    task.timing.durationMs = task.timing.startedAt && task.timing.completedAt
      ? Math.max(0, Date.parse(task.timing.completedAt) - Date.parse(task.timing.startedAt)) : null;
  }
  return result;
}
