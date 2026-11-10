import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerServerOpsRoutes, type ServerOpsRunner } from "../src/server-ops-routes.js";

let app: FastifyInstance | undefined;
let queueRoot: string | undefined;
afterEach(async () => {
  await app?.close();
  if (queueRoot) await rm(queueRoot, { recursive: true, force: true });
});

async function build({ managedHere = true, busy = false, refuse = false } = {}) {
  queueRoot = await mkdtemp(join(tmpdir(), "server-ops-queue-"));
  await mkdir(join(queueRoot, "tickets"));
  if (busy) await writeFile(join(queueRoot, "tickets", "q-20261106-000000-aaaa.json"), JSON.stringify({ id: "q-20261106-000000-aaaa", status: "DEPLOYING", submittedAt: "2026-11-06T00:00:00Z" }));
  const calls: string[] = [];
  const audits: string[] = [];
  const runner: ServerOpsRunner = {
    run: async (file, args) => {
      calls.push([file, ...args].join(" "));
      if (args[0] === "show") return "ActiveState=inactive\nResult=success\nExecMainStartTimestamp=@1793934000\nExecMainExitTimestamp=@1793934060\n";
      if (refuse && args[1] === "assert-restart-safe") throw Object.assign(new Error("exit 2"), { stderr: '{"ok":false,"code":"CLI_HOST_ACTIVE_SESSIONS","activeSessionCount":3}' });
      return "";
    },
    cleanWorktrees: async (excludePaths) => ({ cleaned: [{ path: "/w/a", branch: "a", reason: "merged" }], preserved: excludePaths.map((path) => ({ path, branch: "b", reason: "open pane" })) })
  };
  app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"];
    (request as unknown as { user: unknown }).user = role ? { id: "user:operator", email: "operator@example.invalid", role } : null;
  });
  const store = {
    upsertUser: async (user: { id: string }) => user, recordAuditEvent: async (event: { action: string }) => { audits.push(event.action); },
    listRooms: async () => [{ id: "room:1" }], listPanes: async () => [{ cwd: "/w/open" }, { cwd: null }]
  } as never;
  registerServerOpsRoutes(app, { store, managedHere, queueRoot, routeOptions: {}, runner });
  await app.ready();
  const call = (method: "GET" | "POST", url: string, payload?: object, role = "ADMIN") =>
    app!.inject({ method, url: `/api/admin/server-ops${url}`, headers: role ? { "x-test-role": role } : {}, ...(payload ? { payload } : {}) });
  return { call, calls, audits };
}

describe("server operations (Nous Settings, nous_msg:5249d11d)", () => {
  it("reads status and runs each operation through its fixed guarded command, audited", async () => {
    const { call, calls, audits } = await build();
    expect((await call("GET", "")).json()).toMatchObject({ managedHere: true, queueActive: false, cleanDisk: { state: "idle", result: "success", finishedAt: new Date(1793934060_000).toISOString() }, deployRemotes: { lines: [] } });
    expect((await call("POST", "/clean-disk")).statusCode).toBe(202);
    expect(calls).toContain("/usr/bin/sudo -n /usr/bin/systemctl --no-block start space-retention.service");
    expect((await call("POST", "/deploy-remotes")).statusCode).toBe(202);
    expect(calls).toContain("/usr/bin/sudo -n /usr/bin/systemctl --no-block start space-deploy-remotes.service");
    const worktrees = await call("POST", "/clean-worktrees");
    expect(worktrees.json()).toMatchObject({ status: "DONE", preserved: [{ path: "/w/open" }] });
    const restart = await call("POST", "/restart", { service: "pane-hosts" });
    expect(restart.json()).toMatchObject({ status: "RESTARTED", service: "pane-hosts" });
    expect(calls.filter((line) => line.includes("assert-restart-safe") && !line.includes("--allow-active-sessions"))).toHaveLength(2);
    expect(calls).toContain("/usr/bin/sudo -n /usr/bin/systemctl restart space-admin-pane-host.service");
    expect(audits).toEqual(["server_ops.clean-disk", "server_ops.deploy-remotes", "server_ops.clean-worktrees", "server_ops.restart"]);
  });

  it("refuses without ADMIN, on dev, with a busy stable queue, an unknown service, and when the restart guard refuses", async () => {
    expect((await (await build()).call("POST", "/clean-disk", undefined, "OPERATOR")).statusCode).toBe(403);
    expect((await (await build({ managedHere: false })).call("POST", "/clean-disk")).json().error.code).toBe("NOT_MANAGED_HERE");
    const busy = await build({ busy: true });
    expect((await busy.call("POST", "/restart", { service: "browser-host" })).json().error.code).toBe("QUEUE_BUSY");
    expect(busy.calls.some((line) => line.includes("restart"))).toBe(false);
    expect((await (await build()).call("POST", "/restart", { service: "space-api" })).statusCode).toBe(400);
    const refused = await build({ refuse: true });
    const answer = await refused.call("POST", "/restart", { service: "pane-hosts" });
    expect(answer.json().error).toMatchObject({ code: "HOST_BUSY", message: "Not restarted: 3 sessions are running on it." });
    expect(refused.calls.some((line) => line.includes("systemctl restart"))).toBe(false);
  });
});
