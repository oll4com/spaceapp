import { cliChatTurnDefaultRuntimeIds, type DummyTurnInput } from "@space/contracts";

// Temporal requires a finite activity duration. A 100-year horizon leaves Goal completion
// and explicit cancellation as the only practical native Chat termination conditions.
export const NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT = "36500 days" as const;

export function isNativeChatTurn(input: DummyTurnInput): input is DummyTurnInput & {
  agentSessionId: string;
  agentAssistantMessageId: string;
} {
  return Boolean(input.agentSessionId && input.agentAssistantMessageId && !input.roomAgentMissionId);
}

export function cliChatTurnRuntimeIdsFromEnv(env: NodeJS.ProcessEnv = {}): Set<string> {
  const raw = env.SPACE_CLI_CHAT_TURN_RUNTIME_IDS;
  const ids = raw
    ? raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0)
    : [...cliChatTurnDefaultRuntimeIds];
  return new Set(ids);
}

export function isCliChatTurnProviderId(
  providerId: string | null | undefined,
  env: NodeJS.ProcessEnv = {}
): boolean {
  return Boolean(providerId && cliChatTurnRuntimeIdsFromEnv(env).has(providerId));
}

const cliChatQuotaErrorPattern =
  /insufficient|pre-consumed quota|quota (?:exhausted|exceeded|failed)|exceeded your (?:current )?quota|credit balance|usage limit|no available tokens\/quota/i;

export function isCliChatQuotaError(message: string): boolean {
  return cliChatQuotaErrorPattern.test(message);
}
