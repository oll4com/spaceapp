// Shared facts of the CLI adapter contract: every one derived from the launcher and the lifecycle adapter.
import type { AgentRuntime, CliAdapterLimitation } from "@space/contracts";
import { getApiConfig } from "../../src/config.js";
import { cliRuntimeDescriptors, type CliRuntimeDescriptor } from "../../src/cli-runtime-descriptors.js";
import { buildCliEnvironment, buildCliSpawnArgs, supportsNativeCliResume } from "../../src/cli-terminal.js";

export const config = getApiConfig({});
export const spaceSessionId = "cli_session_contract01";
export const uuidSample = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";

// One valid sample per recorded-reference family the launcher knows.
export const referenceSamples = [
  { codexThreadId: "019f8e42-2463-7b6f-8b45-3df4e53ddd25" },
  { nativeTaskRef: uuidSample },
  { nativeTaskRef: "ses_contractRecovery123" },
  { nativeTaskRef: `session_${"a".repeat(32)}` },
  { nativeTaskRef: "local-726fd372ce79ee5291c60cab026391ad5b206d48c1e9a44b3350237480e45d58" },
  { nativeTaskRef: `session_${uuidSample}` },
  { nativeTaskRef: `${uuidSample}-1793700000000` }
] as const;

// Provider-selection forms that open an interactive picker (provider --help, see
// docs/quality/native-resume-matrix.md). Kept beside the argv so a changed form flips the test.
export const interactivePickerForms: Readonly<Record<string, readonly string[]>> = {
  "cli:claude": ["--resume"],
  "cli:autohand": ["--resume"],
  "cli:kimi": ["--session"]
};

export const limitationOperation: Readonly<Record<CliAdapterLimitation["code"], CliAdapterLimitation["operation"]>> = {
  START_REQUIRES_RESOLVED_MODEL: "start",
  NATIVE_RESUME_UNSUPPORTED: "nativeResume",
  PROVIDER_SELECTION_ONLY: "nativeResume",
  PROVIDER_SELECTION_INTERACTIVE_PICKER: "nativeResume",
  REFERENCE_PENDING_LIVE_PROOF: "nativeResume",
  REFERENCE_STEERED_BY_WRAPPER: "nativeResume",
  HOST_LOSS_RESTARTS_FRESH: "reconnect",
  COMPLETION_UNOBSERVED: "completion",
  LOGIN_NOT_IN_TERMINAL: "login"
};

export type Launch = { argv: string[]; error: null } | { argv: null; error: { errorCode?: string } };

export function runtimeFor(descriptor: CliRuntimeDescriptor): AgentRuntime {
  return { id: descriptor.id, commandName: descriptor.commandName } as AgentRuntime;
}

export function launch(descriptor: CliRuntimeDescriptor, session: Parameters<typeof buildCliSpawnArgs>[1]): Launch {
  try {
    return { argv: buildCliSpawnArgs(runtimeFor(descriptor), session), error: null };
  } catch (error) {
    return { argv: null, error: error as { errorCode?: string } };
  }
}

export function sameArgv(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface RuntimeFacts {
  fresh: Launch;
  start: string[];
  selection: Launch;
  reference: string[] | null;
  steeredEnv: string | null;
  login: Launch;
  hostLossResumes: boolean;
}

export function factsFor(descriptor: CliRuntimeDescriptor): RuntimeFacts {
  const fresh = launch(descriptor, { codexThreadId: null, modelId: null, launchMode: "FRESH", sessionId: spaceSessionId });
  const resolved = fresh.argv ?? launch(descriptor, {
    codexThreadId: null, modelId: descriptor.defaultModelId, reasoningEffort: "high", launchMode: "FRESH", sessionId: spaceSessionId
  }).argv;
  if (!resolved) throw new Error(`${descriptor.id} cannot start even with a resolved model`);
  const selection = launch(descriptor, { codexThreadId: null, modelId: null, launchMode: "RESUME" });
  let reference: string[] | null = null;
  for (const sample of referenceSamples) {
    const result = launch(descriptor, {
      codexThreadId: null, modelId: null, launchMode: "RESUME", sessionId: spaceSessionId, ...sample
    });
    if (result.argv && !sameArgv(result.argv, selection.argv)) {
      reference = result.argv;
      break;
    }
  }
  const env = buildCliEnvironment(config, {
    runtimeId: descriptor.id, geminiConversationId: uuidSample, cliSessionId: spaceSessionId, nativeTaskRef: uuidSample
  });
  const steeredEnv = Object.entries(env).find(([, value]) => value === uuidSample)?.[0] ?? null;
  return {
    fresh,
    start: resolved,
    selection,
    reference,
    steeredEnv,
    login: launch(descriptor, { codexThreadId: null, modelId: null, purpose: "LOGIN" }),
    // cli-terminal restores a host-lost RUNNING session as RESUME when the runtime has a
    // native resume form, for Codex once its thread id is bound (bindCodexThreadIdBeforeResume),
    // or with the exact recorded/resolved task for a runtime that declares REFERENCE resume.
    hostLossResumes: supportsNativeCliResume(descriptor.id) || descriptor.id === "cli:codex" || descriptor.declaresNativeReference
  };
}

export const runtimeCases = cliRuntimeDescriptors.map(item => [item.id, item] as const);
