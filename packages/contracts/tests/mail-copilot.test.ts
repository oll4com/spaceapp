import { describe, expect, it } from "vitest";
import {
  connectorCapabilities, createPaneInputSchema, defaultMailCopilotPaneMetadata, mailCopilotConsentUrl, mailCopilotPaneMetadataSchema, mailRuleConditionSchema,
  mailRuleMatches, resolveMailCopilotPaneMetadata, roomPaneBatchItemSchema, userSettingsSchema
} from "../src/index.js";

describe("Mail Copilot contracts", () => {
  it("reads unconfigured panes as Assist defaults and keeps the view (the CLI account lives in the session, never the row)", () => {
    const metadata = defaultMailCopilotPaneMetadata();
    expect(metadata).toEqual({ version: 1, settings: {
      autonomy: "ASSIST", paused: false, accounts: [], backlogHours: 24, sendsPerHour: 20, signature: null, notifications: { newMail: true, needsYou: true, telegram: false, mutedAccounts: [] }
    } });
    expect(resolveMailCopilotPaneMetadata(null)).toEqual(metadata);
    const parsed = mailCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "RULES", accounts: ["me@gmail.com"] },
      view: { account: "me@gmail.com", labelId: "INBOX", threadId: "t1", updatedAt: "2026-10-13T10:00:00.000Z" } });
    expect(parsed.settings.autonomy).toBe("RULES");
    expect(mailCopilotPaneMetadataSchema.safeParse({ version: 1, settings: {}, agent: { runtimeId: "cli:claude", accountProfileId: null } }).success).toBe(false);
    expect(parsed.view).toMatchObject({ account: "me@gmail.com", threadId: "t1", messageId: null, query: null });
    expect(() => mailCopilotPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "YOLO" } })).toThrow();
    expect(() => mailCopilotPaneMetadataSchema.parse({ version: 2, settings: {} })).toThrow();
  });

  it("creates MAIL_COPILOT panes with a CLI runtime and an account, like Job Copilot", () => {
    expect(createPaneInputSchema.parse({ roomId: "room:test-1", title: "Mail Copilot", mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude" }).terminalRuntimeId).toBe("cli:claude");
    expect(roomPaneBatchItemSchema.parse({ mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" }))
      .toEqual({ mode: "MAIL_COPILOT", terminalRuntimeId: "cli:claude", accountProfileId: "space-gateway" });
    expect(roomPaneBatchItemSchema.safeParse({ mode: "MAIL_COPILOT", cwd: "/root" }).success).toBe(false);
    expect(userSettingsSchema.parse({ mailCopilot: { runtimeId: "cli:codex" } }).mailCopilot).toEqual({ runtimeId: "cli:codex", accountProfileId: null, askOnLaunch: false });
  });

  it("treats gmail.modify as reading and organizing mail; composing stays its own grant", () => {
    expect(connectorCapabilities("GOOGLE", ["https://www.googleapis.com/auth/gmail.modify"])).toEqual(["MAIL_READ", "MAIL_ORGANIZE"]);
    expect(connectorCapabilities("GOOGLE", ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"])).toEqual(["MAIL_READ", "MAIL_COMPOSE", "MAIL_ORGANIZE"]);
    expect(connectorCapabilities("GOOGLE", ["https://www.googleapis.com/auth/gmail.readonly"])).toEqual(["MAIL_READ"]);
    expect(connectorCapabilities("MICROSOFT", ["Mail.ReadWrite"])).toEqual(["MAIL_READ", "MAIL_ORGANIZE"]);
    expect(mailCopilotConsentUrl("me@gmail.com")).toBe("/api/connectors/google/start?capabilities=MAIL_READ%2CMAIL_COMPOSE%2CCALENDAR%2CMAIL_ORGANIZE&source=mail-copilot&loginHint=me%40gmail.com");
    expect(mailCopilotConsentUrl()).not.toContain("loginHint");
  });

  it("matches rules on sender, domain, labels, subject and attachments", () => {
    const message = { from: "Anna Papadopoulou <anna@acme-corp.com>", subject: "Invoice #4521 for March", labelIds: ["INBOX", "CATEGORY_UPDATES"], hasAttachment: true };
    expect(mailRuleMatches({ domain: "acme-corp.com" }, message)).toBe(true);
    expect(mailRuleMatches({ domain: "corp.com" }, message)).toBe(false);
    expect(mailRuleMatches({ domain: "@ACME-corp.com", fromContains: "anna" }, message)).toBe(true);
    expect(mailRuleMatches({ labelAny: ["CATEGORY_PROMOTIONS"] }, message)).toBe(false);
    expect(mailRuleMatches({ labelAny: ["CATEGORY_PROMOTIONS", "INBOX"] }, message)).toBe(true);
    expect(mailRuleMatches({ subjectPattern: "^invoice #\\d+" }, message)).toBe(true);
    expect(mailRuleMatches({ subjectPattern: "(" }, message)).toBe(false);
    expect(mailRuleMatches({ hasAttachment: false }, message)).toBe(false);
    expect(mailRuleMatches({ domain: "sub.acme-corp.com" }, { ...message, from: "x@deep.sub.acme-corp.com" })).toBe(true);
    expect(mailRuleConditionSchema.safeParse({}).success).toBe(false);
    expect(mailRuleMatches({ fromAddress: "ANNA@acme-corp.com" }, message)).toBe(true);
    expect(mailRuleMatches({ fromAddress: "nna@acme-corp.com" }, message)).toBe(false);
  });

  it("groups subjects by shape and turns a shape into a rule pattern that matches its kind of mail only", async () => {
    const { mailSubjectKey, mailSubjectKeyPattern, mailThreadActionLabels } = await import("../src/index.js");
    const key = mailSubjectKey("Re: Fwd: [Olla] [Ticket - #34470872] - Έχετε ένα νέο ticket");
    expect(key).toBe("[olla] [ticket - #0] - έχετε ένα νέο ticket");
    expect(mailSubjectKey("ΑΠ: Παραγγελία 261010-5983736 ακυρώθηκε")).toBe("παραγγελία 0-0 ακυρώθηκε");
    const pattern = mailSubjectKeyPattern(key);
    expect(pattern.length).toBeLessThanOrEqual(300);
    const subject = (text: string) => ({ from: "x@y.com", subject: text, labelIds: [], hasAttachment: false });
    expect(mailRuleMatches({ subjectPattern: pattern }, subject("[Olla] [Ticket - #34453669] - Έχετε ένα νέο ticket από τους διαχειριστές"))).toBe(true);
    expect(mailRuleMatches({ subjectPattern: pattern }, subject("RE: [Olla] [Ticket - #1] - έχετε ένα νέο ticket"))).toBe(true);
    expect(mailRuleMatches({ subjectPattern: pattern }, subject("[Olla] [Invoice - #1]"))).toBe(false);
    expect(mailSubjectKeyPattern("a ".repeat(400).trim()).length).toBeLessThanOrEqual(300);
    expect(mailThreadActionLabels({ action: "move", labelIds: ["Label_7"] })).toEqual({ addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] });
  });
});

describe("mail copilot rules and sync contracts", () => {
  it("defaults a proposal's confidence and evidence, requires a condition, and names the instance job", async () => {
    const { mailRuleProposalSchema, instanceBackgroundJobs } = await import("../src/index.js");
    expect(mailRuleProposalSchema.parse({ name: "Archive invoices", condition: { domain: "acme.com" }, action: { type: "ARCHIVE" } })).toMatchObject({ confidence: 0.7, evidence: [], condition: { domain: "acme.com" } });
    expect(() => mailRuleProposalSchema.parse({ name: "Empty", condition: {}, action: { type: "ARCHIVE" } })).toThrow(/at least one condition/);
    expect(instanceBackgroundJobs).toContain("mail-copilot-sync");
  });
});
