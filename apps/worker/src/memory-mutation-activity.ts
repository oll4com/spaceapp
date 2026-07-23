import {
  memoryMutationWorkflowInputSchema,
  memoryMutationWorkflowResultSchema,
  type MemoryChangeSet,
  type MemoryMutationExecutionResult,
  type MemoryMutationRecoveryResult,
  type MemoryMutationWorkflowInput,
  type MemoryMutationWorkflowResult
} from "@space/contracts";
import { PostgresSpaceStore } from "@space/db";
import {
  CanonicalMemoryMutationExecutionError,
  executeCanonicalMemoryMutation,
  finalizeCanonicalMemoryMutationJournal,
  recoverCanonicalMemoryMutation,
  resolveCanonicalGeminiMemoryPaths,
  SpaceConflictError,
  type CanonicalMemoryMutationOptions
} from "@space/runtime";

interface MemoryMutationStore {
  getMemoryChangeSet(changeSetId: string): Promise<MemoryChangeSet> | MemoryChangeSet;
  updateMemoryChangeSet(
    changeSetId: string,
    input: { status: "APPLYING" | "APPLIED" | "FAILED"; resultingSourceHash?: string; statusReason?: string }
  ): Promise<MemoryChangeSet> | MemoryChangeSet;
}

export interface ExecutePersistedMemoryChangeSetOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  store?: MemoryMutationStore;
  coreOptions?: CanonicalMemoryMutationOptions;
  executeMutation?: (
    changeSet: MemoryChangeSet,
    options: CanonicalMemoryMutationOptions
  ) => Promise<MemoryMutationExecutionResult>;
  recoverMutation?: (
    changeSet: MemoryChangeSet,
    options: CanonicalMemoryMutationOptions
  ) => Promise<MemoryMutationRecoveryResult>;
  finalizeJournal?: (changeSet: MemoryChangeSet, options: CanonicalMemoryMutationOptions) => Promise<void>;
}

function mutationsEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.SPACE_MEMORY_GRAPH_ENABLED === "true" && env.SPACE_MEMORY_MUTATIONS_ENABLED === "true";
}

function defaultCoreOptions(env: NodeJS.ProcessEnv | Record<string, string | undefined>): CanonicalMemoryMutationOptions {
  const { indexPath, monthlyPath, lockPath } = resolveCanonicalGeminiMemoryPaths(env);
  const graphRoot = env.SPACE_MEMORY_GRAPH_ROOT || "/opt/spaceapp/var/memory-graph";
  return {
    sources: [
      { path: indexPath, kind: "INDEX" },
      { path: monthlyPath, kind: "MONTHLY" }
    ],
    journalRoot: `${graphRoot}/mutations`,
    lockPath
  };
}

function requiredStore(env: NodeJS.ProcessEnv | Record<string, string | undefined>, override?: MemoryMutationStore): MemoryMutationStore {
  if (override) return override;
  const databaseUrl = env.SPACE_DATABASE_URL;
  if (!databaseUrl) throw new Error("SPACE_DATABASE_URL is required for durable memory mutations.");
  return PostgresSpaceStore.fromConnectionString(databaseUrl);
}

async function finalizeBestEffort(
  changeSet: MemoryChangeSet,
  options: CanonicalMemoryMutationOptions,
  finalizeJournal: NonNullable<ExecutePersistedMemoryChangeSetOptions["finalizeJournal"]>
): Promise<void> {
  try {
    await finalizeJournal(changeSet, options);
  } catch {
    // The APPLIED database state is authoritative; retained WRITTEN evidence is safe for an idempotent retry.
  }
}

export async function executePersistedMemoryChangeSet(
  rawInput: MemoryMutationWorkflowInput,
  options: ExecutePersistedMemoryChangeSetOptions = {}
): Promise<MemoryMutationWorkflowResult> {
  const input = memoryMutationWorkflowInputSchema.parse(rawInput);
  const changeSetId = input.changeSetId;
  const env = options.env ?? process.env;
  if (!mutationsEnabled(env)) {
    return memoryMutationWorkflowResultSchema.parse({ status: "DISABLED", changeSetId, resultingSourceHash: null, reason: null });
  }

  const store = requiredStore(env, options.store);
  const coreOptions = options.coreOptions ?? defaultCoreOptions(env);
  const executeMutation = options.executeMutation ?? executeCanonicalMemoryMutation;
  const recoverMutation = options.recoverMutation ?? recoverCanonicalMemoryMutation;
  const finalizeJournal = options.finalizeJournal ?? finalizeCanonicalMemoryMutationJournal;
  let current = await store.getMemoryChangeSet(changeSetId);

  const reconcile = async (): Promise<MemoryMutationWorkflowResult> => {
    current = await store.getMemoryChangeSet(changeSetId);
    if (current.status === "APPLIED" && current.resultingSourceHash) {
      await finalizeBestEffort(current, coreOptions, finalizeJournal);
      return memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId, resultingSourceHash: current.resultingSourceHash, reason: null });
    }
    if (current.status !== "APPLYING") {
      throw new SpaceConflictError(`Memory change set ${changeSetId} cannot be reconciled from ${current.status}.`);
    }
    const recovery = await recoverMutation(current, coreOptions);
    if (recovery.status === "COMPLETE_APPLIED") {
      if (!recovery.resultingSourceHash) {
        throw new SpaceConflictError(`Applied recovery for ${changeSetId} did not provide a resulting source hash.`);
      }
      const applied = await store.updateMemoryChangeSet(changeSetId, {
        status: "APPLIED",
        resultingSourceHash: recovery.resultingSourceHash
      });
      await finalizeBestEffort(applied, coreOptions, finalizeJournal);
      return memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId, resultingSourceHash: recovery.resultingSourceHash, reason: null });
    }
    if (recovery.status === "COMPLETE_FAILED") {
      const reason = "Canonical mutation did not pass the atomic replacement commit point.";
      await store.updateMemoryChangeSet(changeSetId, { status: "FAILED", statusReason: reason });
      return memoryMutationWorkflowResultSchema.parse({ status: "FAILED", changeSetId, resultingSourceHash: null, reason });
    }
    return memoryMutationWorkflowResultSchema.parse({ status: "OPERATOR_REQUIRED", changeSetId, resultingSourceHash: null, reason: recovery.reason });
  };

  if (current.status === "APPLYING" || current.status === "APPLIED") return reconcile();
  if (current.status !== "APPROVED") {
    throw new SpaceConflictError(`Memory change set ${changeSetId} must be APPROVED before execution.`);
  }

  const approved = current;
  await store.updateMemoryChangeSet(changeSetId, { status: "APPLYING" });
  try {
    const execution = await executeMutation(approved, coreOptions);
    const applied = await store.updateMemoryChangeSet(changeSetId, {
      status: "APPLIED",
      resultingSourceHash: execution.resultingSourceHash
    });
    await finalizeBestEffort(applied, coreOptions, finalizeJournal);
    return memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId, resultingSourceHash: execution.resultingSourceHash, reason: null });
  } catch (error) {
    if (error instanceof CanonicalMemoryMutationExecutionError && !error.canonicalReplaced) {
      const reason = "Canonical mutation failed before the atomic replacement commit point.";
      await store.updateMemoryChangeSet(changeSetId, { status: "FAILED", statusReason: reason });
      return memoryMutationWorkflowResultSchema.parse({ status: "FAILED", changeSetId, resultingSourceHash: null, reason });
    }
    return reconcile();
  }
}
