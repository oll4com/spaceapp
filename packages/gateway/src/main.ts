import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer, type Server } from "node:http";
import { PostgresGatewayRepository } from "@space/db";
import type { GatewaySettings } from "@space/contracts";
import { AccountPool } from "./accounts/account-pool.js";
import { StickyStore } from "./accounts/sticky-store.js";
import { registerAccountAdminRoutes } from "./admin/account-admin.js";
import { antigravityAccountActions, registerAntigravitySignInRoutes } from "./admin/antigravity-sign-in.js";
import { apiKeyAccountActions, googleAiEntry, openAiApiAccountActions, registerApiKeyAccountRoutes } from "./admin/api-key-accounts.js";
import { keyPoolProviders, registerKeyPoolRoutes } from "./providers/key-pools/key-pools.js";
import { claudeAccountActions, registerClaudeSignInRoutes } from "./admin/claude-sign-in.js";
import { registerCodexSignInRoutes } from "./admin/codex-sign-in.js";
import { loadGatewayConfig } from "./config.js";
import { lanAccessFromSettings, withLanEnvFile } from "./lan-access.js";
import { loadCredentialCipher, type CredentialCipher } from "./credential-cipher.js";
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
import { DRAIN_MESSAGE } from "./supervisor.js";
import { registerStatsRoute } from "./stats.js";
import { registerAnthropicAdminRoutes, startAnthropicBillingSync, type AnthropicBillingSync } from "./admin/anthropic-admin.js";
import { trackKeySettlement } from "./policy.js";

async function readVersion(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(new URL("../../../version.json", import.meta.url), "utf8")) as { platform?: { version?: string } };
    return raw.platform?.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  const config = loadGatewayConfig(await withLanEnvFile(process.env, process.env.SPACE_GATEWAY_ENV_FILE?.trim() || "/opt/spaceapp/.env"));
  if (!config.databaseUrl) throw new Error("SPACE_DATABASE_URL is required for Space Gateway.");
  const repository = PostgresGatewayRepository.fromConnectionString(config.databaseUrl);
  let credentialKeyPresent = false;
  let cipher: CredentialCipher | null = null;
  const checkKey = async () => {
    credentialKeyPresent = await access(config.encryptionKeyFile, constants.R_OK).then(() => true, () => false);
    if (credentialKeyPresent && !cipher) cipher = await loadCredentialCipher(config.encryptionKeyFile).catch(() => null);
  };
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
  if (startupSettings && startupSettings.lanMode !== "ENV") {
    const fromSettings = lanAccessFromSettings(startupSettings);
    config.lan = fromSettings.lan;
    config.lanError = fromSettings.error;
  }
  const logs = new RequestLogWriter(repository, {
    onError: (error) => process.stderr.write(`space-gateway request log write failed: ${error instanceof Error ? error.message : "unknown"}\n`)
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
  const settleKeyUsage = (keyId: string, usage: Parameters<typeof repository.settleApiKeyUsage>[1]) =>
    trackKeySettlement(keyId, usage, () => repository.settleApiKeyUsage(keyId, usage));
  const compression = { run: compressionPool.run, cache: compressionCache, rawBlocks, record: (rows: Parameters<typeof repository.recordCompression>[0]) => repository.recordCompression(rows),
    recordSignals: (rows: Parameters<typeof repository.recordCompressionSignals>[0]) => repository.recordCompressionSignals(rows) };
  let clientVersion = () => "0.150.1";
  const modelPlans = new CodexModelPlans({ pool: codexPool, clientVersion: () => clientVersion() });
  const webSockets = new CodexWebSocketRegistry();
  let anthropicBilling: AnthropicBillingSync | null = null;
  const server = createGatewayServer({
    repository, version: await readVersion(), credentialKeyPresent: () => credentialKeyPresent, logger: false, lan: config.lan,
    live: {
      inFlightByAccount: () => Object.assign({}, codexPool.inFlight(), claudePool.inFlight(), antigravityPool.inFlight(), openAiApiPool.inFlight(),
        openRouterPool.inFlight(), deepSeekPool.inFlight(), googleAiPool.inFlight()),
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
      registerCodexProxyRoutes(app, helpers, { pool: codexPool, logs, settings, settleKeyUsage, compression, modelPlans, speedDefaults,
        sticky: { threads: sticky.codexThreads, continuations: sticky.codexContinuations }, webSockets });
      const claude = registerClaudeProxyRoutes(app, helpers, { pool: claudePool, logs, settings, settleKeyUsage, compression, sticky: sticky.claudeSessions });
      clientVersion = registerCodexModelRoutes(app, helpers, { pool: codexPool, anthropicModels: claude.models }).clientVersion;
      registerWeeklyRemainingRoute(app, helpers, { pool: codexPool });
      registerCodexAccountUsageRoute(app, { pool: codexPool, internalToken: config.internalToken });
      registerCodexSignInRoutes(app, { repository, pool: codexPool, cipher: () => cipher, internalToken: config.internalToken,
        otherProviders: { CLAUDE: claudeAccountActions({ repository, pool: claudePool }), ANTIGRAVITY: antigravityAccountActions({ repository, pool: antigravityPool }),
          OPENAI_API: openAiApiAccountActions({ pool: openAiApiPool }),
          OPENROUTER: apiKeyAccountActions({ entry: keyPoolProviders.openrouter, pool: openRouterPool }),
          DEEPSEEK: apiKeyAccountActions({ entry: keyPoolProviders.deepseek, pool: deepSeekPool }),
          GOOGLE_AI: apiKeyAccountActions({ entry: googleAiEntry, pool: googleAiPool }) } });
      registerEmbeddingsRoute(app, helpers, { pool: openAiApiPool, googlePool: googleAiPool, local: localEmbeddings, logs, settings, settleKeyUsage });
      registerApiKeyAccountRoutes(app, { repository, pools: { OPENAI_API: openAiApiPool, OPENROUTER: openRouterPool, DEEPSEEK: deepSeekPool, CLAUDE: claudePool,
        GOOGLE_AI: googleAiPool },
        cipher: () => cipher, internalToken: config.internalToken });
      registerKeyPoolRoutes(app, helpers, { pools: { openai: openAiApiPool, openrouter: openRouterPool, deepseek: deepSeekPool }, logs, settings, settleKeyUsage });
      registerAntigravityProxyRoutes(app, { pool: antigravityPool, repository, logs, settings, sticky: sticky.antigravitySessions, compression });
      registerImageRoutes(app, helpers, { antigravityPool, codexPool, repository, logs, settings, settleKeyUsage, modelPlans });
      registerAntigravitySignInRoutes(app, { repository, pool: antigravityPool, cipher: () => cipher, internalToken: config.internalToken });
      registerClaudeSignInRoutes(app, { repository, pool: claudePool, cipher: () => cipher, internalToken: config.internalToken });
      registerAccountAdminRoutes(app, { repository, cipher: () => cipher, internalToken: config.internalToken,
        // Under the supervisor a reload starts a new worker that reads the settings, then hands over without dropping streams.
        reload: typeof process.send === "function" ? () => { setTimeout(() => process.kill(process.ppid, "SIGHUP"), 200).unref(); return true; } : undefined });
      registerStatsRoute(app, { repository, internalToken: config.internalToken, cache: compressionCache, compressionMode: async () => (await settings()).compressionMode });
      registerAnthropicAdminRoutes(app, { repository, cipher: () => cipher, internalToken: config.internalToken, sync: () => anthropicBilling });
    }
  });
  await server.app.listen({ host: config.host, port: config.port });
  server.setListen(`${config.host}:${config.port}`);
  process.stdout.write(`space-gateway listening on ${config.host}:${config.port}\n`);
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
    socketsDrained.then(() => Promise.all([server.app.close(), lanClosed]))
      .then(() => logs.flush())
      .then(() => Promise.all(Object.values(sticky).map((store) => store.flush())))
      .then(() => compressionPool.close())
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

main().catch((error: unknown) => {
  process.stderr.write(`space-gateway failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(1);
});
