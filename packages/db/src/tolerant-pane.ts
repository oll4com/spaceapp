import { paneSchema, type Pane } from "@space/contracts";

/**
 * The resident Browser Host can be older than the API that writes pane rows: deploys preserve its process so
 * Chromes survive. A promote that adds a field to one of the strict pane metadata schemas, or a value to a pane
 * enum, used to make the host's `paneSchema.parse` throw BROWSER_HOST_INTERNAL_ERROR until a guarded restart.
 *
 * This parse drops the keys and enum values this host does not know and keeps validating everything it does know.
 * It is opt-in for the Browser Host's store only: the API keeps strict parsing of its own writes.
 */
type UnknownRecord = Record<string, unknown>;

type ZodDef = {
  type?: string;
  shape?: Record<string, unknown>;
  catchall?: unknown;
  element?: unknown;
  innerType?: unknown;
  entries?: Record<string, unknown>;
  defaultValue?: unknown;
  in?: unknown;
  options?: unknown[];
  valueType?: unknown;
  getter?: unknown;
};

interface RowSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: Error & { issues: Array<{ path: PropertyKey[] }> } };
  shape?: Record<string, RowSchema>;
}

/** What the Browser Host reads of a pane row: a value of these that does not parse is a real failure, never emptied. */
export const BROWSER_HOST_PANE_FIELDS = ["id", "roomId", "title", "mode", "isClosed", "freelanceCopilotMetadata"] as const;

/**
 * Fields whose values the host acts on (the freelance pane's egress route decides where its browser leaves from): they lose
 * unknown keys but never get a default for an enum value this host does not know, so a new route stops the pane instead of
 * sending it out through the wrong one. `mode` is not among them: a pane of a mode this host does not know reads as CHAT,
 * so listing a room's panes keeps working and the host never mistakes it for a browser pane.
 */
export const BROWSER_HOST_STRICT_ENUM_FIELDS = ["freelanceCopilotMetadata"] as const;

/** An enum value this host does not know, travelling up to the wrapper that can absorb it (default, optional, nullable). */
const UNKNOWN_ENUM_VALUE = Symbol("unknown enum value");

function defOf(schema: unknown): ZodDef | null {
  const def = (schema as { _zod?: { def?: unknown } } | null)?._zod?.def;
  return def && typeof def === "object" ? def as ZodDef : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function enumValues(def: ZodDef): unknown[] {
  return def.entries && typeof def.entries === "object" ? Object.values(def.entries) : [];
}

function defaultValue(def: ZodDef): unknown {
  return typeof def.defaultValue === "function" ? (def.defaultValue as () => unknown)() : def.defaultValue;
}

function parses(schema: unknown, value: unknown): boolean {
  return (schema as RowSchema).safeParse?.(value).success === true;
}

/** The first member of the enum a field is made of, for a required enum field with no default of its own. */
function firstEnumValue(schema: unknown): unknown {
  const def = defOf(schema);
  if (!def) return undefined;
  if (def.type === "enum") return enumValues(def)[0];
  if (def.type === "pipe") return firstEnumValue(def.in);
  if (def.type === "lazy" && typeof def.getter === "function") return firstEnumValue((def.getter as () => unknown)());
  return def.innerType ? firstEnumValue(def.innerType) : undefined;
}

/**
 * Keep the keys this host's schema knows; with `enums`, replace an enum value it does not know by the field's default, null
 * or nothing (without it the value stays as it is and the parse that follows rejects it).
 */
function sanitize(schema: unknown, value: unknown, enums: boolean): unknown {
  const def = defOf(schema);
  if (!def) return value;
  const next = (child: unknown, item: unknown) => sanitize(child, item, enums);
  switch (def.type) {
    case "enum": {
      return !enums || value === undefined || enumValues(def).includes(value) ? value : UNKNOWN_ENUM_VALUE;
    }
    case "default": {
      if (value === undefined) return value; // the schema applies its default
      const inner = next(def.innerType, value);
      return inner === UNKNOWN_ENUM_VALUE ? defaultValue(def) : inner;
    }
    case "optional": {
      const inner = next(def.innerType, value);
      return inner === UNKNOWN_ENUM_VALUE ? undefined : inner;
    }
    case "nullable": {
      if (value === null) return value;
      const inner = next(def.innerType, value);
      return inner === UNKNOWN_ENUM_VALUE ? null : inner;
    }
    case "nonoptional":
    case "readonly":
    case "catch":
    case "prefault":
      return next(def.innerType, value);
    case "pipe":
      return next(def.in, value);
    case "lazy":
      return typeof def.getter === "function" ? next((def.getter as () => unknown)(), value) : value;
    case "object": {
      if (!isRecord(value)) return value;
      const shape = def.shape && typeof def.shape === "object" ? def.shape : {};
      // A passthrough or catchall object keeps what it does not list; a strict or plain one drops it.
      const extrasKept = def.catchall !== undefined && defOf(def.catchall)?.type !== "never";
      const result: UnknownRecord = extrasKept ? { ...value } : {};
      for (const [key, child] of Object.entries(shape)) {
        if (!(key in value)) continue;
        const cleaned = next(child, value[key]);
        const kept = cleaned === UNKNOWN_ENUM_VALUE ? firstEnumValue(child) ?? value[key] : cleaned;
        if (kept !== undefined || value[key] === undefined) result[key] = kept;
      }
      return result;
    }
    case "array":
      return Array.isArray(value) ? value.map((item) => next(def.element, item)).filter((item) => item !== UNKNOWN_ENUM_VALUE) : value;
    case "record": {
      if (!isRecord(value)) return value;
      const result: UnknownRecord = {};
      for (const [key, item] of Object.entries(value)) {
        const cleaned = next(def.valueType, item);
        if (cleaned !== UNKNOWN_ENUM_VALUE) result[key] = cleaned;
      }
      return result;
    }
    case "union": {
      // Also a discriminated union: the option that accepts the cleaned value wins.
      let sawUnknownEnumValue = false;
      for (const option of def.options ?? []) {
        const candidate = next(option, value);
        if (candidate === UNKNOWN_ENUM_VALUE) { sawUnknownEnumValue = true; continue; }
        if (parses(option, candidate)) return candidate;
      }
      return sawUnknownEnumValue ? UNKNOWN_ENUM_VALUE : value;
    }
    default:
      return value;
  }
}

/**
 * Parse a pane row the way this host's own contracts understand it: unknown metadata keys are dropped and unknown enum
 * values fall back to the field's default. A field the host does not read whose value still does not parse (a changed
 * metadata shape) is emptied; BROWSER_HOST_PANE_FIELDS and every field that cannot be empty still throw.
 */
export function parsePaneRowTolerantly(value: unknown, schema: RowSchema = paneSchema as unknown as RowSchema): Pane {
  const cleaned = sanitize(schema, value, true);
  if (isRecord(cleaned) && isRecord(value) && schema.shape) {
    for (const key of BROWSER_HOST_STRICT_ENUM_FIELDS) {
      if (key in value && schema.shape[key]) cleaned[key] = sanitize(schema.shape[key], value[key], false);
    }
  }
  const first = schema.safeParse(cleaned);
  if (first.success) return first.data as Pane;
  if (isRecord(cleaned) && schema.shape) {
    const needed = new Set<string>(BROWSER_HOST_PANE_FIELDS);
    const repaired: UnknownRecord = { ...cleaned };
    let changed = false;
    for (const key of new Set(first.error.issues.map((issue) => issue.path[0]).filter((part): part is string => typeof part === "string"))) {
      const field = schema.shape[key];
      if (needed.has(key) || !field) continue;
      for (const fallback of [null, undefined]) {
        if (!parses(field, fallback)) continue;
        repaired[key] = fallback;
        changed = true;
        break;
      }
    }
    if (changed) {
      const second = schema.safeParse(repaired);
      if (second.success) return second.data as Pane;
    }
  }
  throw first.error;
}
