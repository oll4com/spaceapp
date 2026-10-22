import { z } from "zod";

// Vault password generator (plan clipboard:vEYtT6-bEN0J, operator request 2026-10-17 13:55 UTC). Pure and shared: the
// Browser Host fill path (phase 3) and the dock's Generate button (phase 5) both call it. CSPRNG only, uniform choice by
// rejection sampling (no modulo bias), every required class present, and the field's own constraints honoured.

export const VAULT_PASSWORD_LOWER = "abcdefghijklmnopqrstuvwxyz";
export const VAULT_PASSWORD_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const VAULT_PASSWORD_DIGITS = "0123456789";
/** Default symbols: no quotes, backslash or space, which forms and shells often mangle. */
export const VAULT_PASSWORD_SYMBOLS = "!#$%&*+-.:=?@^_~";
/** ASCII punctuation as passwordrules' `special` class defines it (space excluded: never generated). */
const SPECIAL = "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?]/\\";
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

export const vaultPasswordPolicySchema = z.object({
  length: z.number().int().min(MIN_LENGTH).max(MAX_LENGTH),
  lower: z.boolean(), upper: z.boolean(), digits: z.boolean(),
  /** The symbol alphabet; empty means no symbols. */
  symbols: z.string().max(64).regex(/^[\x21-\x7e]*$/),
  /** Every enabled class appears at least once. */
  requireEachClass: z.boolean(),
  /** Longest run of one repeated character; null means unlimited. */
  maxConsecutive: z.number().int().min(1).max(MAX_LENGTH).nullable()
}).strict().refine((policy) => policy.lower || policy.upper || policy.digits || policy.symbols.length > 0, "At least one character class is needed.");
export type VaultPasswordPolicy = z.infer<typeof vaultPasswordPolicySchema>;

export const VAULT_PASSWORD_DEFAULTS: VaultPasswordPolicy = {
  length: 24, lower: true, upper: true, digits: true, symbols: VAULT_PASSWORD_SYMBOLS, requireEachClass: true, maxConsecutive: null
};

export class VaultPasswordPolicyError extends Error {
  constructor(readonly code: "TOO_SHORT" | "NO_CLASSES" | "UNSATISFIABLE") { super(`Vault password policy: ${code}`); }
}

type Uint32Source = () => number;
const cryptoUint32: Uint32Source = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!;

/**
 * Uniform integer in [0, n): values at or above the largest multiple of n below 2^32 are drawn again, so every
 * residue has exactly the same number of accepted 32-bit values.
 */
export function vaultUniformIndex(n: number, next: Uint32Source = cryptoUint32): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError("n must be an integer in [1, 2^32].");
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const value = next();
    if (value < limit) return value % n;
  }
}

/** The field's own constraints (input attributes) the site enforces. */
export interface VaultPasswordFieldConstraints {
  minLength?: number | null;
  maxLength?: number | null;
  /** HTML `pattern` (anchored like the browser does). */
  pattern?: string | null;
  /** Apple `passwordrules` attribute. */
  passwordRules?: string | null;
}

const unique = (chars: string) => [...new Set(chars)].join("");
const classOf: Record<string, string> = { lower: VAULT_PASSWORD_LOWER, upper: VAULT_PASSWORD_UPPER, digit: VAULT_PASSWORD_DIGITS, special: SPECIAL };

/** Parses `passwordrules` (minlength, maxlength, required, allowed, max-consecutive); unknown rules are ignored. */
function parsePasswordRules(rules: string) {
  const parsed = { minLength: null as number | null, maxLength: null as number | null, maxConsecutive: null as number | null, required: [] as string[], allowed: [] as string[] };
  for (const rule of rules.split(";")) {
    const separator = rule.indexOf(":");
    if (separator < 0) continue;
    const name = rule.slice(0, separator).trim().toLowerCase();
    const value = rule.slice(separator + 1).trim();
    const number = Number.parseInt(value, 10);
    if (name === "minlength" && number > 0) parsed.minLength = Math.max(parsed.minLength ?? 0, number);
    else if (name === "maxlength" && number > 0) parsed.maxLength = Math.min(parsed.maxLength ?? Infinity, number);
    else if (name === "max-consecutive" && number > 0) parsed.maxConsecutive = Math.min(parsed.maxConsecutive ?? Infinity, number);
    else if (name === "required" || name === "allowed") {
      // A rule lists classes and [custom] characters separated by commas; one required rule means "at least one of these".
      let alphabet = "";
      for (const token of value.match(/\[[^\]]*\]|[^,\s]+/g) ?? []) {
        if (token.startsWith("[")) alphabet += token.slice(1, -1).replace(/[^\x21-\x7e]/g, "");
        else if (token === "ascii-printable" || token === "unicode") alphabet += VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS + SPECIAL;
        else alphabet += classOf[token.toLowerCase()] ?? "";
      }
      if (alphabet) parsed[name].push(unique(alphabet));
    }
  }
  return parsed;
}

export interface VaultFieldPasswordPolicy { length: number; alphabet: string; required: string[]; maxConsecutive: number | null }

/**
 * The policy for one field: the item's (or the default) policy narrowed by the field's maxlength/minlength and
 * passwordrules. Each `required` set must appear; the alphabet is the required sets plus our classes cut to what
 * `allowed` permits (so quotes or spaces appear only if the site requires them). The HTML pattern cannot be turned into
 * classes; generateVaultPassword checks every candidate against it.
 */
export function vaultPasswordPolicyForField(field: VaultPasswordFieldConstraints = {}, base: VaultPasswordPolicy = VAULT_PASSWORD_DEFAULTS): VaultFieldPasswordPolicy {
  const rules = field.passwordRules ? parsePasswordRules(field.passwordRules) : null;
  const max = Math.min(MAX_LENGTH, ...[field.maxLength, rules?.maxLength].filter((value): value is number => typeof value === "number" && value > 0));
  const min = Math.max(0, ...[field.minLength, rules?.minLength].filter((value): value is number => typeof value === "number" && value > 0));
  const length = Math.min(Math.max(base.length, min), max);
  if (length < MIN_LENGTH || length < min) throw new VaultPasswordPolicyError("TOO_SHORT");
  const classes = [base.lower && VAULT_PASSWORD_LOWER, base.upper && VAULT_PASSWORD_UPPER, base.digits && VAULT_PASSWORD_DIGITS, base.symbols]
    .filter((group): group is string => Boolean(group));
  let required = base.requireEachClass ? classes : [];
  let alphabet = unique(classes.join(""));
  if (rules && (rules.required.length > 0 || rules.allowed.length > 0)) {
    const permitted = unique(rules.required.join("") + rules.allowed.join(""));
    required = rules.required;
    alphabet = unique(rules.required.join("") + [...alphabet].filter((char) => permitted.includes(char)).join(""));
  }
  if (!alphabet) throw new VaultPasswordPolicyError("NO_CLASSES");
  const maxConsecutive = [base.maxConsecutive, rules?.maxConsecutive].filter((value): value is number => typeof value === "number")
    .reduce<number | null>((low, value) => low === null ? value : Math.min(low, value), null);
  return { length, alphabet, required, maxConsecutive };
}

/**
 * A password for one field. Characters are drawn uniformly from the alphabet; a candidate missing a required
 * set, breaking max-consecutive or failing the field's pattern is drawn again (rejection keeps the result uniform over
 * valid passwords). Fails closed with UNSATISFIABLE instead of weakening the policy.
 */
export function generateVaultPassword(field: VaultPasswordFieldConstraints = {}, base: VaultPasswordPolicy = VAULT_PASSWORD_DEFAULTS, next: Uint32Source = cryptoUint32): string {
  const policy = vaultPasswordPolicyForField(field, base);
  const alphabet = [...policy.alphabet];
  let pattern: RegExp | null = null;
  if (field.pattern) {
    try { pattern = new RegExp(`^(?:${field.pattern})$`, "v"); } catch { throw new VaultPasswordPolicyError("UNSATISFIABLE"); }
  }
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let candidate = "";
    for (let index = 0; index < policy.length; index += 1) candidate += alphabet[vaultUniformIndex(alphabet.length, next)];
    if (!policy.required.every((group) => [...candidate].some((char) => group.includes(char)))) continue;
    if (policy.maxConsecutive !== null && new RegExp(`(.)\\1{${policy.maxConsecutive}}`, "s").test(candidate)) continue;
    if (pattern && !pattern.test(candidate)) continue;
    return candidate;
  }
  throw new VaultPasswordPolicyError("UNSATISFIABLE");
}
