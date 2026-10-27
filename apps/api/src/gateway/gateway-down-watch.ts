import type { NotificationRaiseInput } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";

const dedupeKey = "gateway:down";

/**
 * Tells the admins (and so Nous) when Space Gateway has not answered its health check for a minute, and clears the card
 * once it answers again. 2026-10-19: the gateway was stopped during a disk stall and stayed down 31 minutes unnoticed.
 */
export function createGatewayDownWatch(input: {
  probe: () => Promise<boolean>;
  admins: () => Promise<string[]>;
  raise: (notification: NotificationRaiseInput) => Promise<unknown>;
  resolve: (ownerUserId: string, dedupeKey: string) => Promise<unknown>;
  log: { warn(meta: Record<string, unknown>, message: string): void };
  now?: () => number;
  intervalMs?: number;
  downAfterMs?: number;
}) {
  const now = input.now ?? Date.now;
  let downSince: number | null = null;
  let alerted = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    const up = await input.probe().catch(() => false);
    if (up) {
      downSince = null;
      if (alerted) {
        alerted = false;
        for (const owner of await input.admins()) await input.resolve(owner, dedupeKey);
      }
      return;
    }
    downSince ??= now();
    if (alerted || now() - downSince < (input.downAfterMs ?? 60_000)) return;
    alerted = true;
    const since = new Date(downSince).toISOString().slice(11, 16);
    for (const ownerUserId of await input.admins()) {
      await input.raise({
        ownerUserId, roomId: null, paneId: null, source: "SYSTEM", kind: "GATEWAY_DOWN", severity: "ATTENTION",
        title: "Space Gateway is down",
        body: `Space Gateway has not answered since ${since} UTC, so Claude and Codex panes on the space-gateway profile cannot reach their models. Start it with: sudo systemctl start space-gateway.service`,
        link: {}, dedupeKey, payload: { downSince: new Date(downSince).toISOString() }, telegram: null
      });
    }
  }

  return {
    tick,
    start() {
      timer ??= setInterval(() => { void tick().catch((error: unknown) => input.log.warn({ err: error }, "Space Gateway down watch failed.")); }, input.intervalMs ?? 20_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

/** Starts the watch on the instance that runs the `gateway-down-notify` job (stable: dev shares stable's gateway). */
export function registerGatewayDownWatch(app: FastifyInstance, input: {
  enabled: boolean; gatewayUrl: string; store: Pick<SpaceStore, "listUsersWithRoomCounts">;
  notifications: { raise(notification: NotificationRaiseInput): Promise<unknown>; resolve(owner: string, dedupeKey: string): Promise<unknown> };
}): void {
  const watch = createGatewayDownWatch({
    probe: async () => (await fetch(`${input.gatewayUrl}/health`, { signal: AbortSignal.timeout(5_000) })).ok,
    raise: (notification) => input.notifications.raise(notification),
    resolve: (owner, key) => input.notifications.resolve(owner, key),
    log: app.log,
    admins: async () => ((await input.store.listUsersWithRoomCounts?.()) ?? []).filter((user) => user.role === "ADMIN").map((user) => user.id)
  });
  app.addHook("onReady", async () => { if (input.enabled) watch.start(); });
  app.addHook("onClose", async () => watch.stop());
}
