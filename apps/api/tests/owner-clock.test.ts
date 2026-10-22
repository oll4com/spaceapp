import { expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { ownerClockLine } from "../src/owner-clock.js";

it("gives the owner's working time zone and local time for an agent's turn", async () => {
  const store = new InMemorySpaceStore();
  store.updateUserSettings("user:operator", { dateTime: { timeZone: "Asia/Bangkok" } });
  const line = await ownerClockLine(store, "user:operator", new Date("2026-10-17T12:00:00Z"));
  expect(line).toBe("The operator's working time zone is Asia/Bangkok; their local time now is Sat, 17 Oct 2026, 19:00 GMT+7. Write every time to them in this zone.");
  store.updateUserSettings("user:operator", { dateTime: { timeZone: "system" } });
  expect(await ownerClockLine(store, "user:operator", new Date("2026-10-17T12:00:00Z"))).toContain("is UTC;");
});
