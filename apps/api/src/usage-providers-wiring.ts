import type { AntigravityUsageAccountList, ApiProviderAccountList, ClaudeUsageAccountList } from "@space/contracts";
import type { GatewayRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { createAntigravityUsageAccountProvider } from "./antigravity-usage-services.js";
import { createApiProviderAccountProvider } from "./api-provider-balance-services.js";
import { anthropicMonthSpendUsd, claudeGatewayApiKeyUsage, createClaudeUsageAccountProvider } from "./claude-usage-services.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { emailsOutOfRotation } from "./gateway/account-rotation.js";
import type { GatewayAdminService } from "./gateway/gateway-service.js";
import { createHostStatsProvider, type HostStatsProvider } from "./host-stats.js";

type UsageProvidersDeps = {
  options: {
    hostStatsProvider?: HostStatsProvider;
    antigravityUsageProvider?: () => Promise<AntigravityUsageAccountList>;
    claudeUsageProvider?: () => Promise<ClaudeUsageAccountList>;
    apiProviderAccountsProvider?: () => Promise<ApiProviderAccountList>;
  };
  apiStartedAt: string; config: SpaceApiConfig; store: SpaceStore;
  cliTerminalManager: Pick<CliTerminalManager, "hostHealth">;
  readClaudeAccountProfileUsage: Parameters<typeof createClaudeUsageAccountProvider>[0]["readUsage"];
  /** Call-time readers: app.ts declares the gateway repository and the gateway admin service after this block, so they are read only when a provider runs. */
  gatewayRepositoryFor: () => GatewayRepository;
  resolveGatewayAdminService: () => GatewayAdminService;
};

/**
 * The host stats and account usage providers of app.ts (moved verbatim, ARCH-001 step 89): the host stats of the CLI hosts,
 * the Antigravity accounts with the ones out of the gateway's rotation hidden, the Claude accounts with the gateway's accounts,
 * settings and API-key usage and the month's Anthropic bill, and the API provider accounts with the Anthropic bill, settings and usage.
 */
export function createUsageProviders(deps: UsageProvidersDeps) {
  const { options, apiStartedAt, config, store, cliTerminalManager, readClaudeAccountProfileUsage, gatewayRepositoryFor, resolveGatewayAdminService } = deps;
  const hostStatsProvider =
    options.hostStatsProvider ??
    createHostStatsProvider({
      apiStartedAt,
      cliHosts: [
        {
          hostId: "main",
          enabled: config.cliEnabled,
          health: () => cliTerminalManager.hostHealth("cli:codex")
        },
        {
          hostId: "root",
          enabled: config.cliRootEnabled,
          health: () => cliTerminalManager.hostHealth("cli:root")
        }
      ]
    });
  const antigravityUsageProvider =
    options.antigravityUsageProvider ??
    createAntigravityUsageAccountProvider({
      profileLabels: async () => {
        try {
          const list = await Promise.resolve(store.listCliAccountProfiles("cli:gemini"));
          return new Map(list.map((p: { profileId: string; displayName: string }) => [p.profileId, p.displayName]));
        } catch {
          return new Map();
        }
      },
      hiddenEmails: async () => emailsOutOfRotation(await gatewayRepositoryFor().listAccounts(), "ANTIGRAVITY", Date.now())
    });
  const claudeUsageProvider = options.claudeUsageProvider ?? createClaudeUsageAccountProvider({
    listProfiles: async () => store.listCliAccountProfiles("cli:claude"),
    readUsage: readClaudeAccountProfileUsage,
    gatewayAccounts: () => gatewayRepositoryFor().listAccounts(),
    gatewaySettings: () => gatewayRepositoryFor().getSettings(),
    gatewayAccountUsage: (accountId) => claudeGatewayApiKeyUsage(gatewayRepositoryFor(), accountId, Date.now()),
    anthropicMonthUsd: async () => anthropicMonthSpendUsd(await resolveGatewayAdminService().anthropicBilling(new Date().getUTCDate()), Date.now())
  });
  const apiProviderAccountsProvider =
    options.apiProviderAccountsProvider ??
    createApiProviderAccountProvider({ anthropic: { billing: () => resolveGatewayAdminService().anthropicBilling(31), settings: () => gatewayRepositoryFor().getSettings(),
      usage: () => gatewayRepositoryFor().listAnthropicUsage("2000-01-01", new Date().toISOString().slice(0, 10)),
      configured: async () => (await resolveGatewayAdminService().anthropicAdminStatus()).configured },
      gatewayAccounts: () => gatewayRepositoryFor().listAccounts(), freeLedger: () => resolveGatewayAdminService().freeLedger() });
  return { hostStatsProvider, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider };
}
