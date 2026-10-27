// The Vault fence also covers two places the composition root wires without the Vault module: a completed browser
// handoff (browser-control-activity.ts: what the operator typed stays out of agents' reads) and the CLI CDP proxy
// (cli-browser-cdp.ts: another pane on the same Chrome never sees a fenced tab). Both get the app's store object, so the
// Vault registers its hooks under that object; tests and other apps use their own stores and get no hooks.

export interface VaultFenceHooks {
  /** Fences the pane's current page after an operator handoff, like a Vault fill. */
  fenceHandoff(paneId: string): Promise<void>;
  /** The tabs (target ids) a pane's fence still covers. */
  fencedTargets(paneId: string): Promise<string[]>;
}

const hooks = new WeakMap<object, VaultFenceHooks>();

export function registerVaultFenceHooks(store: object, value: VaultFenceHooks): void {
  hooks.set(store, value);
}

/** Best effort: a handoff completes even when the fence cannot be set (no Browser Host, no web page). */
export async function fenceCompletedHandoff(store: object, paneId: string): Promise<void> {
  await hooks.get(store)?.fenceHandoff(paneId).catch(() => undefined);
}

export async function vaultFencedTargets(store: object, paneId: string): Promise<string[]> {
  return (await hooks.get(store)?.fencedTargets(paneId).catch((): string[] => [])) ?? [];
}
