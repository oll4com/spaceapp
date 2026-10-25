import { useCallback, useEffect, useState } from "react";
import type { CliAccountBalance } from "@space/contracts";
import { api } from "../../api.js";
import { CLI_ACCOUNT_PROFILES_EVENT } from "../../cli-account-profile-events.js";

// One sample per balanced CLI (Copilot, Cursor, Kimi Code) of each account's remaining quota and the account Auto
// would start on, shared by every pane picker of that CLI. The server caches wrapper readings for five minutes.
const balanceTtlMs = 60_000;
const balances = new Map<string, { value: CliAccountBalance; fetchedAt: number }>();
const inFlight = new Map<string, Promise<CliAccountBalance | null>>();
const listeners = new Set<(runtimeId: string, value: CliAccountBalance) => void>();
let profilesListenerInstalled = false;

function installProfilesListener(): void {
  if (profilesListenerInstalled || typeof window === "undefined") return;
  profilesListenerInstalled = true;
  window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, () => {
    for (const [runtimeId, entry] of balances) balances.set(runtimeId, { ...entry, fetchedAt: 0 });
  });
}

export function peekCliAccountBalance(runtimeId: string): CliAccountBalance | null {
  return balances.get(runtimeId)?.value ?? null;
}

export async function fetchCliAccountBalance(runtimeId: string, loader: (runtimeId: string) => Promise<CliAccountBalance> = api.cliAccountBalance): Promise<CliAccountBalance | null> {
  installProfilesListener();
  const cached = balances.get(runtimeId);
  if (cached && Date.now() - cached.fetchedAt < balanceTtlMs) return cached.value;
  const pending = inFlight.get(runtimeId);
  if (pending) return pending;
  const request = (async () => {
    try {
      const value = await loader(runtimeId);
      if (!value || !Array.isArray(value.profiles)) return cached?.value ?? null;
      balances.set(runtimeId, { value, fetchedAt: Date.now() });
      for (const listener of listeners) listener(runtimeId, value);
      return value;
    } catch {
      return cached?.value ?? null;
    } finally {
      inFlight.delete(runtimeId);
    }
  })();
  inFlight.set(runtimeId, request);
  return request;
}

/** The shared balance of `runtimeId` (null for CLIs Space does not balance) and a loader to call on hover or open. */
export function useCliAccountBalance(runtimeId: string | null): { balance: CliAccountBalance | null; load: () => void } {
  const [balance, setBalance] = useState<CliAccountBalance | null>(() => (runtimeId ? peekCliAccountBalance(runtimeId) : null));

  useEffect(() => {
    setBalance(runtimeId ? peekCliAccountBalance(runtimeId) : null);
    if (!runtimeId) return undefined;
    const listener = (changed: string, value: CliAccountBalance) => {
      if (changed === runtimeId) setBalance(value);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [runtimeId]);

  const load = useCallback(() => {
    if (runtimeId) void fetchCliAccountBalance(runtimeId);
  }, [runtimeId]);

  return { balance, load };
}

export function resetCliAccountBalanceForTests(): void {
  balances.clear();
  inFlight.clear();
  listeners.clear();
}
