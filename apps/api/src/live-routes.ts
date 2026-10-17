import type {} from "./request-context.js";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { AuthUser, Room } from "@space/contracts";
import {
  InMemoryLiveHistoryRepository, InMemoryLiveMemoryRepository, PostgresLiveHistoryRepository,
  PostgresLiveMemoryRepository, PostgresSpaceStore
} from "@space/db";
import { nowIso, SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { AuthConfig } from "./auth.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { registerLiveHistoryRoutes } from "./live-history-routes.js";
import { createLivePersonalMemory } from "./live-personal-memory.js";
import { buildLiveRoomContext } from "./live-room-context.js";
import type { RoomAgentService } from "./room-agent.js";
import type { RoomPaneController } from "./room-pane-control.js";

/**
 * Live pane search, URL fetch, room context, personal memory and history (with their repositories and close hooks);
 * the parent retains authentication, CSRF, errors and rate limits.
 */
export function registerLiveRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  auth: AuthConfig;
  store: SpaceStore;
  roomPaneController: RoomPaneController;
  roomAgentService: RoomAgentService;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  assertRoomAccess: (roomId: string, user: AuthUser | null | undefined) => Promise<Room>;
  /** The Agents Dashboard sample, so Live and the Dashboard agree on who is working. */
  readDashboardAgents?: (roomId: string) => Promise<{ activity: Record<string, string> }>;
}) {
  const { config, auth, store, roomPaneController, roomAgentService, routeOptions: defaultRouteRateLimitOptions,
    assertRoomAccess } = options;
  app.post("/api/live/search", defaultRouteRateLimitOptions, async (request) => {
    const body = (request.body as { query?: string; limit?: number }) || {};
    const query = typeof body.query === "string" ? body.query.trim() : "";
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 10) : 5;
    if (!query) {
      return { results: [] };
    }

    const results: Array<{ title: string; snippet: string; url?: string }> = [];

    // 1. If query contains a domain or URL-like term (e.g. "ola.gr"), fetch summary of that domain
    const domainMatch = query.match(/(?:https?:\/\/)?([a-zA-Z0-9-]+\.(?:gr|com|org|net|io|co|app|ai)(?:\/[^\s]*)?)/i);
    if (domainMatch && domainMatch[1]) {
      try {
        const targetUrl = domainMatch[1].startsWith("http") ? domainMatch[1] : `https://${domainMatch[1]}`;
        const siteResp = await fetch(targetUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)" },
          signal: AbortSignal.timeout(4000)
        });
        if (siteResp.ok) {
          const html = await siteResp.text();
          const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || domainMatch[1];
          const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() || "";
          const bodySnippet = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
          results.push({
            title: `Website: ${title}`,
            snippet: metaDesc || bodySnippet || `Active website at ${targetUrl}`,
            url: targetUrl
          });
        }
      } catch {}
    }

    // 2. If query mentions weather or temperature, query Open-Meteo for real-time weather
    if (/weather|temperature|καιρ/i.test(query)) {
      try {
        let lat = 13.7563; // Bangkok default
        let lon = 100.5018;
        let locName = "Bangkok, Thailand";
        if (/athens|greece|αθην/i.test(query)) {
          lat = 37.9838;
          lon = 23.7275;
          locName = "Athens, Greece";
        }
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`;
        const weatherResp = await fetch(weatherUrl, { signal: AbortSignal.timeout(4000) });
        if (weatherResp.ok) {
          const wData = (await weatherResp.json()) as { current?: { temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; wind_speed_10m?: number } };
          if (wData?.current) {
            results.push({
              title: `Live Weather in ${locName}`,
              snippet: `Temperature: ${wData.current.temperature_2m}°C (feels like ${wData.current.apparent_temperature}°C), Humidity: ${wData.current.relative_humidity_2m}%, Wind: ${wData.current.wind_speed_10m} km/h`,
              url: `https://open-meteo.com/`
            });
          }
        }
      } catch {}
    }

    // 3. Wikipedia search for factual knowledge, definitions, history, people, geography
    try {
      const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
      const wikiResp = await fetch(wikiUrl, {
        headers: { "User-Agent": "SpaceApp/1.0 (LiveAssistant; contact@space.local)" },
        signal: AbortSignal.timeout(4000)
      });
      if (wikiResp.ok) {
        const data = (await wikiResp.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
        if (Array.isArray(data?.query?.search)) {
          for (const item of data.query.search.slice(0, 3)) {
            const cleanTitle = item.title?.trim() || "";
            const cleanSnippet = (item.snippet || "").replace(/<[^>]+>/g, "").trim();
            if (cleanTitle && cleanSnippet) {
              results.push({
                title: cleanTitle,
                snippet: cleanSnippet,
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(cleanTitle.replace(/\s+/g, "_"))}`
              });
            }
          }
        }
      }
    } catch {}

    return { results: results.slice(0, limit) };
  });
  app.post("/api/live/fetch-url", defaultRouteRateLimitOptions, async (request, reply) => {
    const body = (request.body as { url?: string; maxChars?: number }) || {};
    let rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    const maxChars = typeof body.maxChars === "number" && body.maxChars > 0 ? Math.min(body.maxChars, 8000) : 3000;
    if (!rawUrl) {
      return sendApiError(reply, 400, "MISSING_URL", "Target URL is required.");
    }
    if (!/^https?:\/\//i.test(rawUrl)) {
      rawUrl = `https://${rawUrl}`;
    }

    try {
      const resp = await fetch(rawUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!resp.ok) {
        return {
          url: rawUrl,
          title: "",
          text: `HTTP error ${resp.status} fetching ${rawUrl}: ${resp.statusText}`
        };
      }
      const html = await resp.text();
      const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() || rawUrl;
      const cleanText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, " ")
        .trim();

      return {
        url: rawUrl,
        title,
        text: cleanText.slice(0, maxChars)
      };
    } catch (err) {
      return {
        url: rawUrl,
        title: "",
        text: `Error fetching URL ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  });
  const liveContextReads = new Map<string, Promise<Awaited<ReturnType<typeof buildLiveRoomContext>>>>();
  app.get("/api/live/context/:roomId", defaultRouteRateLimitOptions, async request => {
    if (!request.user || request.user.automationScope) throw new SpaceConflictError("An authenticated interactive owner is required.");
    const { roomId } = z.object({ roomId: z.string().min(1).max(120) }).parse(request.params);
    const room = await assertRoomAccess(roomId, request.user);
    const { fresh } = z.object({ fresh: z.enum(["true", "false"]).optional() }).parse(request.query);
    const key = `${request.user.id}:${roomId}:${fresh === "true" ? "fresh" : "cached"}`;
    const pending = liveContextReads.get(key);
    if (pending) return pending;
    const read = (async () => {
      const [panes, mission, board] = await Promise.all([store.listPanes(roomId), roomAgentService.inspectMission(roomId).catch(() => null),
        options.readDashboardAgents?.(roomId).catch(() => null) ?? null]);
      return buildLiveRoomContext({ room, panes, objective: mission?.snapshot?.objective, dashboard: board?.activity,
        inspect: pane => roomPaneController.inspect(pane, fresh === "true" ? { fresh: true } : undefined) });
    })();
    liveContextReads.set(key, read);
    try { return await read; } finally { if (liveContextReads.get(key) === read) liveContextReads.delete(key); }
  });
  const liveMemoryRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresLiveMemoryRepository.fromConnectionString(config.databaseUrl) : new InMemoryLiveMemoryRepository();
  const livePersonalMemory = createLivePersonalMemory({
    repository: liveMemoryRepository,
    // Import only for the installation's configured legacy operator, never the
    // first arbitrary caller. An unassigned legacy file remains untouched.
    legacyOwnerId: auth.operatorEmail ? "user:operator" : auth.devLogin ? "user:dev-operator" : undefined,
    readLegacy: async () => {
      if (!(store instanceof PostgresSpaceStore)) return null;
      try { return await readFile("/opt/spaceapp/var/live-personal-memory.json", "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
  });
  app.addHook("onClose", async () => liveMemoryRepository.dispose());
  const liveMemoryOwner = (request: FastifyRequest) => {
    if (!request.user || request.user.automationScope) throw new SpaceConflictError("Authenticated personal-memory owner required.");
    return request.user.id;
  };
  app.get("/api/live/personal-memory", defaultRouteRateLimitOptions, async request => livePersonalMemory.read(liveMemoryOwner(request)));
  app.post("/api/live/personal-memory", defaultRouteRateLimitOptions, async request => livePersonalMemory.save(liveMemoryOwner(request), request.body));
  app.delete("/api/live/personal-memory/:id", defaultRouteRateLimitOptions, async request => {
    const { id } = z.object({ id: z.string().trim().min(1).max(200) }).parse(request.params);
    const { expectedRevision } = z.object({ expectedRevision: z.coerce.number().int().min(0).optional() }).parse(request.query);
    return livePersonalMemory.delete(liveMemoryOwner(request), id, expectedRevision);
  });
  app.get("/api/live/personal-memory/changes", defaultRouteRateLimitOptions, async request => ({ items: await livePersonalMemory.changes(liveMemoryOwner(request)) }));
  app.get("/api/live/personal-memory/review", defaultRouteRateLimitOptions, async request => livePersonalMemory.review(liveMemoryOwner(request)));
  app.post("/api/live/personal-memory/maintain", defaultRouteRateLimitOptions, async request => {
    const { expectedRevision } = z.object({ expectedRevision: z.number().int().min(0) }).strict().parse(request.body);
    return livePersonalMemory.maintain(liveMemoryOwner(request), expectedRevision);
  });
  const liveHistoryRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresLiveHistoryRepository.fromConnectionString(config.databaseUrl) : new InMemoryLiveHistoryRepository();
  app.addHook("onClose", () => liveHistoryRepository.dispose());
  registerLiveHistoryRoutes(app, {
    repository: liveHistoryRepository, routeOptions: defaultRouteRateLimitOptions,
    assertAccess: (request, room) => assertRoomAccess(room, request.user!),
    readLegacy: async room => {
      if (!(store instanceof PostgresSpaceStore) || !/^[a-zA-Z0-9:_-]+$/.test(room)) return null;
      try { return await readFile(join("/opt/spaceapp/var/live-voice-logs", `live-voice-${room}.jsonl`), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    audit: async (owner, room, event) => {
      if (!(store instanceof PostgresSpaceStore)) return;
      const key = createHash("sha256").update(JSON.stringify([owner, room])).digest("hex");
      const directory = "/opt/spaceapp/var/live-voice-logs/owners";
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(join(directory, `${key}.jsonl`), JSON.stringify({ ...event, ownerId: owner, roomId: room, recordedAt: nowIso() }) + "\n", { mode: 0o600 });
    }
  });
  // The Research Council reads the owner's personal memory as context for its coordinator.
  return { livePersonalMemory };
}
