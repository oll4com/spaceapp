import { describe, expect, it, vi } from "vitest";
import { eventSchema, needsYouFiles, type AgentFileRef } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";

// nous_msg:0cb8d563 («θελω να βλεπω κατευθειαν το αρχειο και να μπορώ να το ανοιξω απο εδω!!»): a Needs you card carries the Agent Files it names.
const script: AgentFileRef = { artifactId: "artifact:I2LCjrN6I0I8", name: "YC W27 founder video script.md", folder: "Documents/Funding", mime: "text/markdown" };
const deck: AgentFileRef = { artifactId: "artifact:deckdeck0001", name: "oll4 pitch deck.pdf", folder: "Documents/Funding", mime: "application/pdf" };
const card = (body: string, payload: Record<string, unknown> = {}) => ({ ownerUserId: "user:1", roomId: "room:work000001", paneId: "pane:bob000000001", source: "AGENT" as const,
  kind: "NEEDS_YOU", severity: "ATTENTION" as const, title: "Bob needs you", body, link: { roomId: "room:work000001", paneId: "pane:bob000000001" }, dedupeKey: null,
  payload: { ask: { question: "Record the YC founder video?", answer: { kind: "PANE" } }, ...payload }, telegram: false });

function fixture() {
  const repository = new InMemorySpaceNotificationsRepository();
  const agentFiles = vi.fn(async () => [script, deck]);
  const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
    recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
    nous: { held: async () => false, raised: () => undefined, agentFiles } });
  return { repository, service, agentFiles };
}

describe("Needs you files", () => {
  it("a card raised names its file by folder and words, or by the id its producer gave", async () => {
    const { service } = fixture();
    const named = await service.raise(card("The YC founder video script is in Agent Files › Documents/Funding.\n1. Read it.\n2. Record 1 minute."));
    expect(needsYouFiles(named)).toEqual([script]);
    const given = await service.raise({ ...card("Look at the deck first."), paneId: "pane:bob000000002", payload: { files: ["artifact:deckdeck0001"] } });
    expect(needsYouFiles(given)).toEqual([deck]);
  });

  it("an older card gets its files when Needs you is read, stored once (an empty list too)", async () => {
    const { repository, service, agentFiles } = fixture();
    const { notification: old } = await repository.raise(card("The YC founder video script is in Agent Files › Documents/Funding."));
    const { notification: none } = await repository.raise({ ...card("Approve the invoice."), paneId: "pane:bob000000002" });
    const [listed] = [await service.list("user:1", { status: "NEEDS_YOU", limit: 50 })];
    expect(needsYouFiles(listed.find((record) => record.id === old.id)!)).toEqual([script]);
    expect((await repository.get("user:1", none.id))!.payload.files).toEqual([]);
    expect(agentFiles).toHaveBeenCalledTimes(1);
    await service.list("user:1", { status: "NEEDS_YOU", limit: 50 });
    expect(agentFiles).toHaveBeenCalledTimes(1);
  });
});
