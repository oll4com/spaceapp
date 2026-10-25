import type { FastifyRequest } from "fastify";
import { agentFileMaxBytes, agentFileMaxCount } from "./cli-agent-files.js";
import { withStagedUploads, type StagedFile } from "./multipart-upload.js";

export type StagedAgentFile = StagedFile;

export async function withStagedAgentFiles<T>(request: FastifyRequest, root: string,
  consume: (uploads: StagedAgentFile[], totalBytes: number) => Promise<T>,
  onField?: (name: string, value: unknown) => void): Promise<T> {
  return withStagedUploads(request, root, { maxFiles: agentFileMaxCount, fileBytes: agentFileMaxBytes, onField }, consume);
}
