import { describe, expect, it } from "vitest";
import {
  clipboardItemSchema,
  createClipboardItemRequestSchema,
  listClipboardItemsQuerySchema,
  saveAgentClipboardItemInputSchema,
  saveAgentClipboardPlanInputSchema,
  setClipboardItemCompletedRequestSchema,
  spaceAgentClipboardActionEnvelopeSchema,
  planStepSchema,
  updatePlanProgressRequestSchema,
  upsertClipboardItemInputSchema
} from "../src/index.js";

describe("clipboard contracts", () => {
  it("accepts the complete clipboard item contract", () => {
    expect(
      clipboardItemSchema.parse({
        id: "clipboard:one",
        text: "  exact text  ",
        source: "COPY",
        roomId: "room:one",
        paneId: "pane:one",
        paneTitle: "Drafts and Sync",
        occurrenceCount: 2,
        characterCount: 14,
        createdAt: "2026-07-15T10:00:00.000Z",
        lastUsedAt: "2026-07-15T10:05:00.000Z"
      })
    ).toMatchObject({ text: "  exact text  ", source: "COPY", occurrenceCount: 2 });
    expect(clipboardItemSchema.parse({
      id: "clipboard:one",
      text: "exact text",
      source: "COPY",
      occurrenceCount: 1,
      characterCount: 10,
      createdAt: "2026-07-15T10:00:00.000Z",
      lastUsedAt: "2026-07-15T10:05:00.000Z"
    }).isCompleted).toBe(false);
  });

  it("allows operator capture, manual-note, and PLAN sources on the public create contract", () => {
    expect(createClipboardItemRequestSchema.parse({ text: "copied text", source: "COPY" })).toEqual({
      text: "copied text",
      source: "COPY"
    });
    expect(
      createClipboardItemRequestSchema.parse({ text: "full plan", source: "PLAN", title: "Plan title", minimumModel: "gpt-5.6-sol" })
    ).toEqual({ text: "full plan", source: "PLAN", title: "Plan title", minimumModel: "gpt-5.6-sol" });
    expect(createClipboardItemRequestSchema.parse({ text: "plan without title", source: "PLAN", minimumModel: "gpt-5.6-sol" }).title).toBeUndefined();
    expect(() => createClipboardItemRequestSchema.parse({ text: "plan without min model", source: "PLAN" })).toThrow();
    expect(() => createClipboardItemRequestSchema.parse({ text: "copy with min model", source: "COPY", minimumModel: "gpt-5.6-sol" })).toThrow();
    expect(() =>
      createClipboardItemRequestSchema.parse({ text: "no titles here", source: "COPY", title: "Blocked" })
    ).toThrow();
    expect(() => createClipboardItemRequestSchema.parse({ text: "forged", source: "AGENT_NOTE" })).toThrow();
    expect(() =>
      createClipboardItemRequestSchema.parse({
        text: "forged owner",
        source: "MANUAL_NOTE",
        ownerUserId: "user:other"
      })
    ).toThrow();
  });

  it("preserves exact text while rejecting blank and oversized captures", () => {
    const exact = "  keep surrounding whitespace  ";
    expect(createClipboardItemRequestSchema.parse({ text: exact, source: "PASTE" }).text).toBe(exact);
    expect(() => createClipboardItemRequestSchema.parse({ text: " \n\t ", source: "PASTE" })).toThrow();
    expect(
      createClipboardItemRequestSchema.parse({ text: "x".repeat(100_000), source: "PASTE" }).text
    ).toHaveLength(100_000);
    expect(() =>
      createClipboardItemRequestSchema.parse({ text: "x".repeat(100_001), source: "PASTE" })
    ).toThrow();
  });

  it("caps agent-created notes at 10,000 characters and fixes their source server-side", () => {
    expect(saveAgentClipboardItemInputSchema.parse({ text: "x".repeat(10_000) }).text).toHaveLength(10_000);
    expect(() => saveAgentClipboardItemInputSchema.parse({ text: "x".repeat(10_001) })).toThrow();
    expect(() => saveAgentClipboardItemInputSchema.parse({ text: "note", source: "COPY" })).toThrow();
  });

  it("allows full-size plans with a title and persists the title and minimumModel only for PLAN items", () => {
    const plan = saveAgentClipboardPlanInputSchema.parse({
      text: "x".repeat(100_000),
      title: "  Rollout plan  ",
      minimumModel: "  gpt-5.6-sol  "
    });
    expect(plan.text).toHaveLength(100_000);
    expect(plan.title).toBe("Rollout plan");
    expect(plan.minimumModel).toBe("gpt-5.6-sol");
    expect(() => saveAgentClipboardPlanInputSchema.parse({ text: "plan", title: "Plan" })).toThrow();
    expect(() => saveAgentClipboardPlanInputSchema.parse({ text: "x".repeat(100_001), minimumModel: "m" })).toThrow();
    expect(() => saveAgentClipboardPlanInputSchema.parse({ text: "plan", minimumModel: "m", title: "x".repeat(161) })).toThrow();

    expect(
      upsertClipboardItemInputSchema.parse({
        ownerUserId: "user:operator",
        text: "plan text",
        source: "PLAN",
        title: "Plan title",
        minimumModel: "gpt-5.6-sol"
      }).minimumModel
    ).toBe("gpt-5.6-sol");
    expect(() =>
      upsertClipboardItemInputSchema.parse({
        ownerUserId: "user:operator",
        text: "plan text",
        source: "PLAN",
        title: "Plan title"
      })
    ).toThrow();
    expect(
      clipboardItemSchema.parse({
        id: "clipboard:plan",
        text: "plan text",
        source: "PLAN",
        title: "Plan title",
        minimumModel: "gpt-5.6-sol",
        occurrenceCount: 1,
        characterCount: 9,
        createdAt: "2026-07-15T10:00:00.000Z",
        lastUsedAt: "2026-07-15T10:05:00.000Z"
      }).title
    ).toBe("Plan title");
    expect(() =>
      upsertClipboardItemInputSchema.parse({
        ownerUserId: "user:operator",
        text: "note text",
        source: "AGENT_NOTE",
        title: "Not allowed"
      })
    ).toThrow();
    expect(() =>
      upsertClipboardItemInputSchema.parse({
        ownerUserId: "user:operator",
        text: "note text",
        source: "AGENT_NOTE",
        minimumModel: "gpt-5.6-sol"
      })
    ).toThrow();
  });

  it("normalizes pagination, search, source filters, and completed-plan visibility", () => {
    expect(listClipboardItemsQuerySchema.parse({ q: "  fallback ", source: "AGENT_NOTE", page: "2", pageSize: "40" }))
      .toEqual({ q: "fallback", source: "AGENT_NOTE", page: 2, pageSize: 40 });
    expect(listClipboardItemsQuerySchema.parse({ q: "plan", source: "PLAN", page: 1, pageSize: 25 }).source).toBe("PLAN");
    expect(() => listClipboardItemsQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(listClipboardItemsQuerySchema.parse({ includeCompleted: "false", page: 1, pageSize: 25 }).includeCompleted)
      .toBe(false);
    expect(listClipboardItemsQuerySchema.parse({ includeCompleted: true, page: 1, pageSize: 25 }).includeCompleted)
      .toBe(true);
    expect(listClipboardItemsQuerySchema.parse({ page: 1, pageSize: 25 }).includeCompleted).toBeUndefined();
  });

  it("accepts strict completed-flag updates for clipboard items", () => {
    expect(setClipboardItemCompletedRequestSchema.parse({ completed: true })).toEqual({ completed: true });
    expect(() => setClipboardItemCompletedRequestSchema.parse({ completed: "yes" })).toThrow();
    expect(() => setClipboardItemCompletedRequestSchema.parse({})).toThrow();
    expect(() => setClipboardItemCompletedRequestSchema.parse({ completed: true, extra: 1 })).toThrow();
  });

  it("validates strict clipboard list, get, agent-save, and save-plan action/tool pairs", () => {
    expect(spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [
        { toolId: "clipboard:list", action: { type: "list", q: "fallback", pageSize: 5 } },
        { toolId: "clipboard:get", action: { type: "get", clipboardItemId: "clipboard:one" } },
        { toolId: "clipboard:save", action: { type: "save", text: "agent note" } }
      ]
    }).actions).toHaveLength(3);
    expect(spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:save-plan", action: { type: "save-plan", text: "full plan", title: "Plan", minimumModel: "gpt-5.6-sol" } }]
    }).actions).toHaveLength(1);
    expect(() => spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:list", action: { type: "get", clipboardItemId: "clipboard:one" } }]
    })).toThrow();
    expect(() => spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:save", action: { type: "save", text: "x".repeat(10_001) } }]
    })).toThrow();
    expect(spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:save-plan", action: { type: "save-plan", text: "plan without a title", minimumModel: "gpt-5.6-sol" } }]
    }).actions).toHaveLength(1);
    expect(() => spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:save-plan", action: { type: "save-plan", text: "plan without a model" } }]
    })).toThrow();
    expect(() => spaceAgentClipboardActionEnvelopeSchema.parse({
      version: 1,
      actions: [{ toolId: "clipboard:save", action: { type: "save-plan", text: "plan", minimumModel: "gpt-5.6-sol" } }]
    })).toThrow();
  });
});


describe("plan reasoning recommendations", () => {
  it("accepts a separate reasoning level for plans and rejects invalid or non-plan recommendations", () => {
    const plan = { text: "full plan", source: "PLAN", minimumModel: "gpt-6.1-sol", minimumReasoning: "high" };
    expect(createClipboardItemRequestSchema.parse(plan)).toMatchObject({ minimumReasoning: "high" });
    expect(saveAgentClipboardPlanInputSchema.parse({ text: "full plan", minimumModel: "gpt-6.1-sol", minimumReasoning: "medium" })).toMatchObject({ minimumReasoning: "medium" });
    expect(() => createClipboardItemRequestSchema.parse({ ...plan, minimumReasoning: "arbitrary" })).toThrow();
    expect(() => createClipboardItemRequestSchema.parse({ text: "note", source: "COPY", minimumReasoning: "high" })).toThrow();
  });

  it("numbers steps given without an order by position, on every step input (2026-10-24: six steps all arrived as Stage 1)", () => {
    const steps = [{ title: "Contracts" }, { title: "API" }, { title: "Web" }];
    const plan = { text: "A plan with three steps", minimumModel: "claude-fable-5-1" };
    const created = createClipboardItemRequestSchema.parse({ ...plan, source: "PLAN", steps });
    expect(created.steps!.map((step) => [step.id, step.order])).toEqual([["step-1", 1], ["step-2", 2], ["step-3", 3]]);
    expect(saveAgentClipboardPlanInputSchema.parse({ ...plan, steps }).steps!.map((step) => step.order)).toEqual([1, 2, 3]);
    expect(upsertClipboardItemInputSchema.parse({ ...plan, ownerUserId: "user:operator", source: "PLAN", steps }).steps!.map((step) => step.order)).toEqual([1, 2, 3]);
    expect(updatePlanProgressRequestSchema.parse({ steps }).steps!.map((step) => step.order)).toEqual([1, 2, 3]);
    // Explicit unique orders stay as given; an explicit id survives the renumbering of duplicates.
    const explicit = createClipboardItemRequestSchema.parse({ ...plan, source: "PLAN", steps: [{ title: "b", order: 2 }, { title: "a", order: 1 }] });
    expect(explicit.steps!.map((step) => [step.id, step.order])).toEqual([["step-2", 2], ["step-1", 1]]);
    const named = updatePlanProgressRequestSchema.parse({ steps: [{ id: "deploy", title: "Deploy" }, { title: "Verify" }] });
    expect(named.steps!.map((step) => [step.id, step.order])).toEqual([["deploy", 1], ["step-2", 2]]);
  });

  it("coerces PLANNED status to PENDING and supplies default id and order", () => {
    const rawStep = { title: "Contracts & DB Schema", status: "PLANNED" };
    const parsed = planStepSchema.parse(rawStep);
    expect(parsed.status).toBe("PENDING");
    expect(parsed.id).toBe("step-1");
    expect(parsed.order).toBe(1);
    expect(parsed.title).toBe("Contracts & DB Schema");
  });

  it("strips unknown properties and preserves custom order and id", () => {
    const rawStep = {
      id: "custom-step-id",
      order: 4,
      title: "Settings UI Component",
      status: "COMPLETED",
      extraMetadata: "ignored"
    };
    const parsed = planStepSchema.parse(rawStep);
    expect(parsed.id).toBe("custom-step-id");
    expect(parsed.order).toBe(4);
    expect(parsed.status).toBe("COMPLETED");
    expect((parsed as Record<string, unknown>).extraMetadata).toBeUndefined();
  });
});
