// Daily Nous errors 13/11 (agent card 079c6e5a, AWS root code): a pane agent's card held for Nous is shown when Nous forwards it, refused only once shown.
import { describe, expect, it } from "vitest";
import { eventSchema, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { createNousPaneNotices } from "../src/nous/pane-notices.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const room = { id: "room:felix", name: "Felix", kind: "WORKSPACE", ownerUserId: owner } as Room;
const pane = { id: "pane:felix-bob", roomId: room.id, title: "Bob", paneName: "Bob", mode: "TERMINAL", isClosed: false } as unknown as Pane;

describe("Nous forwarding a pane agent's card held for it", () => {
  it("shows the held card with Nous's note and pick, then refuses a second forward", async () => {
    const service = createNotificationService({ repository: new InMemorySpaceNotificationsRepository(), eventBus: new SpaceEventBus(), userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: new Date().toISOString() }),
      nous: { held: async () => true, raised: () => undefined, holdsCopilotQuestions: async () => true } });
    const card = await service.raise({ ownerUserId: owner, roomId: room.id, paneId: pane.id, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", title: "AWS root sign-in",
      body: "Type the authenticator code for the AWS root account.", link: { roomId: room.id, paneId: pane.id }, dedupeKey: `agent:needs-you:${pane.id}`, telegram: false,
      payload: { ask: { question: "Is the code typed?", options: ["Done", "Need links/steps"], answer: { kind: "PANE" } } } });
    const shown = async () => (await service.list(owner, { status: "NEEDS_YOU", limit: 50 })).map((item) => item.id);
    expect(card.payload.heldForNous).toBeTruthy();
    expect(await shown()).not.toContain(card.id);

    const nous = createNousTools({ rooms: async () => [room], listPanes: async () => [pane], notifications: service,
      paneNotices: createNousPaneNotices({ notifications: service }) } as unknown as NousToolDeps);
    const forward = { room: "Felix", pane: "Bob", reason: "The AWS root sign-in waits for your authenticator code", ref: card.id, question: "Is the code typed?",
      options: ["Done", "Need links/steps"], recommended: "Need links/steps", checked: ["Vault: no TOTP stored for the AWS root account"] };
    const answer = await nous.execute("space_focus_pane", forward, ctx);
    expect(answer).toMatchObject({ ok: true, display: "Showed the pane's held card to the operator" });
    expect(await shown()).toContain(card.id);
    const released = (await service.get(owner, card.id))!;
    expect(released.payload.heldForNous).toBeUndefined();
    expect(released.body).toMatch(/^Nous: The AWS root sign-in waits/);
    expect(released.payload.ask).toMatchObject({ recommended: "Need links/steps" });

    expect(await nous.execute("space_focus_pane", forward, ctx)).toMatchObject({ ok: false, display: "The pane's own card is open" });
  });
});
