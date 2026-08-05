import { spawn } from "node:child_process";
import { z } from "zod";
import {
  codexResetCreditAvailabilitySchema,
  codexResetCreditRedemptionResponseSchema,
  type CodexResetCreditAvailability,
  type CodexResetCreditRedemptionOutcome,
  type CodexResetCreditRedemptionResponse
} from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError } from "@space/runtime";

const bridgeTimeoutMs = 9_000;
const bridgeMaxBufferBytes = 64 * 1024;
const attemptRetentionMs = 24 * 60 * 60 * 1_000;
const maximumRetainedAttempts = 2_000;

const accountIdSchema = z.string().min(1).max(160);
const creditIdSchema = z.string().min(1).max(512);
const creditIdHashSchema = z.string().min(1).max(128);
const idempotencyKeySchema = z.string().uuid();
const checkedAtSchema = z.string().datetime();

const availabilityBridgeResponseSchema = z.object({
  ok: z.literal(true),
  accounts: z.array(z.object({
    accountId: accountIdSchema,
    availableCreditCount: z.number().int().min(0).max(100).nullable()
  }).strict()).max(100),
  checkedAt: checkedAtSchema
}).strict();

const prepareBridgeResponseSchema = z.discriminatedUnion("state", [
  z.object({
    ok: z.literal(true),
    state: z.literal("READY"),
    creditId: creditIdSchema,
    creditIdHash: creditIdHashSchema
  }).strict(),
  z.object({
    ok: z.literal(true),
    state: z.literal("NO_CREDIT"),
    completedAt: checkedAtSchema
  }).strict()
]);

const redeemBridgeResponseSchema = z.object({
  ok: z.literal(true),
  outcome: z.enum(["RESET", "ALREADY_REDEEMED", "NOTHING_TO_RESET", "NO_CREDIT"]),
  creditIdHash: creditIdHashSchema,
  usageVerified: z.boolean(),
  completedAt: checkedAtSchema
}).strict();

const bridgeErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.enum(["AUTH_REQUIRED", "PROVIDER_UNAVAILABLE", "STALE_CREDIT", "UNKNOWN_OUTCOME"])
}).strict();

type BridgeErrorCode = z.infer<typeof bridgeErrorResponseSchema>["error"];
type PrepareBridgeResponse =
  | { state: "READY"; creditId: string; creditIdHash: string }
  | { state: "NO_CREDIT"; completedAt: string };
type RedeemBridgeResponse = Omit<z.infer<typeof redeemBridgeResponseSchema>, "ok">;

export interface CodexResetCreditsBridge {
  availability(): Promise<{
    accounts: Array<{ accountId: string; availableCreditCount: number | null }>;
    checkedAt: string;
  }>;
  prepare(accountId: string): Promise<PrepareBridgeResponse>;
  redeem(input: {
    accountId: string;
    creditId: string;
    idempotencyKey: string;
    isRetry: boolean;
  }): Promise<RedeemBridgeResponse>;
}

export interface CodexResetCreditsRedemptionResult {
  response: CodexResetCreditRedemptionResponse;
  audit: {
    outcome: CodexResetCreditRedemptionOutcome;
    usageVerified: boolean;
    creditIdHash: string | null;
  };
}

export interface CodexResetCreditsService {
  availability(): Promise<CodexResetCreditAvailability>;
  redeem(accountId: string, idempotencyKey: string): Promise<CodexResetCreditsRedemptionResult>;
}

const errorMessages: Record<BridgeErrorCode, string> = {
  AUTH_REQUIRED: "The account must be authenticated again before a reset can be used.",
  PROVIDER_UNAVAILABLE: "Reset credits are temporarily unavailable.",
  STALE_CREDIT: "The selected reset credit is no longer available.",
  UNKNOWN_OUTCOME: "The reset result is unknown. Retry with the same request."
};

const errorCodes: Record<BridgeErrorCode, string> = {
  AUTH_REQUIRED: "CODEX_RESET_AUTH_REQUIRED",
  PROVIDER_UNAVAILABLE: "CODEX_RESET_PROVIDER_UNAVAILABLE",
  STALE_CREDIT: "CODEX_RESET_STALE_CREDIT",
  UNKNOWN_OUTCOME: "CODEX_RESET_OUTCOME_UNKNOWN"
};

export class CodexResetCreditsError extends SpaceFeatureDisabledError {
  readonly bridgeCode: BridgeErrorCode;

  constructor(code: BridgeErrorCode) {
    super(errorCodes[code], errorMessages[code]);
    this.name = "CodexResetCreditsError";
    this.bridgeCode = code;
  }
}

class CodexResetCreditsTransportError extends Error {
  constructor() {
    super("Codex reset credits bridge transport failed.");
    this.name = "CodexResetCreditsTransportError";
  }
}

function asBridgeError(value: unknown): CodexResetCreditsError {
  if (value instanceof CodexResetCreditsError) return value;
  return new CodexResetCreditsError("PROVIDER_UNAVAILABLE");
}

function parseBridgeOutput<T>(raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CodexResetCreditsError("PROVIDER_UNAVAILABLE");
  }
  const bridgeError = bridgeErrorResponseSchema.safeParse(value);
  if (bridgeError.success) throw new CodexResetCreditsError(bridgeError.data.error);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CodexResetCreditsError("PROVIDER_UNAVAILABLE");
  return parsed.data;
}

export function createCodexResetCreditsBridge(): CodexResetCreditsBridge {
  async function invoke<T>(input: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "/usr/bin/sudo",
          ["-n", "/opt/spaceapp/bin/space-codex-reset-credits"],
          { stdio: ["pipe", "pipe", "ignore"] }
        );
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (error: Error | null, value = "") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error("Codex reset credits bridge timed out."));
        }, bridgeTimeoutMs);
        timer.unref();
        child.stdout.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > bridgeMaxBufferBytes) {
            child.kill("SIGKILL");
            finish(new Error("Codex reset credits bridge output exceeded its limit."));
            return;
          }
          chunks.push(chunk);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (code !== 0) {
            finish(new Error("Codex reset credits bridge failed."));
            return;
          }
          finish(null, Buffer.concat(chunks).toString("utf8"));
        });
        child.stdin.end(JSON.stringify(input));
      });
      return parseBridgeOutput(stdout, schema);
    } catch (error) {
      if (error instanceof CodexResetCreditsError) throw error;
      throw new CodexResetCreditsTransportError();
    }
  }

  return {
    async availability() {
      try {
        const result = await invoke({ action: "availability" }, availabilityBridgeResponseSchema);
        return { accounts: result.accounts, checkedAt: result.checkedAt };
      } catch (error) {
        throw asBridgeError(error);
      }
    },
    async prepare(accountId) {
      accountIdSchema.parse(accountId);
      try {
        const result = await invoke({ action: "prepare", accountId }, prepareBridgeResponseSchema);
        const { ok: _ok, ...prepared } = result;
        return prepared;
      } catch (error) {
        throw asBridgeError(error);
      }
    },
    async redeem(input) {
      accountIdSchema.parse(input.accountId);
      creditIdSchema.parse(input.creditId);
      idempotencyKeySchema.parse(input.idempotencyKey);
      try {
        const result = await invoke({ action: "redeem", ...input }, redeemBridgeResponseSchema);
        const { ok: _ok, ...redeemed } = result;
        return redeemed;
      } catch (error) {
        if (error instanceof CodexResetCreditsTransportError) {
          throw new CodexResetCreditsError("UNKNOWN_OUTCOME");
        }
        throw asBridgeError(error);
      }
    }
  };
}

interface RetainedAttempt {
  accountId: string;
  idempotencyKey: string;
  creditId: string | null;
  creditIdHash: string | null;
  isRetry: boolean;
  createdAtMs: number;
  inFlight: Promise<CodexResetCreditsRedemptionResult> | null;
  result: CodexResetCreditsRedemptionResult | null;
}

function noCreditResult(accountId: string, completedAt: string): CodexResetCreditsRedemptionResult {
  return {
    response: codexResetCreditRedemptionResponseSchema.parse({
      accountId,
      outcome: "NO_CREDIT",
      completedAt
    }),
    audit: {
      outcome: "NO_CREDIT",
      usageVerified: false,
      creditIdHash: null
    }
  };
}

export function createCodexResetCreditsService(options: {
  bridge?: CodexResetCreditsBridge;
  now?: () => number;
} = {}): CodexResetCreditsService {
  const bridge = options.bridge ?? createCodexResetCreditsBridge();
  const now = options.now ?? Date.now;
  const attempts = new Map<string, RetainedAttempt>();
  const accountTails = new Map<string, Promise<void>>();
  const accountInFlightKeys = new Map<string, string>();

  function pruneAttempts(): void {
    const cutoff = now() - attemptRetentionMs;
    for (const [key, attempt] of attempts) {
      if (!attempt.inFlight && attempt.createdAtMs < cutoff) attempts.delete(key);
    }
    if (attempts.size <= maximumRetainedAttempts) return;
    const removable = [...attempts.entries()]
      .filter(([, attempt]) => !attempt.inFlight)
      .sort((left, right) => left[1].createdAtMs - right[1].createdAtMs)
      .slice(0, attempts.size - maximumRetainedAttempts);
    for (const [key] of removable) attempts.delete(key);
  }

  async function serializeForAccount<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = accountTails.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    accountTails.set(accountId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (accountTails.get(accountId) === tail) accountTails.delete(accountId);
    }
  }

  async function execute(attempt: RetainedAttempt): Promise<CodexResetCreditsRedemptionResult> {
    return serializeForAccount(attempt.accountId, async () => {
      if (attempt.result) return attempt.result;
      if (!attempt.creditId) {
        const prepared = await bridge.prepare(attempt.accountId);
        if (prepared.state === "NO_CREDIT") {
          const result = noCreditResult(attempt.accountId, prepared.completedAt);
          attempt.result = result;
          return result;
        }
        attempt.creditId = prepared.creditId;
        attempt.creditIdHash = prepared.creditIdHash;
      }
      const creditId = attempt.creditId;
      if (!creditId) throw new CodexResetCreditsError("PROVIDER_UNAVAILABLE");
      try {
        const redeemed = await bridge.redeem({
          accountId: attempt.accountId,
          creditId,
          idempotencyKey: attempt.idempotencyKey,
          isRetry: attempt.isRetry
        });
        const result = {
          response: codexResetCreditRedemptionResponseSchema.parse({
            accountId: attempt.accountId,
            outcome: redeemed.outcome,
            completedAt: redeemed.completedAt
          }),
          audit: {
            outcome: redeemed.outcome,
            usageVerified: redeemed.usageVerified,
            creditIdHash: redeemed.creditIdHash
          }
        };
        attempt.result = result;
        return result;
      } catch (error) {
        const safeError = asBridgeError(error);
        if (safeError.bridgeCode === "UNKNOWN_OUTCOME") attempt.isRetry = true;
        throw safeError;
      }
    });
  }

  return {
    async availability() {
      try {
        const result = await bridge.availability();
        return codexResetCreditAvailabilitySchema.parse({
          data: result.accounts,
          source: "vm214-codex-lb",
          isStale: false,
          error: null,
          checkedAt: result.checkedAt
        });
      } catch (error) {
        throw asBridgeError(error);
      }
    },
    async redeem(rawAccountId, rawIdempotencyKey) {
      const accountId = accountIdSchema.parse(rawAccountId);
      const idempotencyKey = idempotencyKeySchema.parse(rawIdempotencyKey);
      pruneAttempts();
      const key = `${accountId}\u0000${idempotencyKey}`;
      let attempt = attempts.get(key);
      if (attempt?.result) return attempt.result;
      if (attempt?.inFlight) return attempt.inFlight;
      const activeKey = accountInFlightKeys.get(accountId);
      if (activeKey && activeKey !== key) {
        throw new SpaceConflictError("A reset credit redemption is already running for this account.");
      }
      if (!attempt) {
        attempt = {
          accountId,
          idempotencyKey,
          creditId: null,
          creditIdHash: null,
          isRetry: false,
          createdAtMs: now(),
          inFlight: null,
          result: null
        };
        attempts.set(key, attempt);
      }
      accountInFlightKeys.set(accountId, key);
      const request = execute(attempt);
      attempt.inFlight = request;
      const clear = () => {
        if (attempt?.inFlight === request) attempt.inFlight = null;
        if (accountInFlightKeys.get(accountId) === key) accountInFlightKeys.delete(accountId);
      };
      void request.then(clear, clear);
      return request;
    }
  };
}
