import { spawn } from "node:child_process";
import { z } from "zod";
import {
  sourceControlConnectionSchema,
  sourceControlProviderSchema,
  updateSourceControlConnectionInputSchema,
  type SourceControlConnection,
  type SourceControlProvider,
  type SourceControlVerificationCode
} from "@space/contracts";
import type {
  SourceControlConnectionRecord,
  SpaceStore
} from "@space/runtime";

const brokerCommand = "/usr/bin/sudo";
const brokerExecutable = "/opt/spaceapp/bin/space-source-control-secret-broker";
const secretReferenceSchema = z.string().regex(/^source_control_(?:gitea|github)_[A-Za-z0-9_-]{8,96}$/);
const brokerSuccessSchema = z
  .object({
    provider: sourceControlProviderSchema,
    accountLogin: z.string().trim().min(1).max(160),
    secretRef: secretReferenceSchema,
    verificationCode: z.literal("VERIFIED")
  })
  .strict();
const brokerErrorSchema = z
  .object({
    code: z.enum(["INVALID_TOKEN", "INSUFFICIENT_PERMISSION", "PROVIDER_UNAVAILABLE", "SECRET_NOT_FOUND", "BROKER_FAILED"]),
    message: z.string().trim().min(1).max(500)
  })
  .strict();

export class SourceControlPublishingError extends Error {
  constructor(
    readonly code: SourceControlVerificationCode | "SECRET_NOT_FOUND" | "BROKER_FAILED" | "NOT_CONNECTED",
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "SourceControlPublishingError";
  }
}

export interface SourceControlBrokerResult {
  provider: SourceControlProvider;
  accountLogin: string;
  secretRef: string;
  verificationCode: "VERIFIED";
}

export interface SourceControlBroker {
  replace(provider: SourceControlProvider, token: string): Promise<SourceControlBrokerResult>;
  verify(provider: SourceControlProvider, secretRef: string): Promise<SourceControlBrokerResult>;
  remove(provider: SourceControlProvider, secretRef: string): Promise<void>;
  importExisting(provider: SourceControlProvider): Promise<SourceControlBrokerResult>;
}

export type SourceControlBrokerExecutor = (
  command: string,
  args: string[],
  stdin: string
) => Promise<string>;

async function executeBroker(command: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8"
      },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 16_384) stdout += chunk.slice(0, 16_384 - stdout.length);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SourceControlPublishingError("BROKER_FAILED", "The protected credential broker could not start.", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new SourceControlPublishingError("PROVIDER_UNAVAILABLE", "Credential verification timed out.", 502));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const safeFailure = brokerErrorSchema.safeParse(safeJson(stderr || stdout));
      if (safeFailure.success) {
        const statusCode = safeFailure.data.code === "INVALID_TOKEN" || safeFailure.data.code === "INSUFFICIENT_PERMISSION"
          ? 422
          : safeFailure.data.code === "SECRET_NOT_FOUND"
            ? 409
            : 502;
        reject(new SourceControlPublishingError(safeFailure.data.code, safeFailure.data.message, statusCode));
        return;
      }
      reject(new SourceControlPublishingError("BROKER_FAILED", "The protected credential broker rejected the request.", 502));
    });
    child.stdin.end(stdin);
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class SourceControlBrokerClient implements SourceControlBroker {
  constructor(private readonly execute: SourceControlBrokerExecutor = executeBroker) {}

  private async run(
    action: "replace" | "verify" | "import-existing",
    provider: SourceControlProvider,
    secretRef?: string,
    stdin = ""
  ): Promise<SourceControlBrokerResult> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const args = ["-n", brokerExecutable, action, parsedProvider];
    if (secretRef !== undefined) args.push(secretReferenceSchema.parse(secretRef));
    const output = await this.execute(brokerCommand, args, stdin);
    const parsed = brokerSuccessSchema.parse(safeJson(output));
    if (parsed.provider !== parsedProvider) {
      throw new SourceControlPublishingError("BROKER_FAILED", "Credential broker provider mismatch.", 502);
    }
    return parsed;
  }

  async replace(provider: SourceControlProvider, token: string): Promise<SourceControlBrokerResult> {
    const parsed = updateSourceControlConnectionInputSchema.parse({ token });
    return this.run("replace", provider, undefined, `${parsed.token}\n`);
  }

  verify(provider: SourceControlProvider, secretRef: string): Promise<SourceControlBrokerResult> {
    return this.run("verify", provider, secretRef);
  }

  async remove(provider: SourceControlProvider, secretRef: string): Promise<void> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const parsedRef = secretReferenceSchema.parse(secretRef);
    await this.execute(brokerCommand, ["-n", brokerExecutable, "remove", parsedProvider, parsedRef], "");
  }

  importExisting(provider: SourceControlProvider): Promise<SourceControlBrokerResult> {
    return this.run("import-existing", provider);
  }
}

export interface SourceControlPublishingManagerOptions {
  store: SpaceStore;
  broker?: SourceControlBroker;
  now?: () => Date;
}

function publicConnection(record: SourceControlConnectionRecord): SourceControlConnection {
  const { secretRef: _secretRef, ...safe } = record;
  return sourceControlConnectionSchema.parse(safe);
}

export class SourceControlPublishingManager {
  private readonly broker: SourceControlBroker;
  private readonly now: () => Date;

  constructor(private readonly options: SourceControlPublishingManagerOptions) {
    this.broker = options.broker ?? new SourceControlBrokerClient();
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<SourceControlConnection[]> {
    return (await this.options.store.listSourceControlConnections()).map(publicConnection);
  }

  async get(provider: SourceControlProvider): Promise<SourceControlConnection> {
    return publicConnection(await this.options.store.getSourceControlConnection(sourceControlProviderSchema.parse(provider)));
  }

  async replace(provider: SourceControlProvider, token: string): Promise<SourceControlConnection> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const parsedToken = updateSourceControlConnectionInputSchema.parse({ token }).token;
    const previous = await this.options.store.getSourceControlConnection(parsedProvider);
    const verified = await this.broker.replace(parsedProvider, parsedToken);
    let saved: SourceControlConnectionRecord;
    try {
      saved = await this.options.store.upsertSourceControlConnection({
        provider: parsedProvider,
        accountLogin: verified.accountLogin,
        connectionStatus: "CONNECTED",
        secretRef: verified.secretRef,
        lastVerifiedAt: this.now().toISOString(),
        lastVerificationCode: verified.verificationCode
      });
    } catch (error) {
      await this.broker.remove(parsedProvider, verified.secretRef).catch(() => undefined);
      throw error;
    }
    if (previous.secretRef && previous.secretRef !== verified.secretRef) {
      await this.broker.remove(parsedProvider, previous.secretRef).catch(() => undefined);
    }
    return publicConnection(saved);
  }

  async verify(provider: SourceControlProvider): Promise<SourceControlConnection> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const current = await this.options.store.getSourceControlConnection(parsedProvider);
    if (!current.secretRef) {
      throw new SourceControlPublishingError("NOT_CONNECTED", "Connect a publishing credential first.", 409);
    }
    try {
      const verified = await this.broker.verify(parsedProvider, current.secretRef);
      return publicConnection(await this.options.store.upsertSourceControlConnection({
        provider: parsedProvider,
        accountLogin: verified.accountLogin,
        connectionStatus: "CONNECTED",
        secretRef: current.secretRef,
        lastVerifiedAt: this.now().toISOString(),
        lastVerificationCode: verified.verificationCode
      }));
    } catch (error) {
      if (error instanceof SourceControlPublishingError) {
        const verificationCode: SourceControlVerificationCode =
          error.code === "INVALID_TOKEN" || error.code === "INSUFFICIENT_PERMISSION" || error.code === "PROVIDER_UNAVAILABLE"
            ? error.code
            : "PROVIDER_UNAVAILABLE";
        await this.options.store.upsertSourceControlConnection({
          provider: parsedProvider,
          accountLogin: current.accountLogin,
          connectionStatus: "ERROR",
          secretRef: current.secretRef,
          lastVerifiedAt: this.now().toISOString(),
          lastVerificationCode: verificationCode
        });
      }
      throw error;
    }
  }

  async disconnect(provider: SourceControlProvider): Promise<SourceControlConnection> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const current = await this.options.store.getSourceControlConnection(parsedProvider);
    const disconnected = await this.options.store.upsertSourceControlConnection({
      provider: parsedProvider,
      accountLogin: null,
      connectionStatus: "DISCONNECTED",
      secretRef: null,
      lastVerifiedAt: null,
      lastVerificationCode: "NOT_VERIFIED"
    });
    if (current.secretRef) {
      await this.broker.remove(parsedProvider, current.secretRef).catch(() => undefined);
    }
    return publicConnection(disconnected);
  }

  async importExisting(provider: SourceControlProvider): Promise<SourceControlConnection> {
    const parsedProvider = sourceControlProviderSchema.parse(provider);
    const previous = await this.options.store.getSourceControlConnection(parsedProvider);
    const imported = await this.broker.importExisting(parsedProvider);
    const saved = await this.options.store.upsertSourceControlConnection({
      provider: parsedProvider,
      accountLogin: imported.accountLogin,
      connectionStatus: "CONNECTED",
      secretRef: imported.secretRef,
      lastVerifiedAt: this.now().toISOString(),
      lastVerificationCode: imported.verificationCode
    });
    if (previous.secretRef && previous.secretRef !== imported.secretRef) {
      await this.broker.remove(parsedProvider, previous.secretRef).catch(() => undefined);
    }
    return publicConnection(saved);
  }
}
