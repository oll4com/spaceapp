/**
 * Codex runtime model settings shared by the pane CLI model routes and composition: the reasoning-effort schema, the
 * advertised model id mapping and the unconfirmed-switch error (moved verbatim from the composition root).
 */
import { z } from "zod";
import type { CodexAppServerSocketModelOption } from "@space/codex-app-server";
import { SpaceConflictError } from "@space/runtime";

export const cliModelReasoningEffortSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export type CodexRuntimeModelSettings = {
  modelId: string;
  reasoningEffort: string | null;
};

export type CodexRuntimeModelSettingsConfirmationDetails = {
  stage: "THREAD_CONFIRMATION";
  expected: { modelId: string; reasoningEffort: string };
  observed: CodexRuntimeModelSettings | null;
  attempts: number;
};

export class CodexRuntimeModelSettingsUnconfirmedError extends SpaceConflictError {
  readonly errorCode = "CODEX_RUNTIME_MODEL_SETTINGS_UNCONFIRMED";

  constructor(public readonly details: CodexRuntimeModelSettingsConfirmationDetails) {
    const expected = `${details.expected.modelId} · ${details.expected.reasoningEffort}`;
    const observed = details.observed
      ? `${details.observed.modelId} · ${details.observed.reasoningEffort ?? "not available"}`
      : "not available";
    super(
      `Codex accepted the runtime model update, but Space could not confirm it after ${details.attempts} checks. ` +
      `Expected ${expected}; last observed ${observed}.`
    );
    this.name = "CodexRuntimeModelSettingsUnconfirmedError";
  }
}

export function canonicalCodexAdvertisedModelId(
  runtimeModelId: string | null,
  models: CodexAppServerSocketModelOption[]
): string | null {
  if (!runtimeModelId) return null;
  const normalizedRuntimeModelId = runtimeModelId.toLowerCase();
  const exact = models.find((model) => model.id.toLowerCase() === normalizedRuntimeModelId);
  if (exact) return exact.id;
  const suffix = `-${normalizedRuntimeModelId}`;
  const aliases = models.filter((model) => model.id.toLowerCase().endsWith(suffix));
  return aliases.length === 1 ? aliases[0]!.id : runtimeModelId;
}
