import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

describe("managed plan preparation", () => {
  it("preserves structured instructions and stage choices through PLAN creation", () => {
    const steps = [
      {
        id: "build",
        order: 1,
        title: "Build",
        modelId: "gpt-6-astra",
        reasoningEffort: "high",
        instructions: "Implement the feature",
        completionCriteria: ["Scoped tests pass"],
      },
    ];
    const saved = contracts.saveAgentClipboardPlanInputSchema.parse({
      text: "Build plan",
      minimumModel: "gpt-6.1-sol",
      steps,
    });
    expect(
      contracts.spaceAgentClipboardSavePlanActionSchema.parse({
        type: "save-plan",
        text: "Build plan",
        minimumModel: "gpt-6.1-sol",
        steps,
      }),
    ).toMatchObject({ steps: [{ modelId: "gpt-6-astra" }] });
    expect(saved).toMatchObject({
      steps: [
        {
          modelId: "gpt-6-astra",
          instructions: "Implement the feature",
          completionCriteria: ["Scoped tests pass"],
        },
      ],
    });
  });
  it("recognizes explicit stage assignments without executing ordinary headings", () => {
    const result = contracts.preparePlanStages({
      text: "# Overview\nNothing to execute\n### Stage 1: Contracts [gpt-6.1-sol / high]\nImplement contracts.\nChecks: Compatibility and persistence pass.\n### Stage 2: Controller [gpt-6-astra / high]\nImplement controller.\nCompletion criteria: Protocol tests pass.\n## Delivery\nDeliver.",
    });
    expect(result.issues).toEqual([]);
    expect(
      result.stages.map((s) => [s.order, s.modelId, s.reasoningEffort]),
    ).toEqual([
      [1, "gpt-6.1-sol", "high"],
      [2, "gpt-6-astra", "high"],
    ]);
    expect(result.stages[1].instructions).not.toContain("## Delivery");
    expect(result.stages[1].completionCriteria).toEqual([
      "Protocol tests pass.",
    ]);
  });
  it("reports missing and conflicting assignments before any execution", () => {
    expect(
      contracts.preparePlanStages({ text: "### Stage 1: Build\nBuild it." })
        .issues.length,
    ).toBeGreaterThan(0);
    expect(
      contracts.preparePlanStages({
        text: "### Stage 1: Build [gpt-6-astra / high] [gpt-6.1-sol / low]\nChecks: Pass.",
      }).issues.length,
    ).toBeGreaterThan(0);
    expect(
      contracts.preparePlanStages({
        text: "# Intro\n## Goals\nNo explicit stages.",
      }).stages,
    ).toEqual([]);
  });
  it("requires criterion evidence and rejects unknown completion fields", () => {
    expect(
      contracts.managedPlanStageResultSchema.safeParse({
        outcome: "COMPLETED",
        summary: "Done",
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      contracts.managedPlanStageResultSchema.safeParse({
        outcome: "COMPLETED",
        summary: "Done",
        evidence: [{ criterion: "Tests pass", result: "Passed 12/12" }],
      }).success,
    ).toBe(true);
  });
  it("ignores fenced stage examples and keeps code inside real stage instructions", () => {
    const example =
      "```markdown\n### Stage 1: Example [gpt-6.1-sol / high]\nChecks: Pass.\n```";
    expect(contracts.preparePlanStages({ text: example }).stages).toEqual([]);
    const result = contracts.preparePlanStages({
      text: "### Stage 1: Real [gpt-6.1-sol / high]\nImplement.\n```\n## Example heading\n### Stage 2: Fake [gpt-6-astra / low]\nChecks: Fake criterion\n```\nChecks: Real tests pass.",
    });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]?.completionCriteria).toEqual(["Real tests pass."]);
    expect(result.stages[0]?.instructions).toContain("## Example heading");
  });
});

it('distinguishes accepted configuration from obsolete defaults and provider telemetry',()=>{
 const at=new Date().toISOString();const attempt={id:'a',stageId:'s',commandId:'c',turnId:'t',modelId:'model-a',reasoningEffort:'high',status:'COMPLETED',startedAt:at,completedAt:at,result:null};
 const accepted={source:'NATIVE_ACCEPTED_TURN_CONFIGURATION',modelId:'model-a',reasoningEffort:'high',observedAt:at,completedAt:at,threadId:'thread',turnId:'t',commandId:'c',transport:'CONTINUOUS_NATIVE_NOTIFICATIONS',providerTelemetry:false};
 expect(contracts.managedPlanAttemptSchema.parse({...attempt,actualSelection:accepted}).actualSelection).toEqual(accepted);
 expect(contracts.managedPlanAttemptSchema.parse({...attempt,actualSelection:{modelId:'model-a',reasoningEffort:'high',observedAt:at,source:'NATIVE_CURRENT_TURN'}}).actualSelection).toBeNull();
 expect(contracts.managedPlanAttemptSchema.safeParse({...attempt,actualSelection:{...accepted,providerTelemetry:true}}).success).toBe(false);
 expect(contracts.managedPlanAttemptSchema.safeParse({...attempt,actualSelection:{...accepted,turnId:undefined}}).success).toBe(false);
});
