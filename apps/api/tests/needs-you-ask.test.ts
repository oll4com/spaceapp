import { describe, expect, it, vi } from "vitest";
import type { MailCopilotEvent, Pane } from "@space/contracts";
import { notifyMailCopilotEvent } from "../src/mail-copilot/notify.js";
import { jobApplyNeedsYouAsk } from "../src/job-apply/service.js";

// Needs you as questions (plan clipboard:5AQvaoSR-IZa): every Mail Copilot needs-you record asks one question and names where the answer goes.
describe("Mail Copilot's needs-you questions", () => {
  const pane = { id: "pane:mail0001", roomId: "room:main0001", title: "Mail", mode: "MAIL_COPILOT", mailCopilotMetadata: null } as unknown as Pane;
  const event = (type: string, payload: Record<string, unknown>, message = "Needs you"): MailCopilotEvent =>
    ({ id: `mailevt:${type}`, type, message, payload, accountEmail: "op@example.com", threadId: "t1", messageId: null, paneId: pane.id, runId: null, ownerUserId: "user:operator", createdAt: "2026-10-27T04:00:00.000Z" }) as unknown as MailCopilotEvent;
  const askOf = async (input: MailCopilotEvent) => {
    const raise = vi.fn(async (value: { payload: Record<string, unknown> }) => value as never);
    await notifyMailCopilotEvent(input, { roomId: pane.roomId, pane, owner: "user:operator", notifications: { raise, resolve: vi.fn(async () => 0) } });
    return raise.mock.calls[0]![0].payload.ask;
  };

  it("asks the copilot's question, its review and rule decisions, and what to do with a mail only the operator handles", async () => {
    expect(await askOf(event("QUESTION", { questionId: "mailq:1", options: ["Yes", "No"] }, "Reply to Anna today?")))
      .toEqual({ question: "Reply to Anna today?", options: ["Yes", "No"], answer: { kind: "COPILOT_QUESTION", copilot: "MAIL", questionId: "mailq:1" } });
    expect(await askOf(event("REVIEW_REQUESTED", { reviewId: "mailr:1" }, "Review the reply to Anna")))
      .toEqual({ question: "Review the reply to Anna", options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "REVIEW", itemId: "mailr:1" } });
    expect(await askOf(event("RULE_PROPOSED", { ruleId: "mailrule:1" }, "Archive GitHub digests")))
      .toMatchObject({ answer: { kind: "COPILOT_DECISION", copilot: "MAIL", item: "RULE", itemId: "mailrule:1" } });
    expect(await askOf(event("NEEDS_USER", {}, "The bank asks for a signed form")))
      .toEqual({ question: "What should Mail Copilot do with this mail?", options: ["I handled it", "Ignore it"], answer: { kind: "MAIL_FIX", account: "op@example.com", threadId: "t1" } });
  });

  it("asks Job Copilot's question with its options and its review as Approve or Decline; other events ask nothing", () => {
    expect(jobApplyNeedsYouAsk({ type: "QUESTION", message: "Needs you: Notice period?", payload: { questionId: "jobq:1", question: "Notice period?", options: ["1 month", "3 months"] } }))
      .toEqual({ ask: { question: "Notice period?", options: ["1 month", "3 months"], answer: { kind: "COPILOT_QUESTION", copilot: "JOB", questionId: "jobq:1" } } });
    expect(jobApplyNeedsYouAsk({ type: "REVIEW_REQUESTED", message: "Review the Acme application", payload: { reviewId: "jobr:1" } }).ask)
      .toMatchObject({ options: ["Approve", "Decline"], answer: { kind: "COPILOT_DECISION", copilot: "JOB", item: "REVIEW", itemId: "jobr:1" } });
    expect(jobApplyNeedsYouAsk({ type: "HANDOFF_REQUESTED", message: "x", payload: {} })).toEqual({});
  });
});
