import { z } from "zod";

/** Read-only view of the merge queue (space-merge-queue.service) for operators. */
export const deployQueueTicketStatusSchema = z.enum([
  // AWAITING_APPROVAL: a stable hotfix submitted while dev is the default target.
  "AWAITING_APPROVAL", "QUEUED", "INTEGRATING", "VERIFYING", "DEPLOYING", "DEPLOYED", "CONFLICT", "FAILED", "CANCELLED"
]);

/** The CLI pane that submitted a ticket, with its pane and room names when they still exist. */
export const deployQueueSubmitterSchema = z.object({
  runtimeId: z.string().max(80).nullable(),
  cliSessionId: z.string().max(120).nullable(),
  paneId: z.string().max(120).nullable(),
  roomId: z.string().max(120).nullable(),
  paneTitle: z.string().max(120).nullable(),
  roomName: z.string().max(120).nullable()
}).strict();

export const deployQueueTicketSchema = z.object({
  id: z.string().max(80),
  status: deployQueueTicketStatusSchema,
  branch: z.string().max(200),
  summary: z.string().max(240),
  sha: z.string().max(40),
  submittedAt: z.string().max(40),
  updatedAt: z.string().max(40),
  note: z.string().max(1000).nullable(),
  deployedCommit: z.string().max(40).nullable(),
  conflictFiles: z.array(z.string().max(300)).max(50),
  autoResolvedFiles: z.array(z.string().max(300)).max(50),
  remotes: z.enum(["ok", "failed"]).nullable(),
  /** When the ticket entered its current status. */
  statusSince: z.string().max(40).nullable().optional(),
  submitter: deployQueueSubmitterSchema.nullable().optional()
}).strict();

export const deployQueueBatchSchema = z.object({
  batchId: z.string().max(80),
  phase: z.string().max(20),
  ticketIds: z.array(z.string().max(80)).max(20),
  /** When the batch was created (integration start). */
  batchStartedAt: z.string().max(40).nullable().optional(),
  /** When the batch entered its current phase. */
  phaseStartedAt: z.string().max(40).nullable().optional(),
  candidate: z.string().max(40).nullable().optional()
}).strict();

export const deployQueueReportSchema = z.object({
  available: z.boolean(),
  daemonRunning: z.boolean(),
  heartbeatAt: z.string().max(40).nullable(),
  paused: z.object({ reason: z.string().max(500), at: z.string().max(40) }).strict().nullable(),
  current: deployQueueBatchSchema.nullable(),
  /** A batch prepared on top of the deploying one (pipeline). */
  next: deployQueueBatchSchema.nullable().optional(),
  active: z.array(deployQueueTicketSchema).max(200),
  recent: z.array(deployQueueTicketSchema).max(30)
}).strict();

export type DeployQueueTicketStatus = z.infer<typeof deployQueueTicketStatusSchema>;
export type DeployQueueSubmitter = z.infer<typeof deployQueueSubmitterSchema>;
export type DeployQueueTicket = z.infer<typeof deployQueueTicketSchema>;
export type DeployQueueBatch = z.infer<typeof deployQueueBatchSchema>;
export type DeployQueueReport = z.infer<typeof deployQueueReportSchema>;
