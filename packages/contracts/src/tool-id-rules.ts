import type { z } from "zod";

/**
 * Business rule shared by the agent action request schemas: the request's toolId must be the tool of its action type
 * (ARCH-002). A type with no tool (null) belongs to the operator's live view. Pass to `.superRefine(...)`.
 */
export function toolIdMatchesAction<Type extends string>(noun: string, expectedToolId: (type: Type) => string | null) {
  return (input: { toolId: string; action: { type: Type } }, context: z.RefinementCtx) => {
    const expected = expectedToolId(input.action.type);
    if (input.toolId === expected) return;
    context.addIssue({
      code: "custom",
      path: ["toolId"],
      message: expected
        ? `toolId ${input.toolId} does not match ${noun} action type ${input.action.type}.`
        : `${noun[0]!.toUpperCase()}${noun.slice(1)} action type ${input.action.type} belongs to the operator's live view.`
    });
  };
}
