import { z } from "zod";

const zero = z.literal(0);
// The installer's free model benchmark: a model is anonymousAvailable only after real tool calls (operator rule
// 2026-10-11); the OpenCode 1 text benchmark "setup-actions:v1" is refused.
export const setupFreeModelCatalogSchema = z.object({
  schema: z.literal(1), benchmarkVersion: z.literal("tool-call:v1"), checkedAt: z.string().datetime(),
  models: z.array(z.object({
    id: z.string().regex(/^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/),
    anonymousAvailable: z.boolean(), setupPassed: z.number().int().min(0).max(2),
    attempts: z.number().int().min(1).max(1002), successes: z.number().int().min(0).max(1002),
    latencyMs: z.number().min(0).max(60_000), context: z.number().positive().nullable(),
    toolcall: z.boolean(), text: z.boolean(),
    // Strict: another price dimension is refused, not stripped (review 2026-10-21 #2).
    cost: z.object({ input: zero, output: zero, cache: z.object({ read: zero, write: zero }).strict() }).strict()
  }).refine((item) => item.successes <= item.attempts && (!item.anonymousAvailable ||
    item.setupPassed === 2 && item.toolcall && item.text))).max(100)
});
export type SetupFreeModelCatalog = z.infer<typeof setupFreeModelCatalogSchema>;
