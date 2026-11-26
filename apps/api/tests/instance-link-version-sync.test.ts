import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { fullSyncCommit, registerVersionSyncRoutes, syncLinkVersion, withFullCommit, type VersionSyncAnswer, type VersionSyncState } from "../src/instance-link/version-sync.js";

// Space Link version sync (operator nous_msg:2c4707988f754da5b0719dd5): a linked SpaceApp follows the commit the managing one runs.
const A = "a".repeat(40), B = "b".repeat(40);
const lastOf = (state: VersionSyncState["state"], target = A): VersionSyncState => ({ state, from: B, target, startedAt: "2026-11-15T03:00:00.000Z", finishedAt: null, reason: null });
function peer(answer: Partial<VersionSyncAnswer> | number, post: { status: number; body?: unknown } = { status: 202, body: { status: "started" } }) {
  const calls: string[] = [];
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (method === "POST") return { status: post.status, body: post.body ?? null };
    return typeof answer === "number" ? { status: answer, body: { error: { message: "Not for this device." } } }
      : { status: 200, body: { commit: B, version: "0.2.5", enabled: true, last: null, ...answer } };
  };
  return { call, calls };
}

describe("the managing side asks a linked SpaceApp to follow its commit", () => {
  it("asks one that runs another commit, and shows it running", async () => {
    const { call, calls } = peer({});
    const entry = await syncLinkVersion(call, A);
    expect(calls).toEqual(["GET /api/version-sync", `POST /api/version-sync {"commit":"${A}"}`]);
    expect(entry).toMatchObject({ commit: B, version: "0.2.5", error: null, last: { state: "running", from: B, target: A } });
  });

  it("asks nothing of one already on it, one that cannot update itself, or with no local commit", async () => {
    for (const [answer, local] of [[{ commit: A }, A], [{ enabled: false }, A], [{}, null]] as const) {
      const { call, calls } = peer(answer, { status: 500 });
      await syncLinkVersion(call, local);
      expect(calls).toEqual(["GET /api/version-sync"]);
    }
  });

  it("never asks again for a target it ran, failed or rolled back; asks again after a refusal or for a newer target", async () => {
    for (const state of ["running", "failed", "rolled-back"] as const) {
      const { call, calls } = peer({ last: lastOf(state) });
      expect((await syncLinkVersion(call, A)).last?.state).toBe(state);
      expect(calls).toHaveLength(1);
    }
    for (const last of [lastOf("refused"), lastOf("failed", "c".repeat(40))]) {
      const { call, calls } = peer({ last });
      await syncLinkVersion(call, A);
      expect(calls).toHaveLength(2);
    }
  });

  it("its person's Upgrade asks even after a failure, a rollback or with sync off there, and names the upgrade scope on a 403", async () => {
    for (const answer of [{ last: lastOf("failed") }, { last: lastOf("rolled-back") }, { enabled: false }]) {
      const { call, calls } = peer(answer);
      expect((await syncLinkVersion(call, A, true)).last?.state).toBe("running");
      expect(calls).toHaveLength(2);
    }
    const { call, calls } = peer({ commit: A });
    await syncLinkVersion(call, A, true);
    expect(calls).toHaveLength(1);
    expect((await syncLinkVersion(peer({}, { status: 403, body: { error: { message: "Not for this device." } } }).call, A)).error)
      .toBe("Not for this device. It needs the upgrade scope: its person allows it there in Settings > Account > Devices.");
  });

  it("names why: one built before version sync (403), and its refusal of the ask", async () => {
    expect((await syncLinkVersion(peer(403).call, A)).error).toBe("Not for this device. It updates itself from a link once it runs a version with Space Link version sync.");
    const refused = await syncLinkVersion(peer({}, { status: 409, body: { error: { message: "This SpaceApp is already updating itself." } } }).call, A);
    expect(refused).toMatchObject({ commit: B, error: "This SpaceApp is already updating itself.", last: null });
  });
});

describe("GET and POST /api/version-sync on the linked SpaceApp", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  async function setup(options: { role?: string; enabled?: boolean; failStart?: boolean } = {}) {
    root = await mkdtemp(join(tmpdir(), "version-sync-"));
    await mkdir(join(root, "var"));
    const runs: string[] = [], audits: unknown[] = [];
    const app = Fastify();
    app.addHook("onRequest", async (request) => { request.user = { id: "user:hz", role: options.role ?? "ADMIN" } as never; });
    registerVersionSyncRoutes(app, { store: { recordAuditEvent: async (event: unknown) => { audits.push(event); }, upsertUser: async () => ({ id: "user:hz" }) } as never,
      routeOptions: {}, assertPerson: () => undefined, version: "0.2.5", commit: async () => B, enabled: options.enabled ?? true, root,
      runner: { run: async (file, args) => { runs.push([file, ...args].join(" ")); if (options.failStart) throw new Error("no unit"); return ""; } } });
    return { app, runs, audits };
  }
  const post = (app: Awaited<ReturnType<typeof setup>>["app"], body: unknown) => app.inject({ method: "POST", url: "/api/version-sync", payload: body as object });

  it("writes the target and starts its fixed unit; then answers busy while the script runs, and what it runs with its last state", async () => {
    const { app, runs, audits } = await setup();
    const started = await post(app, { commit: A });
    expect(started.statusCode).toBe(202);
    expect(await readFile(join(root, "var/version-sync-target"), "utf8")).toBe(`${A}\n`);
    expect(runs).toEqual(["/usr/bin/sudo -n /usr/bin/systemctl --no-block start space-version-sync.service"]);
    expect(audits).toHaveLength(1);
    await writeFile(join(root, "var/version-sync.json"), JSON.stringify(lastOf("running")));
    expect((await post(app, { commit: A })).json().error.code).toBe("VERSION_SYNC_BUSY");
    expect((await app.inject({ method: "GET", url: "/api/version-sync" })).json()).toEqual({ commit: B, version: "0.2.5", enabled: true, last: lastOf("running") });
    await app.close();
  });

  it("refuses: not ADMIN, a body other than a full commit id, sync off, a missing unit; answers current for its own commit", async () => {
    expect((await post((await setup({ role: "USER" })).app, { commit: A })).statusCode).toBe(403);
    const { app, runs } = await setup();
    for (const body of [{ commit: "abc" }, { commit: A, extra: 1 }, { commit: A.toUpperCase() }]) expect((await post(app, body)).statusCode).toBe(400);
    expect((await post(app, { commit: B })).json()).toEqual({ status: "current", commit: B });
    expect((await post(app, { commit: B.slice(0, 10) })).json()).toEqual({ status: "current", commit: B });
    expect(runs).toEqual([]);
    const head = await fullSyncCommit(undefined, null);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await fullSyncCommit(head!.slice(0, 10), null)).toBe(head);
    expect(await fullSyncCommit("HEAD", null)).toBe(head);
    expect(await fullSyncCommit("git:HEAD", null)).toBe(head);
    expect(await fullSyncCommit(`commit:${A.slice(0, 8)}`, A)).toBe(A);
    expect(await fullSyncCommit("not-a-sha", A)).toBeNull();
    expect((await post((await setup({ enabled: false })).app, { commit: A })).json().error.code).toBe("VERSION_SYNC_OFF");
    expect((await post((await setup({ failStart: true })).app, { commit: A })).json().error.code).toBe("VERSION_SYNC_UNAVAILABLE");
    expect((await (await setup()).app.inject({ method: "GET", url: "/api/version-sync" })).json().last).toBeNull();
  });
});

describe("a short commit id goes out as the full one (space_remote ×24 in 7 d answered 400)", () => {
  it("resolves a short id, passes a full one and refuses one this repository does not know", async () => {
    const known = async (short: string) => (A.startsWith(short) ? A : null);
    await expect(withFullCommit({ commit: "AAAAAAA" }, known)).resolves.toEqual({ commit: A });
    await expect(withFullCommit({ commit: B }, known)).resolves.toEqual({ commit: B });
    await expect(withFullCommit({ commit: "bbbbbbb" }, known)).rejects.toThrow(/Not sent: commit bbbbbbb is not a commit/);
  });
});
