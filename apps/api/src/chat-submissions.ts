import { createHash } from "node:crypto";

export function chatSubmissionFingerprint(input: {
  content: string;
  operatorUserId?: string;
  selectedModelConfigId?: string;
  selectedToolIds?: string[];
  artifactIds?: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    operatorUserId: input.operatorUserId ?? null,
    content: input.content.trim(),
    selectedModelConfigId: input.selectedModelConfigId ?? null,
    // Inherited tools and an explicitly empty selection have different meanings.
    selectedToolIds: input.selectedToolIds ?? null,
    artifactIds: [...new Set(input.artifactIds ?? [])]
  })).digest("hex");
}
