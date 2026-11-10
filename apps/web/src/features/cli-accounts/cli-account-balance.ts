import { useCallback, useEffect, useState } from "react";
import type { CliAccountBalance } from "@space/contracts";
import { api } from "../../api.js";
import { CLI_ACCOUNT_PROFILES_EVENT } from "../../cli-account-profile-events.js";
import { CLI_RUNTIME_VISIBILITY_EVENT } from "../../cli-runtime-visibility-events.js";

// One sample per balanced CLI (Copilot, Cursor, Kimi Code) of each account's remaining quota and the account Auto
// would start on, shared by every pane picker of that CLI. The server caches wrapper readings for five minutes.
const balanceTtlMs = 60_000;
const balances = new Map<string, { value: CliAccountBalance; fetchedAt: number }>();
const inFlight = new Map<string, Promise<CliAccountBalance | null>>();
// API audit 4/11: a failed read (503 for a CLI that is switched off: 282 a day on stable, every one failed) waits out the same minute
// instead of being asked again on every hover of the account button.
const failedAt = new Map<string, number>();
// API audit 6/11: a client that never lists the runtimes has no snapshot (705 failed reads from two clients), so the server's own
// CLI_RUNTIME_DISABLED answer stops the asks until a CLI is switched on or off (Settings, or the server's event in every client).
const switchedOff = new Set<string>();
const listeners = new Set<(runtimeId: string, value: CliAccountBalance) => void>();
let listenersInstalled = false;

function installListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, () => {
    switchedOff.clear();
    failedAt.clear();
  });
  window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, () => {
    for (const [runtimeId, entry] of balances) balances.set(runtimeId, { ...entry, fetchedAt: 0 });
    failedAt.clear();
  });
}

export function peekCliAccountBalance(runtimeId: string): CliAccountBalance | null {
  return balances.get(runtimeId)?.value ?? null;
}

export async function fetchCliAccountBalance(runtimeId: string, loader: (runtimeId: string) => Promise<CliAccountBalance> = api.cliAccountBalance): Promise<CliAccountBalance | null> {
  installListeners();
  const cached = balances.get(runtimeId);
  if (switchedOff.has(runtimeId)) return cached?.value ?? null;
  // API audit 5/11: a CLI switched off is absent from the runtimes Space lists and is never asked (985 failed reads a day on stable).
  if (api.cliRuntimesSnapshot()?.data.some((runtime) => runtime.id === runtimeId) === false) return cached?.value ?? null;
  if (cached && Date.now() - cached.fetchedAt < balanceTtlMs) return cached.value;
  if (Date.now() - (failedAt.get(runtimeId) ?? -Infinity) < balanceTtlMs) return cached?.value ?? null;
  const pending = inFlight.get(runtimeId);
  if (pending) return pending;
  const request = (async () => {
    try {
      const value = await loader(runtimeId);
      if (!value || !Array.isArray(value.profiles)) return cached?.value ?? null;
      balances.set(runtimeId, { value, fetchedAt: Date.now() });
      failedAt.delete(runtimeId);
      for (const listener of listeners) listener(runtimeId, value);
      return value;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "CLI_RUNTIME_DISABLED") switchedOff.add(runtimeId);
      else failedAt.set(runtimeId, Date.now());
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
  failedAt.clear();
  switchedOff.clear();
  listeners.clear();
}
