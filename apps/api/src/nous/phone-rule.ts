// C7 (internal MASVS review 1/11, security review P1-3): NOUS_MOBILE_RULE held on the server too. A turn whose operator message came
// from a paired phone never uses the Vault or sends a merge-queue command on Nous's own allowance; both go to the operator as a decision,
// which the phone answers with its signed decide. Settings, allowances, Always kinds, hotfixes and releases already need the operator's
// own answer, and Away grants are refused in space_nous_away itself; a phone turn's space_ask_operator is never approved by an allowance,
// an "Always approve" or an Away grant either (`phone` in the service's ask).

const VAULT_TOOLS = new Set(["space_vault_fill", "space_vault_save", "space_vault_key_save"]);
const QUEUE_COMMAND = /space-queue\s+(?:promote|approve|default-target|pause|resume)\b/i;

/** What a phone turn may not do with this call, or null. */
export function phoneTurnRefusal(tool: string, args: Record<string, unknown>): string | null {
  if (VAULT_TOOLS.has(tool)) return "the Vault";
  if (tool === "space_send_to_pane" && typeof args.text === "string" && QUEUE_COMMAND.test(args.text)) return "a merge-queue command";
  return null;
}

export const phoneRuleHold = (what: string) => `The operator wrote from a paired phone (the phone rule): ${what} needs a computer. `
  + "Ask them with space_ask_operator instead; they answer it with the phone's signed decide, or on a computer.";
