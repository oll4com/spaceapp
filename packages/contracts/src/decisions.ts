import { z } from "zod";

export const tacticalTargetPreferenceSchema = z.enum(["nearest", "threat", "rocks", "enemies"]);
export type TacticalTargetPreference = z.infer<typeof tacticalTargetPreferenceSchema>;

export const tacticalCombatStyleSchema = z.enum(["interceptor", "blitz", "kiting", "defensive"]);
export type TacticalCombatStyle = z.infer<typeof tacticalCombatStyleSchema>;

export const tacticalMovementInputSchema = z.object({
  rocks: z.number().optional(),
  hostiles: z.union([z.string(), z.number()]).optional(),
  difficulty: z.number().optional(),
  sector: z.string().optional(),
  objective: z.string().optional(),
  ship: z.record(z.string(), z.unknown()).optional(),
  radar: z.array(z.unknown()).optional(),
  state: z.unknown().optional()
}).passthrough();

export type TacticalMovementInput = z.infer<typeof tacticalMovementInputSchema>;

export const tacticalMovementOutcomeSchema = z.object({
  available: z.boolean(),
  targetPreference: tacticalTargetPreferenceSchema,
  combatStyle: tacticalCombatStyleSchema,
  aggression: z.number(),
  mobility: z.number(),
  precision: z.number(),
  leadAiming: z.number(),
  tactic: z.string(),
  confidence: z.number().nullable(),
  latencyMs: z.number().optional(),
  source: z.enum(["model", "fallback"]),
  reason: z.string().optional(),
  degraded: z.boolean().optional()
}).strict();

export type TacticalMovementOutcome = z.infer<typeof tacticalMovementOutcomeSchema>;
