import type { CredentialHost } from "./cli-auth-transfer.js";

const choicePattern = /^(auto|opencode\/[a-z0-9][a-z0-9._-]{0,100})$/;
// The agent gives a pick or a probe 150 s (catalog plus two tool-call runs); ours outlasts it.
const probeTimeoutMs = 160_000;

/**
 * Whether the public CLI container's OpenCode wrapper can apply an owner's free model pick. On a public install the
 * CLI's config lives only in that container, so both actions go through its credential agent. Only `inspect-env` is
 * asked (side-effect free in every public wrapper): an older wrapper would hand an unknown subcommand to OpenCode.
 */
export async function nativeFreeModelSelectionSupported(host: CredentialHost, commandPath: string): Promise<boolean> {
  try {
    const answer = await host.run(commandPath, "inspect-env");
    const operations = answer.exitCode === 0 ? /^operations=(.*)$/m.exec(answer.stdout)?.[1] ?? "" : "";
    return operations.split(",").includes("select-free-model");
  } catch { return false; }
}

/**
 * The wrapper probes the pick ("auto": Big Pickle first) with a real tool call (OpenCode 2 --standalone, never the
 * panes' store) and writes the CLI's model only on a pass; a failed check leaves the current model.
 */
export async function selectNativeSetupFreeModel(host: CredentialHost, commandPath: string, choice: string): Promise<void> {
  if (!choicePattern.test(choice)) throw new Error("Invalid free model.");
  const answer = await host.run(commandPath, "select-free-model", undefined, { argument: choice, timeoutMs: probeTimeoutMs }).catch(() => null);
  if (answer?.exitCode !== 0) throw new Error("The selected free model did not complete a tool call.");
}

/** The Room Agent setup check on a public install: the wrapper probes this model with a real tool call and changes nothing. */
export async function checkNativeSetupFreeModel(host: CredentialHost, commandPath: string, modelId: string): Promise<boolean> {
  if (!/^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/.test(modelId)) return false;
  const answer = await host.run(commandPath, "check-free-model", undefined, { argument: modelId, timeoutMs: probeTimeoutMs }).catch(() => null);
  return answer?.exitCode === 0;
}
