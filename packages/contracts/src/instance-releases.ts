import { z } from "zod";
import { deployQueueReportSchema, deployQueueTicketSchema } from "./deploy-queue.js";

/** One change that is live on the dev instance but not yet on stable. */
export const releasePendingChangeSchema = z.object({
  commit: z.string().max(40),
  ticketId: z.string().max(80).nullable(),
  summary: z.string().max(240),
  committedAt: z.string().max(40)
}).strict();

/** The operator's view of the stable and dev instances (Settings → Releases). */
export const releasesReportSchema = z.object({
  /** The dev instance and its queue exist on this server. */
  available: z.boolean(),
  /** Releases are managed from the stable instance only. */
  managedHere: z.boolean(),
  defaultTarget: z.enum(["stable", "dev"]),
  stable: z.object({ commit: z.string().max(40).nullable(), url: z.string().max(200) }).strict(),
  dev: z.object({
    commit: z.string().max(40).nullable(),
    verifiedCommit: z.string().max(40).nullable(),
    url: z.string().max(200)
  }).strict(),
  pending: z.array(releasePendingChangeSchema).max(200),
  pendingCount: z.number().int().min(0),
  promotion: deployQueueTicketSchema.nullable(),
  hotfixes: z.array(deployQueueTicketSchema).max(50),
  devQueue: deployQueueReportSchema
}).strict();

export const releaseActionResponseSchema = z.object({
  status: z.enum(["QUEUED", "ALREADY_LIVE", "APPROVED"]),
  ticketId: z.string().max(80).nullable(),
  message: z.string().max(500)
}).strict();

export type ReleasePendingChange = z.infer<typeof releasePendingChangeSchema>;
export type ReleasesReport = z.infer<typeof releasesReportSchema>;
export type ReleaseActionResponse = z.infer<typeof releaseActionResponseSchema>;
