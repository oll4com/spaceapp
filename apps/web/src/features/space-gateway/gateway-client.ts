import type {
  GatewayAccount, GatewayAccountDetail, GatewayAccountUpdateRequest, GatewayApiKey, GatewayApiKeyCreateRequest, GatewayApiKeyCreatedResponse,
  GatewayApiKeyDetail, GatewayApiKeyUpdateRequest, GatewayCompressionStats, GatewayDashboard, GatewayDashboardRange, GatewayHealth, GatewayReport,
  GatewayRequestLog, GatewayRequestLogFacets, GatewayRequestLogFilter, GatewayRequestLogList, GatewaySettings, GatewaySettingsUpdateRequest, GatewayStatus,
  GatewayHeadroomHistory, GatewayHeadroomLifetime, GatewayHeadroomSession, GatewayAnthropicAdminStatus, GatewayAnthropicBillingReport
} from "@space/contracts";
import { api } from "../../api.js";
import { announceGatewaySettings } from "./gateway-settings-events.js";

type Connected = { status: "CONNECTED"; account: { id: string; label: string } };

/** Everything the Space Gateway workspace asks the Space API; tests pass their own. */
export interface SpaceGatewayClient {
  status(): Promise<GatewayStatus>;
  dashboard(range: GatewayDashboardRange): Promise<GatewayDashboard>;
  health(): Promise<GatewayHealth>;
  accounts(): Promise<{ data: GatewayAccount[] }>;
  accountDetail(accountId: string): Promise<GatewayAccountDetail>;
  setAccountPaused(accountId: string, paused: boolean): Promise<GatewayAccount>;
  updateAccount(accountId: string, patch: GatewayAccountUpdateRequest): Promise<GatewayAccount>;
  exportAccount(accountId: string): Promise<{ accountId: string; email: string | null; planType: string | null; status: string; authJson: string }>;
  keys(): Promise<{ data: GatewayApiKey[] }>;
  keyDetail(keyId: string): Promise<GatewayApiKeyDetail>;
  createKey(input: Partial<GatewayApiKeyCreateRequest> & { name: string }): Promise<GatewayApiKeyCreatedResponse>;
  updateKey(keyId: string, patch: GatewayApiKeyUpdateRequest): Promise<GatewayApiKey>;
  regenerateKey(keyId: string): Promise<GatewayApiKeyCreatedResponse>;
  deleteKey(keyId: string): Promise<{ id: string; deleted: true }>;
  logs(query: { limit?: number; cursor?: string | null; filter?: GatewayRequestLogFilter }): Promise<GatewayRequestLogList>;
  logDetail(logId: string): Promise<GatewayRequestLog>;
  logFacets(range: { from?: string; to?: string }): Promise<GatewayRequestLogFacets>;
  updateSettings(patch: GatewaySettingsUpdateRequest): Promise<GatewaySettings>;
  /** A new gateway worker reads the settings and takes over (LAN access). */
  reload(): Promise<{ status: string }>;
  startDeviceSignIn(): Promise<{ flowId: string; verificationUrl: string; userCode: string; intervalSeconds: number; expiresInSeconds: number }>;
  pollDeviceSignIn(flowId: string): Promise<{ status: "PENDING" | "EXPIRED" | "CONNECTED"; account?: { id: string; label: string } }>;
  startBrowserSignIn(): Promise<{ flowId: string; authorizationUrl: string }>;
  completeBrowserSignIn(flowId: string, callbackUrl: string): Promise<Connected>;
  importAuthJson(authJson: string): Promise<Connected>;
  startClaudeSignIn(): Promise<{ flowId: string; authorizationUrl: string }>;
  antigravityProfiles(): Promise<{ data: Array<{ profileId: string; email: string | null; inGateway: boolean }> }>;
  addOpenAiApiKey(input: { provider?: "OPENAI_API" | "OPENROUTER" | "DEEPSEEK" | "CLAUDE" | "GOOGLE_AI"; apiKey?: string; useSpaceKey?: boolean; label?: string }): Promise<Connected>;
  importAntigravityProfile(profileId: string): Promise<Connected>;
  completeClaudeSignIn(flowId: string, code: string): Promise<Connected>;
  refreshUsage(accountId: string): Promise<{ status: string }>;
  testAccount(accountId: string): Promise<{ ok: boolean; model: string | null; status: number; latencyMs: number; error: string | null }>;
  deleteAccount(accountId: string): Promise<{ id: string; deleted: true }>;
  useResetCredit(accountId: string, idempotencyKey: string): Promise<{ outcome: string; windowsReset: number }>;
  report(from: string, to: string): Promise<GatewayReport>;
  compressionStats(hours: number): Promise<GatewayCompressionStats>;
  compressionSession(): Promise<GatewayHeadroomSession>;
  compressionLifetime(): Promise<GatewayHeadroomLifetime>;
  compressionHistory(): Promise<GatewayHeadroomHistory>;
  /** The operator's Anthropic Admin API key: its hint and last sync only; the key itself goes in once and never comes back. */
  anthropicAdmin(): Promise<GatewayAnthropicAdminStatus>;
  saveAnthropicAdminKey(adminKey: string): Promise<GatewayAnthropicAdminStatus>;
  removeAnthropicAdminKey(): Promise<{ removed: boolean }>;
  syncAnthropicBilling(): Promise<GatewayAnthropicAdminStatus>;
  /** Anthropic's bill for the last `days` UTC days, shown on the Claude API-key account. */
  anthropicBilling?(days: number): Promise<GatewayAnthropicBillingReport>;
}

export const defaultGatewayClient: SpaceGatewayClient = {
  status: () => api.gatewayStatus(),
  dashboard: (range) => api.gatewayDashboard(range),
  health: () => api.gatewayHealth(),
  accounts: () => api.gatewayAccounts(),
  accountDetail: (accountId) => api.gatewayAccountDetail(accountId),
  setAccountPaused: (accountId, paused) => api.setGatewayAccountPaused(accountId, paused),
  updateAccount: (accountId, patch) => api.updateGatewayAccount(accountId, patch),
  exportAccount: (accountId) => api.exportGatewayAccount(accountId),
  keys: () => api.gatewayApiKeys(),
  keyDetail: (keyId) => api.gatewayApiKeyDetail(keyId),
  createKey: (input) => api.createGatewayApiKey(input),
  updateKey: (keyId, patch) => api.updateGatewayApiKey(keyId, patch),
  regenerateKey: (keyId) => api.regenerateGatewayApiKey(keyId),
  deleteKey: (keyId) => api.deleteGatewayApiKey(keyId),
  logs: (query) => api.gatewayRequestLogs(query),
  logDetail: (logId) => api.gatewayRequestLog(logId),
  logFacets: (range) => api.gatewayRequestLogFacets(range),
  updateSettings: (patch) => api.updateGatewaySettings(patch).then((settings) => { announceGatewaySettings(settings); return settings; }),
  reload: () => api.reloadGateway(),
  startDeviceSignIn: () => api.startGatewayCodexDeviceSignIn(),
  pollDeviceSignIn: (flowId) => api.pollGatewayCodexDeviceSignIn(flowId),
  startBrowserSignIn: () => api.startGatewayCodexBrowserSignIn(),
  completeBrowserSignIn: (flowId, callbackUrl) => api.completeGatewayCodexBrowserSignIn(flowId, callbackUrl),
  importAuthJson: (authJson) => api.importGatewayCodexAuthJson(authJson),
  startClaudeSignIn: () => api.startGatewayClaudeSignIn(),
  antigravityProfiles: () => api.gatewayAntigravityProfiles(),
  addOpenAiApiKey: (input) => api.addGatewayOpenAiApiKey(input),
  importAntigravityProfile: (profileId) => api.importGatewayAntigravityProfile(profileId),
  completeClaudeSignIn: (flowId, code) => api.completeGatewayClaudeSignIn(flowId, code),
  refreshUsage: (accountId) => api.refreshGatewayAccountUsage(accountId),
  testAccount: (accountId) => api.testGatewayAccount(accountId),
  deleteAccount: (accountId) => api.deleteGatewayAccount(accountId),
  useResetCredit: (accountId, idempotencyKey) => api.useGatewayResetCredit(accountId, idempotencyKey),
  report: (from, to) => api.gatewayReport(from, to),
  compressionStats: (hours) => api.gatewayCompressionStats(hours),
  compressionSession: () => api.gatewayCompressionSession(),
  compressionLifetime: () => api.gatewayCompressionLifetime(),
  compressionHistory: () => api.gatewayCompressionHistory(),
  anthropicAdmin: () => api.gatewayAnthropicAdmin(),
  saveAnthropicAdminKey: (adminKey) => api.saveGatewayAnthropicAdminKey(adminKey),
  removeAnthropicAdminKey: () => api.removeGatewayAnthropicAdminKey(),
  syncAnthropicBilling: () => api.syncGatewayAnthropicBilling(),
  anthropicBilling: (days) => api.gatewayAnthropicBilling(days)
};

export function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
