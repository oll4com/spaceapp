import type {} from "./request-context.js";
import type { FastifyReply } from "fastify";

export function sendApiError(reply: FastifyReply, statusCode: number, code: string, message: string, details?: unknown) {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      details,
      requestId: reply.request.requestIdForSpace
    }
  });
}
