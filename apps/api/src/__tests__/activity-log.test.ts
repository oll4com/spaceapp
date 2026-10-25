import { describe, expect, it } from "vitest";
import { listActivityLogEventsQuerySchema } from "@space/contracts";
import { InMemoryActivityLogRepository } from "@space/db";
import { ActivityLogService } from "../activity-log.js";

function createService() {
  const repository = new InMemoryActivityLogRepository();
  let counter = 0;
  const service = new ActivityLogService({
    repository,
    createId: (prefix) => `${prefix}:${String(++counter).padStart(8, "0")}`
  });
  return { repository, service };
}

describe("ActivityLogService", () => {
  it("is disabled by default and records nothing when off", async () => {
    const { service } = createService();
    expect((await service.getSettings()).enabled).toBe(false);
    const event = await service.recordRoomCreate({
      roomId: "room:test-0001",
      actorUserId: "user:agent",
      reason: "Why I opened this room",
      traceId: "req:abcdef123456"
    });
    expect(event).toBeNull();
    const result = await service.listEvents({ page: 1, pageSize: 25, hasReason: undefined });
    expect(result.data).toHaveLength(0);
    expect(result.pagination.totalItems).toBe(0);
  });

  it("captures room creation with actor and reason when enabled", async () => {
    const { service } = createService();
    await service.setEnabled(true, "user:admin");
    const event = await service.recordRoomCreate({
      roomId: "room:test-0001",
      actorUserId: "cli:agent-session",
      reason: "Open a workspace for the Olla integration",
      traceId: "req:abcdef123456",
      metadata: { roomName: "Olla Integration" }
    });
    expect(event).not.toBeNull();
    expect(event!.action).toBe("room.create");
    expect(event!.actorUserId).toBe("cli:agent-session");
    expect(event!.reason).toBe("Open a workspace for the Olla integration");
    expect(event!.metadata).toEqual({ roomName: "Olla Integration" });
  });

  it("stores a trimmed null reason as null and filters by hasReason and actor", async () => {
    const { service } = createService();
    await service.setEnabled(true, "user:admin");
    await service.recordRoomCreate({
      roomId: "room:aaaa0001",
      actorUserId: "user:one",
      reason: "   ",
      traceId: "req:aaaaaaaaaaaa"
    });
    await service.recordRoomCreate({
      roomId: "room:bbbb0002",
      actorUserId: "user:two",
      reason: "Task kickoff",
      traceId: "req:bbbbbbbbbbbb"
    });

    const withReason = await service.listEvents({ hasReason: true, page: 1, pageSize: 25 });
    expect(withReason.data).toHaveLength(1);
    expect(withReason.data[0]!.roomId).toBe("room:bbbb0002");

    const byActor = await service.listEvents({ actorUserId: "user:one", page: 1, pageSize: 25, hasReason: undefined });
    expect(byActor.data).toHaveLength(1);
    expect(byActor.data[0]!.reason).toBeNull();
  });

  it("filters by a partial actor substring case-insensitively", async () => {
    const { service } = createService();
    await service.setEnabled(true, "user:admin");
    await service.recordRoomCreate({
      roomId: "room:aaaa0001",
      actorUserId: "user:Operator",
      reason: "First",
      traceId: "req:aaaaaaaaaaaa"
    });
    await service.recordRoomCreate({
      roomId: "room:bbbb0002",
      actorUserId: "cli:agent-session",
      reason: "Second",
      traceId: "req:bbbbbbbbbbbb"
    });

    const partial = await service.listEvents({ actorUserId: "operator", page: 1, pageSize: 25, hasReason: undefined });
    expect(partial.data).toHaveLength(1);
    expect(partial.data[0]!.actorUserId).toBe("user:Operator");

    const prefixCli = await service.listEvents({ actorUserId: "cli:", page: 1, pageSize: 25, hasReason: undefined });
    expect(prefixCli.data).toHaveLength(1);
    expect(prefixCli.data[0]!.actorUserId).toBe("cli:agent-session");
  });

  it("records the enabled toggle with the acting user id", async () => {
    const { service } = createService();
    const enabled = await service.setEnabled(true, "user:admin");
    expect(enabled.enabled).toBe(true);
    expect(enabled.enabledByUserId).toBe("user:admin");
    expect(enabled.enabledAt).toBeTruthy();
    const disabled = await service.setEnabled(false, "user:admin");
    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledByUserId).toBe("user:admin");
  });

  it("accepts short partial actor filter values in the query schema", () => {
    const short = listActivityLogEventsQuerySchema.parse({ actorUserId: "user" });
    expect(short.actorUserId).toBe("user");
    const prefix = listActivityLogEventsQuerySchema.parse({ actorUserId: "cli:" });
    expect(prefix.actorUserId).toBe("cli:");
    const empty = listActivityLogEventsQuerySchema.safeParse({ actorUserId: "" });
    expect(empty.success).toBe(false);
  });
});
