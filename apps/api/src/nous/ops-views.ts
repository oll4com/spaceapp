import { z } from "zod";
import type { GatewayStatus, SystemAnalyticsModelsResponse, SystemHealthSnapshot, SystemServicesResponse } from "@space/contracts";
import type { GatewayAdminService } from "../gateway/gateway-service.js";

/**
 * Read-only ops views for Nous (plan clipboard:8s0ZNiO3q5ZT S5): service health and recent errors (like space_status),
 * token usage (like the admin action token-usage) and Space Gateway status (like gateway-status). The same in-process
 * readers the ADMIN pages use; nothing here restarts, controls or changes anything.
 */
export interface NousOpsDeps {
  health?: { snapshot(): Promise<SystemHealthSnapshot> };
  services?: () => Promise<SystemServicesResponse>;
  tokenUsage?: (range: NousUsageRange) => Promise<SystemAnalyticsModelsResponse>;
  gateway?: () => Promise<GatewayStatus>;
  /** Space Gateway's admin reads (gap audit, plan clipboard:ajcJqa3IW6Eh): never a key secret, never a request body. */
  gatewayAdmin?: Pick<GatewayAdminService, "listAccounts" | "listApiKeys" | "listRequestLogs" | "report" | "anthropicBilling">;
}

export const nousUsageRangeSchema = z.enum(["1h", "24h", "7d", "30d"]);
export type NousUsageRange = z.infer<typeof nousUsageRangeSchema>;
export const nousOpsServicesArgsSchema = z.object({});
export const nousOpsUsageArgsSchema = z.object({ range: nousUsageRangeSchema.optional().describe("Token usage period (default 24h).") });
export const nousOpsGatewayArgsSchema = z.object({
  view: z.enum(["accounts", "keys", "logs", "report", "billing"]).describe("accounts: status and usage windows; keys: names, models, limits (never the key); logs: newest request metadata; report: daily rollups; billing: Anthropic's bill next to the estimate."),
  days: z.number().int().min(1).max(31).optional().describe("report and billing: days back (default 7)."),
  limit: z.number().int().min(1).max(100).optional().describe("logs: how many (default 30).")
});

/** Space Gateway detail for Nous, read only; the same admin reads as space-admin-action gateway-accounts/-keys/-logs/-report/-anthropic-billing. */
export async function nousOpsGatewayText(deps: NousOpsDeps, args: z.infer<typeof nousOpsGatewayArgsSchema>): Promise<string> {
  const admin = deps.gatewayAdmin;
  if (!admin) return "Space Gateway's admin views are not available here.";
  const days = args.days ?? 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (args.view === "accounts") {
    return (await admin.listAccounts()).data.map((account) => `- ${account.provider} · ${account.alias ?? account.label}${account.email ? ` <${account.email}>` : ""} · ${account.status}`
      + `${account.statusReason ? ` (${account.statusReason.slice(0, 120)})` : ""} · windows ${JSON.stringify(account.primaryWindow)} / ${JSON.stringify(account.secondaryWindow)} · last used ${account.lastUsedAt?.slice(0, 16) ?? "never"}`).join("\n") || "No accounts.";
  }
  if (args.view === "keys") {
    return (await admin.listApiKeys()).data.map((key) => `- ${key.name} (${key.keyPrefix}…) · ${key.isActive ? "active" : "off"} · ${key.trafficClass}`
      + `${key.enforcedModel ? ` · model ${key.enforcedModel}` : key.allowedModels.length ? ` · models ${key.allowedModels.join(", ")}` : ""}`
      + `${key.limits.length ? ` · limits ${key.limits.map((limit) => `${limit.limitType}/${limit.limitWindow} ${limit.currentValue}/${limit.maxValue}`).join(", ")}` : ""} · last used ${key.lastUsedAt?.slice(0, 16) ?? "never"}`).join("\n") || "No keys.";
  }
  if (args.view === "logs") {
    const logs = await admin.listRequestLogs({ limit: args.limit ?? 30 });
    return logs.data.map((log) => `- ${log.requestedAt.slice(0, 19)} · ${log.provider} ${log.model} · ${log.status}${log.errorCode ? ` ${log.errorCode}` : ""} · in ${count(log.inputTokens)} out ${count(log.outputTokens)} · ${usd(log.costUsd)}`
      + `${log.latencyMs != null ? ` · ${log.latencyMs} ms` : ""}`).join("\n") || "No requests.";
  }
  if (args.view === "report") return JSON.stringify(await admin.report(since, today)).slice(0, 11_000);
  return JSON.stringify(await admin.anthropicBilling(days)).slice(0, 11_000);
}

const usd = (value: number | null | undefined) => value == null ? "n/a" : `$${value.toFixed(2)}`;
const count = (value: number | null | undefined) => value == null ? "n/a" : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value);

export async function nousOpsServicesText(deps: NousOpsDeps): Promise<string> {
  const [health, units] = await Promise.all([deps.health?.snapshot().catch(() => null) ?? null, deps.services?.().catch(() => null) ?? null]);
  const lines: string[] = [];
  if (health) {
    const notHealthy = health.services.filter((service) => service.status !== "healthy" && service.status !== "disabled");
    lines.push(`Health ${health.sampledAt.slice(0, 16)} UTC: ${health.services.length - notHealthy.length} of ${health.services.length} checks healthy.`,
      ...notHealthy.map((service) => `- ${service.label}: ${service.status}${service.detail ? ` (${service.detail.replace(/\s+/g, " ").slice(0, 200)})` : ""}`));
    const { requests } = health;
    lines.push(`API requests in the last 5 minutes: ${requests.requestCount}, errors ${requests.errorCount}${requests.errorRatePercent != null ? ` (${requests.errorRatePercent.toFixed(1)}%)` : ""}${requests.p95Ms != null ? `, p95 ${Math.round(requests.p95Ms)} ms` : ""}.`);
  } else lines.push("Health checks could not be read now.");
  if (units) {
    const failed = units.units.filter((unit) => unit.activeState === "failed");
    const stopped = units.units.filter((unit) => unit.type === "service" && unit.activeState === "inactive" && unit.unitFileState === "enabled");
    lines.push(`Services: ${units.summary.active} active, ${units.summary.failed} failed of ${units.summary.total} units.`,
      ...failed.slice(0, 20).map((unit) => `- failed: ${unit.unit}${unit.description ? ` (${unit.description})` : ""}`),
      ...stopped.slice(0, 20).map((unit) => `- enabled but not running: ${unit.unit}`));
  } else lines.push("Service units could not be read now.");
  return lines.join("\n");
}

export async function nousOpsUsageText(deps: NousOpsDeps, range: NousUsageRange = "24h"): Promise<string> {
  const [usage, gateway] = await Promise.all([deps.tokenUsage?.(range).catch(() => null) ?? null, deps.gateway?.().catch(() => null) ?? null]);
  const lines: string[] = [];
  if (usage) {
    const routes = usage.routes;
    lines.push(`Token usage, last ${range}${routes ? `: Space Gateway ${count(routes.gateway.tokensIn + routes.gateway.tokensOut)} tokens ${usd(routes.gateway.costUsd)}, direct ${count(routes.direct.tokensIn + routes.direct.tokensOut)} tokens ${usd(routes.direct.costUsd)} (API value)` : ""}.`);
    const models = [...usage.models].sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0)).slice(0, 12);
    lines.push(...models.map((model) => `- ${model.providerId}/${model.modelId}: in ${count(model.tokensIn)}, out ${count(model.tokensOut)}, ${usd(model.costUsd)}, ${model.completedTurns} turns`));
  } else lines.push("Token usage could not be read now.");
  if (gateway) {
    const { service, accounts, apiKeys, last24h } = gateway;
    lines.push(`Space Gateway: ${service.state}${service.version ? ` ${service.version}` : ""}${service.error ? ` (${service.error.slice(0, 200)})` : ""}; accounts ${accounts.active}/${accounts.total} active`
      + ` (${accounts.byProvider.map((entry) => `${entry.provider} ${entry.active}/${entry.total}`).join(", ")}); keys ${apiKeys.active}/${apiKeys.total} active.`,
    `Gateway last 24 h: ${last24h.requests} requests, ${last24h.errors} errors, ${count(last24h.inputTokens)} in, ${count(last24h.outputTokens)} out, ${usd(last24h.costUsd)}.`);
  } else lines.push("Space Gateway status could not be read now.");
  return lines.join("\n");
}
