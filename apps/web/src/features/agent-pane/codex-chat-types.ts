import type { AgentPaneSession, Artifact } from "@space/contracts";

export type CodexModelOption = AgentPaneSession["modelOptions"][number] | {
  id: string;
  displayName: string;
  providerId?: string | null;
  providerName?: string | null;
  model?: string | null;
  reasoningKey?: string | null;
  reasoningLabel?: string | null;
  isDefault?: boolean;
};

export type CodexComposerAttachment = Pick<Artifact, "id" | "kind" | "mimeType" | "byteSize" | "metadata">;

export function codexModelName(option: CodexModelOption): string {
  return option.model ?? option.displayName;
}
