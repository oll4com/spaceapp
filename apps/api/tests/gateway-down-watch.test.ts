import { describe, expect, it } from "vitest";
import { instanceBackgroundJobEnabled } from "@space/contracts";
import { createGatewayDownWatch } from "../src/gateway/gateway-down-watch.js";

describe("Space Gateway down watch", () => {
  it("alerts every admin once after a minute down and clears the card when the gateway answers again", async () => {
    let up = true, clock = Date.parse("2026-10-19T12:24:58.000Z");
    const raised: Array<{ ownerUserId: string; severity: string; dedupeKey: string | null; title: string }> = [];
    const resolved: string[] = [];
    const watch = createGatewayDownWatch({
      probe: async () => { if (!up) throw new Error("ECONNREFUSED"); return true; },
      admins: async () => ["user:operator", "user:admin-2"],
      raise: async (n) => { raised.push(n as never); },
      resolve: async (owner, key) => { resolved.push(`${owner} ${key}`); },
      log: { warn() {} }, now: () => clock
    });
    await watch.tick();
    up = false;
    await watch.tick();
    clock += 59_000; await watch.tick();
    expect(raised).toEqual([]);
    clock += 2_000; await watch.tick();
    clock += 60_000; await watch.tick();
    expect(raised).toHaveLength(2);
    expect(raised[0]).toMatchObject({ ownerUserId: "user:operator", severity: "ATTENTION", dedupeKey: "gateway:down", title: "Space Gateway is down" });
    up = true; await watch.tick(); await watch.tick();
    expect(resolved).toEqual(["user:operator gateway:down", "user:admin-2 gateway:down"]);
  });

  it("runs on stable only: dev shares stable's gateway and would announce it twice", () => {
    expect(instanceBackgroundJobEnabled({ SPACE_INSTANCE: "stable" } as never, "gateway-down-notify")).toBe(true);
    expect(instanceBackgroundJobEnabled({ SPACE_INSTANCE: "dev" } as never, "gateway-down-notify")).toBe(false);
  });
});
