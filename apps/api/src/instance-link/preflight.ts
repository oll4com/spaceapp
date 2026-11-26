import { controlExecuteSchema, controlInspectSchema, controlToolSchemas, mobileBodyProblem, type MobileRouteRule } from "@space/contracts";
import type { ZodType } from "zod";
import { sanitizeControlExecute } from "../space-control-routes.js";
import { InstanceLinkError } from "./client.js";

/** A request this side refused before sending (Nous's tool counts it REFUSED, not FAILED). */
export class LinkNotSentError extends InstanceLinkError {}

// What the other side would refuse, caught before a request leaves (plan clipboard:1NF6u6gcCwtj step 4, 15/11: MOBILE_BODY on inspect x4,
// "Unrecognized key(s)" x5): its body rule for a link, then the schema its route parses. Both sides run the same commit (version sync).
const SCHEMAS: Record<string, { schema: ZodType; prepare?: (body: unknown) => unknown }> = {
  "/api/control/v1/inspect": { schema: controlInspectSchema },
  "/api/control/v1/commands": { schema: controlExecuteSchema, prepare: sanitizeControlExecute },
  "/api/control/v1/screenshot": { schema: controlToolSchemas.space_screenshot }
};

/** Why the other side would refuse this body, or null. */
export function linkBodyProblem(rule: MobileRouteRule, method: string, path: string, body: unknown, scopes: readonly string[]): string | null {
  if (rule.body) {
    const problem = mobileBodyProblem(rule.body, body ?? {}, scopes);
    if (problem) return problem;
  }
  const entry = method === "POST" ? SCHEMAS[path.split("?")[0]!] : undefined;
  if (!entry) return null;
  const parsed = entry.schema.safeParse(entry.prepare ? entry.prepare(body ?? {}) : body ?? {});
  return parsed.success ? null : parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

/** The room a request names (its body's roomId or /api/rooms/:id), which the other side must hold. */
export function roomOf(path: string, body: unknown): string | null {
  const roomId = body && typeof body === "object" && !Array.isArray(body) ? (body as { roomId?: unknown }).roomId : undefined;
  if (typeof roomId === "string" && roomId) return roomId;
  return /^\/api\/rooms\/([^/?]+)/.exec(path)?.[1] ?? null;
}

/**
 * Null while the other side holds `room` (or its rooms cannot be read: that never blocks), else "has no room X. Its rooms: ...". A room not
 * among the rooms it last listed is read again first, so a room made a moment ago passes.
 */
export async function roomMissing(known: Map<string, Set<string>>, linkId: string, room: string, read: () => Promise<unknown>): Promise<string | null> {
  if (known.get(linkId)?.has(room)) return null;
  const body = await read().catch(() => null);
  const listed = Array.isArray(body) ? body : (body as { rooms?: unknown } | null)?.rooms;
  if (!Array.isArray(listed)) return null;
  const rooms = (listed as Array<{ id?: unknown; name?: unknown }>).filter((entry) => typeof entry?.id === "string");
  known.set(linkId, new Set(rooms.map((entry) => entry.id as string)));
  return known.get(linkId)!.has(room) ? null
    : `has no room ${room}. Its rooms: ${rooms.map((entry) => `${String(entry.name ?? "")} (${entry.id as string})`).join(", ") || "none"}.`;
}
