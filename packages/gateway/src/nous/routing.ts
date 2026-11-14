import type pg from "pg";
import type { TenantPlan } from "./tenant-keys.js";

/**
 * Task routing of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 4, K5-routing; install plan §3.3): the Nous turn worker names the
 * kind of step in `x-nous-task` (missing = reason). A turn keeps its model while that model's pool has room; when it has none the
 * gateway answers `409 route_moved {model}` with the first model of the task's list whose pool has room, and the worker starts its
 * next turn there (one turn never changes provider; the gateway translates no formats).
 * Today's models stand in for the plan's names (GPT-6 Luna → gpt-5.6-luna, GPT-6.1 Sol and GPT-6 Astra → gpt-5.6-sol; Gemini Flash →
 * gemini-3.8-flash, the model Space's own Gemini Nous runs on). No Gemini Pro id is known to be served by the pool yet, so `reason`
 * has none until a person adds it. A person edits the lists through the admin API (`ngw_task_routes`).
 * shortcut: the first model with room wins; preferring a pool whose accounts would reset with room left waits for measured windows.
 */
export const NOUS_TASKS = ["classify", "extract", "browse", "reason", "code", "hard"] as const;
export type NousTask = typeof NOUS_TASKS[number];

const light = ["claude-haiku-5-5", "gpt-5.6-luna", "gemini-3.8-flash"];
export const DEFAULT_TASK_ROUTES: Record<NousTask, string[]> = {
  classify: light, extract: light, browse: light,
  reason: ["claude-sonnet-5-5", "gpt-5.6-sol"],
  code: ["claude-sonnet-5-5", "gpt-5.6-sol"],
  hard: ["claude-opus-5-5", "gpt-5.6-sol", "claude-fable-5-1"]
};

/** GEMINI is served by the Antigravity (Code Assist) account pool. */
export type ModelProvider = "CLAUDE" | "CODEX" | "GEMINI";
export const modelProvider = (model: string): ModelProvider | null =>
  model.startsWith("claude-") ? "CLAUDE" : model.startsWith("gpt-") ? "CODEX" : model.startsWith("gemini-") ? "GEMINI" : null;

/** The header's task; a missing header is `reason`, an unknown one null (refused). */
export function taskOf(value: string | string[] | undefined): NousTask | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  if (!raw) return "reason";
  return (NOUS_TASKS as readonly string[]).includes(raw) ? raw as NousTask : null;
}

/** The defaults with a person's edits over them. */
export async function readTaskRoutes(db: Pick<pg.Pool, "query">): Promise<Record<NousTask, string[]>> {
  const routes = { ...DEFAULT_TASK_ROUTES };
  for (const row of (await db.query("SELECT task, models FROM ngw_task_routes")).rows) {
    if ((NOUS_TASKS as readonly string[]).includes(row.task)) routes[row.task as NousTask] = row.models as string[];
  }
  return routes;
}

/** The first other model of the list that the gateway serves and whose pool has room, or null. */
export async function nextRoute(models: readonly string[], current: string, hasRoom: (model: string) => Promise<boolean>): Promise<string | null> {
  for (const model of models) if (model !== current && modelProvider(model) && await hasRoom(model)) return model;
  return null;
}

/**
 * Plan v2 §4.4.5 (Ultra routing): the `hard` list (Opus, Astra, Fable) runs for Ultra when its user asks, and for any plan only on
 * the retry of a `reason` turn that failed (`x-nous-after-failure: reason`). A model only the hard list names counts as a hard
 * request whatever task the header says, so a cheaper plan cannot reach Opus by naming it under `reason`.
 */
export function hardRequest(routes: Record<NousTask, string[]>, task: NousTask, model: string): boolean {
  return task === "hard" || (routes.hard.includes(model) && !routes[task].includes(model));
}
export const hardAllowed = (plan: TenantPlan, afterFailure: string | string[] | undefined): boolean =>
  plan === "ULTRA" || (Array.isArray(afterFailure) ? afterFailure[0] : afterFailure)?.trim().toLowerCase() === "reason";
