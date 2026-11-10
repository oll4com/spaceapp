import type { z } from "zod";

/**
 * Business rule shared by free-form records (MCP tool arguments, artifact and review metadata): at most 50 top-level
 * keys, at most 8000 JSON characters and JSON serializable (ARCH-002). Pass to `.superRefine(...)`.
 */
export function boundedJsonRecord(noun: string, supportVerb: "support" | "supports") {
  return (record: Record<string, unknown>, ctx: z.RefinementCtx) => {
    if (Object.keys(record).length > 50) {
      ctx.addIssue({ code: "custom", message: `${noun} ${supportVerb} at most 50 top-level keys.` });
    }
    try {
      if (JSON.stringify(record).length > 8000) {
        ctx.addIssue({ code: "custom", message: `${noun} must fit within 8000 JSON characters.` });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: `${noun} must be JSON serializable.` });
    }
  };
}

/**
 * Business rule shared by bounded JSON payloads (memory state metadata, Space Control requests, task acceptance checks):
 * the value's JSON text is at most `max` characters (ARCH-002). Pass to `.refine(...)`.
 */
export function jsonFitsWithin(max: number, message: string): [(value: unknown) => boolean, string] {
  return [(value) => JSON.stringify(value).length <= max, message];
}

/**
 * Business rule shared by keyed records (mail contact attributes, a post's metrics, a Jev decision's questions): the
 * record holds between `min` and `max` keys (ARCH-002). Pass to `.refine(...)`.
 */
export function keyCountWithin(min: number, max: number, message: string): [(record: object) => boolean, string] {
  return [(record) => { const count = Object.keys(record).length; return count >= min && count <= max; }, message];
}
