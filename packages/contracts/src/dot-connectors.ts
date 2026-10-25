import { z } from "zod";

/**
 * Space Dots Stage 5: email and calendar through accounts the user connects to
 * Space (Google first, Microsoft when the server has an app registration).
 * An account is never assumed to exist because it exists elsewhere: Dots see
 * only accounts connected here, with the scopes the user granted.
 */
export const connectorProviderSchema = z.enum(["GOOGLE", "MICROSOFT"]);
// MAIL_ORGANIZE lets Space label and archive mail (Job Copilot files application emails); it never deletes mail.
export const connectorCapabilitySchema = z.enum(["MAIL_READ", "MAIL_COMPOSE", "CALENDAR", "MAIL_ORGANIZE"]);
export const connectorAccountSummarySchema = z.object({
  accountId: z.string().regex(/^connector:[a-f0-9]{32}$/),
  provider: connectorProviderSchema,
  email: z.string().min(3).max(320),
  capabilities: z.array(connectorCapabilitySchema),
  connectedAt: z.iso.datetime()
}).strict();
export const connectorsStatusSchema = z.object({
  providers: z.array(z.object({ provider: connectorProviderSchema, configured: z.boolean(), reason: z.string().nullable() }).strict()),
  accounts: z.array(connectorAccountSummarySchema)
}).strict();
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;
export type ConnectorCapability = z.infer<typeof connectorCapabilitySchema>;
export type ConnectorAccountSummary = z.infer<typeof connectorAccountSummarySchema>;
export type ConnectorsStatus = z.infer<typeof connectorsStatusSchema>;

/** OAuth scopes per provider and what each grants. */
export const googleConnectorScopes = {
  MAIL_READ: "https://www.googleapis.com/auth/gmail.readonly",
  MAIL_COMPOSE: "https://www.googleapis.com/auth/gmail.compose",
  CALENDAR: "https://www.googleapis.com/auth/calendar.events",
  MAIL_ORGANIZE: "https://www.googleapis.com/auth/gmail.modify"
} as const satisfies Record<ConnectorCapability, string>;
export const microsoftConnectorScopes = {
  MAIL_READ: "Mail.Read",
  MAIL_COMPOSE: "Mail.Send",
  CALENDAR: "Calendars.ReadWrite",
  MAIL_ORGANIZE: "Mail.ReadWrite"
} as const satisfies Record<ConnectorCapability, string>;
/** A broader scope grants the narrower capability too: gmail.modify (Mail.ReadWrite) covers reading. Composing stays its own grant. */
const impliedConnectorCapabilities: Record<ConnectorProvider, Partial<Record<ConnectorCapability, ConnectorCapability[]>>> = {
  GOOGLE: { MAIL_ORGANIZE: ["MAIL_READ"] },
  MICROSOFT: { MAIL_ORGANIZE: ["MAIL_READ"] }
};
export function connectorCapabilities(provider: ConnectorProvider, scopes: readonly string[]): ConnectorCapability[] {
  const table = provider === "GOOGLE" ? googleConnectorScopes : microsoftConnectorScopes;
  const granted = new Set(scopes.map((scope) => scope.toLowerCase()));
  const direct = (Object.keys(table) as ConnectorCapability[]).filter((capability) => granted.has(table[capability].toLowerCase())
    || [...granted].some((scope) => scope.endsWith(`/${table[capability].toLowerCase()}`)));
  const implied = direct.flatMap((capability) => impliedConnectorCapabilities[provider][capability] ?? []);
  return (Object.keys(table) as ConnectorCapability[]).filter((capability) => direct.includes(capability) || implied.includes(capability));
}
