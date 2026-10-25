import { LogController, type FastifyReply, type FastifyRequest } from "fastify";

/** Requests slower than this are logged even when they succeed. */
export const SLOW_REQUEST_LOG_MS = 1_000;

/**
 * Errors and slow requests are logged; fast successful requests are not, except DELETE.
 * Deletes are rare, and the deploy continuity check reads them from the journal: a CLI
 * session whose room or pane a successful DELETE removed was closed by its owner, not
 * by the deploy (scripts/cli-session-continuity.mjs deletedResourcesFromApiLog).
 */
export function shouldLogRequest(statusCode: number, responseTimeMs: number, method = "GET"): boolean {
  return method === "DELETE" || statusCode >= 400 || responseTimeMs >= SLOW_REQUEST_LOG_MS;
}

/**
 * Fastify's per-request lines, minus the noise: no "incoming request" line, and
 * "request completed" only for errors, slow requests and deletes (with the request
 * fields, since the incoming line is gone). Error-handler and stream-error
 * logs are unchanged.
 */
export class QuietRequestLogController extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    if (error) {
      reply.log.error({ req: request, res: reply, err: error, responseTime: reply.elapsedTime }, "request errored");
      return;
    }
    if (!shouldLogRequest(reply.statusCode, reply.elapsedTime, request.method)) return;
    // Same level as Fastify's own line; the error handler already logs 5xx causes at error level.
    reply.log.info({ req: request, res: reply, responseTime: reply.elapsedTime }, "request completed");
  }
}
