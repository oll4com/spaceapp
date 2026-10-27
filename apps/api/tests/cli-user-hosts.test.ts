import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCliUserHosting, createUserRuntimeRegistries, readCliUserHostSockets } from "../src/cli-user-hosts.js";
import { getApiConfig } from "../src/config.js";

it("reads the per-user pane host map and refuses an invalid one (fail closed)", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-cli-user-hosts-"));
  try {
    expect(readCliUserHostSockets(null)).toBeNull();
    const file = join(root, "cli-hosts.json");
    await writeFile(file, JSON.stringify({ "user:bob": "/run/spaceapp-cli/user-bob/host.sock" }));
    expect(readCliUserHostSockets(file)).toEqual({ "user:bob": "/run/spaceapp-cli/user-bob/host.sock" });
    for (const bad of [{ "user:bob": "relative/host.sock" }, { "../etc": "/run/x.sock" }, ["user:bob"]]) {
      await writeFile(file, JSON.stringify(bad));
      expect(() => readCliUserHostSockets(file)).toThrow();
    }
    expect(() => readCliUserHostSockets(join(root, "missing.json"))).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps one runtime registry per user with an own container and none for anyone else", () => {
  const config = { ...getApiConfig({ SPACE_LOG_LEVEL: "silent" }), publicDistribution: true, cliEnabled: true };
  const registryFor = createUserRuntimeRegistries(config, { "user:bob": "/run/spaceapp-cli-users/bob/host.sock" });
  expect(registryFor("user:carol")).toBeNull();
  const bob = registryFor("user:bob");
  expect(bob).not.toBeNull();
  expect(registryFor("user:bob")).toBe(bob);
  expect(createUserRuntimeRegistries(config, null)("user:bob")).toBeNull();
});

it("lets core model runs (task summaries, Room Agent chat) bill the owner only for the owner's panes and rooms (MU-002)", async () => {
  const roles: Record<string, string> = { "user:operator": "ADMIN", "user:bob": "USER" };
  const rooms: Record<string, string | null> = { "room:op": "user:operator", "room:bob": "user:bob", "room:system": null };
  const panes: Record<string, { roomId: string; owner: string | null }> = {
    "pane:op": { roomId: "room:op", owner: null }, "pane:bob": { roomId: "room:bob", owner: null }, "pane:bob-in-op": { roomId: "room:op", owner: "user:bob" },
    "pane:system": { roomId: "room:system", owner: null }
  };
  const hosting = createCliUserHosting({
    store: {
      getPaneOwner: async (paneId: string) => panes[paneId]!.owner,
      getRoom: async (roomId: string) => ({ ownerUserId: rooms[roomId] }) as never,
      getControlActor: async (userId: string) => (roles[userId] ? { id: userId, role: roles[userId] } : null) as never
    },
    config: getApiConfig({}),
    paneById: async (paneId: string) => ({ roomId: panes[paneId]!.roomId }) as never
  });
  expect(await Promise.all(["pane:op", "pane:bob", "pane:bob-in-op"].map(hosting.ownerModels.pane))).toEqual([true, false, false]);
  expect(await Promise.all(["room:op", "room:bob", "room:system"].map(hosting.ownerModels.room))).toEqual([true, false, true]);
  // MU-009: the operator's CLI control token, only where the CLI is the operator side's.
  expect(await Promise.all(["pane:op", "pane:bob", "pane:bob-in-op", "pane:system"].map((paneId) => hosting.controlActorAllowed(paneId, "user:operator"))))
    .toEqual([true, false, false, true]);
});
