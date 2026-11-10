import { hkdfSync } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SpaceStore } from "@space/runtime";
import type { NotificationService } from "../notifications/service.js";
import { InMemoryMailCampaignsRepository, PostgresMailCampaignsRepository, type MailCampaignsRepository } from "@space/db";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import type { MailCopilotGoogleAccess } from "../mail-copilot/service.js";
import type { VaultStore } from "../vault/routes.js";
import { createMailTransports, type MailTransportDeps } from "./transports.js";
import { createGmailClient, type GmailClient } from "../mail-copilot/gmail-client.js";
import { header, parseParticipants } from "../mail-copilot/gmail-mime.js";
import { registerMailCampaignsRoutes, type MailCampaignsRouteDependencies } from "./routes.js";
import { createMailCampaignsService, type MailCampaignsService, type MailCampaignsServiceOptions } from "./service.js";
import { mailSite } from "./site.js";

export interface MailCampaignsWiring extends MailCampaignsRouteDependencies {
  databaseUrl: string | null | undefined;
  /** Tests pass an in-memory repository; otherwise Postgres when a database is configured. */
  repository?: MailCampaignsRepository;
  threadParticipants?: MailCampaignsServiceOptions["threadParticipants"];
  google(): MailCopilotGoogleAccess | null;
  /** The Vault's store, read when a sender needs its kept key (the Vault registers after this module). */
  vaultStore(): VaultStore | null | undefined;
  crypto: ConnectorCrypto;
  /** Tests replace the SMTP client and Google's token endpoint. */
  smtp?: MailTransportDeps["smtp"];
  fetchImpl?: typeof fetch;
  store: Pick<SpaceStore, "getRoom" | "getPane" | "listRooms" | "listPanes">;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  /** Nous on with "May send to third parties": agents and the server resume what it covers (campaigns.ts `resumeAfterOutage`). */
  coversApproval?(owner: string): Promise<boolean>;
  /** The secret unsubscribe tokens are signed under (the connector key; it never rotates lightly, so links stay valid). */
  unsubscribeSecret: string;
  /** The public one-click endpoint, e.g. https://oll4.com/u/ (SPACE_MAIL_UNSUBSCRIBE_BASE_URL); unset: mailto unsubscribe only. */
  unsubscribeBase?: string | null;
  /** Instance job mail-campaign-sender (stable only): mails approved campaigns every 15 s. */
  senderJob: boolean;
  /** Instance job mail-campaign-health (stable only): address health and Gmail senders' bounces and replies every 10 minutes. */
  healthJob?: boolean;
  log: { warn(details: unknown, message: string): void };
}

const SENDER_TICK_MS = 15_000;
const HEALTH_TICK_MS = 10 * 60_000;
/**
 * The public one-click endpoint (Nous decision 29/10): it keeps the token only; the signals pass brings it here.
 * SPACE_MAIL_UNSUBSCRIBE_BASE_URL overrides it ("off": mailto only).
 */
export const DEFAULT_UNSUBSCRIBE_BASE = "https://oll4.com/u/?t=";
function unsubscribeBase(value: string | null | undefined): string | null {
  if (value === "off") return null;
  const url = new URL(value || DEFAULT_UNSUBSCRIBE_BASE);
  if (url.protocol !== "https:" || url.hash || !(/\/$/.test(url.toString()) || /\?t=$/.test(url.toString()))) throw new Error("SPACE_MAIL_UNSUBSCRIBE_BASE_URL must be an https URL ending in / or ?t=.");
  return url.toString();
}

/** Mail Campaigns (plan clipboard:IJ2ovfLg1Lbw), kept out of the composition root: its repository, service and operator routes. */
/** One message of a Gmail mailbox by its Message-ID (spam and trash too): its labels and every header; the body is never read. */
export async function gmailMessageById(gmail: GmailClient, messageId: string) {
  const id = messageId.replace(/^<|>$/g, "");
  const [threadId] = (await gmail.listThreads({ q: `in:anywhere rfc822msgid:${id}`, maxResults: 1 })).ids;
  if (!threadId) return null;
  // The client's metadata format names only From, To, Subject and Date, so full is the one answer with Message-ID and the verdict headers.
  // The thread may also hold other copies (a test copy, a later send): only this message counts.
  const messages = ((await gmail.thread(threadId, "full")).messages as Array<{ labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } }> | undefined) ?? [];
  const message = messages.find((entry) => header(entry.payload?.headers, "Message-ID").replace(/^<|>$/g, "") === id);
  return message ? { labels: message.labelIds ?? [], headers: message.payload?.headers ?? [] } : null;
}

export function registerMailCampaigns(app: FastifyInstance, deps: MailCampaignsWiring): MailCampaignsService {
  const repository = deps.repository ?? (deps.databaseUrl ? PostgresMailCampaignsRepository.fromConnectionString(deps.databaseUrl) : new InMemoryMailCampaignsRepository());
  app.addHook("onClose", () => repository.dispose());
  // A kept key only: a one-time key belongs to the pane it was handed to, and taking it here would spend it.
  const keptKey = async (owner: string, id: string) => {
    const store = deps.vaultStore();
    if (!store || !(await store.listHandoffKeys(owner)).some((key) => key.id === id && key.kept && key.hasValue)) return null;
    const taken = await store.takeHandoffKey(owner, id, "mail-campaigns");
    return taken ? deps.crypto.open(taken.valueSealed, connectorSealContext("vault-handoff-key", owner, id)) : null;
  };
  const transports = createMailTransports({ google: deps.google, keptKey, heloName: mailSite().heloName, smtp: deps.smtp, fetchImpl: deps.fetchImpl });
  const mailPane = async (owner: string) => {
    for (const room of await deps.store.listRooms(owner)) {
      const pane = (await deps.store.listPanes(room.id)).find((candidate) => candidate.mode === "MAIL_COPILOT" && !candidate.isClosed);
      if (pane) return { id: pane.id, roomId: room.id };
    }
    return null;
  };
  const mailboxCorrespondents = async (owner: string, account: string, days: number) => {
    const google = deps.google();
    if (!google?.googleConfigured || !(await google.googleAccounts(owner)).some((entry) => entry.email === account)) throw new Error(`${account} is not one of your connected Google accounts.`);
    const gmail = createGmailClient({ accessToken: await google.googleAccessToken(owner, account, "MAIL_READ"), fetchImpl: deps.fetchImpl });
    const people = new Map<string, { name: string; address: string }>();
    let pageToken: string | undefined;
    // shortcut: at most 1,000 sent threads per import (10 pages); a bigger mailbox imports in several passes by days.
    for (let page = 0; page < 10; page++) {
      const listed = await gmail.listThreads({ q: `in:sent newer_than:${days}d`, maxResults: 100, ...(pageToken ? { pageToken } : {}) });
      for (const threadId of listed.ids) {
        const thread = await gmail.thread(threadId, "metadata").catch(() => null);
        for (const message of (thread?.messages as Array<{ payload?: { headers?: unknown } }> | undefined) ?? []) {
          for (const person of parseParticipants(header(message.payload?.headers, "To"))) if (!people.has(person.address)) people.set(person.address, person);
        }
      }
      if (!listed.nextPageToken) break;
      pageToken = listed.nextPageToken;
    }
    return [...people.values()];
  };
  const service = createMailCampaignsService({ repository, transports, threadParticipants: deps.threadParticipants, mailboxCorrespondents, campaigns: {
    notify: deps.notifications, mailPane, coversApproval: deps.coversApproval,
    ownMailboxes: async (owner) => (await deps.google()?.googleAccounts(owner).catch(() => []) ?? []).map((account) => account.email),
    seedMessage: async (owner, account, messageId) => {
      const google = deps.google();
      if (!google?.googleConfigured || !(await google.googleAccounts(owner)).some((entry) => entry.email === account)) return null;
      return gmailMessageById(createGmailClient({ accessToken: await google.googleAccessToken(owner, account, "MAIL_READ"), fetchImpl: deps.fetchImpl }), messageId);
    },
    unsubscribeKey: Buffer.from(hkdfSync("sha256", Buffer.from(deps.unsubscribeSecret, "utf8"), Buffer.from("space-mail-campaigns"), Buffer.from("unsubscribe-token"), 32)),
    unsubscribeBase: unsubscribeBase(deps.unsubscribeBase ?? process.env.SPACE_MAIL_UNSUBSCRIBE_BASE_URL)
  } });
  registerMailCampaignsRoutes(app, service, deps);
  if (deps.senderJob) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void service.tick().catch((error) => deps.log.warn({ err: error }, "Mail campaign sender pass failed.")).finally(() => { running = false; });
    }, SENDER_TICK_MS);
    timer.unref?.();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  if (deps.healthJob) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void service.healthTick().catch((error) => deps.log.warn({ err: error }, "Mail campaign health pass failed.")).finally(() => { running = false; });
    }, HEALTH_TICK_MS);
    timer.unref?.();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  return service;
}
