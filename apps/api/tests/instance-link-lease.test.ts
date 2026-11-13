import { describe, expect, it } from "vitest";
import { InMemoryNousRepository } from "@space/db";
import { createNousService } from "../src/nous/service.js";
import { LINK_LEASE_IDLE_MS, linkLease } from "../src/instance-link/lease.js";

describe("Space Link lease (ADR-014 Λ5)", () => {
  it("lets one link act at a time, expires when idle, and holds every link at reading once the person takes it back", () => {
    let at = 0;
    const store = {}, lease = linkLease(store, () => at);
    expect(lease.claim("u", "d1", "A")).toBeNull();
    expect(linkLease(store, () => at).holder("u")).toMatchObject({ deviceId: "d1", name: "A" });
    expect(lease.claim("u", "d2", "B")).toMatchObject({ code: "LINK_LEASE_HELD", message: expect.stringContaining("A manages") });
    expect(lease.claim("other", "d2", "B")).toBeNull();
    at = LINK_LEASE_IDLE_MS;
    expect(lease.holder("u")).toBeNull();
    expect(lease.claim("u", "d2", "B")).toBeNull();
    lease.release("u", "d1");
    expect(lease.holder("u")?.deviceId).toBe("d2");
    lease.release("u", "d2");
    expect(lease.holder("u")).toBeNull();
    lease.claim("u", "d1", "A");
    lease.takeBack("u");
    expect(lease.holder("u")).toBeNull();
    expect(lease.claim("u", "d1", "A")).toMatchObject({ code: "LINK_TAKEN_BACK" });
    lease.giveBack("u");
    expect(lease.takenBackAt("u")).toBeNull();
    expect(lease.claim("u", "d1", "A")).toBeNull();
  });

  it("while a linked SpaceApp manages this one, Nous's own turns wait and the person's still run", async () => {
    let managed: string | null = "A manages this SpaceApp";
    const runs: string[] = [], owner = "user:operator";
    let settings = { enabled: true, maxTurnsPerHour: 20 };
    const service = createNousService({
      repository: new InMemoryNousRepository(),
      runner: async (input) => { runs.push(input.reason); return { text: "Done.", isError: false }; },
      tools: { execute: async () => ({ ok: true, display: "", result: "" }) },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => settings as never,
      saveSettings: async (_owner, value) => { settings = value as never; return value; },
      notifications: { raise: async () => ({}) as never, resolve: async () => {} } as never,
      executeAction: async () => "",
      managed: () => managed,
      limits: { inboxDebounceMs: 10, gatewayProbeMs: 10 }
    });
    expect(await service.standing(owner, "STANDING", "## Finished panes\n- Andy")).toBe("PAUSED");
    await service.notice(owner, "pane:a", "Andy finished.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toEqual([]);
    await service.send(owner, "Hello", { person: true });
    await service.idle(owner);
    expect(runs).toEqual(["OPERATOR"]);
    managed = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.idle(owner);
    expect(runs).toEqual(["OPERATOR", "INBOX"]);
  });
});
