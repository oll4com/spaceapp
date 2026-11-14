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

// Daily Nous errors G (8/11 12:00: tasks.update ×2 answered "Invalid request data." and nothing else): an error answer read back by
// Space Control names the fields its validation refused.
export function apiErrorText(body: { error?: { message?: string; details?: unknown } }, statusCode: number) {
  const issues = body.error?.details as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
  const fields = [...(issues?.formErrors ?? []), ...Object.entries(issues?.fieldErrors ?? {}).map(([key, messages]) => `${key}: ${messages.join(", ")}`)].join("; ");
  return `${body.error?.message ?? `Protected control failed (HTTP ${statusCode}).`}${fields ? ` ${fields}` : ""}`;
}
