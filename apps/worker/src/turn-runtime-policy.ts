import type { DummyTurnInput } from "@space/contracts";

// Temporal requires a finite activity duration. A 100-year horizon leaves Goal completion
// and explicit cancellation as the only practical native Chat termination conditions.
export const NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT = "36500 days" as const;

export function isNativeChatTurn(input: DummyTurnInput): input is DummyTurnInput & {
  agentSessionId: string;
  agentAssistantMessageId: string;
} {
  return Boolean(input.agentSessionId && input.agentAssistantMessageId && !input.roomAgentMissionId);
}

const cliChatTurnRuntimeIds = new Set(["cli:cursor", "cli:copilot", "cli:gemini", "cli:deepseek"]);

export function isCliChatTurnProviderId(providerId: string | null | undefined): boolean {
  return Boolean(providerId && cliChatTurnRuntimeIds.has(providerId));
}
