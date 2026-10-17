import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { mayCreateCliSessionDirectory, mayCreatePaneDirectory, resolveProjectEnsureTarget } from "../src/project-paths.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("project ensure path policy", () => {
  let base: string;
  let install: string;
  let projects: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-project-ensure-"));
    install = join(base, "install");
    projects = join(install, "projects");
    await mkdir(projects, { recursive: true });
  });
  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const resolveFor = (role: string | null, input: { name?: string; path?: string }) =>
    resolveProjectEnsureTarget({ ...input, role, projectsRoot: projects, installRoot: install });

  it("creates named projects under the projects root for every role", async () => {
    await expect(resolveFor("USER", { name: "demo_app-1" })).resolves.toEqual({ ok: true, path: join(projects, "demo_app-1"), name: "demo_app-1" });
    await expect(resolveFor("USER", { name: "../etc" })).resolves.toMatchObject({ ok: false, code: "INVALID_PROJECT_NAME" });
    await expect(resolveFor("USER", {})).resolves.toMatchObject({ ok: false, code: "INVALID_PROJECT_PATH" });
  });

  it("limits arbitrary locations to ADMIN or OPERATOR and refuses system or install paths", async () => {
    const custom = join(base, "custom", "project");
    await expect(resolveFor("USER", { path: custom })).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(resolveFor("OPERATOR", { path: custom })).resolves.toMatchObject({ ok: true, path: custom });
    await expect(resolveFor("ADMIN", { path: "relative/project" })).resolves.toMatchObject({ ok: false, code: "INVALID_PROJECT_PATH" });
    for (const path of ["/", "/etc", "/etc/space-project", "/usr/local/project", "/home", "/srv", "/tmp", "/var/lib/project", install, join(install, "apps"), projects]) {
      await expect(resolveFor("ADMIN", { path }), path).resolves.toMatchObject({ ok: false, status: 403 });
    }
  });

  it("evaluates symlinked parents by their real location", async () => {
    const link = join(base, "link-to-install");
    await symlink(install, link);
    await expect(resolveFor("ADMIN", { path: join(link, "apps", "new") })).resolves.toMatchObject({ ok: false, status: 403 });
    await expect(resolveFor("USER", { path: join(link, "projects", "via-link") })).resolves.toMatchObject({ ok: true });
  });

  it("creates missing pane directories only for projects, worktrees or approved operator paths (SEC-009)", async () => {
    const worktrees = join(install, "var", "worktrees");
    await mkdir(worktrees, { recursive: true });
    const decide = (role: string | null, cwd: string) =>
      mayCreatePaneDirectory({ cwd, role, projectsRoot: projects, installRoot: install, worktreesRoot: worktrees });
    await expect(decide("USER", join(projects, "new-app"))).resolves.toBe(true);
    await expect(decide("USER", join(worktrees, "space", "wt-new"))).resolves.toBe(true);
    await expect(decide("USER", join(base, "elsewhere", "dir"))).resolves.toBe(false);
    await expect(decide("ADMIN", join(base, "elsewhere", "dir"))).resolves.toBe(true);
    for (const cwd of ["/etc/space-pane", "/usr/lib/space-pane", join(install, "apps", "new"), worktrees, "relative/dir"]) {
      await expect(decide("ADMIN", cwd), cwd).resolves.toBe(false);
    }
  });

  it("lets a CLI session create a missing folder only in the workspace root or where a pane may (SEC-009)", async () => {
    // 1.1.5 internal review: the session start and terminal attach ran mkdir -p on any requested cwd.
    const worktrees = join(install, "var", "worktrees");
    const workspaces = join(base, "workspaces");
    await mkdir(worktrees, { recursive: true });
    const decide = (role: string | null, cwd: string) => mayCreateCliSessionDirectory({
      cwd, role, projectsRoot: projects, installRoot: install, worktreesRoot: worktrees, workspaceRoot: workspaces
    });
    await expect(decide(null, join(workspaces, "room-abc"))).resolves.toBe(true);
    await expect(decide(null, join(projects, "new-app"))).resolves.toBe(true);
    await expect(decide(null, join(base, "elsewhere", "dir"))).resolves.toBe(false);
    await expect(decide(null, join(workspaces, "..", "outside"))).resolves.toBe(false);
    for (const cwd of ["/etc/space-session", join(install, "apps", "new"), "relative/dir"]) {
      await expect(decide("ADMIN", cwd), cwd).resolves.toBe(false);
    }
  });

  it("enforces the policy on the HTTP route", async () => {
    const secret = "project-ensure-test-secret";
    const store = new InMemorySpaceStore();
    const app = await createApp({
      store,
      config: getApiConfig({ SPACE_PROJECTS_ROOT: projects, SPACE_INSTALL_ROOT: install, SPACE_LOG_LEVEL: "silent" }),
      auth: { sessionSecret: secret, devLogin: false, secureCookies: false }
    });
    const headersFor = (role: "USER" | "ADMIN") => {
      const user = { id: `user:${role.toLowerCase()}-ensure`, role, email: `${role.toLowerCase()}@space.local` };
      store.upsertUser(user);
      const session = signSession(user, secret);
      return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, secret)! };
    };
    try {
      const denied = await app.inject({ method: "POST", url: "/api/projects/ensure", headers: headersFor("USER"), payload: { path: join(base, "user-elsewhere") } });
      expect(denied.statusCode).toBe(403);
      expect(await exists(join(base, "user-elsewhere"))).toBe(false);

      const named = await app.inject({ method: "POST", url: "/api/projects/ensure", headers: headersFor("USER"), payload: { name: "named-project" } });
      expect(named.statusCode).toBe(200);
      expect(named.json()).toMatchObject({ ok: true, path: join(projects, "named-project"), name: "named-project" });
      expect(await exists(join(projects, "named-project", ".git"))).toBe(true);

      const system = await app.inject({ method: "POST", url: "/api/projects/ensure", headers: headersFor("ADMIN"), payload: { path: "/etc/space-ensure-probe" } });
      expect(system.statusCode).toBe(403);
      expect(await exists("/etc/space-ensure-probe")).toBe(false);

      // Updating a room's project path creates a missing directory only where the same policy allows.
      const room = store.createRoom({ name: "Room path policy", initialPaneCount: 0 });
      const patchRoom = (projectPath: string) => app.inject({ method: "PATCH", url: `/api/rooms/${encodeURIComponent(room.id)}`,
        headers: headersFor("ADMIN"), payload: { name: "Room path policy", projectPath } });
      for (const refused of [join(install, "apps-probe"), "/etc/space-room-probe"]) {
        const response = await patchRoom(refused);
        // The path is recorded, but no directory is created outside the policy.
        expect(response.statusCode, refused).toBe(200);
        expect(await exists(refused), refused).toBe(false);
      }
      const allowed = await patchRoom(join(projects, "room-project"));
      expect(allowed.statusCode).toBe(200);
      expect(await exists(join(projects, "room-project"))).toBe(true);
    } finally {
      await app.close();
    }
  });
});
