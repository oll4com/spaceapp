import { z } from "zod";
import { dotIdSchema } from "./dots.js";

/**
 * Space Dots Stage 4: each Dot's own computer.
 *
 * A Dot gets a private workspace directory, created the first time it works,
 * and its own Browser pane per room with an isolated profile, opened only when
 * it needs a browser. The Computer view shows both, the Dot's live work across
 * rooms, and stops it.
 */
export const DOT_WORKSPACE_ROOT = "/opt/spaceapp/var/dots/workspaces";

/** The Dot's private workspace. Dot ids are unique per user, so the id alone scopes it. */
export function dotWorkspacePath(dotId: string, root = DOT_WORKSPACE_ROOT): string {
  const parsed = dotIdSchema.parse(dotId);
  return `${root.replace(/\/+$/, "")}/${parsed.slice("dot:".length)}`;
}

export const dotWorkspaceEntrySchema = z.object({
  name: z.string().min(1).max(255),
  kind: z.enum(["file", "directory", "other"]),
  bytes: z.number().int().min(0).nullable(),
  modifiedAt: z.iso.datetime()
}).strict();
export const dotComputerRunSchema = z.object({
  sessionId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200),
  roomName: z.string().max(200).nullable(),
  paneId: z.string().min(1).max(200),
  title: z.string().max(300).nullable(),
  status: z.enum(["QUEUED", "RUNNING"]),
  kind: z.enum(["CHAT", "GOAL", "SCHEDULE"]),
  startedAt: z.iso.datetime()
}).strict();
export const dotComputerBrowserSchema = z.object({
  roomId: z.string().min(1).max(200),
  roomName: z.string().max(200).nullable(),
  paneId: z.string().min(1).max(200),
  active: z.boolean(),
  currentUrl: z.string().max(2000).nullable(),
  title: z.string().max(500).nullable(),
  /** The open browser session, for its latest picture in the Dot's card; null when none is open. */
  sessionId: z.string().min(1).max(200).nullable(),
  /** Its browser is running, so taking a picture never starts one. */
  ready: z.boolean()
}).strict();
export const dotComputerSchema = z.object({
  dotId: dotIdSchema,
  workspace: z.object({
    path: z.string().min(1).max(500),
    exists: z.boolean(),
    entries: z.array(dotWorkspaceEntrySchema).max(50),
    totalEntries: z.number().int().min(0),
    /** False when the folder was too large to sort completely. */
    sortedAll: z.boolean()
  }).strict(),
  runs: z.array(dotComputerRunSchema).max(20),
  goals: z.array(z.object({ goalId: z.string(), objective: z.string(), status: z.string(), steps: z.number().int(), maxSteps: z.number().int() }).strict()).max(20),
  browsers: z.array(dotComputerBrowserSchema).max(20),
  limits: z.object({ maxConcurrentTasks: z.number().int().min(1).max(6), activeTasks: z.number().int().min(0) }).strict()
}).strict();
export const dotComputerStopInputSchema = z.object({ sessionId: z.string().trim().min(1).max(200).optional() }).strict();
export const dotComputerStopResultSchema = z.object({
  dotId: dotIdSchema,
  interruptedRuns: z.number().int().min(0),
  pausedGoals: z.number().int().min(0)
}).strict();
export type DotWorkspaceEntry = z.infer<typeof dotWorkspaceEntrySchema>;
export type DotComputer = z.infer<typeof dotComputerSchema>;
export type DotComputerRun = z.infer<typeof dotComputerRunSchema>;
export type DotComputerStopResult = z.infer<typeof dotComputerStopResultSchema>;

/** A path inside a Dot's workspace: relative, without `.` or `..` segments, backslashes or control characters. */
export const dotWorkspaceRelativePathSchema = z.string().trim().min(1).max(500)
  .refine((path) => !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f]/.test(path), "Use a path relative to the workspace.")
  .refine((path) => path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), "Use a path inside the workspace.");
export const dotWorkspaceFolderSchema = z.object({
  dotId: dotIdSchema,
  /** Relative folder; empty for the workspace root. */
  folder: z.string().max(500),
  exists: z.boolean(),
  entries: z.array(dotWorkspaceEntrySchema).max(200),
  totalEntries: z.number().int().min(0),
  sortedAll: z.boolean()
}).strict();
export type DotWorkspaceFolder = z.infer<typeof dotWorkspaceFolderSchema>;

/** Stage 5: a workspace file published to Agent Files, one row per version. */
export const dotDeliverableSchema = z.object({
  deliverableId: z.string().regex(/^dot_deliverable:[a-f0-9]{32}$/),
  dotId: dotIdSchema,
  roomId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  version: z.number().int().min(1),
  /** Null once the Agent File was deleted; the version number stays taken. */
  artifactId: z.string().min(1).max(200).nullable(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().min(0),
  mimeType: z.string().min(1).max(120),
  publishedBy: z.enum(["USER", "DOT"]),
  createdAt: z.iso.datetime()
}).strict();
export const publishDotDeliverableInputSchema = z.object({ path: dotWorkspaceRelativePathSchema, roomId: z.string().trim().min(1).max(200) }).strict();
export type DotDeliverable = z.infer<typeof dotDeliverableSchema>;
