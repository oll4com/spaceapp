import { Github, Gitlab } from "../ui-theme/app-icons.js";
import { repositoryProviderRegistry, type RepositoryProviderId, type RepositoryProviderState } from "@space/contracts";

const monograms: Partial<Record<RepositoryProviderId, string>> = { gitea: "Gt", forgejo: "Fj", bitbucket: "Bb", "azure-devops": "Az" };

export function providerLabel(id: RepositoryProviderId): string {
  return repositoryProviderRegistry.find(provider => provider.id === id)?.label ?? id;
}

export function ProviderIcon({ provider, size = 16 }: { provider: RepositoryProviderId; size?: number }) {
  if (provider === "github") return <Github size={size} aria-hidden="true" />;
  if (provider === "gitlab") return <Gitlab size={size} aria-hidden="true" />;
  return <span className={`repository-provider-monogram is-${provider}`} style={{ width: size + 2, height: size + 2, fontSize: Math.max(8, size * 0.55) }} aria-hidden="true">{monograms[provider]}</span>;
}

export type ProviderAvailability = "connected" | "setup" | "error" | "disabled";
/** Enabled and connected are independent: disabled hides a provider, enabled without an account needs setup. */
export function providerAvailability(state: RepositoryProviderState): ProviderAvailability {
  if (!state.enabled || !state.available) return "disabled";
  if (state.connection.status === "CONNECTED") return "connected";
  if (state.connection.status === "ERROR") return "error";
  return "setup";
}
export const availabilityLabel: Record<ProviderAvailability, string> = { connected: "Connected", setup: "Setup required", error: "Reconnect required", disabled: "Disabled" };

/** Enabled providers in alphabetical order, as shown by every repository picker. */
export function enabledProviders(states: RepositoryProviderState[]): RepositoryProviderState[] {
  return states.filter(state => state.enabled && state.available).sort((a, b) => a.label.localeCompare(b.label));
}
