import type { CliAccountIdentitiesResponse, CliAccountIdentity } from "@space/contracts";
import { api } from "../../api.js";
import { CLI_ACCOUNT_PROFILES_EVENT } from "../../cli-account-profile-events.js";

// One sample of every CLI account profile's sign-in identity, shared by the pane account
// pickers and the CLI accounts settings. Linking by email reads from the same sample.
const identitiesTtlMs = 60_000;
let identities: { accounts: CliAccountIdentity[]; fetchedAt: number } | null = null;
let identitiesInFlight: Promise<CliAccountIdentity[]> | null = null;
const identityListeners = new Set<(accounts: CliAccountIdentity[]) => void>();
let profilesListenerInstalled = false;

function installProfilesListener(): void {
  if (profilesListenerInstalled || typeof window === "undefined") return;
  profilesListenerInstalled = true;
  // A created, renamed or removed profile makes the sample stale for everyone.
  window.addEventListener(CLI_ACCOUNT_PROFILES_EVENT, () => {
    if (identities) identities = { ...identities, fetchedAt: 0 };
  });
}

export function peekCliAccountIdentities(): CliAccountIdentity[] | null {
  return identities?.accounts ?? null;
}

export function subscribeCliAccountIdentities(listener: (accounts: CliAccountIdentity[]) => void): () => void {
  installProfilesListener();
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
}

// `force` skips the client TTL; `refresh` also asks the server to re-read native sign-ins.
export async function fetchCliAccountIdentities(options: {
  force?: boolean;
  refresh?: boolean;
  loader?: (refresh: boolean) => Promise<CliAccountIdentitiesResponse>;
} = {}): Promise<CliAccountIdentity[]> {
  installProfilesListener();
  if (!options.force && !options.refresh && identities && Date.now() - identities.fetchedAt < identitiesTtlMs) {
    return identities.accounts;
  }
  if (identitiesInFlight && !options.refresh) return identitiesInFlight;
  let request: Promise<CliAccountIdentity[]> | null = null;
  request = (async () => {
    try {
      const response = await (options.loader ?? api.cliAccountIdentities)(Boolean(options.refresh));
      identities = { accounts: response.accounts, fetchedAt: Date.now() };
      for (const listener of identityListeners) listener(response.accounts);
      return response.accounts;
    } catch {
      return identities?.accounts ?? [];
    } finally {
      if (identitiesInFlight === request) identitiesInFlight = null;
    }
  })();
  identitiesInFlight = request;
  return request;
}

export function normalizeAccountEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function resetCliAccountIdentitiesForTests(): void {
  identities = null;
  identitiesInFlight = null;
  identityListeners.clear();
}
