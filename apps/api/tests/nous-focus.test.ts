import { describe, expect, it } from "vitest";
import { eventSchema, nousFocusRequestPayloadSchema, type Event, type Pane, type Room } from "@space/contracts";
import { createNousFocus, focusPaneSchema, FOCUS_PANE_MIN_INTERVAL_MS } from "../src/nous/focus.js";

const room = { id: "room:focus000001", name: "Main" } as Room;
const pane = { id: "pane:focus000001", roomId: room.id, title: "Freelance", paneName: "Emma" } as Pane;

describe("space_focus_pane", () => {
  it("publishes ids only, for the owner, and at most once a minute", () => {
    const published: Event[] = [];
    let clock = Date.parse("2026-10-17T10:00:00.000Z");
    const focus = createNousFocus({ eventBus: { publish: (event) => published.push(event) }, now: () => clock });

    const first = focus.request("user:operator", room, pane, "CAPTCHA on Upwork");
    expect(first.ok).toBe(true);
    expect(published).toHaveLength(1);
    const event = eventSchema.parse(published[0]);
    expect(event).toMatchObject({ type: "NOUS_FOCUS_REQUESTED", roomId: room.id, paneId: pane.id });
    expect(Object.keys(nousFocusRequestPayloadSchema.parse(event.payload)).sort()).toEqual(["ownerUserId", "paneId", "requestId", "roomId"]);
    expect(JSON.stringify(event)).not.toContain("CAPTCHA");

    clock += FOCUS_PANE_MIN_INTERVAL_MS - 1;
    expect(focus.request("user:operator", room, pane, "again")).toMatchObject({ ok: false, refused: true });
    expect(focus.request("user:other", room, pane, "another owner")).toMatchObject({ ok: true });
    clock += 1;
    expect(focus.request("user:operator", room, pane, "later")).toMatchObject({ ok: true });
    expect(published).toHaveLength(3);
  });

  it("needs a reason", () => {
    expect(focusPaneSchema.safeParse({ room: "Main", pane: "Emma" }).success).toBe(false);
    expect(focusPaneSchema.safeParse({ room: "Main", pane: "Emma", reason: "Sign in to Upwork" }).success).toBe(true);
  });
});
