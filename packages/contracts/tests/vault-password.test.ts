import { describe, expect, it } from "vitest";
import {
  VAULT_PASSWORD_DEFAULTS, VAULT_PASSWORD_DIGITS, VAULT_PASSWORD_LOWER, VAULT_PASSWORD_SYMBOLS, VAULT_PASSWORD_UPPER, VAULT_PATTERN_MAX_LENGTH, VaultPasswordPolicyError,
  generateVaultPassword, vaultGeneratePolicySchema, vaultItemMetadataSchema, vaultPasswordPolicyForField, vaultPasswordPolicySchema, vaultPatternIsSafe, vaultPolicyConstraints, vaultUniformIndex
} from "../src/index.js";

const has = (value: string, set: string) => [...value].some((char) => set.includes(char));
const only = (value: string, set: string) => [...value].every((char) => set.includes(char));

describe("a site's stated rules (queue item 37)", () => {
  it("merge with the field: the stricter length wins, NONE drops symbols, an 8-char floor and a policy nothing satisfies fail closed", () => {
    const merged = vaultPolicyConstraints({ minLength: null, maxLength: 64 }, { minLength: 8, maxLength: 18, symbols: "NONE" });
    expect(merged.field).toMatchObject({ minLength: 8, maxLength: 18 });
    expect(generateVaultPassword(merged.field, merged.base)).toMatch(/^[A-Za-z0-9]{18}$/);
    // The page's own smaller maximum still wins over the declared one.
    expect(vaultPolicyConstraints({ maxLength: 12 }, { maxLength: 18 }).field.maxLength).toBe(12);
    const own = vaultPolicyConstraints({}, { symbols: "!!_" });
    expect(own.base.symbols).toBe("!_");
    expect(generateVaultPassword(own.field, own.base)).toMatch(/[!_]/);
    expect(vaultPolicyConstraints({}, undefined).base).toEqual(VAULT_PASSWORD_DEFAULTS);
    expect(() => { const tight = vaultPolicyConstraints({ maxLength: 6 }, { minLength: 8 }); generateVaultPassword(tight.field, tight.base); }).toThrow(VaultPasswordPolicyError);
    expect(vaultGeneratePolicySchema.safeParse({ minLength: 7 }).success).toBe(false);
    expect(vaultGeneratePolicySchema.safeParse({ minLength: 20, maxLength: 10 }).success).toBe(false);
    expect(vaultGeneratePolicySchema.safeParse({ symbols: "a b" }).success).toBe(false);
    expect(vaultGeneratePolicySchema.safeParse({ symbols: "NONE", extra: 1 }).success).toBe(false);
  });
});

describe("Vault password generator: policy", () => {
  it("defaults to 24 characters with every class", () => {
    const password = generateVaultPassword();
    expect(password).toHaveLength(24);
    for (const set of [VAULT_PASSWORD_LOWER, VAULT_PASSWORD_UPPER, VAULT_PASSWORD_DIGITS, VAULT_PASSWORD_SYMBOLS]) expect(has(password, set)).toBe(true);
    expect(only(password, VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS + VAULT_PASSWORD_SYMBOLS)).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => generateVaultPassword())).size).toBe(50);
  });

  it("follows the item policy", () => {
    const policy = { ...VAULT_PASSWORD_DEFAULTS, length: 40, symbols: "", upper: false };
    expect(vaultPasswordPolicySchema.safeParse(policy).success).toBe(true);
    const password = generateVaultPassword({}, policy);
    expect(password).toHaveLength(40);
    expect(only(password, VAULT_PASSWORD_LOWER + VAULT_PASSWORD_DIGITS)).toBe(true);
    expect(vaultPasswordPolicySchema.safeParse({ ...policy, length: 6 }).success).toBe(false);
    expect(vaultPasswordPolicySchema.safeParse({ ...policy, lower: false, digits: false }).success).toBe(false);
    const item = { id: "vault_item:AAAAAAAAAAAAAAAAAAAAAA", label: "Synthetic", origins: ["https://example.com"], fieldRoles: ["PASSWORD"],
      policy: { agentUse: false, approvalMode: "ASSIST", submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [], passwordPolicy: policy } };
    expect(vaultItemMetadataSchema.safeParse(item).success).toBe(true);
  });

  it("honours the field's maxlength and minlength and refuses a weak field", () => {
    expect(generateVaultPassword({ maxLength: 16 })).toHaveLength(16);
    expect(generateVaultPassword({ minLength: 32 })).toHaveLength(32);
    expect(() => generateVaultPassword({ maxLength: 6 })).toThrow(VaultPasswordPolicyError);
    expect(() => generateVaultPassword({ minLength: 30, maxLength: 20 })).toThrow("TOO_SHORT");
  });

  it("follows passwordrules: required sets, allowed characters, lengths and max-consecutive", () => {
    const rules = "minlength: 20; maxlength: 22; required: lower; required: upper; required: digit; required: [-().&@?'#,/\"+]; max-consecutive: 2";
    const policy = vaultPasswordPolicyForField({ passwordRules: rules });
    expect(policy.length).toBe(22);
    expect(policy.maxConsecutive).toBe(2);
    for (let run = 0; run < 50; run += 1) {
      const password = generateVaultPassword({ passwordRules: rules });
      expect(password.length).toBe(22);
      expect(has(password, "-().&@?'#,/\"+")).toBe(true);
      expect(/(.)\1\1/.test(password)).toBe(false);
    }
    // Only letters and digits allowed: no symbol appears.
    const plain = generateVaultPassword({ passwordRules: "required: upper; required: digit; allowed: lower" });
    expect(only(plain, VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS)).toBe(true);
    expect(has(plain, VAULT_PASSWORD_UPPER) && has(plain, VAULT_PASSWORD_DIGITS)).toBe(true);
    // `allowed: ascii-printable` permits quotes but does not bring them into a generated password.
    expect(only(generateVaultPassword({ passwordRules: "allowed: ascii-printable" }), VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS + VAULT_PASSWORD_SYMBOLS)).toBe(true);
  });

  it("checks the HTML pattern and fails closed when it cannot be met", () => {
    const password = generateVaultPassword({ pattern: "[A-Za-z0-9]{8,}" }, { ...VAULT_PASSWORD_DEFAULTS, symbols: "" });
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(() => generateVaultPassword({ pattern: "\\d{4}" })).toThrow("UNSATISFIABLE");
    expect(() => generateVaultPassword({ pattern: "(" })).toThrow("UNSATISFIABLE");
  });

  it("ignores a pattern that could stall the Browser Host: nested or alternating quantified groups, or one that is too long (Vault review 2026-10-22)", () => {
    // Real-world password patterns pass; the classic exponential shapes do not, however they are dressed.
    for (const safe of ["(?=.*[A-Z])(?=.*\\d).{8,}", "[A-Za-z0-9!@#$%^&*]{12,64}", "(abc|def)\\d+", "\\((a+)\\)", "[(+*]+x"]) expect(vaultPatternIsSafe(safe), safe).toBe(true);
    for (const risky of ["(a+)+", "^(a|aa)*$", "(?:x*)*y", "((ab)*)*", "(.*a){20}", "a{1,".padEnd(VAULT_PATTERN_MAX_LENGTH + 1, "9"), "(", "[a-z"]) expect(vaultPatternIsSafe(risky), risky).toBe(false);
    // A page that sets minlength=128 and a catastrophic pattern gets a password that follows the other rules, within a bounded time.
    const started = Date.now();
    const password = generateVaultPassword({ pattern: "^(a|aa)*$", minLength: 128 });
    expect(password).toHaveLength(128);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("Vault password generator: no modulo bias", () => {
  it("redraws exactly the 32-bit values above the largest multiple of n", () => {
    for (const n of [10, 26, 62, 77, 94]) {
      const limit = 2 ** 32 - (2 ** 32 % n);
      expect(limit % n).toBe(0);
      // The last accepted value maps normally; every value from the limit up is drawn again.
      const draws = [limit, 2 ** 32 - 1, limit - 1];
      expect(vaultUniformIndex(n, () => draws.shift()!)).toBe((limit - 1) % n);
      expect(draws).toEqual([]);
    }
    expect(vaultUniformIndex(1, () => 123)).toBe(0);
    expect(() => vaultUniformIndex(0)).toThrow(RangeError);
  });

  it("gives every index the same share over a full residue window", () => {
    // Feeding every value of [limit - 77 * 1000, limit) gives each residue exactly 1000 hits.
    const n = 77;
    const limit = 2 ** 32 - (2 ** 32 % n);
    let value = limit - n * 1000;
    const counts = new Array<number>(n).fill(0);
    for (let draw = 0; draw < n * 1000; draw += 1) counts[vaultUniformIndex(n, () => value++)]! += 1;
    expect(new Set(counts)).toEqual(new Set([1000]));
  });

  it("draws every character of a generated password uniformly (no modulo bias end to end)", () => {
    // One class and no "each class" rejection: every position is a plain uniform draw over the 62-character alphabet.
    const alphabet = VAULT_PASSWORD_LOWER + VAULT_PASSWORD_UPPER + VAULT_PASSWORD_DIGITS;
    const policy = { ...VAULT_PASSWORD_DEFAULTS, length: 128, symbols: "", requireEachClass: false };
    const counts = new Map<string, number>([...alphabet].map((char) => [char, 0]));
    const passwords = 1_000;
    for (let run = 0; run < passwords; run += 1) for (const char of generateVaultPassword({}, policy)) counts.set(char, counts.get(char)! + 1);
    const expected = (passwords * 128) / alphabet.length;
    const chiSquare = [...counts.values()].reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(counts.size).toBe(62);
    expect(chiSquare).toBeLessThan(125);
  });

  it("is statistically uniform on the real CSPRNG (chi-square)", () => {
    const n = 62;
    const samples = 124_000;
    const counts = new Array<number>(n).fill(0);
    for (let draw = 0; draw < samples; draw += 1) counts[vaultUniformIndex(n)]! += 1;
    const expected = samples / n;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // 61 degrees of freedom: p < 1e-6 lies above ~125, so a fair source essentially never fails this.
    expect(chiSquare).toBeLessThan(125);
  });
});
