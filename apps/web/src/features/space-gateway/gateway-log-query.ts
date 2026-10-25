import type { GatewayRequestLogFilter } from "@space/contracts";

/** Query parameters of the Space Gateway request log filters (repeated keys for lists). */
export function gatewayLogFilterParams(filter: GatewayRequestLogFilter = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  for (const value of filter.accountIds ?? []) params.append("account", value);
  for (const value of filter.apiKeyIds ?? []) params.append("key", value);
  for (const value of filter.models ?? []) params.append("model", value);
  for (const value of filter.providers ?? []) params.append("provider", value);
  for (const value of filter.statuses ?? []) params.append("status", value);
  for (const value of filter.clients ?? []) params.append("client", value);
  return params;
}

/** Download address of the filtered request logs as CSV (same-origin; the session cookie authorizes it). */
export function gatewayLogsCsvUrl(filter: GatewayRequestLogFilter = {}): string {
  const suffix = gatewayLogFilterParams(filter).toString();
  return `/api/admin/gateway/logs/export.csv${suffix ? `?${suffix}` : ""}`;
}
