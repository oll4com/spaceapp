import { InMemorySpaceStore } from "@space/runtime";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { createSessionAccess } from "../src/session-access.js";

const log = { warn: () => undefined } as unknown as FastifyBaseLogger;

// EXT-C-F9: the role signed into a long-lived token never stands on its own; the store's row decides.
describe("session access role", () => {
  it("gives a token with no user row (a deleted account) the least-privileged role", async () => {
    const access = createSessionAccess({ store: new InMemorySpaceStore(), durableUsers: true });
    const user = await access.resolve({ id: "user:gone", email: "gone@example.com", role: "ADMIN" }, log);
    expect(user?.role).toBe("USER");
    expect(access.roleCache.get("user:gone")?.role).toBe("USER");
  });

  it("takes the role of the row holding the session's e-mail when its id has none (the broker's diagnostics session)", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "Owner@example.com", role: "ADMIN" });
    const access = createSessionAccess({ store, durableUsers: true });
    const user = await access.resolve({ id: "user:operator-diagnostics", email: "owner@example.com", role: "ADMIN" }, log);
    expect(user?.role).toBe("ADMIN");
  });

  it("prefers the session's own row over its e-mail and replaces the token's role", async () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:member", email: "m@example.com", role: "USER" });
    const access = createSessionAccess({ store });
    expect((await access.resolve({ id: "user:member", email: "m@example.com", role: "ADMIN" }, log))?.role).toBe("USER");
  });

  it("keeps the token's role for a missing row when the store's rows do not outlive a restart (memory store)", async () => {
    const access = createSessionAccess({ store: new InMemorySpaceStore() });
    expect((await access.resolve({ id: "user:after-restart", email: "a@example.com", role: "ADMIN" }, log))?.role).toBe("ADMIN");
    expect(access.roleCache.has("user:after-restart")).toBe(false);
  });
});
