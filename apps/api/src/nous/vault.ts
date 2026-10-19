import { z } from "zod";
import { vaultAgentFillRequestSchema, vaultAgentSaveRequestSchema, type Pane } from "@space/contracts";
import type { VaultModule } from "../vault/wiring.js";

/**
 * Nous's Vault tools (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac): the same calls as the agents' space_vault
 * tools (vault/agent.ts), so Nous and agents have identical access. While the operator's agent-access switch is on, Nous lists
 * the delegated items, fills one into a pane's open browser page by handle, and saves a login it created; it never sees or
 * sends a stored value, and every answer is a status with an audit id (a list adds handles, labels and origins).
 */
export const nousVaultFillArgsSchema = z.object({
  room: z.string().trim().min(1).max(200).describe("The room's name as shown in the world (or its id)."),
  pane: z.string().trim().min(1).max(160).describe("The browser pane whose open page gets the fill."),
  handle: vaultAgentFillRequestSchema.shape.handle.describe("The Vault item handle (vault_item:...), from space_vault_list."),
  fields: vaultAgentFillRequestSchema.shape.fields,
  submit: z.boolean().optional().describe("Submit the form after filling.")
}).strict();
export const nousVaultListArgsSchema = z.object({}).strict();
export const nousVaultSaveArgsSchema = vaultAgentSaveRequestSchema;

export const NOUS_VAULT_FILL_DESCRIPTION = "Fill a Vault item into a browser pane's open page by handle (open the site's login page first). "
  + "Space types the values itself; you never see or send a value, username, URL or selector. The answer is {status, auditId}: FILLED or SUBMITTED, "
  + "BLOCKED (agent access is off, the item is not delegated, or no login form), ORIGIN_MISMATCH (the page is not the item's site).";
export const NOUS_VAULT_LIST_DESCRIPTION = "The Vault items the operator lets agents and you use: handles, labels, exact sites and fields, never a value. BLOCKED while agent access is off.";
export const NOUS_VAULT_SAVE_DESCRIPTION = "Save a login whose password you set (a new account, or a reset of an account the Vault has no item for: site, username or email, "
  + "the password you chose, a label) into the operator's Vault. It is sealed at once; the operator's Vault adds it on their next unlock, "
  + "and it becomes fillable then. Never save a login whose password you did not set.";

const vaultOff = { status: "BLOCKED", auditId: null } as const;

export function nousVaultFill(vault: VaultModule | undefined, owner: string, pane: Pane, args: z.infer<typeof nousVaultFillArgsSchema>, traceId: string) {
  return vault ? vault.agent.call({ owner, paneId: pane.id, roomId: pane.roomId, path: "fill", traceId,
    body: vaultAgentFillRequestSchema.parse({ handle: args.handle, fields: args.fields, submit: args.submit ?? false, targetPaneId: pane.id }) }) : Promise.resolve(vaultOff);
}

// List and save name no pane: their audit rows carry "nous" as the caller.
export function nousVaultList(vault: VaultModule | undefined, owner: string, traceId: string) {
  return vault ? vault.agent.call({ owner, paneId: "nous", roomId: "", path: "list", body: {}, traceId }) : Promise.resolve(vaultOff);
}

export function nousVaultSave(vault: VaultModule | undefined, owner: string, args: z.infer<typeof nousVaultSaveArgsSchema>, traceId: string) {
  return vault ? vault.agent.call({ owner, paneId: "nous", roomId: "", path: "save", body: args, traceId }) : Promise.resolve(vaultOff);
}
