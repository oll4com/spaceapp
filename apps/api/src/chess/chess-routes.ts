import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { START_FEN, findMoveInText, legalMoves, parseFen } from "./chess-rules.js";
import type { CliMoveRunner } from "./chess-cli.js";
import {
  createChessCatalog,
  createChessMoveRequester,
  isChessContestantId,
  reasoningRank,
  type ChessCliBridge,
  type ChessContestant,
  type ChessContestantCatalog,
  type ChessMoveRequester,
  type ChessProviderCheck,
} from "./chess-players.js";
import {
  CHESS_SYSTEM_PROMPT,
  ChessTournamentConflictError,
  ChessTournamentRunner,
  buildMovePrompt,
  defaultSwissRounds,
  type ChessTournamentSettings,
} from "./chess-tournament.js";

/**
 * Chess tournament API for the Benchmark page. Reads are open to signed-in
 * users; starting, stopping, resuming and resetting spend provider quota and
 * need an ADMIN or OPERATOR account. Contestants must come from the live
 * catalog: the client never supplies model ids that the server would call
 * blindly.
 */

const DEFAULT_STATE_FILE = "/opt/spaceapp/var/chess-tournament.json";
export const MAX_CHESS_CONTESTANTS = 128;
const PROVIDER_CHECK_TIMEOUT_MS = 60_000;
const PROVIDER_CHECK_CONCURRENCY = 6;
const PROVIDER_CHECK_MODELS = 3;

const startSchema = z.object({
  contestantIds: z.array(z.string()).min(2).max(MAX_CHESS_CONTESTANTS),
  format: z.enum(["swiss", "round_robin"]).default("swiss"),
  rounds: z.number().int().min(1).max(30).optional(),
  moveTimeoutMs: z.number().int().min(5_000).max(180_000).default(30_000),
  maxPlies: z.number().int().min(20).max(400).default(60),
  concurrency: z.number().int().min(1).max(32).default(16),
});

export interface ChessRouteDeps {
  stateFile?: string;
  requestMove?: ChessMoveRequester;
  loadContestants?: () => Promise<ChessContestantCatalog>;
  /** SpaceApp CLI runtimes (readiness and model catalogs) for CLI providers. */
  cli?: ChessCliBridge;
  /** Claude account profile with the most quota left (null = main account). */
  claudeProfile?: () => Promise<string | null>;
  /** Runs CLI moves in the worker (CLI processes never run in the API's cgroup). */
  runCliMove?: CliMoveRunner;
  /** Continue a tournament an API restart interrupted (the production server only, never tests). */
  autoResume?: boolean;
}

/** One real opening move from a provider's lightest contestant: proves sign-in, quota and answer format. */
export async function checkChessProvider(contestant: ChessContestant, requestMove: ChessMoveRequester): Promise<ChessProviderCheck> {
  const position = parseFen(START_FEN);
  const legal = legalMoves(position);
  const started = Date.now();
  const result = (ok: boolean, error: string | null): ChessProviderCheck => ({
    ok,
    latencyMs: Date.now() - started,
    contestantId: contestant.id,
    error,
    checkedAt: new Date().toISOString(),
  });
  try {
    const reply = await requestMove({
      contestant,
      system: CHESS_SYSTEM_PROMPT,
      prompt: buildMovePrompt(position, legal, [], null),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
    return findMoveInText(position, reply.text, legal) ? result(true, null) : result(false, "Answered without a legal move.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(false, /abort|timeout/i.test(message) ? `No answer within ${PROVIDER_CHECK_TIMEOUT_MS / 1000} s.` : message.slice(0, 180));
  }
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const role = request.user?.role;
  if (role === "ADMIN" || role === "OPERATOR") return true;
  void reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only an admin can control the chess tournament." } });
  return false;
}

function conflict(reply: FastifyReply, error: unknown) {
  if (error instanceof ChessTournamentConflictError) {
    return reply.code(409).send({ error: { code: "CONFLICT", message: error.message } });
  }
  throw error;
}

export function registerChessBenchmarkRoutes(
  app: FastifyInstance,
  rateLimitOptions: RouteShorthandOptions,
  deps: ChessRouteDeps = {}
): ChessTournamentRunner {
  const catalog = createChessCatalog({ cli: deps.cli });
  const providerChecks = new Map<string, ChessProviderCheck>();
  const requestMove = deps.requestMove ?? createChessMoveRequester({ claudeProfile: deps.claudeProfile, runCliMove: deps.runCliMove });
  let checking: Promise<void> | null = null;
  const loadContestants = async (): Promise<ChessContestantCatalog & { checking: boolean }> => {
    const loaded = await (deps.loadContestants ?? (() => catalog()))();
    return {
      ...loaded,
      checking: checking !== null,
      providers: loaded.providers.map((provider) => {
        const check = providerChecks.get(provider.id);
        return check ? { ...provider, check } : provider;
      }),
    };
  };
  const runner = new ChessTournamentRunner({
    requestMove,
    stateFile: deps.stateFile ?? (process.env.SPACE_CHESS_TOURNAMENT_FILE?.trim() || DEFAULT_STATE_FILE),
    log: (event, details) => app.log.info({ event, ...details }, "chess benchmark"),
  });
  app.addHook("onClose", async () => {
    await runner.stop("interrupted");
  });
  if (deps.autoResume) {
    app.addHook("onReady", async () => {
      void runner.resumeIfInterrupted().catch((error) => app.log.warn({ event: "chess_auto_resume_failed", error: String(error) }, "chess benchmark"));
    });
  }

  app.get("/api/chess/benchmark/contestants", rateLimitOptions, async () => loadContestants());

  // Checks run in the background (a slow CLI can take a minute); the page polls the catalog for results.
  app.post("/api/chess/benchmark/providers/check", rateLimitOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    if (runner.active) {
      return reply.code(409).send({ error: { code: "CONFLICT", message: "Providers are checked between tournaments." } });
    }
    if (!checking) {
      checking = (async () => {
        const loaded = await loadContestants();
        // Up to three models per provider (lightest effort each): one unavailable model must not
        // switch a whole provider off.
        const probes = loaded.providers
          .filter((provider) => provider.available)
          .map((provider) => {
            const byModel = new Map<string, ChessContestant>();
            for (const contestant of loaded.contestants.filter((candidate) => candidate.providerId === provider.id)) {
              const current = byModel.get(contestant.modelId);
              if (!current || reasoningRank(contestant.reasoningEffort) < reasoningRank(current.reasoningEffort)) {
                byModel.set(contestant.modelId, contestant);
              }
            }
            return [...byModel.values()].slice(0, PROVIDER_CHECK_MODELS);
          })
          .filter((candidates) => candidates.length > 0);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(PROVIDER_CHECK_CONCURRENCY, probes.length) }, async () => {
            while (cursor < probes.length) {
              const candidates = probes[cursor++]!;
              // The first passing model, otherwise the first failure.
              let result: ChessProviderCheck | null = null;
              for (const contestant of candidates) {
                const check = await checkChessProvider(contestant, requestMove);
                if (check.ok || !result) result = check;
                if (check.ok) break;
              }
              providerChecks.set(candidates[0]!.providerId, result!);
            }
          })
        );
      })()
        .catch((error) => app.log.warn({ event: "chess_provider_check_failed", error: String(error) }, "chess benchmark"))
        .finally(() => {
          checking = null;
        });
    }
    return reply.code(202).send(await loadContestants());
  });

  app.get("/api/chess/benchmark/tournament", rateLimitOptions, async () => ({ tournament: await runner.snapshot() }));

  app.get<{ Params: { gameId: string } }>("/api/chess/benchmark/games/:gameId", rateLimitOptions, async (request, reply) => {
    const gameId = request.params?.gameId ?? "";
    if (!/^r\d{1,3}-(?:g\d{1,4}|bye)$/.test(gameId)) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid game id." } });
    }
    const game = await runner.game(gameId);
    if (!game) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Game not found." } });
    return { game };
  });

  app.post("/api/chess/benchmark/tournament/start", rateLimitOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const parsed = startSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: "INVALID_SETTINGS", message: "Tournament settings are invalid." } });
    }
    const body = parsed.data;
    const ids = [...new Set(body.contestantIds)];
    if (ids.length < 2 || ids.some((id) => !isChessContestantId(id))) {
      return reply.code(400).send({ error: { code: "INVALID_CONTESTANTS", message: "Choose at least two valid contestants." } });
    }
    const catalog = await loadContestants();
    const byId = new Map(catalog.contestants.map((contestant) => [contestant.id, contestant]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: { code: "UNKNOWN_CONTESTANTS", message: `Not in the live catalog: ${unknown.slice(0, 5).join(", ")}` },
      });
    }
    const maxRounds = Math.max(1, ids.length - 1);
    const settings: ChessTournamentSettings = {
      format: body.format,
      rounds: Math.min(body.rounds ?? defaultSwissRounds(ids.length), maxRounds),
      moveTimeoutMs: body.moveTimeoutMs,
      maxPlies: body.maxPlies,
      concurrency: body.concurrency,
    };
    try {
      await runner.start(settings, ids.map((id) => byId.get(id)!));
    } catch (error) {
      return conflict(reply, error);
    }
    return { tournament: await runner.snapshot() };
  });

  app.post("/api/chess/benchmark/tournament/stop", rateLimitOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    await runner.stop("stopped");
    return { tournament: await runner.snapshot() };
  });

  app.post("/api/chess/benchmark/tournament/resume", rateLimitOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    try {
      await runner.resume();
    } catch (error) {
      return conflict(reply, error);
    }
    return { tournament: await runner.snapshot() };
  });

  app.post("/api/chess/benchmark/tournament/reset", rateLimitOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    try {
      await runner.reset();
    } catch (error) {
      return conflict(reply, error);
    }
    return { tournament: null };
  });

  return runner;
}
