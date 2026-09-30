import type { LiveIntentResult } from "./live-intent-classifier.js";
import type { createVoiceDelegateResponse } from "./voice-transcription.js";
type DelegateResult = Awaited<ReturnType<typeof createVoiceDelegateResponse>>;

/** Jev may propose only a parameter-free, room-wide read. Execution still
 * passes through the normal authenticated tool executor and its access gates. */
export function liveJevReadCandidate(result: LiveIntentResult, roomId: string | undefined, tools: Array<Record<string, unknown>> = []) {
  if (!roomId || !result.available || result.intent !== "inspect" || result.toolFamily !== "read" ||
      result.route !== "shell" || result.complexity !== "simple" || result.ambiguous === undefined || result.ambiguous > 0.1 ||
      !["STATE", "MODELS", "TASKS", "CONTENT", "QUOTA", "RUNTIMES", "SYSTEM_HEALTH"].includes(result.readSection ?? "")) return null;
  const tool = tools.find(tool => tool.name === "space_inspect_room");
  const parameters = tool?.parameters as { properties?: { section?: { enum?: unknown[] } } } | undefined;
  if (!parameters?.properties?.section?.enum?.includes(result.readSection)) return null;
  return { name: "space_inspect_room", args: { roomId, section: result.readSection! } };
}

export async function routeLiveDelegation(input: {
  enabled: boolean; roomId?: string; tools?: Array<Record<string, unknown>>;
  classify: () => Promise<LiveIntentResult>;
  delegate: (signal?: AbortSignal) => Promise<DelegateResult>;
}): Promise<DelegateResult> {
  if (!input.enabled) return input.delegate();
  const started = performance.now(), abort = new AbortController();
  // Starting the fallback immediately avoids adding the classifier's timeout
  // to ordinary commands. Cancelling a losing provider request does not prove
  // zero provider cost, so its cost remains unknown in the receipt.
  const baseline = input.delegate(abort.signal);
  const candidate = input.classify().then(result => {
    const toolCall = liveJevReadCandidate(result, input.roomId, input.tools);
    return toolCall ? { toolCall, message: null, telemetry: { provider: null, model: null,
      latencyMs: Math.round(performance.now() - started), attempt: 1, estimatedCostUsd: null,
      routing: "jev-read" as const } } : baseline;
  }).catch(() => baseline);
  const result = await Promise.race([baseline, candidate]);
  if (result.telemetry?.routing === "jev-read") abort.abort();
  return result;
}
