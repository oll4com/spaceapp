import { cliRuntimeDescriptors, type CliRuntimeKey } from "./cli-runtime-descriptors.js";
import type { CliAdapterContract } from "@space/contracts";

export type CliRunCompletionStrategy =
  | "CODEX_ROLLOUT"
  | "OPENCODE_NATIVE_STATUS"
  | "UNAVAILABLE_FAIL_CLOSED";

export interface CliRunLifecycleAdapter {
  runtimeId: `cli:${CliRuntimeKey}`;
  tracksRunStarts: true;
  completionStrategy: CliRunCompletionStrategy;
}

const completionStrategyByRuntimeKey: Record<CliRuntimeKey, CliRunCompletionStrategy> = {
  codex: "CODEX_ROLLOUT",
  opencode: "OPENCODE_NATIVE_STATUS",
  claude: "UNAVAILABLE_FAIL_CLOSED",
  gemini: "UNAVAILABLE_FAIL_CLOSED",
  autohand: "UNAVAILABLE_FAIL_CLOSED",
  qwen: "UNAVAILABLE_FAIL_CLOSED",
  kimi: "UNAVAILABLE_FAIL_CLOSED",
  grok: "UNAVAILABLE_FAIL_CLOSED",
  deepseek: "UNAVAILABLE_FAIL_CLOSED",
  cursor: "UNAVAILABLE_FAIL_CLOSED",
  copilot: "UNAVAILABLE_FAIL_CLOSED",
  hermes: "UNAVAILABLE_FAIL_CLOSED",
  omp: "UNAVAILABLE_FAIL_CLOSED",
  qoder: "UNAVAILABLE_FAIL_CLOSED",
  muse: "UNAVAILABLE_FAIL_CLOSED",
  droid: "UNAVAILABLE_FAIL_CLOSED"
};

export const cliRunLifecycleAdapters: readonly CliRunLifecycleAdapter[] = cliRuntimeDescriptors.map(
  (descriptor) => ({
    runtimeId: descriptor.id,
    tracksRunStarts: true,
    completionStrategy: completionStrategyByRuntimeKey[descriptor.key]
  })
);

const adapterByRuntimeId = new Map(cliRunLifecycleAdapters.map((adapter) => [adapter.runtimeId, adapter]));

export function findCliRunLifecycleAdapter(runtimeId: string | null | undefined): CliRunLifecycleAdapter | null {
  if (!runtimeId) return null;
  return adapterByRuntimeId.get(runtimeId as `cli:${CliRuntimeKey}`) ?? null;
}

/** Uses the existing launch and completion policies; does not probe a provider. */
export function describeCliAdapter(runtimeId: string): CliAdapterContract | undefined {
  const descriptor = cliRuntimeDescriptors.find(item => item.id === runtimeId);
  const lifecycle = findCliRunLifecycleAdapter(runtimeId);
  if (!descriptor || !lifecycle) return undefined;
  const nativeResumeModes: CliAdapterContract["nativeResumeModes"] = [];
  // REFERENCE: the launcher passes a recorded native session/thread id (cli-terminal
  // buildCliSpawnArgs); others only reach a provider picker/continue. The contract test
  // derives both from the launcher and the launch gates, so neither can drift silently.
  if (descriptor.declaresNativeReference) nativeResumeModes.push("REFERENCE");
  if (descriptor.nativeResumeArgs) nativeResumeModes.push("PROVIDER_SELECTION");
  return {
    contractVersion: 1,
    operations: {
      start: "PTY_SPAWN", send: "PTY_INPUT", interrupt: "PROCESS_TERMINATE",
      inspect: "HOST_PROCESS", events: "PTY_OUTPUT_AND_PROCESS_EXIT", reconnect: "LIVE_HOST_PROCESS"
    },
    nativeResumeModes,
    completion: lifecycle.completionStrategy,
    context: { owner: "PROVIDER_NATIVE", spaceCompaction: "NONE", usageReporting: "UNAVAILABLE" },
    limitations: descriptor.adapterLimitations.map(limitation => ({ ...limitation })),
    evidence: "DECLARED_ONLY"
  };
}
