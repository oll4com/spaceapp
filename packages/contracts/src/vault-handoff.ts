import { z } from "zod";
import { vaultAuditIdSchema } from "./vault.js";

// Vault API key handoff (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): the operator pastes a key into the Vault
// dock and gets an id to give an agent; the agent's space_vault_key_install writes the key into the file it belongs in without
// the key ever entering the agent's context, and the value is deleted once that succeeded. Unlike a login, the API can read
// the sealed value (an agent's own file must receive it); the dock says so.

export const vaultHandoffKeyIdSchema = z.string().regex(/^vault_key:[A-Za-z0-9_-]{16,64}$/);
export const VAULT_HANDOFF_KEY_LIMITS = { valueMax: 4_096, labelMax: 80, defaultHours: 168, maxHours: 720 } as const;

/** What the operator pastes: a label, the key and how long an agent has to take it. */
export const vaultHandoffKeyCreateRequestSchema = z.object({
  label: z.string().trim().min(1).max(VAULT_HANDOFF_KEY_LIMITS.labelMax),
  value: z.string().min(1).max(VAULT_HANDOFF_KEY_LIMITS.valueMax).refine((value) => !/[\r\n]/.test(value), "A key is one line."),
  expiresInHours: z.number().int().min(1).max(VAULT_HANDOFF_KEY_LIMITS.maxHours).default(VAULT_HANDOFF_KEY_LIMITS.defaultHours)
}).strict();

/** A key as the dock lists it: never its value. */
export const vaultHandoffKeySchema = z.object({
  id: vaultHandoffKeyIdSchema, label: z.string().max(VAULT_HANDOFF_KEY_LIMITS.labelMax), createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  takenAt: z.string().datetime().nullable(), takenByPaneId: z.string().max(200).nullable(), usedAt: z.string().datetime().nullable(), usedByPaneId: z.string().max(200).nullable(),
  hasValue: z.boolean()
}).strict();
export type VaultHandoffKey = z.infer<typeof vaultHandoffKeySchema>;

// Agent side (bridge /api/cli/space-vault/key-take and key-used, through the space_vault MCP only): the relay takes the value,
// writes the file itself and confirms; the agent sees ids and statuses.
export const vaultAgentKeyRequestSchema = z.object({ id: vaultHandoffKeyIdSchema }).strict();
/** key-take's answer: the one place a value crosses, to the relay that writes the file (never into the agent's context). */
export const vaultAgentKeyTakeResultSchema = z.object({
  status: z.literal("TAKEN"), auditId: vaultAuditIdSchema.nullable(), reason: z.null(), value: z.string().min(1).max(VAULT_HANDOFF_KEY_LIMITS.valueMax)
}).strict();
/** The placeholder the relay replaces in the file content the agent composes. */
export const VAULT_HANDOFF_KEY_PLACEHOLDER = "{{SPACE_VAULT_KEY}}";
