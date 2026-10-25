import { expect, it } from "vitest";
import { DOT_PROACTIVE_DEFAULTS, dotFeedCursor, dotFeedOrigin, dotProactiveUsageSchema, dotUserSettingsFrom, parseDotFeedCursor, projectDotFeedRow,
  summarizeDotProactiveUsage, updateDotProfileSchema, updateDotUserSettingsSchema, type DotProactiveUsageEntry } from "../src/index.js";

const row = (input: Partial<Parameters<typeof projectDotFeedRow>[0]>) => ({ id: "agent_msg:one", role: "user", content: "Hello", status: "COMPLETED",
  createdAt: "2026-10-12T08:00:00.000Z", sessionId: "space_agent_session:one", roomId: "room:one", runId: "run:one", clientRequestId: null,
  conversationStart: false, ...input });

it("classifies turns Space started by their request key and hides evaluation runs", () => {
  expect(dotFeedOrigin(null)).toBe("USER");
  expect(dotFeedOrigin("4f1d2c90-1111-4222-8333-944445555666")).toBe("USER");
  expect(dotFeedOrigin("live-abc")).toBe("VOICE");
  expect(dotFeedOrigin("channel-abc")).toBe("CHANNEL");
  expect(dotFeedOrigin("approval-abc")).toBe("APPROVAL");
  expect(dotFeedOrigin("schedule-abc")).toBe("SCHEDULE");
  expect(dotFeedOrigin("proactive-abc")).toBe("SCHEDULE");
  expect(dotFeedOrigin("goal-abc")).toBe("GOAL");
  expect(dotFeedOrigin("delegation-abc")).toBe("DELEGATION");
  expect(projectDotFeedRow(row({ clientRequestId: "eval-run-case" }))).toBeNull();
});

it("shows approvals, reminders and Goal steps as one-line events instead of user messages", () => {
  const approval = projectDotFeedRow(row({ clientRequestId: "approval-1",
    content: "Approved: Create the event “SpaceApp test” on 2026-10-13T10:00:00+03:00\nResult: COMPLETED\nDetails: {\"eventId\":\"x\"}\nContinue the task." }))!;
  expect(approval).toMatchObject({ kind: "EVENT", author: "USER", origin: "APPROVAL", summary: "Approved: Create the event “SpaceApp test” on 2026-10-13T10:00:00+03:00" });
  expect(projectDotFeedRow(row({ clientRequestId: "schedule-1", content: "Scheduled task “Water the plants” (daily at 09:00):\nRemind me" }))?.summary)
    .toBe("Reminder: Water the plants");
  expect(projectDotFeedRow(row({ clientRequestId: "goal-1", content: "Goal step 3 of at most 20.\n\nObjective: Plan the launch\n\nMilestones:" }))?.summary)
    .toBe("Goal step 3: Plan the launch");
  expect(projectDotFeedRow(row({ clientRequestId: "live-1", content: "(Voice) What's next?" }))).toMatchObject({ kind: "MESSAGE", origin: "VOICE", content: "What's next?" });
});

it("keeps Dot answers without internal action blocks and drops empty placeholders and tool rows", () => {
  const answer = projectDotFeedRow(row({ role: "assistant", content: "Done.\n```space-memory-actions\n{\"secret\":1}\n```" }))!;
  expect(answer).toMatchObject({ kind: "MESSAGE", author: "DOT", content: "Done." });
  expect(projectDotFeedRow(row({ role: "assistant", content: "", status: "RUNNING" }))).toBeNull();
  expect(projectDotFeedRow(row({ role: "assistant", content: "", status: "FAILED" }))?.status).toBe("FAILED");
  expect(projectDotFeedRow(row({ role: "tool" }))).toBeNull();
  expect(projectDotFeedRow(row({ role: "user", content: "   " }))).toBeNull();
  // A photo sent without text is the user's request (Stage 5), so it stays in the feed with its file names.
  expect(projectDotFeedRow(row({ role: "user", content: "", attachments: [{ name: "receipt.png", mimeType: "image/png" }, { name: 42 }] })))
    .toMatchObject({ kind: "MESSAGE", author: "USER", content: "", attachments: [{ name: "receipt.png", mimeType: "image/png" }] });
  expect(projectDotFeedRow(row({ role: "user", content: "", clientRequestId: "approval-1", attachments: [{ name: "x.png", mimeType: "image/png" }] }))).toBeNull();
  expect(projectDotFeedRow(row({ notice: true, role: "assistant", content: "Security notice", link: { label: "Open email", url: "https://mail.google.com/x" } })))
    .toMatchObject({ kind: "NOTICE", author: "DOT", origin: "PROACTIVE", link: { url: "https://mail.google.com/x" } });
});

it("round-trips feed cursors and rejects anything else", () => {
  const cursor = dotFeedCursor({ createdAt: "2026-10-12T08:00:00Z", id: "agent_msg:a_b-1" });
  expect(parseDotFeedCursor(cursor)).toEqual({ createdAt: "2026-10-12T08:00:00.000Z", id: "agent_msg:a_b-1" });
  for (const bad of ["", "2026-10-12|x", "2026-10-12T08:00:00.000Z|'; DROP", `2026-10-12T08:00:00.000Z|${"x".repeat(201)}`]) {
    expect(() => parseDotFeedCursor(bad)).toThrow();
  }
});

it("fills user settings with defaults and accepts only known settings", () => {
  expect(dotUserSettingsFrom(null)).toEqual({ defaultDotId: null, defaultModelConfigId: null, defaultPermissionMode: null,
    confirmExternalActions: true, proactive: DOT_PROACTIVE_DEFAULTS, updatedAt: null });
  const stored = dotUserSettingsFrom({ defaultDotId: `dot:${"b".repeat(32)}`, updatedAt: "2026-10-12T08:00:00.000Z",
    settings: { confirmExternalActions: false, defaultPermissionMode: "ask_for_approval", proactive: { enabled: false, intervalMinutes: 5 } } });
  expect(stored.confirmExternalActions).toBe(false);
  expect(stored.defaultPermissionMode).toBeNull();
  expect(stored.proactive).toEqual({ ...DOT_PROACTIVE_DEFAULTS, enabled: false });
  expect(updateDotUserSettingsSchema.safeParse({}).success).toBe(false);
  expect(updateDotUserSettingsSchema.safeParse({ proactive: { intervalMinutes: 10 } }).success).toBe(false);
  expect(updateDotUserSettingsSchema.safeParse({ proactive: { quietHours: { start: "23:00", end: "08:00" } } }).success).toBe(true);
  expect(updateDotUserSettingsSchema.safeParse({ ownerUserId: "someone" }).success).toBe(false);
});

it("lets a Dot carry its model and permissions but never the unsupported approval mode", () => {
  expect(updateDotProfileSchema.safeParse({ preferences: { runtime: { modelConfigId: "codex|gpt|high", permissionMode: "approve_for_me" } } }).success).toBe(true);
  expect(updateDotProfileSchema.safeParse({ preferences: { runtime: { permissionMode: "ask_for_approval" } } }).success).toBe(false);
  expect(updateDotProfileSchema.safeParse({ preferences: { runtime: { sandbox: "danger-full-access" } } }).success).toBe(false);
});

it("totals proactive model calls: tokens only from measured calls, and cost only from priced ones", () => {
  const measured = (tokens: number) => ({ status: "MEASURED" as const, inputTokens: tokens, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 1,
    totalTokens: tokens + 5, source: "gateway", observedAt: "2026-10-13T08:00:00.000Z", model: "gpt-5.6-sol" });
  const unknownCost = (reason: string) => ({ status: "UNKNOWN" as const, amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason });
  const entries: DotProactiveUsageEntry[] = [
    { calledAt: "2026-10-13T08:00:00.000Z", dotId: null, model: "gpt-5.6-sol", status: "COMPLETED", candidates: 3, notices: 2, usage: measured(100),
      cost: { status: "ESTIMATED", reason: null, amountUsd: 0.0012, source: "tokens × p1", observedAt: "2026-10-13T08:00:00.000Z", priceCatalogVersion: "p1" } },
    { calledAt: "2026-10-13T09:00:00.000Z", dotId: null, model: "gpt-5.6-sol", status: "COMPLETED", candidates: 1, notices: 0, usage: measured(50),
      cost: unknownCost("Price catalog p1 has no price for gpt-5.6-sol.") },
    { calledAt: "2026-10-13T07:00:00.000Z", dotId: null, model: "other", status: "FAILED", candidates: 2, notices: 0,
      usage: { status: "UNKNOWN", reason: "failed" }, cost: unknownCost("No usage was reported, so no price applies.") }];
  const summary = summarizeDotProactiveUsage(entries, 7);
  expect(dotProactiveUsageSchema.parse(summary)).toEqual({ kind: "PROACTIVE", days: 7, calls: 3, failedCalls: 1, notices: 2, measuredCalls: 2,
    inputTokens: 150, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 160, estimatedCostUsd: 0.0012, estimatedCalls: 1,
    unknownCostCalls: 2, unknownCostReason: "Price catalog p1 has no price for gpt-5.6-sol.", priceCatalogVersions: ["p1"], models: ["gpt-5.6-sol", "other"],
    lastCallAt: "2026-10-13T09:00:00.000Z" });
  // No priced call means no amount, never $0.
  expect(summarizeDotProactiveUsage(entries.slice(1), 7)).toMatchObject({ estimatedCostUsd: null, estimatedCalls: 0, unknownCostCalls: 2 });
  expect(summarizeDotProactiveUsage([], 30)).toMatchObject({ calls: 0, lastCallAt: null, estimatedCostUsd: null });
});
