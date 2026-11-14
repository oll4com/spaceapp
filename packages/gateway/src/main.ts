import { initNodeSentry, captureSentryException, flushSentry } from "@space/contracts/sentry-node";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, type Server } from "node:http";
import { PostgresGatewayRepository } from "@space/db";
import { SPACE_INSTALL_ROOT, type GatewaySettings } from "@space/contracts";
import { AccountPool } from "./accounts/account-pool.js";
import { StickyStore } from "./accounts/sticky-store.js";
import { registerAccountAdminRoutes } from "./admin/account-admin.js";
import { antigravityAccountActions, registerAntigravitySignInRoutes } from "./admin/antigravity-sign-in.js";
import { apiKeyAccountActions, googleAiEntry, openAiApiAccountActions, registerApiKeyAccountRoutes } from "./admin/api-key-accounts.js";
import { ModelChecks, startModelProbe } from "./providers/key-pools/model-checks.js";
import { keyPoolProviders, registerKeyPoolRoutes } from "./providers/key-pools/key-pools.js";
import { registerSpacePoolRoutes } from "./providers/space/space-pool.js";
import { claudeAccountActions, registerClaudeSignInRoutes } from "./admin/claude-sign-in.js";
import { registerCodexSignInRoutes } from "./admin/codex-sign-in.js";
import { loadGatewayConfig } from "./config.js";
import { lanAccessFromSettings, withLanEnvFile } from "./lan-access.js";
import { createCredentialCipher, loadCredentialCipher, type CredentialCipher } from "./credential-cipher.js";
import { registerCodexProxyRoutes } from "./providers/codex/codex-proxy.js";
import { CodexWebSocketRegistry } from "./providers/codex/codex-websocket.js";
import { CodexModelPlans } from "./providers/codex/model-plans.js";
import { registerCodexAccountUsageRoute } from "./providers/codex/account-usage.js";
import { registerWeeklyRemainingRoute } from "./providers/codex/weekly-remaining.js";
import { registerCodexModelRoutes } from "./providers/codex/models.js";
import { createCodexRefresher } from "./providers/codex/credentials.js";
import { startCodexUsagePoller } from "./providers/codex/usage-refresh.js";
import { registerAntigravityProxyRoutes } from "./providers/antigravity/antigravity-proxy.js";
import { registerImageRoutes } from "./providers/images/images-route.js";
import { createAntigravityRefresher } from "./providers/antigravity/credentials.js";
import { startAntigravityUsagePoller } from "./providers/antigravity/usage-refresh.js";
import { createApiBudgetPacer } from "./providers/claude/api-budget.js";
import { registerClaudeProxyRoutes } from "./providers/claude/claude-proxy.js";
import { apiKeyRefresher, registerEmbeddingsRoute } from "./providers/openai-api/embeddings-proxy.js";
import { LocalEmbeddings } from "./providers/local/embeddings.js";
import { createClaudeRefresher } from "./providers/claude/credentials.js";
import { startClaudeUsagePoller } from "./providers/claude/usage-refresh.js";
import { CompressionCache, RawBlockRegistry } from "./compression/engine.js";
import { CompressionPool } from "./compression/pool.js";
import { RequestLogWriter } from "./request-log-writer.js";
import { startWarmupRunner } from "./warmup/warmup-runner.js";
import { createGatewayServer } from "./server.js";
import { DRAIN_MESSAGE, heldCredentialKey, holdCredentialKey } from "./supervisor.js";
import { gcpKmsDecrypter, gcpKmsKeyProvider } from "./nous/kms.js";
import { loadBilling, registerCheckoutRoute, registerStripeWebhook, type BillingConfig } from "./nous/subscriptions.js";
import { startAdminListener } from "./nous/admin.js";
import { createNgwMetrics } from "./nous/metrics.js";
import { createSwitchReader, type SwitchReader } from "./nous/switches.js";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { registerStatsRoute } from "./stats.js";
import { registerAnthropicAdminRoutes, startAnthropicBillingSync, type AnthropicBillingSync } from "./admin/anthropic-admin.js";
import { createPriorityPanes, registerPriorityPanesRoute } from "./admin/priority-panes.js";
import { trackKeySettlement } from "./policy.js";
import { registerMakeRelayRoutes } from "./providers/make/make-relay.js";
import pg from "pg";
import { createNousTenancy, type NousTenancy } from "./nous/http.js";
import { createTenantKeyResolver, type TenantKeyResolver } from "./nous/tenant-keys.js";

async function readVersion(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(new URL("../../../version.json", import.meta.url), "utf8")) as { platform?: { version?: string } };
    return raw.platform?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

initNodeSentry("gateway");

async function main() {
  const config = loadGatewayConfig(await withLanEnvFile(process.env, process.env.SPACE_GATEWAY_ENV_FILE?.trim() || `${SPACE_INSTALL_ROOT}/.env`));
  if (!config.databaseUrl) throw new Error("SPACE_DATABASE_URL is required for Space Gateway.");
  // NGW_MODE=nous: no shared admin token. The admin routes accept only this per-process one, which only the mTLS admin listener sends.
  if (config.ngw) config.internalToken = randomBytes(32).toString("base64url");
  const repository = PostgresGatewayRepository.fromConnectionString(config.databaseUrl);
  let credentialKeyPresent = false;
  let cipher: CredentialCipher | null = null;
  const checkKey = async () => {
    if (config.ngw?.kms) return;
    credentialKeyPresent = await access(config.encryptionKeyFile, constants.R_OK).then(() => true, () => false);
    if (credentialKeyPresent && !cipher) cipher = await loadCredentialCipher(config.encryptionKeyFile).catch(() => null);
  };
  if (config.ngw?.kms) {
    // Unwrapped once into memory; a worker that cannot get the key exits and the supervisor keeps the running one (runbook §8.9).
    const held = await heldCredentialKey();
    const material = held ? Buffer.from(held, "base64") : await gcpKmsKeyProvider(config.ngw.kms).load();
    if (!held) holdCredentialKey(material.toString("base64"));
    cipher = createCredentialCipher(material);
    credentialKeyPresent = true;
  }
  await checkKey();
  let settingsCache: { at: number; value: GatewaySettings } | null = null;
  // Prompt-cache affinity follows its setting; the stores read it on every binding.
  let promptCacheTtlMs = 1800_000;
  const settings = async () => {
    if (!settingsCache || Date.now() - settingsCache.at > 5_000) {
      settingsCache = { at: Date.now(), value: await repository.getSettings() };
      promptCacheTtlMs = settingsCache.value.promptCacheTtlSeconds * 1000;
    }
    return settingsCache.value;
  };
  // LAN access: the settings override the env file when the operator chose ON or OFF there.
  const startupSettings = await settings().catch(() => null);
  if (startupSettings && startupSettings.lanMode !== "ENV" && !config.ngw) {
    const fromSettings = lanAccessFromSettings(startupSettings);
    config.lan = fromSettings.lan;
    config.lanError = fromSettings.error;
  }
  let tenancy: NousTenancy | undefined;
  const logs = new RequestLogWriter(repository, {
    onError: (error) => process.stderr.write(`space-gateway request log write failed: ${error instanceof Error ? error.message : "unknown"}\n`),
    transform: (row) => tenancy?.logRow(row) ?? row
  });
  const compressionPool = new CompressionPool(new URL("./compression-worker.mjs", import.meta.url), config.compressionWorkers);
  const compressionCache = new CompressionCache();
  const rawBlocks = new RawBlockRegistry();
  const codexPool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: createCodexRefresher() });
  const claudePool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: createClaudeRefresher() });
  const antigravityPool = new AccountPool({ provider: "ANTIGRAVITY", repository, cipher: () => cipher, refresher: createAntigravityRefresher() });
  const openAiApiPool = new AccountPool({ provider: "OPENAI_API", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const openRouterPool = new AccountPool({ provider: "OPENROUTER", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const deepSeekPool = new AccountPool({ provider: "DEEPSEEK", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const googleAiPool = new AccountPool({ provider: "GOOGLE_AI", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  // The free key pools (operator 5/11 14:34 BKK) and the granted credits of Adaption Labs and AMD Token Lab (6/11), wired like OpenRouter and DeepSeek.
  const freePools = Object.fromEntries((["nvidia", "groq", "cloudflare", "adaption", "amd", "inception", "jina", "mixedbread", "agentrouter", "freeai", "azure", "zai", "siliconflow", "ovh", "mistral", "bedrock", "vertex"] as const).map((slug) => [slug,
    new AccountPool({ provider: keyPoolProviders[slug].provider, repository, cipher: () => cipher, refresher: apiKeyRefresher })])) as Record<"groq" | "nvidia" | "cloudflare" | "adaption" | "amd" | "inception" | "jina" | "mixedbread" | "agentrouter" | "freeai" | "azure" | "zai" | "siliconflow" | "ovh" | "mistral" | "bedrock" | "vertex", AccountPool>;
  const freeByProvider = Object.entries(freePools).map(([slug, pool]) => ({ entry: keyPoolProviders[slug as keyof typeof freePools], pool }));
  // Their dead models (410/404), loaded before the routes serve and probed daily (model-checks.ts).
  const modelChecks = new ModelChecks(repository);
  await modelChecks.load().catch((error: unknown) => process.stderr.write(`space-gateway model checks failed to load: ${error instanceof Error ? error.message : "unknown"}\n`));
  const localEmbeddings = new LocalEmbeddings();
  const onStickyError = (error: unknown) =>
    process.stderr.write(`space-gateway sticky binding storage failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  const promptCacheTtl = () => promptCacheTtlMs;
  const sticky = {
    codexThreads: new StickyStore({ repository, provider: "CODEX", kind: "STICKY_THREAD", onError: onStickyError, ttlMs: promptCacheTtl }),
    codexContinuations: new StickyStore({ repository, provider: "CODEX", kind: "CONTINUATION", onError: onStickyError }),
    claudeSessions: new StickyStore({ repository, provider: "CLAUDE", kind: "PROMPT_CACHE", onError: onStickyError, ttlMs: promptCacheTtl }),
    antigravitySessions: new StickyStore({ repository, provider: "ANTIGRAVITY", kind: "PROMPT_CACHE", onError: onStickyError, ttlMs: promptCacheTtl })
  };
  // NGW_MODE=nous: tenant keys and the shared ledger (nous/http.ts); the ledger settles from the request-log rows instead.
  let ngwDb: pg.Pool | null = null;
  let ngwResolver: TenantKeyResolver | null = null;
  let ngwSwitches: SwitchReader | null = null;
  const ngwMetrics = createNgwMetrics();
  if (config.ngw) {
    ngwDb = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    ngwResolver = await createTenantKeyResolver(ngwDb);
    ngwSwitches = await createSwitchReader(ngwDb);
    tenancy = createNousTenancy({ db: ngwDb, resolver: ngwResolver, region: config.ngw.region, pools: { CLAUDE: claudePool, CODEX: codexPool,
      GEMINI: { accounts: () => antigravityPool.accounts(), toBalancerState: (account) => antigravityPool.toBalancerState(account, "gemini") } }, metrics: ngwMetrics, switches: ngwSwitches,
      onError: (error) => process.stderr.write(`nous-gateway settlement failed: ${error instanceof Error ? error.message : "unknown"}\n`) });
  }
  // K4-billing, test mode only: a missing or refused setting leaves billing off and AI serving on.
  const billing: BillingConfig | null = config.ngw ? await loadBilling(process.env, config.ngw.kms ? gcpKmsDecrypter(config.ngw.kms) : null)
    .catch((error: unknown) => { process.stderr.write(`nous-gateway billing is off: ${error instanceof Error ? error.message : "unknown"}\n`); return null; }) : null;
  const settleKeyUsage = tenancy ? undefined : (keyId: string, usage: Parameters<typeof repository.settleApiKeyUsage>[1]) =>
    trackKeySettlement(keyId, usage, () => repository.settleApiKeyUsage(keyId, usage));
  const compression = { run: compressionPool.run, cache: compressionCache, rawBlocks, record: (rows: Parameters<typeof repository.recordCompression>[0]) => repository.recordCompression(rows),
    recordSignals: (rows: Parameters<typeof repository.recordCompressionSignals>[0]) => repository.recordCompressionSignals(rows) };
  let clientVersion = () => "0.150.1";
  const modelPlans = new CodexModelPlans({ pool: codexPool, clientVersion: () => clientVersion() });
  const webSockets = new CodexWebSocketRegistry();
  let anthropicBilling: AnthropicBillingSync | null = null;
  const server = createGatewayServer({
    repository, version: await readVersion(), credentialKeyPresent: () => credentialKeyPresent, logger: false, lan: config.lan, tenancy,
    requestLog: (record) => { process.stdout.write(`${JSON.stringify(record)}\n`); },
    live: {
      inFlightByAccount: () => Object.assign({}, codexPool.inFlight(), claudePool.inFlight(), antigravityPool.inFlight(), openAiApiPool.inFlight(),
        openRouterPool.inFlight(), deepSeekPool.inFlight(), googleAiPool.inFlight(), ...Object.values(freePools).map((pool) => pool.inFlight())),
      activeWebSockets: () => webSockets.active(),
      relayTasks: () => webSockets.relays(),
      compressionQueue: () => compressionPool.queued()
    },
    routes: (app, helpers) => {
      let speedCache: { at: number; models: Record<string, string> } | null = null;
      const speedDefaults = async () => {
        if (!speedCache || Date.now() - speedCache.at > 5_000) speedCache = { at: Date.now(), models: (await repository.speedDefaults()).models };
        return speedCache.models;
      };
      // Operator rule 31/10: panes on an open operator request are never held by the pace cap; the Space API sends the list.
      const priorityPanes = createPriorityPanes();
      registerPriorityPanesRoute(app, { priorityPanes, internalToken: config.internalToken });
      registerCodexProxyRoutes(app, helpers, { pool: codexPool, logs, settings, settleKeyUsage, compression, modelPlans, speedDefaults,
        sticky: { threads: sticky.codexThreads, continuations: sticky.codexContinuations }, webSockets, priorityPanes });
      const claude = registerClaudeProxyRoutes(app, helpers, { pool: claudePool, logs, settings, settleKeyUsage, compression, sticky: sticky.claudeSessions,
        apiBudget: createApiBudgetPacer({ repository, settings }), internalToken: config.internalToken, priorityPanes });
      clientVersion = registerCodexModelRoutes(app, helpers, { pool: codexPool, anthropicModels: claude.models }).clientVersion;
      registerWeeklyRemainingRoute(app, helpers, { pool: codexPool });
      registerCodexAccountUsageRoute(app, { pool: codexPool, internalToken: config.internalToken });
      registerCodexSignInRoutes(app, { repository, pool: codexPool, cipher: () => cipher, internalToken: config.internalToken,
        otherProviders: { CLAUDE: claudeAccountActions({ repository, pool: claudePool }), ANTIGRAVITY: antigravityAccountActions({ repository, pool: antigravityPool }),
          OPENAI_API: openAiApiAccountActions({ pool: openAiApiPool }),
          OPENROUTER: apiKeyAccountActions({ entry: keyPoolProviders.openrouter, pool: openRouterPool }),
          DEEPSEEK: apiKeyAccountActions({ entry: keyPoolProviders.deepseek, pool: deepSeekPool }),
          GOOGLE_AI: apiKeyAccountActions({ entry: googleAiEntry, pool: googleAiPool }),
          ...Object.fromEntries(freeByProvider.map(({ entry, pool }) => [entry.provider, apiKeyAccountActions({ entry, pool })])) } });
      registerEmbeddingsRoute(app, helpers, { pool: openAiApiPool, googlePool: googleAiPool, local: localEmbeddings, logs, settings, settleKeyUsage });
      registerApiKeyAccountRoutes(app, { repository, pools: { OPENAI_API: openAiApiPool, OPENROUTER: openRouterPool, DEEPSEEK: deepSeekPool, CLAUDE: claudePool,
        GOOGLE_AI: googleAiPool, ...Object.fromEntries(freeByProvider.map(({ entry, pool }) => [entry.provider, pool])) },
        cipher: () => cipher, internalToken: config.internalToken });
      const selfHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host.includes(":") ? `[${config.host}]` : config.host;
      registerSpacePoolRoutes(app, { settings, selfBaseUrl: `http://${selfHost}:${config.port}`, internalToken: config.internalToken,
        isDead: () => false });
      registerKeyPoolRoutes(app, helpers, { pools: { openai: openAiApiPool, openrouter: openRouterPool, deepseek: deepSeekPool, gemini: googleAiPool, ...freePools }, logs, settings,
        settleKeyUsage, checks: modelChecks, internalToken: config.internalToken,
        // The Claude credit pools' spend since their grant began, from the gateway's daily sums.
        creditSpent: async (provider, sinceDay) => (await repository.providerDailyUsage(sinceDay)).filter((row) => row.provider === provider).reduce((sum, row) => sum + row.costUsd, 0) });
      registerAntigravityProxyRoutes(app, { pool: antigravityPool, repository, logs, settings, sticky: sticky.antigravitySessions, compression,
        tenant: tenancy ? helpers : undefined });
      // Make AI (plan clipboard:F1nJVLcoWdd- step 4): off until SPACE_GATEWAY_MAKE_MODEL names the relay's model; never in NGW_MODE.
      if (!tenancy) registerMakeRelayRoutes(app, helpers, { model: process.env.SPACE_GATEWAY_MAKE_MODEL?.trim() || null, logs, settleKeyUsage,
        dailyCredits: Number(process.env.SPACE_GATEWAY_MAKE_DAILY_CREDITS) || undefined,
        usedTokens: async (day) => (await repository.providerDailyUsage(day)).filter((row) => row.provider === "MAKE" && row.day === day)
          .reduce((sum, row) => ({ inputTokens: sum.inputTokens + row.inputTokens, outputTokens: sum.outputTokens + row.outputTokens }), { inputTokens: 0, outputTokens: 0 }) });
      registerImageRoutes(app, helpers, { antigravityPool, codexPool, repository, logs, settings, settleKeyUsage, modelPlans });
      registerAntigravitySignInRoutes(app, { repository, pool: antigravityPool, cipher: () => cipher, internalToken: config.internalToken });
      registerClaudeSignInRoutes(app, { repository, pool: claudePool, cipher: () => cipher, internalToken: config.internalToken });
      registerAccountAdminRoutes(app, { repository, cipher: () => cipher, internalToken: config.internalToken,
        // Under the supervisor a reload starts a new worker that reads the settings, then hands over without dropping streams.
        reload: typeof process.send === "function" ? () => { setTimeout(() => process.kill(process.ppid, "SIGHUP"), 200).unref(); return true; } : undefined });
      registerStatsRoute(app, { repository, internalToken: config.internalToken, cache: compressionCache, compressionMode: async () => (await settings()).compressionMode });
      registerAnthropicAdminRoutes(app, { repository, cipher: () => cipher, internalToken: config.internalToken, sync: () => anthropicBilling });
      if (billing && ngwDb) registerStripeWebhook(app, { db: ngwDb, billing });
    }
  });
  await server.app.listen({ host: config.host, port: config.port });
  server.setListen(`${config.host}:${config.port}`);
  process.stdout.write(`space-gateway listening on ${config.host}:${config.port}\n`);
  let adminServer: FastifyInstance | null = null;
  if (config.ngw?.admin && ngwDb) {
    const admin = config.ngw.admin;
    const [cert, key, ca] = await Promise.all([readFile(admin.certFile), readFile(admin.keyFile), readFile(admin.caFile)]);
    adminServer = await startAdminListener({ tls: { cert, key, ca }, db: ngwDb, main: server.app, internalToken: config.internalToken!, status: () => server.status(),
      metrics: async () => ngwMetrics.render(await tenancy!.gauges()),
      routes: billing ? (app, helpers) => registerCheckoutRoute(app, { db: ngwDb!, billing, ...helpers }) : undefined },
      { host: admin.host, port: admin.port });
    process.stdout.write(`nous-gateway admin listener (mTLS) on ${admin.host}:${admin.port}\n`);
  }
  // Other internal machines: a second listener on the LAN address hands its requests to the same app, where the
  // source and route checks apply. It listens after loopback, so a handover never leaves loopback without a worker,
  // and a LAN address that cannot be bound only leaves LAN access off: loopback clients keep working.
  let lanServer: Server | null = null;
  if (config.lanError) process.stderr.write(`space-gateway LAN access is off: ${config.lanError}\n`);
  if (config.lan) {
    const lan = config.lan;
    const main = server.app.server;
    const candidate = createServer((request, response) => main.emit("request", request, response));
    candidate.on("upgrade", (request, socket, head) => main.emit("upgrade", request, socket, head));
    candidate.requestTimeout = main.requestTimeout;
    candidate.headersTimeout = main.headersTimeout;
    candidate.keepAliveTimeout = main.keepAliveTimeout;
    try {
      await new Promise<void>((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(lan.port, lan.host, () => resolve());
      });
      lanServer = candidate;
      server.setLanListen(`${lan.host}:${lan.port}`);
      process.stdout.write(`space-gateway LAN listener on ${lan.host}:${lan.port} for ${lan.allowedSources.map((range) => range.text).join(", ")}\n`);
    } catch (error) {
      process.stderr.write(`space-gateway LAN listener on ${lan.host}:${lan.port} failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    }
  }
  const onUsageError = (accountId: string, error: unknown) =>
    process.stderr.write(`space-gateway usage refresh failed for ${accountId}: ${error instanceof Error ? error.message : "unknown"}\n`);
  const usagePollers = [
    startCodexUsagePoller({ repository, pool: codexPool, intervalMs: config.usagePollIntervalMs, onError: onUsageError }),
    startClaudeUsagePoller({ repository, pool: claudePool, intervalMs: config.usagePollIntervalMs, onError: onUsageError }),
    startAntigravityUsagePoller({ repository, pool: antigravityPool, intervalMs: config.usagePollIntervalMs, onError: onUsageError })
  ];

  anthropicBilling = startAnthropicBillingSync({ repository, cipher: () => cipher, claudePool, intervalMs: 5 * 60_000,
    onError: (code) => process.stderr.write(`space-gateway Anthropic billing sync failed: ${code}\n`) });
  void anthropicBilling.runOnce();

  const warmup = startWarmupRunner({ repository, pool: codexPool, modelPlans, logs, settings,
    onError: (error) => process.stderr.write(`space-gateway limit warm-up failed: ${error instanceof Error ? error.message : "unknown"}\n`) });

  const modelProbe = startModelProbe({ targets: freeByProvider.filter(({ entry }) => entry.hidesDeadModels), checks: modelChecks,
    onError: (error) => process.stderr.write(`space-gateway model probe failed: ${error instanceof Error ? error.message : "unknown"}\n`) });
  setTimeout(() => void modelProbe.runOnce(), 5 * 60_000).unref();

  const retention = setInterval(() => {
    void (async () => {
      await checkKey();
      // Request logs are token usage and are never deleted (operator rule 2026-10-18).
      await repository.pruneStickyBindings(new Date().toISOString());
    })().catch((error: unknown) => process.stderr.write(`space-gateway retention failed: ${error instanceof Error ? error.message : "unknown"}\n`));
  }, config.retentionIntervalMs);
  retention.unref();

  let stopping = false;
  const stop = (signal: string, drainTimeoutMs = config.drainTimeoutMs) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`space-gateway ${signal}: draining ${server.inFlight()} request(s)\n`);
    server.startDraining();
    clearInterval(retention);
    for (const poller of usagePollers) poller.stop();
    warmup.stop();
    anthropicBilling?.stop();
    const deadline = setTimeout(() => {
      process.stderr.write("space-gateway drain timeout reached; closing remaining connections\n");
      server.app.server.closeAllConnections();
      lanServer?.closeAllConnections();
    }, drainTimeoutMs);
    deadline.unref();
    const lanClosed = lanServer ? new Promise<void>((resolve) => { lanServer!.close(() => resolve()); lanServer!.closeIdleConnections(); }) : Promise.resolve();
    // Client WebSockets finish their running response first; closing the app afterwards ends any that remain.
    const socketsDrained = Promise.race([webSockets.drain(), new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs).unref())]);
    socketsDrained.then(() => Promise.all([server.app.close(), lanClosed, adminServer?.close()]))
      .then(() => logs.flush())
      .then(() => Promise.all(Object.values(sticky).map((store) => store.flush())))
      .then(() => compressionPool.close())
      .then(() => ngwResolver?.close())
      .then(() => ngwSwitches?.close())
      .then(() => ngwDb?.end())
      .then(() => repository.dispose())
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  // Under the supervisor, a newer worker took over: stop accepting and finish open streams, however long they run.
  process.on("message", (message: { type?: unknown; reason?: unknown } | null) => {
    if (message?.type === DRAIN_MESSAGE) stop(message.reason === "reload" ? "handoff" : "stop", message.reason === "reload" ? config.reloadDrainTimeoutMs : undefined);
  });
}

main().catch(async (error: unknown) => {
  captureSentryException(error);
  await flushSentry();
  process.stderr.write(`space-gateway failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(1);
});
