import { captureSentryException } from "@space/contracts/sentry-node";
import { traceContextForRawRequest } from "./trace-context.js";
import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  SpaceConflictError,
  SpaceFeatureDisabledError,
  SpaceNotFoundError,
  TelegramApiError,
  TelegramIntegrationError
} from "@space/runtime";
import { AppDiagnosticsServiceError } from "./app-diagnostics.js";
import { BrowserControlHeldError } from "./browser-errors.js";
import { CliTerminalControlRequiredError } from "./cli-http-control.js";
import { CliMaintenanceError } from "./cli-maintenance.js";
import { CliRuntimeDisableConfirmationStaleError } from "./cli-runtime-visibility.js";
import { CliVpnError } from "./cli-vpn.js";
import { CodexRuntimeModelSettingsUnconfirmedError } from "./codex-model-settings.js";
import { FilesystemError } from "./filesystem-error.js";
import { sendApiError } from "./http-errors.js";
import { PaneClosedConflictError, PaneCloseRefusedError } from "./pane-guards.js";
import { ReleasePublishingError } from "./release-publishing.js";
import { GitControlError } from "./source-control/errors.js";
import { SourceControlPublishingError } from "./source-control-publishing.js";
import { StreamingServiceError, StreamingSettingsVersionConflictError } from "./streaming-service.js";
import { TurnStarterDisabledError } from "./turns.js";

function frameworkHttpErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 405:
      return "METHOD_NOT_ALLOWED";
    case 429:
      return "RATE_LIMITED";
    default:
      return "HTTP_ERROR";
  }
}

function getFrameworkClientError(error: unknown): { statusCode: number; code: string; message: string } | null {
  const candidate = error as { statusCode?: unknown; message?: unknown };
  const statusCode = candidate.statusCode;
  if (!Number.isInteger(statusCode) || typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  const message = typeof candidate.message === "string" && candidate.message.trim()
    ? candidate.message
    : "The request could not be completed.";
  return {
    statusCode,
    code: frameworkHttpErrorCode(statusCode),
    message
  };
}

/** One error answer for every API route: each known error class maps to its status and code; anything else is a logged 500. */
export function registerApiErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FilesystemError) {
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof GitControlError) return sendApiError(reply, error.statusCode, error.code, error.message);
    if (error instanceof StreamingSettingsVersionConflictError) {
      request.log.info({ requestId: request.requestIdForSpace, currentVersion: error.currentVersion }, "streaming overlay settings conflicted");
      return sendApiError(reply, 409, "STREAMING_SETTINGS_CONFLICT", error.message, { currentVersion: error.currentVersion });
    }
    if (error instanceof StreamingServiceError) {
      request.log.info({ errorCode: error.code, requestId: request.requestIdForSpace }, "streaming request rejected");
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof ZodError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request rejected");
      return sendApiError(reply, 422, "VALIDATION_ERROR", "Invalid request data.", error.flatten());
    }
    if (error instanceof SpaceNotFoundError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request target not found");
      return sendApiError(reply, 404, "NOT_FOUND", error.message);
    }
    if (error instanceof AppDiagnosticsServiceError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "App diagnostics request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof TelegramIntegrationError) {
      request.log.info({ errorCode: error.code, requestId: request.requestIdForSpace }, "Telegram integration request rejected");
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof SourceControlPublishingError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "Source-control publishing request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof CliMaintenanceError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "CLI maintenance request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof ReleasePublishingError) {
      request.log.info(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "Space release publishing request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof TelegramApiError) {
      request.log.warn({ errorCode: error.code, requestId: request.requestIdForSpace }, "Telegram API request failed");
      const statusCode = error.statusCode === 429 ? 429 : error.permanent ? 422 : 502;
      const message = error.permanent
        ? "Telegram rejected the bot or destination. Verify the bot token and permissions."
        : "Telegram is temporarily unavailable. Try again shortly.";
      return sendApiError(reply, statusCode, error.code, message, error.retryAfterSeconds
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : undefined);
    }
    if (error instanceof BrowserControlHeldError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "browser control held by operator");
      return sendApiError(reply, 409, error.errorCode, error.message, error.details);
    }
    if (error instanceof CodexRuntimeModelSettingsUnconfirmedError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "Codex runtime model settings unconfirmed");
      return sendApiError(reply, 409, error.errorCode, error.message, error.details);
    }
    if (error instanceof CliTerminalControlRequiredError) {
      request.log.info(
        { requestId: request.requestIdForSpace },
        "CLI HTTP mutation rejected because terminal control is held by another page"
      );
      return sendApiError(reply, 409, error.errorCode, error.message);
    }
    if (error instanceof PaneClosedConflictError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "closed pane request conflicted");
      return sendApiError(reply, 409, "PANE_CLOSED", error.message);
    }
    if (error instanceof CliRuntimeDisableConfirmationStaleError) {
      request.log.info({ requestId: request.requestIdForSpace }, "CLI runtime disable confirmation is stale");
      return sendApiError(reply, 409, error.errorCode, error.message, error.preview);
    }
    if (error instanceof CliVpnError) {
      request.log.warn(
        { errorCode: error.code, requestId: request.requestIdForSpace },
        "CLI VPN request rejected"
      );
      return sendApiError(reply, error.statusCode, error.code, error.message);
    }
    if (error instanceof PaneCloseRefusedError) return sendApiError(reply, 409, "PANE_HAS_SCHEDULED_POSTS", error.message, error.details);
    if (error instanceof SpaceConflictError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request conflicted");
      return sendApiError(reply, 409, "CONFLICT", error.message);
    }
    if (error instanceof SpaceFeatureDisabledError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace, ...(error.errorCode === "BROWSER_HOST_UNAVAILABLE" ? { hostError: error.details } : {}) }, "request blocked by feature gate");
      const statusCode =
        error.errorCode === "SPACE_AGENT_PERMISSION_FIXED_FULL_ACCESS" ||
        error.errorCode === "SPACE_AGENT_MODEL_CONFIG_NOT_ADVERTISED" ||
        error.errorCode === "CODEX_MASTER_DISABLED"
          ? 409
          : 503;
      return sendApiError(reply, statusCode, error.errorCode, error.message, error.details);
    }
    if (error instanceof TurnStarterDisabledError) {
      request.log.warn({ err: error, requestId: request.requestIdForSpace }, "request blocked by turn starter gate");
      return sendApiError(reply, 503, "TURN_STARTER_DISABLED", error.message);
    }
    const frameworkClientError = getFrameworkClientError(error);
    if (frameworkClientError) {
      request.log.info({ err: error, requestId: request.requestIdForSpace }, "request rejected by framework");
      return sendApiError(reply, frameworkClientError.statusCode, frameworkClientError.code, frameworkClientError.message);
    }
    const trace = traceContextForRawRequest(request.raw);
    captureSentryException(error, { trace_id: trace.w3cTraceId, span_id: trace.spanId });
    request.log.error({ err: error, requestId: request.requestIdForSpace }, "request failed");
    return sendApiError(reply, 500, "INTERNAL_ERROR", "The request could not be completed.");
  });
}
