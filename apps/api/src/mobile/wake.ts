import { randomBytes } from "node:crypto";
import type { AppDeviceSessionRepository } from "@space/db";

// Push wake for the Nous app (plan clipboard:kTV3y2lwO-99 phase 2b, design §8.1): the instance sends the push service only a phone's opaque
// handle and a random 96-bit wake id, never a title, text, credential or the licence (only the phone holds that). The notifications service
// decides whether to wake exactly as it decides a push (quiet hours, held for Nous, Away: URGENT only at night); here every wake but URGENT
// waits 0-20 s at random, so the timing tells less (review P3-5). INFO never wakes (the service never calls for it).

export const MOBILE_WAKE_JITTER_MS = 20_000;

export function createMobileWake(options: {
  /** The push service's http(s) origin (SPACE_MOBILE_PUSH_URL). */
  url: string;
  devices: Pick<AppDeviceSessionRepository, "livePaired" | "setPushHandle">;
  fetchImpl?: typeof fetch;
  jitterMs?: () => number;
  log?: { warn(meta: Record<string, unknown>, message: string): void };
  now?: () => number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/v1/wake`;
  async function send(id: string, handle: string) {
    const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ h: handle, w: randomBytes(12).toString("base64url") }), signal: AbortSignal.timeout(10_000) });
    // The phone's push registration ended (uninstalled, licence gone): it sends a new handle when it registers again.
    if (response.status === 410) await options.devices.setPushHandle(id, null);
    else if (!response.ok) options.log?.warn({ status: response.status, deviceId: id }, "Mobile wake failed.");
  }
  /** Wakes the owner's allowed phones that gave a push handle. */
  return async (owner: string, urgent: boolean) => {
    const at = new Date(options.now?.() ?? Date.now()).toISOString();
    for (const row of await options.devices.livePaired(owner, at)) {
      if (!row.pushHandle || !row.confirmedAt) continue;
      const wake = () => void send(row.id, row.pushHandle!).catch((error: unknown) => options.log?.warn({ err: error, deviceId: row.id }, "Mobile wake failed."));
      if (urgent) wake();
      else setTimeout(wake, options.jitterMs?.() ?? Math.random() * MOBILE_WAKE_JITTER_MS).unref();
    }
  };
}
