import { z } from "zod";

const rubricSchema = z.object({
  correctness: z.number().min(0).max(100),
  completeness: z.number().min(0).max(100),
  instructionAdherence: z.number().min(0).max(100),
  evidence: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  summary: z.string().trim().min(1).max(1000)
}).strict();

export type RoomTaskRubric = Omit<z.infer<typeof rubricSchema>, "summary">;
export type RoomTaskEvaluation =
  | { available: true; qualityScore: number; rubric: RoomTaskRubric; summary: string; attempts: number }
  | { available: false; reason: string; attempts: number };

export interface RoomTaskEvaluator {
  evaluate(input: { instruction: string; finalResult: string; completionEvidence: string }): Promise<RoomTaskEvaluation>;
}

export function createRoomTaskEvaluator(options: {
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  fetch?: typeof globalThis.fetch;
}): RoomTaskEvaluator {
  const request = options.fetch ?? globalThis.fetch;
  return {
    async evaluate(input) {
      if (!options.baseUrl || !options.apiKey) {
        return { available: false, reason: "Quality evaluator is not configured.", attempts: 0 };
      }
      const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
      let reason = "Quality evaluator returned invalid JSON twice.";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const response = await request(endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({
              model: options.model,
              messages: [{
                role: "user",
                content: [
                  "Evaluate the completed task. Return only JSON matching the supplied schema.",
                  "Rubric weights: correctness 30%, completeness 25%, instruction adherence 20%, evidence 15%, clarity 10%.",
                  `Instruction:\n${input.instruction}`,
                  `Final sanitized result:\n${input.finalResult}`,
                  `Completion evidence:\n${input.completionEvidence}`
                ].join("\n\n")
              }],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "room_task_quality",
                  strict: true,
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    required: ["correctness", "completeness", "instructionAdherence", "evidence", "clarity", "summary"],
                    properties: {
                      correctness: { type: "number", minimum: 0, maximum: 100 },
                      completeness: { type: "number", minimum: 0, maximum: 100 },
                      instructionAdherence: { type: "number", minimum: 0, maximum: 100 },
                      evidence: { type: "number", minimum: 0, maximum: 100 },
                      clarity: { type: "number", minimum: 0, maximum: 100 },
                      summary: { type: "string", minLength: 1, maxLength: 1000 }
                    }
                  }
                }
              }
            })
          });
          if (!response.ok) throw new Error(`Evaluator request failed with HTTP ${response.status}.`);
          const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("Evaluator response did not include text content.");
          const parsed = rubricSchema.parse(JSON.parse(content));
          const { summary, ...rubric } = parsed;
          const qualityScore = rubric.correctness * 0.3 + rubric.completeness * 0.25 +
            rubric.instructionAdherence * 0.2 + rubric.evidence * 0.15 + rubric.clarity * 0.1;
          return { available: true, qualityScore, rubric, summary, attempts: attempt };
        } catch (error) {
          reason = error instanceof Error ? error.message : "Quality evaluator failed.";
        }
      }
      return { available: false, reason, attempts: 2 };
    }
  };
}

export const unavailableRoomTaskEvaluator: RoomTaskEvaluator = {
  async evaluate() {
    return { available: false, reason: "Quality evaluator is not configured.", attempts: 0 };
  }
};
