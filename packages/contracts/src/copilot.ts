import { z } from "zod";

/**
 * Shared by every copilot pane (Job Copilot, Mail Copilot): the agent a pane runs is a CLI runtime
 * plus the account that CLI starts on, chosen once in the launch dialog and remembered per user.
 * The account lives in the pane's CLI session, never in the pane row: the Browser Host parses pane
 * rows with the contracts it loaded at start (ADR-011 item 13).
 */

/** A CLI account profile id ("main", a named profile or "space-gateway"); same shape as the CLI account contracts. */
export const copilotAccountProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** The agent new panes of a copilot open with, chosen once in the launch dialog; Settings and Setup → Agent change it. */
export const copilotLaunchSettingsSchema = z.object({
  runtimeId: z.string().regex(/^cli:[a-z0-9-]{1,40}$/),
  /** Account profile of that CLI (Claude Code "main", a named profile or the Space Gateway pool); null for the CLI's default. */
  accountProfileId: z.string().min(1).max(120).nullable().default(null),
  /** Show the launch dialog again on every new pane of this copilot. */
  askOnLaunch: z.boolean().default(false)
}).strict();
export type CopilotLaunchSettings = z.infer<typeof copilotLaunchSettingsSchema>;
