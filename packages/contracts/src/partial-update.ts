import { z } from "zod";

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;

/**
 * The PATCH schema of a settings group: every field optional and none defaulted, so a PATCH keeps only what it names.
 * Zod 4 fills defaults inside .partial(): a PATCH that named one field reset the others (stable 2026-10-17).
 */
export function patchSchema<Shape extends z.ZodRawShape, Config extends z.core.$ZodObjectConfig>(schema: z.ZodObject<Shape, Config>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field]));
  return schema.extend(shape as { [Key in keyof Shape]: WithoutDefault<Shape[Key]> }).partial();
}

/**
 * The PATCH of one settings group (an object field with its own defaults): its fields optional and none defaulted, merged onto the
 * saved group by the caller, whose parse of the merged value runs the group's refinements (zod 4 cannot extend a refined object).
 */
export function groupPatchSchema<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field]));
  return z.object(shape as { [Key in keyof Shape]: WithoutDefault<Shape[Key]> }).strict().partial();
}
