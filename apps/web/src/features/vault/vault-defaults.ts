import { useState } from "react";
import { VAULT_PASSWORD_DEFAULTS, vaultPasswordPolicySchema, type VaultPasswordPolicy } from "@space/contracts";

// The Vault's advanced choices live in its Settings (operator request 2026-10-18), so adding an item stays simple:
// the password generator's rules. Kept per browser, like auto-lock.
export interface VaultDefaults { generator: VaultPasswordPolicy }
export const VAULT_DEFAULTS_KEY = "space:vault-defaults:v1";
export const VAULT_DEFAULTS: VaultDefaults = { generator: VAULT_PASSWORD_DEFAULTS };

export function readVaultDefaults(): VaultDefaults {
  try {
    const stored = JSON.parse(localStorage.getItem(VAULT_DEFAULTS_KEY) ?? "null") as Partial<VaultDefaults> | null;
    const generator = vaultPasswordPolicySchema.safeParse(stored?.generator);
    return { generator: generator.success ? generator.data : VAULT_DEFAULTS.generator };
  } catch {
    return VAULT_DEFAULTS;
  }
}

export function useVaultDefaults(): [VaultDefaults, (next: VaultDefaults) => void] {
  const [defaults, setDefaults] = useState(readVaultDefaults);
  return [defaults, (next) => { setDefaults(next); try { localStorage.setItem(VAULT_DEFAULTS_KEY, JSON.stringify(next)); } catch { /* private mode: this tab only */ } }];
}
