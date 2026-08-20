import { cliRuntimeDescriptors, type CliRuntimeKey } from "./cli-runtime-descriptors.js";

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
  hermes: "UNAVAILABLE_FAIL_CLOSED"
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
