import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { LiveHistoryRepository, LiveHistoryTurn } from "@space/db";
import { SpaceConflictError } from "@space/runtime";

const turnSchema = z.object({
  id: z.string().min(1).max(250), sessionId: z.string().min(1).max(160), roomId: z.string().min(1).max(120), roomName: z.string().max(500).optional(),
  role: z.enum(["user", "assistant", "system", "tool"]), text: z.string().max(32000), timestamp: z.string().max(100),
  createdAtMs: z.number().int().min(0).max(8_640_000_000_000_000), revision: z.number().int().min(1).max(2_147_483_647)
}).strict();
export function verifiedLegacyVoiceTurns(owner: string, room: string, source: string): LiveHistoryTurn[] {
  const result: LiveHistoryTurn[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    try {
      const item = JSON.parse(line);
      // Old unowned/global files are retained, but never attributed by guesswork.
      if (item.ownerId !== owner || item.roomId !== room || !["user", "assistant", "tool"].includes(item.role) || typeof item.text !== "string" || !item.text.trim()) continue;
      const createdAtMs = Date.parse(item.timestamp); if (!Number.isFinite(createdAtMs)) continue;
      const id = createHash("sha256").update(`${index}:${line}`).digest("hex");
      result.push({ id: `legacy:${id}`, sessionId: "legacy-import", roomId: room, role: item.role, text: item.text.slice(0, 32000), timestamp: item.timestamp, createdAtMs, revision: 1 });
    } catch {}
  }
  return result.slice(-200);
}
export function registerLiveHistoryRoutes(app: FastifyInstance, options: {
  repository: LiveHistoryRepository;
  routeOptions: RouteShorthandOptions;
  assertAccess: (request: FastifyRequest, room: string) => Promise<unknown>;
  readLegacy?: (room: string) => Promise<string | null>;
  audit?: (owner: string, room: string, event: Record<string, unknown>) => Promise<void>;
}) {
  const { repository, routeOptions } = options;
  const owner = (request: FastifyRequest) => {
    if (!request.user || request.user.automationScope || request.user.proofScope === "READ_ONLY") throw new SpaceConflictError("An authenticated interactive Live owner is required.");
    return request.user.id;
  };
  const migrate = async (id: string, room: string) => {
    if (!options.readLegacy) return;
    const source = await options.readLegacy(room);
    if (source) await repository.importLegacy(id, room, verifiedLegacyVoiceTurns(id, room, source));
  };
  app.get("/api/live/history", routeOptions, async request => {
    const id = owner(request);
    const input = z.object({ roomId: z.string().min(1).max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(200) }).parse(request.query);
    if (input.roomId) { await options.assertAccess(request, input.roomId); await migrate(id, input.roomId); }
    return { ok: true, ownerId: id, ...await repository.read(id, input.roomId, input.limit) };
  });
  app.post("/api/live/history/turns", routeOptions, async request => {
    const id = owner(request);
    const input = z.object({ expectedOwnerId: z.string().min(1).max(160), turns: z.array(z.object({ item: turnSchema, epoch: z.number().int().min(0) }).strict()).min(1).max(50) }).strict().parse(request.body);
    if (input.expectedOwnerId !== id) throw new SpaceConflictError("Live owner changed. Reload before syncing history.");
    for (const room of new Set(input.turns.map(turn => turn.item.roomId))) await options.assertAccess(request, room);
    const receipts = [];
    for (const turn of input.turns) receipts.push({ id: turn.item.id, sessionId: turn.item.sessionId, accepted: await repository.write(id, turn.item, turn.epoch) });
    return { ok: true, receipts };
  });
  app.delete("/api/voice/realtime/logs/:roomId", routeOptions, async request => {
    const id = owner(request), { roomId } = z.object({ roomId: z.string().min(1).max(120) }).parse(request.params);
    await options.assertAccess(request, roomId);
    return { ok: true, clearedRoomId: roomId, epoch: await repository.clear(id, roomId) };
  });
  app.get("/api/voice/realtime/history/:roomId", routeOptions, async request => {
    const id = owner(request), { roomId } = z.object({ roomId: z.string().min(1).max(120) }).parse(request.params);
    await options.assertAccess(request, roomId); await migrate(id, roomId);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    return { ok: true, roomId, ...await repository.read(id, roomId, limit) };
  });
  const search = async (request: FastifyRequest) => {
    const id = owner(request);
    const input = z.object({ query: z.string().max(1000).optional(), q: z.string().max(1000).optional(), roomId: z.string().min(1).max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(request.method === "POST" ? request.body : request.query);
    if (input.roomId) await options.assertAccess(request, input.roomId);
    const q = (input.query ?? input.q ?? "").trim().toLocaleLowerCase();
    const items = q ? (await repository.read(id, input.roomId, 200)).items : [];
    return { ok: true, results: items.filter(item => item.text.toLocaleLowerCase().includes(q)).slice(-input.limit) };
  };
  app.get("/api/voice/realtime/history/search", routeOptions, search);
  app.post("/api/voice/realtime/history/search", routeOptions, search);
  app.post("/api/voice/realtime/logs", routeOptions, async request => {
    const id = owner(request);
    const event = z.object({ roomId: z.string().min(1).max(120), event: z.string().max(120), role: z.string().max(30).optional(), text: z.string().max(64000).optional(), timestamp: z.string().max(100).optional(), toolCall: z.unknown().optional(), detail: z.unknown().optional() }).parse(request.body);
    await options.assertAccess(request, event.roomId);
    // Technical audit is not a second conversation writer; turns carry stable IDs.
    await options.audit?.(id, event.roomId, event);
    return { ok: true };
  });
}
