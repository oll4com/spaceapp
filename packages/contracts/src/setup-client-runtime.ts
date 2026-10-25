import { z } from "zod";

export const setupClientRuntimeFeatureSchema = z.enum(["utility:osk", "utility:asteroids", "pane:youtube"]);
export const setupClientRuntimeChallengeSchema = z.object({
  checkId: z.uuid(), featureId: setupClientRuntimeFeatureSchema,
  challenge: z.string().regex(/^SpaceApp-[a-f0-9]{32}$/)
}).strict();
export const setupClientRuntimeObservationSchema = z.discriminatedUnion("featureId", [
  z.object({ featureId: z.literal("utility:osk"), text: z.string().max(50), terminalData: z.string().max(50) }).strict(),
  z.object({ featureId: z.literal("utility:asteroids"), ticks: z.literal(30), elapsed: z.number().min(0.49).max(0.51),
    shotsFired: z.number().int().min(1).max(100), painted: z.literal(true) }).strict(),
  z.object({ featureId: z.literal("pane:youtube"), ready: z.literal(true), position: z.number().min(0).max(1),
    embedHost: z.enum(["www.youtube.com", "www.youtube-nocookie.com"]) }).strict()
]);
export type SetupClientRuntimeFeatureId = z.infer<typeof setupClientRuntimeFeatureSchema>;
export type SetupClientRuntimeChallenge = z.infer<typeof setupClientRuntimeChallengeSchema>;
export type SetupClientRuntimeObservation = z.infer<typeof setupClientRuntimeObservationSchema>;
