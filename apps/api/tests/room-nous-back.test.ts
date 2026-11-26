import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerRoomManagementRoutes } from "../src/room-routes.js";

// Operator 22/11: turning "Keep Nous out" off hands the room straight back to Nous (docs/agents/room-nous-off.md).
describe("Keep Nous out switched off", () => {
  async function wire(nousExcluded: boolean, ownerUserId: string | null = "user:alice1") {
    let room = { id: "room:abc123", name: "Work", ownerUserId, nousExcluded };
    const notices: string[][] = [];
    const app = Fastify();
    registerRoomManagementRoutes(app, {
      config: {}, routeOptions: {}, assertRoomAccess: async () => ({ ...room }),
      store: { updateRoom: async (_id: string, input: { name: string; nousExcluded?: boolean }) => (room = { ...room, ...input }),
        upsertUser: async () => null, recordAuditEvent: async () => undefined },
      nousNotice: async (owner: string, key: string, line: string) => { notices.push([owner, key, line]); }
    } as never);
    await app.ready();
    const patch = async (body: object) => (await app.inject({ method: "PATCH", url: "/api/rooms/room:abc123", payload: { name: "Work", ...body } })).statusCode;
    return { patch, notices };
  }

  it("wakes the owner's Nous to take the room back and review what is open there", async () => {
    const { patch, notices } = await wire(true);
    expect(await patch({ nousExcluded: false })).toBe(200);
    expect(notices).toEqual([["user:alice1", "room-nous-back:room:abc123", expect.stringContaining('turned "Keep Nous out" off for room "Work" (room:abc123)')]]);
    expect(notices[0]![2]).toMatch(/Take it back now: read every pane there .*Needs you cards.*tell the operator in the chat/);
  });

  it("stays quiet when the switch does not go from on to off, or the room has no owner", async () => {
    for (const [excluded, body, owner] of [[false, { nousExcluded: false }, "user:alice1"], [false, { nousExcluded: true }, "user:alice1"],
      [true, { nousExcluded: true }, "user:alice1"], [true, {}, "user:alice1"], [true, { nousExcluded: false }, null]] as const) {
      const { patch, notices } = await wire(excluded, owner);
      expect(await patch(body)).toBe(200);
      expect(notices).toEqual([]);
    }
  });
});
