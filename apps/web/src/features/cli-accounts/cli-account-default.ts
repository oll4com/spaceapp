import type { ListCliAccountProfilesResponse } from "@space/contracts";

// A pane created within this window without a CLI session is new: it starts its CLI on its own.
export const NEW_PANE_WINDOW_MS = 60_000;

// CLIs whose Space Gateway profile the server registers (gatewayCliAccountProfiles in apps/api/src/gateway/gateway-cli-accounts.ts).
const gatewayProfileRuntimes = new Set(["cli:claude", "cli:gemini", "cli:copilot"]);

/**
 * The account a pane's picker selects. A pane without a CLI (whatever its age) starts on the CLI's Space Gateway
 * profile while the gateway is ready for that CLI (running, with at least one active account of it), and never
 * defaults to that profile while it is not. Otherwise the pane keeps the remembered account when it still exists,
 * or takes the first one.
 */
export function cliAccountProfileForPane(list: ListCliAccountProfilesResponse, remembered: string, withoutCli: boolean): string {
  const ids = list.profiles.map((profile) => profile.profileId);
  const gateway = withoutCli ? list.gatewayProfile : null;
  if (gateway?.ready && ids.includes(gateway.profileId)) return gateway.profileId;
  const candidates = gateway ? ids.filter((id) => id !== gateway.profileId) : ids;
  return candidates.includes(remembered) ? remembered : candidates[0] ?? "main";
}

/** The account a new pane starts on when its account list is late: the CLI's Space Gateway profile, never the remembered one. */
export function lateListAccountProfileId(runtimeId: string): string | undefined {
  // shortcut: assumes the gateway profile is set up; an install without it gets a 404 on that one start, move the default server-side if that happens.
  return gatewayProfileRuntimes.has(runtimeId) ? "space-gateway" : undefined;
}
