/** Shared request parsing helpers for the API route domains (moved verbatim from the composition root). */
import { z, type ZodTypeAny } from "zod";
import { idSchema } from "@space/contracts";

export const idParamSchema = z.object({ id: idSchema });

export function parseBody<TSchema extends ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  return schema.parse(body);
}

export function parseQuery<TSchema extends ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema> {
  return schema.parse(query);
}
