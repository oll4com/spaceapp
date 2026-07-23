import { z } from "zod";

export const publicWaitlistSourceSchema = z.literal("HOMEPAGE");

export const publicWaitlistRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  consent: z.literal(true),
  source: publicWaitlistSourceSchema.default("HOMEPAGE"),
  website: z.string().trim().max(200).optional()
}).strict();

export const publicWaitlistResponseSchema = z.object({
  status: z.literal("ACCEPTED")
}).strict();

export type PublicWaitlistSource = z.infer<typeof publicWaitlistSourceSchema>;
export type PublicWaitlistRequest = z.infer<typeof publicWaitlistRequestSchema>;
export type PublicWaitlistResponse = z.infer<typeof publicWaitlistResponseSchema>;
