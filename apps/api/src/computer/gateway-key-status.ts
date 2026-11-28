import { request } from "node:https";
import type { TenantKeyStatusPort } from "./accounts.js";

/** The gateway's tenant ids have no ':' (packages/gateway/src/nous/admin.ts TENANT_ID) and a Space id's nanoid never has '.', so this is one to one. */
export const gatewayTenantId = (tenantId: string) => tenantId.replace(":", ".");

/** Each admin call is one small POST; a gateway that does not answer in this time fails the call, and the lifecycle step reports it. */
export const GATEWAY_ADMIN_TIMEOUT_MS = 10_000;

/**
 * The real TenantKeyStatusPort: POST /tenants/:id/status on the Nous Gateway's mTLS admin listener with a service certificate from the
 * ngw CA (OU=service), so the gateway audits it as staff and keeps billing's own freeze (setTenantKeyStatus).
 */
export function createGatewayKeyStatus(options: { url: string; ca: string | Buffer; cert: string | Buffer; key: string | Buffer; timeoutMs?: number }): TenantKeyStatusPort {
  const base = new URL(options.url);
  if (base.protocol !== "https:") throw new Error("The Nous Gateway admin URL must be https (mTLS).");
  return {
    setStatus: (tenantId, status, reason) => new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ status, reason });
      const req = request(new URL(`tenants/${encodeURIComponent(gatewayTenantId(tenantId))}/status`, base.href.endsWith("/") ? base : `${base.href}/`), {
        method: "POST", ca: options.ca, cert: options.cert, key: options.key, minVersion: "TLSv1.3",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: options.timeoutMs ?? GATEWAY_ADMIN_TIMEOUT_MS
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) return resolve();
          let message = text.slice(0, 300); // only for the error line; the gateway's error body is small JSON
          try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message; } catch { /* not JSON */ }
          reject(new Error(`Nous Gateway refused ${status} for ${tenantId}: ${res.statusCode} ${message}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error(`Nous Gateway did not answer ${status} for ${tenantId} in ${options.timeoutMs ?? GATEWAY_ADMIN_TIMEOUT_MS} ms.`)));
      req.on("error", reject);
      req.end(payload);
    })
  };
}
