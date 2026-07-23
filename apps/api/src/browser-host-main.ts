import {
  BrowserHostError,
  createBrowserHostServer,
  readBrowserHostBuildCommit,
  type BrowserHostActorContext,
  type BrowserHostCaptureContext,
  type BrowserHostRequestHandler,
  type BrowserHostRuntimeInput,
  type BrowserHostStartInput,
  type BrowserHostStreamHints
} from "@space/browser-host";
import type {
  AcquireBrowserControlInput,
  BrowserCaptureOptions,
  BrowserControlLeaseActionInput,
  BrowserSessionViewport,
  BrowserStreamMode,
  BrowserToolActionInput,
  Pane
} from "@space/contracts";
import { PostgresSpaceStore } from "@space/db";
import { createBrowserSessionManager } from "./browser-sessions.js";
import { getApiConfig } from "./config.js";

const config = getApiConfig(process.env);
if (config.runtimeStore !== "postgres" || !config.databaseUrl) {
  throw new Error("Browser Host requires SPACE_RUNTIME_STORE=postgres and SPACE_DATABASE_URL.");
}

const store = PostgresSpaceStore.fromConnectionString(config.databaseUrl, {
  codexLbConfigured: config.codexLbConfigured,
  codexLbBaseUrl: config.codexLbBaseUrl,
  mcpServerConfigs: config.mcpServerConfigs ?? [],
  mcpConfigError: config.mcpConfigError ?? null
});
const manager = createBrowserSessionManager({ store, config });
const startedAt = new Date().toISOString();
const captureRecovery = await manager.recoverCaptureJobs?.();
if (captureRecovery && (captureRecovery.failedSegments > 0 || captureRecovery.requeuedJobs.length > 0)) {
  process.stderr.write(`Browser Host capture recovery: ${JSON.stringify(captureRecovery)}\n`);
}

function unavailable(method: string): never {
  throw new BrowserHostError("BROWSER_HOST_METHOD_UNAVAILABLE", `Browser Host method ${method} is unavailable.`);
}

const handler: BrowserHostRequestHandler = {
  async health() {
    const captureMetrics = await manager.captureMetrics?.() ?? {
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
    };
    return {
      hostPid: process.pid,
      startedAt,
      buildCommit: readBrowserHostBuildCommit(),
      status: manager.status(),
      capacity: manager.capacity?.() ?? null,
      captureMetrics
    };
  },
  async request(method, params) {
    switch (method) {
      case "startOrRestore":
        return manager.startOrRestore(params.input as unknown as BrowserHostStartInput, params.context as BrowserHostActorContext | undefined);
      case "getActive":
        return manager.getActive(params.pane as Pane);
      case "navigate":
        return manager.navigate(params.pane as Pane, String(params.url), String(params.traceId), params.context as BrowserHostActorContext | undefined);
      case "setViewport":
        return manager.setViewport(params.pane as Pane, params.viewport as BrowserSessionViewport, String(params.traceId), params.context as BrowserHostActorContext | undefined);
      case "setStreamMode":
        return manager.setStreamMode?.(params.pane as Pane, params.mode as BrowserStreamMode, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "action":
        return manager.action(
          params.pane as Pane,
          params.input as BrowserToolActionInput,
          String(params.traceId),
          params.context as BrowserHostActorContext | undefined
        );
      case "captureFrame":
        return manager.captureFrame(String(params.sessionId));
      case "stopPane":
        return manager.stopPane(String(params.paneId), params.traceId === undefined ? undefined : String(params.traceId), params.context as BrowserHostActorContext | undefined);
      case "stopRoom":
        return manager.stopRoom(String(params.roomId), params.traceId === undefined ? undefined : String(params.traceId), params.context as BrowserHostActorContext | undefined);
      case "listPages":
        return manager.listPages?.(params.pane as Pane) ?? unavailable(method);
      case "createPage":
        return manager.createPage?.(
          params.pane as Pane,
          params.url === undefined ? undefined : String(params.url),
          Boolean(params.activate),
          String(params.traceId),
          params.context as BrowserHostActorContext | undefined
        ) ?? unavailable(method);
      case "activatePage":
        return manager.activatePage?.(params.pane as Pane, String(params.pageId), String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "closePage":
        return manager.closePage?.(params.pane as Pane, String(params.pageId), String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "acquireControl":
        return manager.acquireControl?.(params.pane as Pane, params.input as AcquireBrowserControlInput, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "heartbeatControl":
        return manager.heartbeatControl?.(params.pane as Pane, params.input as BrowserControlLeaseActionInput, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "releaseControl":
        return manager.releaseControl?.(params.pane as Pane, params.input as BrowserControlLeaseActionInput, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "dispatchInput":
        return manager.dispatchInput?.(params.pane as Pane, params.input as BrowserHostRuntimeInput, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "input":
        return manager.input?.(params.pane as Pane, params.input as BrowserHostRuntimeInput, String(params.traceId), params.context as BrowserHostActorContext | undefined) ?? unavailable(method);
      case "createCapture":
        return manager.createCapture?.(
          params.pane as Pane,
          params.options as BrowserCaptureOptions,
          params.context as BrowserHostCaptureContext
        ) ?? unavailable(method);
      case "getCapture":
        return manager.getCapture?.(params.pane as Pane, String(params.jobId)) ?? unavailable(method);
      case "stopCapture":
        return manager.stopCapture?.(
          params.pane as Pane,
          String(params.jobId),
          String(params.traceId),
          params.context as BrowserHostActorContext | undefined
        ) ?? unavailable(method);
      case "cancelCapture":
        return manager.cancelCapture?.(
          params.pane as Pane,
          String(params.jobId),
          String(params.traceId),
          params.context as BrowserHostActorContext | undefined
        ) ?? unavailable(method);
      case "diagnostics":
        return manager.diagnostics?.(params.pane as Pane, Boolean(params.includeNetwork), Number(params.limit)) ?? unavailable(method);
    }
  },
  async startFrameStream(params, onFrame) {
    if (!manager.startFrameStream) unavailable("startFrameStream");
    return manager.startFrameStream(
      String(params.sessionId),
      params.mode as BrowserStreamMode,
      onFrame,
      params.hints as BrowserHostStreamHints | undefined
    );
  }
};

const server = await createBrowserHostServer({
  socketPath: config.browserHostSocketPath,
  handler
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`Browser Host received ${signal}; shutting down.\n`);
  await server.close().catch(() => undefined);
  await manager.closeAll().catch(() => undefined);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.stdout.write(`Browser Host listening on ${server.socketPath}.\n`);
