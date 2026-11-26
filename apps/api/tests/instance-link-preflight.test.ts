// Plan clipboard:1NF6u6gcCwtj step 4 (15/11): what a linked SpaceApp would refuse (its link body rule, its route's schema, a room it does not
// hold) is caught here before the request leaves.
import { expect, it } from "vitest";
import { LINK_ROUTE_SCOPES } from "@space/contracts";
import { linkBodyProblem, roomMissing, roomOf } from "../src/instance-link/preflight.js";

const inspect = LINK_ROUTE_SCOPES["POST /api/control/v1/inspect"]!;
const commands = LINK_ROUTE_SCOPES["POST /api/control/v1/commands"]!;

it("refuses a body the other side would refuse, and passes one it takes", () => {
  expect(linkBodyProblem(inspect, "POST", "/api/control/v1/inspect", { section: "CLIPBOARD" }, ["read", "act"])).toMatch(/^A SpaceApp link reads only /);
  expect(linkBodyProblem(inspect, "POST", "/api/control/v1/inspect", { section: "ROOMS", rooms: true }, ["read"])).toMatch(/Unrecognized key/);
  expect(linkBodyProblem(inspect, "POST", "/api/control/v1/inspect", { section: "ROOMS" }, ["read"])).toBeNull();
  expect(linkBodyProblem(commands, "POST", "/api/control/v1/commands", { roomId: "room:a", actions: [{ kind: "pane", operation: "stop", target: { state: "ALL" } }] }, ["read", "act"]))
    .toMatch(/^requestId: /);
  expect(linkBodyProblem(commands, "POST", "/api/control/v1/commands", { roomId: "room:a", requestId: "req:1", actions: [{ kind: "pane", operation: "stop", confirm: true }] }, ["act"]))
    .toBe("A SpaceApp link cannot approve for this SpaceApp's operator; they approve here.");
  expect(linkBodyProblem(commands, "POST", "/api/control/v1/commands", { roomId: "room:a", requestId: "req:1", actions: [{ paneId: "pane:x", action: "stop" }] }, ["act"])).toBeNull();
  expect(linkBodyProblem({ scope: "read" }, "GET", "/api/rooms", undefined, ["read"])).toBeNull();
});

it("names the room a request needs, and checks it against the other side's rooms, read again on a miss", async () => {
  expect(roomOf("/api/control/v1/commands", { roomId: "room:a" })).toBe("room:a");
  expect(roomOf("/api/rooms/room:b/agent-files/chunks", {})).toBe("room:b");
  expect(roomOf("/api/control/v1/inspect", { section: "ROOMS" })).toBeNull();
  const known = new Map<string, Set<string>>();
  let reads = 0;
  let rooms: unknown = [{ id: "room:a", name: "Main" }];
  const read = async () => { reads += 1; return rooms; };
  expect(await roomMissing(known, "link:one", "room:a", read)).toBeNull();
  expect(await roomMissing(known, "link:one", "room:a", read)).toBeNull();
  expect(reads).toBe(1);
  expect(await roomMissing(known, "link:one", "room:zz", read)).toBe("has no room room:zz. Its rooms: Main (room:a).");
  rooms = { rooms: [{ id: "room:a", name: "Main" }, { id: "room:zz", name: "New" }] };
  expect(await roomMissing(known, "link:one", "room:zz", read)).toBeNull();
  expect(await roomMissing(known, "link:two", "room:q", async () => { throw new Error("down"); })).toBeNull();
  expect(await roomMissing(known, "link:two", "room:q", async () => null)).toBeNull();
});
