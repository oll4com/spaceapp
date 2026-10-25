/**
 * Room Agent execution budgets. Activities read them from the worker
 * environment; workflow code never imports this module, so changing a value
 * cannot alter the replay of an existing workflow history.
 *
 * - Supervision passes: follow-up model turns one Room Agent turn may take
 *   after its first action pass (SPACE_ROOM_AGENT_MAX_PASSES, 1-16, default 8).
 * - Background continuations: automatic turns one operator request may start
 *   after its pane actions settle (SPACE_ROOM_AGENT_MAX_CONTINUATIONS, 1-16,
 *   default 16; the queue contract caps a continuation generation at 16). An
 *   operator follow-up starts a new budget.
 * - Measured tokens: model tokens the runtimes reported for one operator request's
 *   turns, counted before each automatic continuation
 *   (SPACE_ROOM_AGENT_MAX_MISSION_TOKENS, 1,000-1,000,000,000, default 10,000,000;
 *   0 turns the budget off). Turns without a usage receipt count as zero, so
 *   this bounds measured spend, not total spend. An operator follow-up starts a
 *   new budget.
 *
 * Like the other worker settings, an absent or invalid value keeps the default.
 */
export const DEFAULT_ROOM_AGENT_MAX_PASSES = 8;
export const DEFAULT_ROOM_AGENT_MAX_CONTINUATIONS = 16;
export const DEFAULT_ROOM_AGENT_MAX_MISSION_TOKENS = 10_000_000;
export const ROOM_AGENT_PASS_LIMIT = "ROOM_AGENT_PASS_LIMIT";
export const ROOM_AGENT_CONTINUATION_LIMIT = "ROOM_AGENT_CONTINUATION_LIMIT";
export const ROOM_AGENT_TOKEN_LIMIT = "ROOM_AGENT_TOKEN_LIMIT";

export interface RoomAgentLimits {
  maxPasses: number;
  maxContinuations: number;
  /** Null when the operator turned the budget off. */
  maxMissionTokens: number | null;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const text = value?.trim() ?? "";
  if (!/^[0-9]{1,4}$/.test(text)) return fallback;
  const parsed = Number(text);
  return parsed >= min && parsed <= max ? parsed : fallback;
}

function missionTokenBudget(value: string | undefined): number | null {
  const text = value?.trim() ?? "";
  if (text === "0") return null;
  if (!/^[0-9]{4,10}$/.test(text)) return DEFAULT_ROOM_AGENT_MAX_MISSION_TOKENS;
  const parsed = Number(text);
  return parsed >= 1_000 && parsed <= 1_000_000_000 ? parsed : DEFAULT_ROOM_AGENT_MAX_MISSION_TOKENS;
}

export function roomAgentLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): RoomAgentLimits {
  return {
    maxPasses: boundedInteger(env.SPACE_ROOM_AGENT_MAX_PASSES, DEFAULT_ROOM_AGENT_MAX_PASSES, 1, 16),
    maxContinuations: boundedInteger(env.SPACE_ROOM_AGENT_MAX_CONTINUATIONS, DEFAULT_ROOM_AGENT_MAX_CONTINUATIONS, 1, 16),
    maxMissionTokens: missionTokenBudget(env.SPACE_ROOM_AGENT_MAX_MISSION_TOKENS)
  };
}
