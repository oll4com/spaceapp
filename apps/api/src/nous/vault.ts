import { z } from "zod";
import { vaultAgentFillRequestSchema, vaultAgentKeyListRequestSchema, vaultAgentKeySaveRequestSchema, vaultAgentSaveRequestSchema, type Pane } from "@space/contracts";
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
export const nousVaultKeyListArgsSchema = vaultAgentKeyListRequestSchema;
export const nousVaultKeySaveArgsSchema = vaultAgentKeySaveRequestSchema;

export const NOUS_VAULT_FILL_DESCRIPTION = "Fill a Vault item into a browser pane's open page by handle (open the site's login page first). "
  + "Space types the values itself; you never see or send a value, username, URL or selector. The answer is {status, auditId, reason}: FILLED or SUBMITTED, "
  + "BLOCKED (agent access is off, the item is not delegated, or no login form), ORIGIN_MISMATCH (the page is not the item's site). "
  + "reason FIELD_NOT_FOUND_AFTER_RELOAD: the page was reloaded first (a session had run code in it) and the field was gone; redo the steps that showed it with navigate, click, type and press only, then fill again.";
export const NOUS_VAULT_LIST_DESCRIPTION = "The Vault items the operator lets agents and you use: handles, labels, exact sites and fields, never a value. BLOCKED while agent access is off.";
export const NOUS_VAULT_SAVE_DESCRIPTION = "Save a login you created (site, username or email, the password you chose, a label) into the operator's Vault. "
  + "It is sealed at once and fillable as soon as space_vault_list shows it, without the operator's unlock. A login that reached the operator (a site's mail with their credentials) may be saved too; "
  + "a password that is not a website login goes to space_vault_key_save.";
export const NOUS_VAULT_KEY_LIST_DESCRIPTION = "The operator's kept passwords and keys for agents (servers, VMs, SSH and admin accounts, API keys): ids and labels, never a value. "
  + "Look here before asking the operator for one; q narrows by words of the label. A pane writes one where it is needed with its space_vault_key_install {id}. BLOCKED while agent access is off.";
export const NOUS_VAULT_KEY_SAVE_DESCRIPTION = "Keep a password or key that reached you or the operator (a mail you read, the operator's message, a service) in the Vault, so every agent finds it "
  + "with space_vault_key_list: label with host, account and purpose (\"vm221 macOS spaceadmin password\"), the value one line. Never put such a value in memory, notes, plans or chat. Answer {status: SAVED, id, auditId}.";

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

export function nousVaultKeyList(vault: VaultModule | undefined, owner: string, args: z.infer<typeof nousVaultKeyListArgsSchema>, traceId: string) {
  return vault ? vault.agent.call({ owner, paneId: "nous", roomId: "", path: "key-list", body: args, traceId }) : Promise.resolve(vaultOff);
}

export function nousVaultKeySave(vault: VaultModule | undefined, owner: string, args: z.infer<typeof nousVaultKeySaveArgsSchema>, traceId: string) {
  return vault ? vault.agent.call({ owner, paneId: "nous", roomId: "", path: "key-save", body: args, traceId }) : Promise.resolve(vaultOff);
}
