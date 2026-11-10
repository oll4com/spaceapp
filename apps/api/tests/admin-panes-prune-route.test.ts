import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

// POST /api/admin/panes/prune left app.ts for admin-cleanup-routes.ts (ARCH-001 step 38); this pins what it answers.
describe("POST /api/admin/panes/prune", () => {
  const sessionSecret = "panes-prune-route-secret";
  function headers(role: "OPERATOR" | "ADMIN") {
    const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
    return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
  }

  it("lets only ADMIN prune, defaults to 24 hours and records the audit", async () => {
    const store = new InMemorySpaceStore();
    const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false } });
    try {
      const refused = await app.inject({ method: "POST", url: "/api/admin/panes/prune", headers: headers("OPERATOR"), payload: {} });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("ADMIN_REQUIRED");

      const pruned = await app.inject({ method: "POST", url: "/api/admin/panes/prune", headers: headers("ADMIN"), payload: {} });
      expect(pruned.statusCode).toBe(200);
      expect(pruned.json()).toEqual({ deletedPanes: 0, olderThanHours: 24 });

      const inRoom = await app.inject({ method: "POST", url: "/api/admin/panes/prune", headers: headers("ADMIN"), payload: { olderThanHours: 2, roomId: "room:x" } });
      expect(inRoom.json()).toEqual({ deletedPanes: 0, olderThanHours: 2, roomId: "room:x" });
      expect((await store.listAuditEvents()).filter((event) => event.action === "pane.prune").map((event) => event.targetId).sort()).toEqual(["global", "room:x"]);
    } finally {
      await app.close();
    }
  });
});
