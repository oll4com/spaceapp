import {
  setupConnectionSchema,
  type AgentRuntime,
  type AgentRuntimeRegistry,
  type SetupConnection,
  type SetupConnectionCheckStage,
  type SetupOverviewSummary
} from "@space/contracts";
import {
  SpaceNotFoundError,
  type SetupConnectionVerification,
  type SpaceStore
} from "@space/runtime";
import { cliRuntimeDescriptors } from "./cli-runtime-descriptors.js";
import {
  checkCliRuntimeCredential,
  findRuntime,
  observeCliRuntimeCredential,
  type CliCredentialCheckResult
} from "./cli-runtimes.js";

const verificationFreshnessMs = 30 * 24 * 60 * 60 * 1_000;

export type SetupConnectionStageEmitter = (
  stage: SetupConnectionCheckStage
) => void | Promise<void>;

export type SetupConnectionCompletionEmitter = (
  connectionId: string,
  connection: SetupConnection | null
) => void | Promise<void>;

export interface SetupConnectionsService {
  overview(): Promise<SetupConnection[]>;
  verify(connectionId: string, emitStage?: SetupConnectionStageEmitter): Promise<SetupConnection>;
  verifyAll(
    emitStage?: (connectionId: string, stage: SetupConnectionCheckStage) => void | Promise<void>,
    onComplete?: SetupConnectionCompletionEmitter
  ): Promise<SetupConnection[]>;
  recordVerifiedEvidence(connectionId: string, fingerprintHash: string): Promise<SetupConnection>;
}

export interface CreateSetupConnectionsServiceOptions {
  store: SpaceStore;
  discoverRuntimes: () => Promise<AgentRuntimeRegistry>;
  observeCredential?: (runtime: AgentRuntime) => Promise<string | null>;
  smokeCredential?: (runtime: AgentRuntime) => Promise<boolean>;
  checkCredential?: (runtime: AgentRuntime) => Promise<CliCredentialCheckResult>;
  now?: () => string;
}

function staleAt(verifiedAt: string | null): string | null {
  if (!verifiedAt) return null;
  return new Date(Date.parse(verifiedAt) + verificationFreshnessMs).toISOString();
}

function isRuntimeAvailable(runtime: AgentRuntime | null): runtime is AgentRuntime {
  return Boolean(
    runtime &&
    runtime.adapterStatus === "ENABLED" &&
    runtime.detectedCommandPath
  );
}

export function summarizeSetupConnections(
  connections: readonly SetupConnection[]
): SetupOverviewSummary {
  const functional = connections.filter((connection) =>
    connection.functionalState === "FUNCTIONAL"
  ).length;
  return {
    total: connections.length,
    functional,
    liveVerified: connections.filter((connection) =>
      connection.liveVerificationState === "VERIFIED"
    ).length,
    needsSetup: connections.length - functional
  };
}

export function createSetupConnectionsService(
  options: CreateSetupConnectionsServiceOptions
): SetupConnectionsService {
  const observeCredential = options.observeCredential ?? observeCliRuntimeCredential;
  const checkCredential = options.checkCredential ??
    (options.smokeCredential
      ? async (runtime: AgentRuntime): Promise<CliCredentialCheckResult> => ({
          outcome: await options.smokeCredential!(runtime) ? "VERIFIED" : "PROVIDER_FAILED"
        })
      : checkCliRuntimeCredential);
  const now = options.now ?? (() => new Date().toISOString());

  function descriptor(connectionId: string) {
    const found = cliRuntimeDescriptors.find((candidate) => candidate.id === connectionId);
    if (!found) throw new SpaceNotFoundError(`Setup connection ${connectionId} was not found.`);
    return found;
  }

  function render(
    connectionId: string,
    functionalState: SetupConnection["functionalState"],
    liveVerificationState: SetupConnection["liveVerificationState"],
    reasonCode: string | null,
    verifiedAt: string | null
  ): SetupConnection {
    const definition = descriptor(connectionId);
    const state: SetupConnection["state"] = functionalState === "FUNCTIONAL"
      ? "CONNECTED"
      : functionalState === "UNAVAILABLE"
        ? "UNAVAILABLE"
        : "NEEDS_SETUP";
    const actions: SetupConnection["actions"] = functionalState === "FUNCTIONAL"
      ? ["VERIFY"]
      : functionalState === "UNAVAILABLE"
        ? ["RUN_HOST_LAUNCHER"]
        : definition.loginAction === "login"
          ? ["OPEN_LOGIN_PANE", "VERIFY"]
          : ["VERIFY", "RUN_HOST_LAUNCHER"];
    return setupConnectionSchema.parse({
      id: definition.id,
      label: definition.agentName,
      providerName: definition.providerName,
      category: "AI coding CLI",
      state,
      functionalState,
      liveVerificationState,
      reasonCode,
      verifiedAt,
      staleAt: staleAt(verifiedAt),
      actions
    });
  }

  async function persist(
    connectionId: string,
    state: SetupConnectionVerification["state"],
    reasonCode: string | null,
    fingerprintHash: string | null,
    verifiedAt: string | null
  ): Promise<SetupConnectionVerification> {
    const updatedAt = now();
    return options.store.upsertSetupConnectionVerification({
      connectionId,
      state,
      reasonCode,
      fingerprintHash,
      verifiedAt,
      updatedAt
    });
  }

  async function current(
    connectionId: string,
    runtime: AgentRuntime | null,
    saved: SetupConnectionVerification | null
  ): Promise<SetupConnection> {
    if (!isRuntimeAvailable(runtime)) {
      return render(connectionId, "UNAVAILABLE", "NOT_CHECKED", "CLI_RUNTIME_UNAVAILABLE", null);
    }
    const fingerprint = await observeCredential(runtime);
    if (!fingerprint) {
      return render(connectionId, "NEEDS_SETUP", "NOT_CHECKED", "CREDENTIAL_REQUIRED", null);
    }
    if (saved?.state === "CONNECTED" && saved.fingerprintHash === fingerprint && saved.verifiedAt) {
      const expiry = staleAt(saved.verifiedAt);
      if (expiry && Date.parse(now()) >= Date.parse(expiry)) {
        return render(connectionId, "FUNCTIONAL", "NOT_CHECKED", "VERIFICATION_STALE", saved.verifiedAt);
      }
      return render(connectionId, "FUNCTIONAL", "VERIFIED", null, saved.verifiedAt);
    }
    if (saved?.fingerprintHash && saved.fingerprintHash !== fingerprint) {
      return render(connectionId, "FUNCTIONAL", "CREDENTIAL_CHANGED", "CREDENTIAL_CHANGED", null);
    }
    if (saved?.fingerprintHash === fingerprint) {
      if (saved.reasonCode === "PROVIDER_QUOTA_LIMITED") {
        return render(connectionId, "FUNCTIONAL", "QUOTA_LIMITED", saved.reasonCode, null);
      }
      if (saved.reasonCode === "PROVIDER_CHECK_TIMED_OUT") {
        return render(connectionId, "FUNCTIONAL", "TIMED_OUT", saved.reasonCode, null);
      }
      if (saved.reasonCode === "PROVIDER_CHECK_FAILED" || saved.reasonCode === "SMOKE_FAILED") {
        return render(connectionId, "FUNCTIONAL", "PROVIDER_FAILED", saved.reasonCode, null);
      }
      if (saved.reasonCode === "CREDENTIAL_CHANGED_DURING_VERIFICATION") {
        return render(connectionId, "FUNCTIONAL", "CREDENTIAL_CHANGED", saved.reasonCode, null);
      }
    }
    return render(connectionId, "FUNCTIONAL", "NOT_CHECKED", "NOT_VERIFIED", null);
  }

  async function verifyRuntime(
    connectionId: string,
    runtime: AgentRuntime | null,
    emitStage: SetupConnectionStageEmitter
  ): Promise<SetupConnection> {
    descriptor(connectionId);
    if (!isRuntimeAvailable(runtime)) {
      await emitStage("Saving result");
      await persist(connectionId, "UNAVAILABLE", "CLI_RUNTIME_UNAVAILABLE", null, null);
      await emitStage("CLI unavailable");
      return render(connectionId, "UNAVAILABLE", "NOT_CHECKED", "CLI_RUNTIME_UNAVAILABLE", null);
    }
    await emitStage("Checking saved credential");
    const before = await observeCredential(runtime);
    if (!before) {
      await emitStage("Saving result");
      await persist(connectionId, "NEEDS_SETUP", "CREDENTIAL_REQUIRED", null, null);
      await emitStage("Needs setup");
      return render(connectionId, "NEEDS_SETUP", "NOT_CHECKED", "CREDENTIAL_REQUIRED", null);
    }
    await emitStage("Sending live provider challenge");
    const check = await checkCredential(runtime);
    await emitStage("Confirming credential identity");
    const after = await observeCredential(runtime);
    if (!after || after !== before) {
      await emitStage("Saving result");
      await persist(connectionId, "CONNECTED", "CREDENTIAL_CHANGED_DURING_VERIFICATION", after, null);
      await emitStage("Credential changed");
      return render(
        connectionId,
        "FUNCTIONAL",
        "CREDENTIAL_CHANGED",
        "CREDENTIAL_CHANGED_DURING_VERIFICATION",
        null
      );
    }
    await emitStage("Saving result");
    if (check.outcome === "QUOTA_LIMITED") {
      await persist(connectionId, "CONNECTED", "PROVIDER_QUOTA_LIMITED", after, null);
      await emitStage("Quota limited");
      return render(connectionId, "FUNCTIONAL", "QUOTA_LIMITED", "PROVIDER_QUOTA_LIMITED", null);
    }
    if (check.outcome === "TIMED_OUT") {
      await persist(connectionId, "CONNECTED", "PROVIDER_CHECK_TIMED_OUT", after, null);
      await emitStage("Timed out");
      return render(connectionId, "FUNCTIONAL", "TIMED_OUT", "PROVIDER_CHECK_TIMED_OUT", null);
    }
    if (check.outcome === "PROVIDER_FAILED") {
      await persist(connectionId, "CONNECTED", "PROVIDER_CHECK_FAILED", after, null);
      await emitStage("Provider failed");
      return render(connectionId, "FUNCTIONAL", "PROVIDER_FAILED", "PROVIDER_CHECK_FAILED", null);
    }
    const verifiedAt = now();
    await persist(connectionId, "CONNECTED", null, after, verifiedAt);
    await emitStage("Verified");
    return render(connectionId, "FUNCTIONAL", "VERIFIED", null, verifiedAt);
  }

  const ignoreStage: SetupConnectionStageEmitter = () => undefined;

  return {
    async overview() {
      const [registry, saved] = await Promise.all([
        options.discoverRuntimes(),
        options.store.listSetupConnectionVerifications()
      ]);
      const byId = new Map(saved.map((record) => [record.connectionId, record]));
      return Promise.all(cliRuntimeDescriptors.map((definition) =>
        current(definition.id, findRuntime(registry, definition.id), byId.get(definition.id) ?? null)
      ));
    },

    async verify(connectionId, emitStage = ignoreStage) {
      descriptor(connectionId);
      await emitStage("Detecting CLI");
      const registry = await options.discoverRuntimes();
      return verifyRuntime(connectionId, findRuntime(registry, connectionId), emitStage);
    },

    async verifyAll(emitStage = () => undefined, onComplete) {
      await Promise.all(cliRuntimeDescriptors.map((definition) =>
        emitStage(definition.id, "Detecting CLI")
      ));
      const registry = await options.discoverRuntimes();
      const settled = await Promise.allSettled(cliRuntimeDescriptors.map(async (definition) => {
        let connection: SetupConnection;
        try {
          connection = await verifyRuntime(
            definition.id,
            findRuntime(registry, definition.id),
            (stage) => emitStage(definition.id, stage)
          );
        } catch {
          await onComplete?.(definition.id, null);
          throw new Error("Setup connection verification failed.");
        }
        await onComplete?.(definition.id, connection);
        return connection;
      }));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) {
        throw new Error("One or more setup connection verifications failed.");
      }
      return settled.map((result) =>
        (result as PromiseFulfilledResult<SetupConnection>).value
      );
    },

    async recordVerifiedEvidence(connectionId, fingerprintHash) {
      descriptor(connectionId);
      if (!/^[a-f0-9]{64}$/.test(fingerprintHash)) {
        throw new Error("Setup connection fingerprint must be a SHA-256 hex digest.");
      }
      const verifiedAt = now();
      await persist(connectionId, "CONNECTED", null, fingerprintHash, verifiedAt);
      return render(connectionId, "FUNCTIONAL", "VERIFIED", null, verifiedAt);
    }
  };
}
