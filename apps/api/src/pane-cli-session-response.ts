/**
 * Pane CLI session response (session, runtime, transcript tail and WebSocket ticket) shared by the CLI routes and
 * composition (moved verbatim from the composition root).
 */
import { type AgentRuntime, paneCliSessionResponseSchema, type PaneCliWebSocketToken } from "@space/contracts";
import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";

/** Compact cold-restore: recent tail only (host circular buffer still supplies live attach). */
const COMPACT_CLI_TRANSCRIPT_CHUNK_LIMIT = 96;

export async function buildPaneCliSessionResponse(input: {
  store: SpaceStore;
  runtime: AgentRuntime;
  sessionId: string;
  includeWebsocket: boolean;
  includeTranscript?: boolean;
  /** When true with includeTranscript, return only the newest compact tail. */
  compactTranscript?: boolean;
  proofScope?: "READ_ONLY";
  tokenTtlMs: number;
  issueTicket: (paneId: string, sessionId: string, ttlMs: number) => PaneCliWebSocketToken;
}) {
  const session = await input.store.getPaneCliSession(input.sessionId);
  if (!session) {
    throw new SpaceNotFoundError(`CLI session ${input.sessionId} was not found.`);
  }
  const transcript = input.includeTranscript === false
    ? []
    : input.compactTranscript
      ? await input.store.listPaneCliTranscriptChunks(session.sessionId, COMPACT_CLI_TRANSCRIPT_CHUNK_LIMIT)
      : await input.store.listPaneCliTranscriptChunks(session.sessionId);
  return paneCliSessionResponseSchema.parse({
    session,
    runtime: input.runtime,
    transcript,
    websocket: input.includeWebsocket
      ? {
          ...input.issueTicket(session.paneId, session.sessionId, input.tokenTtlMs),
          ...(input.proofScope ? { proofScope: input.proofScope } : {})
        }
      : null
  });
}
