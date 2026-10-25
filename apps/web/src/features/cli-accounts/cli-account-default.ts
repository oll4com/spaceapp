import type { ListCliAccountProfilesResponse } from "@space/contracts";

// A pane created within this window without a CLI session is new: it starts its CLI on its own.
export const NEW_PANE_WINDOW_MS = 60_000;

export function isNewCliPane(createdAt: string, hasSession: boolean, now = Date.now()): boolean {
  return !hasSession && now - new Date(createdAt).getTime() <= NEW_PANE_WINDOW_MS;
}

/**
 * The account a pane's picker selects. A new pane starts on the CLI's Space Gateway profile while the gateway is
 * ready for that CLI (running, with at least one active account of it), and never defaults to that profile while
 * it is not. Otherwise the pane keeps the remembered account when it still exists, or takes the first one.
 */
export function cliAccountProfileForPane(list: ListCliAccountProfilesResponse, remembered: string, newPane: boolean): string {
  const ids = list.profiles.map((profile) => profile.profileId);
  const gateway = newPane ? list.gatewayProfile : null;
  if (gateway?.ready && ids.includes(gateway.profileId)) return gateway.profileId;
  const candidates = gateway ? ids.filter((id) => id !== gateway.profileId) : ids;
  return candidates.includes(remembered) ? remembered : candidates[0] ?? "main";
}
