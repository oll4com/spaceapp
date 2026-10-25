import { z } from "zod";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function boundedJson(value: unknown): value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 1024 || item.depth > 16) return false;
    if (item.value === null || typeof item.value === "boolean" || typeof item.value === "string") continue;
    if (typeof item.value === "number") { if (!Number.isFinite(item.value)) return false; continue; }
    if (typeof item.value !== "object" || seen.has(item.value)) return false;
    seen.add(item.value);
    if (!Array.isArray(item.value) && Object.getPrototypeOf(item.value) !== Object.prototype && Object.getPrototypeOf(item.value) !== null) return false;
    for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return JSON.stringify(value).length <= 4000;
}

const base = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), critical: z.boolean().default(true) };
export const taskAcceptanceCheckSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("TEXT_EQUALS"), expected: z.string().min(1).max(4000),
    normalization: z.enum(["NONE", "TRIM"]).default("NONE") }).strict(),
  z.object({ ...base, kind: z.literal("TEXT_INCLUDES"), expected: z.string().min(1).max(1000) }).strict(),
  z.object({ ...base, kind: z.literal("NUMBER_EQUALS"), expected: z.number().finite(),
    tolerance: z.number().finite().min(0).max(1).default(0) }).strict(),
  z.object({ ...base, kind: z.literal("JSON_EQUALS"),
    pointer: z.string().max(200).refine(value => value === "" ||
      value.startsWith("/") && value.split("/").slice(1).every(segment => !/~(?![01])/.test(segment)), "Invalid JSON pointer."),
    expected: z.custom<JsonValue>(boundedJson, "Expected JSON exceeds its size, depth or node bound.") }).strict()
]);

/** Operator-declared checks, never inferred from model output. No executable code. */
export const taskAcceptanceSchema = z.object({
  version: z.literal(1), checks: z.array(taskAcceptanceCheckSchema).min(1).max(16)
}).strict().refine(value => new Set(value.checks.map(check => check.id)).size === value.checks.length,
  "Acceptance check IDs must be unique.").refine(value => JSON.stringify(value).length <= 8000,
  "Acceptance checks exceed the 8000-character limit.");

export const taskValidationEvidenceSchema = z.object({
  scope: z.literal("DECLARED_CHECKS_ONLY"),
  resultSha256: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    kind: z.enum(["TEXT_EQUALS", "TEXT_INCLUDES", "NUMBER_EQUALS", "JSON_EQUALS"]),
    passed: z.boolean(), critical: z.boolean()
  }).strict()).min(1).max(16)
}).strict();

export type TaskAcceptance = z.infer<typeof taskAcceptanceSchema>;
export type TaskValidationEvidence = z.infer<typeof taskValidationEvidenceSchema>;

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) &&
    jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Evaluates the complete final text, not a substring extracted from a claim. */
export function validateTaskResult(acceptance: TaskAcceptance, result: string): TaskValidationEvidence["checks"] {
  const parsed = taskAcceptanceSchema.parse(acceptance);
  let json: unknown;
  try { json = JSON.parse(result); } catch { /* Malformed JSON fails JSON checks. */ }
  return parsed.checks.map(check => {
    let passed = false;
    switch (check.kind) {
      case "TEXT_EQUALS": passed = (check.normalization === "TRIM" ? result.trim() : result) === check.expected; break;
      case "TEXT_INCLUDES": passed = result.includes(check.expected); break;
      case "NUMBER_EQUALS": {
        const text = result.trim();
        const actual = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text) ? Number(text) : NaN;
        passed = Number.isFinite(actual) && Math.abs(actual - check.expected) <= check.tolerance;
        break;
      }
      case "JSON_EQUALS": {
        let actual = json;
        if (check.pointer) for (const segment of check.pointer.slice(1).split("/")) {
          const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
          // Own properties only, including for arrays. Never traverse prototypes.
          actual = actual !== null && typeof actual === "object" && Object.hasOwn(actual, key) &&
            (!Array.isArray(actual) || /^(?:0|[1-9]\d*)$/.test(key))
            ? (actual as Record<string, unknown>)[key] : undefined;
        }
        passed = jsonEqual(actual, check.expected);
        break;
      }
    }
    return { id: check.id, kind: check.kind, passed, critical: check.critical };
  });
}
