import { agentPaneSendMessageInputSchema, artifactSchema } from "@space/contracts";
import type { Artifact } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

export interface ChatSubmission {
  clientRequestId: string;
  content: string;
  selectedModelConfigId: string | null;
  selectedToolIds: string[];
  attachments: Artifact[];
}

const key = (paneId: string) => `space.chatSubmission.v1:${paneId}`;

export function readChatSubmission(paneId: string): ChatSubmission | null {
  try {
    const raw = getSpaceRuntime().platform.sessionStorage?.getItem(key(paneId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.attachments) || parsed.attachments.length > 8) return null;
    const attachments = parsed.attachments.map((item: unknown) => artifactSchema.parse(item));
    const request = agentPaneSendMessageInputSchema.parse({ ...parsed,
      selectedModelConfigId: parsed.selectedModelConfigId ?? undefined, artifactIds: attachments.map((a: Artifact) => a.id) });
    if (!request.clientRequestId) return null;
    return { clientRequestId: request.clientRequestId, content: request.content,
      selectedModelConfigId: request.selectedModelConfigId ?? null, selectedToolIds: request.selectedToolIds ?? [], attachments };
  } catch { return null; }
}

export function writeChatSubmission(paneId: string, submission: ChatSubmission | null): boolean {
  try {
    const storage = getSpaceRuntime().platform.sessionStorage;
    if (!storage) return false;
    if (submission) storage.setItem(key(paneId), JSON.stringify(submission));
    else storage.removeItem(key(paneId));
    return true;
  } catch { return false; }
}

export function submissionWasRejected(error: unknown): boolean {
  // A runtime/server/transport error may follow acceptance. Keep its key.
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}
