import type { ConnectorCapability } from "@space/contracts";
import { createGmailClient } from "../mail-copilot/gmail-client.js";
import { buildMime } from "../mail-copilot/gmail-mime.js";
import type { MailCopilotGoogleAccess } from "../mail-copilot/service.js";

// C5 (internal MASVS review 1/11; design §2.2 and §13.6, security review P1-5): a new pairing is e-mailed to the owner's sign-in address
// through the owner's own connected Gmail, to themselves, so a pairing made through a stolen web session is seen outside it. With no
// connected Gmail that can send, only the URGENT card goes out. Never held for quiet hours or for Nous.

const SENDS: readonly ConnectorCapability[] = ["MAIL_COMPOSE", "MAIL_ORGANIZE"];
export type PairingMailResult = { result: "SENT"; from: string } | { result: "NO_GMAIL" } | { result: "FAILED" };

export async function mailPairingNotice(deps: { google: MailCopilotGoogleAccess | null; fetchImpl?: typeof fetch },
  input: { owner: string; to: string; deviceName: string; deviceId: string; requestedScopes: readonly string[]; instanceLabel: string; at: string }): Promise<PairingMailResult> {
  try {
    if (!deps.google?.googleConfigured) return { result: "NO_GMAIL" };
    const accounts = (await deps.google.googleAccounts(input.owner)).filter((account) => account.capabilities.some((capability) => SENDS.includes(capability)));
    // The sign-in address's own mailbox first, to itself; else another of the owner's connected mailboxes, to the sign-in address.
    const from = accounts.find((account) => account.email.toLowerCase() === input.to.toLowerCase()) ?? accounts[0];
    if (!from) return { result: "NO_GMAIL" };
    const token = await deps.google.googleAccessToken(input.owner, from.email, from.capabilities.find((capability) => SENDS.includes(capability))!);
    const text = [
      `A phone named "${input.deviceName}" was paired with ${input.instanceLabel} at ${input.at} (device ${input.deviceId}; it asks for ${input.requestedScopes.join(", ")}).`,
      "", "Until you allow it in SpaceApp > Settings > Account > Devices, within 10 minutes, it can only read.",
      "", "If you did not pair it: Revoke it there now, then rotate the mobile keys with \"Keys exposed\" in Settings > Account > Mobile app."
    ].join("\n");
    await createGmailClient({ accessToken: token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
      .send(buildMime({ from: from.email, to: [input.to], subject: `New device paired with SpaceApp: ${input.deviceName}`, text }));
    return { result: "SENT", from: from.email };
  } catch {
    return { result: "FAILED" };
  }
}
