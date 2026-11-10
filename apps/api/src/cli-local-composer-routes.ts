import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { Pane, PaneCliSession, Room } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliTerminalManager } from "./cli-terminal.js";
import { CliTerminalControlRequiredError, parseCliHttpControlAuthority } from "./cli-http-control.js";
import { cliLocalComposerSubmissionSchema, createCliLocalComposerService } from "./cli-local-composer.js";
import { sendApiError } from "./http-errors.js";
import { assertCliPaneCompatible, assertNormalCliSession } from "./pane-guards.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import { grantsFromOperatorLine, noteOperatorPromoteLine } from "./queue-operator-grants.js";
import { recordAudit } from "./request-audit.js";
import { classifyPaneApproval } from "./room-agent-guardrails.js";

/** Named keys only, never text (SpaceApp Android's key bar, plan clipboard:1cZ-YxU8zS2O N1). */
const PANE_KEYS = { ESCAPE: "\u001b", CTRL_C: "\u0003", UP: "\u001b[A", DOWN: "\u001b[B", LEFT: "\u001b[D", RIGHT: "\u001b[C", TAB: "\t",
  SHIFT_TAB: "\u001b[Z", BACKSPACE: "\u007f", ENTER: "\r", y: "y", n: "n", ...Object.fromEntries([..."123456789"].map(digit => [digit, digit])) } as Record<string, string>;
/** Keys that can say yes to a prompt: refused on a protected or destructive one, as on the pane board's reply. */
const ANSWER_KEYS = new Set(["ENTER", "y", ..."123456789"]);
const paneKeysSchema = z.object({ expectedSessionId: z.string().min(1).max(200),
  keys: z.array(z.string().refine(key => Object.hasOwn(PANE_KEYS, key), "Unknown key")).min(1).max(8) }).strict();

const receiptParamsSchema = idParamSchema.extend({ submissionId: z.string().uuid() });

export function registerCliLocalComposerRoutes(app: FastifyInstance, deps: {
  store: SpaceStore;
  repository: ControlRepository;
  cliTerminalManager: Pick<CliTerminalManager, "runSerializedTerminalMutation" | "sendInput" | "observeRoomScreen">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: FastifyRequest["user"]) => Promise<Room>;
  /** The terminal's own typing rule (roomShares.observeOnly): true when this user may only watch the pane. */
  observeOnly: (pane: Pane, userId: string) => Promise<boolean>;
  assertPaneCliRuntimeEnabled: (pane: Pane) => Promise<void>;
  assertCliHttpMutationControl: (request: FastifyRequest, session: PaneCliSession) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
}) {
  const service = createCliLocalComposerService({ repository: deps.repository,
    serialize: (sessionId, work) => deps.cliTerminalManager.runSerializedTerminalMutation(sessionId, work),
    sendInput: (sessionId, data, traceId, key) => deps.cliTerminalManager.sendInput(sessionId, data, traceId, null, key, data !== "\r"),
    wait: deps.wait });
  const ownedPane = async (request: FastifyRequest, paneId: string) => {
    const pane = await deps.store.getPane(paneId);
    // Typing here is typing into the terminal: the same room access and observe-only rule as the attach and Space Control prompts.
    await deps.assertRoomAccess(pane.roomId, request.user);
    if (!request.user || await deps.observeOnly(pane, request.user.id)) throw new SpaceNotFoundError(`Pane ${paneId} was not found.`);
    return pane;
  };

  app.get("/api/panes/:id/cli/local-composer/submissions/:submissionId", deps.routeOptions, async (request, reply) => {
    const params = parseQuery(receiptParamsSchema, request.params);
    await ownedPane(request, params.id);
    reply.header("cache-control", "no-store");
    return service.get({ ownerUserId: request.user!.id, paneId: params.id }, params.submissionId);
  });

  app.post("/api/panes/:id/cli/local-composer/submissions", { ...deps.routeOptions, bodyLimit: 1024 * 1024 }, async (request, reply) => {
    if (request.user?.proofScope === "READ_ONLY" || request.user?.automationScope === "APP_DIAGNOSTICS")
      return sendApiError(reply, 403, "AUTOMATION_SCOPE_READ_ONLY", "This session cannot send CLI composer drafts.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(cliLocalComposerSubmissionSchema, request.body);
    const pane = await ownedPane(request, params.id);
    let generation: string | null | undefined;
    const receipt = await service.submit({ ownerUserId: request.user!.id, paneId: pane.id, roomId: pane.roomId }, input, {
      traceId: request.requestIdForSpace,
      assertCurrent: async () => {
        const currentPane = await ownedPane(request, pane.id);
        assertCliPaneCompatible(currentPane);
        const active = await deps.store.getActivePaneCliSession(pane.id);
        if (!active || !active.isActive || active.status !== "RUNNING" || active.sessionId !== input.expectedSessionId)
          throw new SpaceConflictError("The CLI session changed before the composer draft could be sent.");
        assertNormalCliSession(active);
        if (active.runtimeId === "cli:root" || currentPane.terminalRuntimeId === "cli:root")
          throw new SpaceConflictError("The local composer is not available for root shells.");
        if (input.imagePaths?.length && !["cli:codex", "cli:claude"].includes(active.runtimeId))
          throw new SpaceConflictError("This CLI does not support native image pastes.");
        const currentGeneration = active.terminalGeometry?.generationId ?? null;
        if (generation !== undefined && currentGeneration !== generation)
          throw new SpaceConflictError("The CLI process changed before the composer draft could be sent.");
        generation = currentGeneration;
        await deps.assertPaneCliRuntimeEnabled(currentPane);
        // Unlike legacy HTTP mutations, this new composer always requires a
        // current terminal controller, including when no lease exists yet.
        if (!parseCliHttpControlAuthority(request) || !await deps.store.getActivePaneCliTerminalControlLease(active.sessionId))
          throw new CliTerminalControlRequiredError();
        await deps.assertCliHttpMutationControl(request, active);
      }
    });
    // The operator's own draft asking to promote holds this pane's promote grant, like a line typed in the terminal.
    if (receipt.status !== "REJECTED" && grantsFromOperatorLine(request)) noteOperatorPromoteLine(pane.id, input.text, "local-composer");
    return receipt;
  });

  // The operator's key presses from a phone: a person's own session only (never a broker, proof or the Nous app's channel), no lease
  // needed (like Space Control's prompt), one serialized burst, audited by key name.
  app.post("/api/panes/:id/cli/keys", deps.routeOptions, async (request, reply) => {
    const user = request.user;
    if (!user || user.brokerScope || user.proofScope || user.automationScope || user.mobile || request.mobileDevice)
      return sendApiError(reply, 403, "OPERATOR_ONLY", "Only the operator presses keys in a pane.");
    const params = parseQuery(idParamSchema, request.params);
    const input = parseBody(paneKeysSchema, request.body);
    const pane = await ownedPane(request, params.id);
    assertCliPaneCompatible(pane);
    await deps.assertPaneCliRuntimeEnabled(pane);
    const active = await deps.store.getActivePaneCliSession(pane.id);
    if (!active || !active.isActive || active.status !== "RUNNING" || active.sessionId !== input.expectedSessionId)
      throw new SpaceConflictError("The CLI session changed: read the pane again.");
    assertNormalCliSession(active);
    if (input.keys.some(key => ANSWER_KEYS.has(key))) {
      const verdict = classifyPaneApproval((await deps.cliTerminalManager.observeRoomScreen(active.sessionId)).text);
      if (verdict.level !== "SAFE") throw new SpaceConflictError(`Not pressed: the pane shows ${verdict.level.toLowerCase()} work (${verdict.reasons.join(", ")}); answer it at a computer.`);
    }
    const wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    await deps.cliTerminalManager.runSerializedTerminalMutation(active.sessionId, async () => {
      for (const [index, key] of input.keys.entries()) {
        // A TUI reads a burst as one paste: each key goes on its own, like room-cli-control's.
        if (index) await wait(120);
        await deps.cliTerminalManager.sendInput(active.sessionId, PANE_KEYS[key]!, request.requestIdForSpace, null, `${request.requestIdForSpace}:keys:${index}`);
      }
    });
    await recordAudit(deps.store, request, { action: "pane.cli.keys", targetType: "pane", targetId: pane.id,
      metadata: { roomId: pane.roomId, sessionId: active.sessionId, keys: input.keys } });
    return { sessionId: active.sessionId, keys: input.keys };
  });
  return service;
}
