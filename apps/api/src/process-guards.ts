import type { FastifyBaseLogger } from "fastify";

/**
 * Process-level safety net for the API.
 *
 * Without handlers, any rejection or exception that escapes a timer or a
 * fire-and-forget promise terminates the whole multi-user API. Rejections are
 * logged and the process keeps serving. Exceptions still end the process after
 * a graceful shutdown, except for the known background faults listed here,
 * which belong to work that already finished and cannot corrupt state.
 */
const recoverableBackgroundErrorPatterns: ReadonlyArray<RegExp> = [
  // @temporalio/client's retry interceptor re-issues a call from a timer after
  // the connection it belongs to was closed (seen as an API crash loop while
  // Temporal was restarting).
  /^Channel has been shut down$/
];

export function isRecoverableBackgroundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return recoverableBackgroundErrorPatterns.some((pattern) => pattern.test(message));
}

export interface ProcessGuardOptions {
  log: Pick<FastifyBaseLogger, "error" | "fatal">;
  /** Graceful shutdown, typically `app.close()`. */
  shutdown: () => Promise<unknown>;
  exit?: (code: number) => void;
  /** Upper bound for the graceful shutdown before the process is forced out. */
  exitDelayMs?: number;
}

export interface ProcessGuardHandlers {
  onUnhandledRejection: (reason: unknown, promise: Promise<unknown>) => void;
  onUncaughtException: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

export function createProcessGuardHandlers(options: ProcessGuardOptions): ProcessGuardHandlers {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const exitDelayMs = Math.max(0, options.exitDelayMs ?? 5_000);
  let shuttingDown = false;

  const terminate = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const forceExit = setTimeout(() => exit(1), exitDelayMs);
    forceExit.unref?.();
    void Promise.resolve()
      .then(() => options.shutdown())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(forceExit);
        exit(1);
      });
  };

  return {
    onUnhandledRejection(reason) {
      options.log.error({ err: reason, event: "PROCESS_UNHANDLED_REJECTION" }, "Unhandled promise rejection; the API keeps serving.");
    },
    onUncaughtException(error, origin) {
      if (isRecoverableBackgroundError(error)) {
        options.log.error(
          { err: error, origin, event: "PROCESS_RECOVERABLE_EXCEPTION" },
          "Recoverable background exception; the API keeps serving."
        );
        return;
      }
      options.log.fatal({ err: error, origin, event: "PROCESS_UNCAUGHT_EXCEPTION" }, "Uncaught exception; shutting the API down.");
      terminate();
    }
  };
}

export function installProcessGuards(options: ProcessGuardOptions): () => void {
  const handlers = createProcessGuardHandlers(options);
  process.on("unhandledRejection", handlers.onUnhandledRejection);
  process.on("uncaughtException", handlers.onUncaughtException);
  return () => {
    process.off("unhandledRejection", handlers.onUnhandledRejection);
    process.off("uncaughtException", handlers.onUncaughtException);
  };
}
