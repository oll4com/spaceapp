import type {} from "./request-context.js";
import type {} from "@fastify/websocket";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  auditChainListResponseSchema, auditVerifyResponseSchema, clearSharedChatResponseSchema, listAuditChainQuerySchema,
  listSharedChatMessagesQuerySchema, sendSharedChatMessageInputSchema, sharedChatLiveWebSocketMessageSchema,
  sharedChatMessageListResponseSchema
} from "@space/contracts";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { type AuthConfig, verifyAgentPostToken } from "./auth.js";
import { submitCliPrompt } from "./cli-prompt-submit.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import { sendApiError } from "./http-errors.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import {
  buildSharedChatDispatchPrompt, pickSharedChatDispatchTarget, resolveSharedChatDispatchRuntimeIds
} from "./shared-chat-dispatch.js";

interface SharedChatLiveSocket {
  readyState: number;
  send(payload: string | Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "message", listener: () => void): unknown;
}

const sharedChatLiveSockets = new Set<SharedChatLiveSocket>();

function sharedChatBroadcast(message: unknown): void {
  const payload = JSON.stringify(
    sharedChatLiveWebSocketMessageSchema.parse({ type: "message", message })
  );
  for (const socket of sharedChatLiveSockets) {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

function sharedChatBroadcastClear(): void {
  const payload = JSON.stringify(
    sharedChatLiveWebSocketMessageSchema.parse({ type: "clear" })
  );
  for (const socket of sharedChatLiveSockets) {
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

/**
 * Shared chat dock (messages, live socket, agent-pane dispatch) and the audit chain it appends to; the parent
 * retains authentication, CSRF, errors and rate limits.
 */
export function registerSharedChatRoutes(app: FastifyInstance, options: {
  auth: AuthConfig;
  store: SpaceStore;
  cliTerminalManager: CliTerminalManager;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  websocketRouteOptions: Pick<RouteShorthandOptions, "config"> & { websocket: true };
}) {
  const { auth, store, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions,
    websocketRouteOptions: defaultWebsocketRateLimitOptions } = options;
  async function dispatchSharedChatToAgentPanes(input: {
    message: { id: string; senderLabel: string; content: string; metadata?: Record<string, unknown> };
    requestId: string;
    store: SpaceStore;
    cliTerminalManager: CliTerminalManager;
  }): Promise<{ dispatched: number; skipped: number }> {
    // Group conversation: every operator message wakes every eligible runtime
    // (at most one idle pane per runtime). Replies posted by agents
    // (senderType=agent or messages carrying metadata.runtimeId) never trigger
    // dispatch at all — their content is never parsed for mentions and never
    // reaches any pane, so answers only ever land in the dock.
    const agentPosted =
      typeof input.message.metadata?.runtimeId === "string" && input.message.metadata.runtimeId.length > 0;
    if (agentPosted) {
      return { dispatched: 0, skipped: 0 };
    }
    const targetRuntimeIds = resolveSharedChatDispatchRuntimeIds(input.message.content);
    let dispatched = 0;
    let skipped = 0;
    for (const runtimeId of targetRuntimeIds) {
      const target = await pickSharedChatDispatchTarget(input.store, runtimeId);
      if (!target) {
        skipped += 1;
        continue;
      }
      try {
        // Text and Enter in one write left long prompts as Claude Code drafts; the shared submit pastes, then presses Enter.
        await submitCliPrompt(
          input.cliTerminalManager,
          target.session.sessionId,
          buildSharedChatDispatchPrompt(input.message.content, target.pane.title ?? target.session.paneId, runtimeId),
          input.requestId,
          `shared-chat-dispatch:${input.message.id}`
        );
        dispatched += 1;
      } catch {
        skipped += 1;
      }
    }
    return { dispatched, skipped };
  }
  app.get("/api/shared-chat/messages", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(listSharedChatMessagesQuerySchema, request.query);
    const result = await store.listSharedChatMessages(query);
    return sharedChatMessageListResponseSchema.parse({
      data: result.items,
      nextCursor: result.nextCursor
    });
  });
  app.post("/api/shared-chat/messages", defaultRouteRateLimitOptions, async (request, reply) => {
    const input = parseBody(sendSharedChatMessageInputSchema, request.body);
    const owner = await store.upsertUser(request.user!);
    const asAgent = input.senderType === "agent";
    if (asAgent) {
      const runtimeId = typeof input.metadata?.runtimeId === "string" ? input.metadata.runtimeId : "";
      const payload = `${input.senderLabel ?? ""}\n${runtimeId}\n${input.content}`;
      const token = request.headers["x-space-agent-post"];
      if (!verifyAgentPostToken(auth.sessionSecret, token, payload)) {
        return sendApiError(
          reply,
          403,
          "AGENT_POST_INVALID",
          "Agent posts require a valid Space agent post token."
        );
      }
    }
    const message = await store.appendSharedChatMessage({
      ...input,
      senderType: asAgent ? "agent" : "user",
      senderId: asAgent ? null : owner.id,
      senderLabel: asAgent ? (input.senderLabel ?? "agent") : (owner.email ?? owner.id),
      id: makeSpaceId("shared_chat_msg")
    });
    await store.appendAuditChainEntry({
      action: "shared_chat.message_created",
      actor: asAgent ? `agent:${message.senderLabel}` : `user:${owner.id}`,
      targetType: "shared_chat_message",
      targetId: message.id,
      metadata: {
        senderLabel: message.senderLabel,
        senderType: message.senderType,
        runtimeId: typeof input.metadata?.runtimeId === "string" ? input.metadata.runtimeId : null,
        roomId: message.roomId,
        kind: message.kind
      }
    });
    sharedChatBroadcast(message);
    const dispatchResult = asAgent
      ? { dispatched: 0, skipped: 0 }
      : await dispatchSharedChatToAgentPanes({
          message,
          requestId: request.requestIdForSpace,
          store,
          cliTerminalManager
        });
    request.log.info(
      { messageId: message.id, dispatched: dispatchResult.dispatched, skipped: dispatchResult.skipped },
      "shared-chat dispatch complete"
    );
    return reply.code(201).send(message);
  });
  app.delete("/api/shared-chat/messages", defaultRouteRateLimitOptions, async (request) => {
    const owner = await store.upsertUser(request.user!);
    const result = await store.clearSharedChatMessages();
    await store.appendAuditChainEntry({
      action: "shared_chat.cleared",
      actor: `user:${owner.id}`,
      targetType: "shared_chat",
      targetId: null,
      metadata: { deletedCount: result.deletedCount }
    });
    sharedChatBroadcastClear();
    return clearSharedChatResponseSchema.parse(result);
  });
  app.get("/api/audit/entries", defaultRouteRateLimitOptions, async (request) => {
    const query = parseQuery(listAuditChainQuerySchema, request.query);
    const result = await store.listAuditChainEntries(query);
    return auditChainListResponseSchema.parse({
      data: result.items,
      nextCursor: result.nextCursor
    });
  });
  app.get("/api/audit/verify", defaultRouteRateLimitOptions, async () => {
    return auditVerifyResponseSchema.parse(await store.verifyAuditChain());
  });
  app.get("/api/shared-chat/live", defaultWebsocketRateLimitOptions, (socket, request) => {
    if (!request.user) {
      socket.close(4401, "unauthorized");
      return;
    }
    sharedChatLiveSockets.add(socket);
    const onClose = () => sharedChatLiveSockets.delete(socket);
    socket.on("close", onClose);
    socket.on("message", () => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: "pong" }));
      }
    });
  });
}
