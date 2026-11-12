import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SPACE_INSTALL_ROOT } from "@space/contracts";
import type { AccountPool } from "../../accounts/account-pool.js";
import { gatewayError } from "../../errors.js";
import { selectAccount } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";
import { buildCodexUpstreamHeaders } from "./headers.js";
import { CODEX_UPSTREAM_BASE_URL } from "./usage.js";

/**
 * Model catalog (`/backend-api/codex/models`, `/v1/models`), after codex-lb: the Codex catalog comes from upstream
 * through any usable account, cached briefly per client version; `/v1/models` also lists it in OpenAI form.
 * Keys with a model allowlist only see their models.
 */
const CACHE_MS = 5 * 60_000;

type CodexModel = Record<string, unknown> & { slug?: unknown };

// Upstream lists newer models only to newer clients, and clients without a version (Oh My Pi, Hermes) read the newest one
// seen; after a gateway start that is the installed Codex CLI's version, not an old constant (12/11: OMP's default gpt-6-sol was missing).
function installedCodexVersion(): string {
  try {
    const version = basename(readlinkSync(`${SPACE_INSTALL_ROOT}/var/cli-versions/codex/current`));
    if (/^\d+\.\d+\.\d+$/.test(version)) return version;
  } catch { /* no installed Codex link: the fallback below */ }
  return "0.150.1";
}

/** True when `candidate` is a newer major.minor.patch than `current`; anything else never replaces it. */
function isNewerClientVersion(candidate: string, current: string): boolean {
  const next = /^(\d+)\.(\d+)\.(\d+)/.exec(candidate), now = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!next) return false;
  if (!now) return true;
  for (let i = 1; i <= 3; i++) if (Number(next[i]) !== Number(now[i])) return Number(next[i]) > Number(now[i]);
  return false;
}

export function registerCodexModelRoutes(app: FastifyInstance, helpers: GatewayRouteHelpers, options: {
  pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number; defaultClientVersion?: string; upstreamBaseUrl?: string;
  /** Answers `/v1/models` for Anthropic clients (they send `anthropic-version`). */
  anthropicModels?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; models: CodexModel[] }>();
  let lastClientVersion = options.defaultClientVersion ?? installedCodexVersion();

  async function catalog(request: FastifyRequest, clientVersion: string): Promise<CodexModel[] | { error: string; status: number }> {
    const cached = cache.get(clientVersion);
    if (cached && now() - cached.at < CACHE_MS) return cached.models;
    const accounts = await options.pool.accounts();
    const states = accounts.map((account) => options.pool.toBalancerState(account));
    const selected = selectAccount(states, { now: now() / 1000, routingStrategy: "ROUND_ROBIN", allowUsageExhaustionError: false });
    for (const state of states) options.pool.absorb(state);
    // Listing models costs no quota, so an exhausted account may still answer it.
    const account = accounts.find((item) => item.id === selected.account?.accountId)
      ?? accounts.find((item) => item.status !== "PAUSED" && item.status !== "DEACTIVATED");
    if (!account) return cached?.models ?? { error: "No accounts are available in Space Gateway.", status: 503 };
    try {
      const credentials = await options.pool.credentials(account);
      const response = await fetchImpl(`${(options.upstreamBaseUrl ?? CODEX_UPSTREAM_BASE_URL).replace(/\/+$/, "")}/codex/models?client_version=${encodeURIComponent(clientVersion)}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { ...buildCodexUpstreamHeaders(request.headers, credentials.accessToken, credentials.upstreamAccountId, "application/json") }
      });
      if (!response.ok) return cached?.models ?? { error: `The model catalog returned HTTP ${response.status}.`, status: 502 };
      const body = await response.json() as { models?: unknown };
      const models = Array.isArray(body.models) ? body.models.filter((model): model is CodexModel => Boolean(model && typeof model === "object")) : [];
      cache.set(clientVersion, { at: now(), models });
      return models;
    } catch {
      return cached?.models ?? { error: "The model catalog is unavailable.", status: 502 };
    }
  }

  function visible(request: FastifyRequest, models: CodexModel[]): CodexModel[] {
    const allowed = request.gatewayApiKey?.allowedModels ?? [];
    return allowed.length === 0 ? models : models.filter((model) => typeof model.slug === "string" && allowed.includes(model.slug));
  }

  async function codexModels(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const requested = (request.query as { client_version?: unknown }).client_version;
    const clientVersion = typeof requested === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(requested) ? requested : lastClientVersion;
    if (typeof requested === "string" && isNewerClientVersion(clientVersion, lastClientVersion)) lastClientVersion = clientVersion;
    const result = await catalog(request, clientVersion);
    if (!Array.isArray(result)) return reply.code(result.status).send(gatewayError("models_unavailable", result.error));
    return { models: visible(request, result) };
  }

  app.get("/backend-api/codex/models", codexModels);
  app.get("/v1/models", async (request, reply) => {
    if (options.anthropicModels && request.headers["anthropic-version"]) return options.anthropicModels(request, reply);
    if ((request.query as { client_version?: unknown }).client_version) return codexModels(request, reply);
    if (!(await helpers.authenticate(request, reply))) return reply;
    const result = await catalog(request, lastClientVersion);
    if (!Array.isArray(result)) return reply.code(result.status).send(gatewayError("models_unavailable", result.error));
    const models = visible(request, result);
    return {
      object: "list",
      data: models.filter((model) => typeof model.slug === "string").map((model) => ({ id: model.slug as string, object: "model", created: 0, owned_by: "openai" })),
      models
    };
  });
  /** The newest Codex client version seen, for other catalog reads. */
  return { clientVersion: () => lastClientVersion };
}
