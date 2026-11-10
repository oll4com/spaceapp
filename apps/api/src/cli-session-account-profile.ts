import type { PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { isCliAccountProfileRuntimeId } from "./cli-account-profile-runtimes.js";
import { createGatewayCliAccounts } from "./gateway/gateway-cli-accounts.js";
import type { GatewayAdminService } from "./gateway/gateway-service.js";

type PreviousAccount = Pick<PaneCliSession, "runtimeId" | "accountProfileId">;
type AccountDependencies = {
  store: Pick<SpaceStore, "getCliAccountProfile" | "listPaneCliSessions">;
  pinnedDirect(paneId: string): boolean | Promise<boolean>;
};

/** Keep new-pane and resumed-session defaults on the same Gateway readiness hook. */
export function createCliSessionAccounts(deps: AccountDependencies & { gateway: Pick<GatewayAdminService, "serves"> }) {
  const gatewayCliAccounts = createGatewayCliAccounts({
    gateway: deps.gateway,
    profileExists: async (runtimeId, profileId) => isCliAccountProfileRuntimeId(runtimeId)
      && Boolean(await deps.store.getCliAccountProfile(runtimeId, profileId))
  });
  return {
    gatewayCliAccounts,
    resolveCliSessionAccountProfile: createCliSessionAccountProfileResolver({
      ...deps, newPaneAccountProfileId: (runtimeId) => gatewayCliAccounts.newPaneProfileId(runtimeId)
    })
  };
}

/** Account selection for session allocation, shared by history/reopen and the HTTP start/restart path. */
export function createCliSessionAccountProfileResolver(deps: AccountDependencies & {
  newPaneAccountProfileId(runtimeId: string): Promise<string | null>;
}) {
  return async (input: {
    paneId: string;
    runtimeId: string;
    /** Explicit choices (including null/main, or the account chosen by Auto) always win. */
    accountProfileId?: string | null;
    previousSession?: PreviousAccount | null;
    /** Job Copilot also inherits the account of the task it continues, including other runtimes. */
    sourceSession?: PreviousAccount | null;
  }): Promise<string | null> => {
    if (input.accountProfileId !== undefined) return input.accountProfileId;
    if (input.runtimeId === "cli:claude") {
      const previous = input.previousSession ?? (await deps.store.listPaneCliSessions(input.paneId, 1))[0];
      const sameRuntime = previous?.runtimeId === input.runtimeId ? previous : null;
      if (await deps.pinnedDirect(input.paneId)) return sameRuntime?.accountProfileId ?? null;
      if (sameRuntime?.accountProfileId && await deps.store.getCliAccountProfile(input.runtimeId, sameRuntime.accountProfileId)) return sameRuntime.accountProfileId;
    }
    const source = input.sourceSession;
    if (source?.runtimeId === input.runtimeId && source.accountProfileId && isCliAccountProfileRuntimeId(input.runtimeId)
      && await deps.store.getCliAccountProfile(input.runtimeId, source.accountProfileId)) return source.accountProfileId;
    return input.runtimeId === "cli:claude" ? deps.newPaneAccountProfileId(input.runtimeId).catch(() => null) : null;
  };
}

export type CliSessionAccountProfileResolver = ReturnType<typeof createCliSessionAccountProfileResolver>;
