import { describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PostgresSourceControlRepository } from "../../../packages/db/src/source-control-repository.js";

// Requires initdb/pg_ctl on PATH. This test owns a temporary cluster and never reads a DB URL.
let available = true;
try { execFileSync("initdb", ["--version"], { stdio: "ignore" }); } catch { available = false; }
describe("repository provider migration on PostgreSQL", () => {
  it.skipIf(!available)("preserves legacy identity, credentials and defaults while extending personal providers", async () => {
    const scratch = "/var/lib/spaceapp-user/agent-workspace/reports/repository-provider-test-fixtures";
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, "pg-"));
    const data = join(root, "data"), socket = join(root, "socket");
    await mkdir(socket);
    let started = false;
    let client: pg.Client | undefined;
    let watchdog: ChildProcess | undefined;
    try {
      execFileSync("initdb", ["-D", data, "-U", "fixture", "--auth=trust", "--no-locale", "--encoding=UTF8"], { stdio: "pipe", timeout: 30000 });
      // pg_ctl detaches the server, so a killed or timed-out worker never reaches
      // `finally`. This detached watchdog stops the cluster and removes the scratch
      // directory once the worker is gone; `finally` cancels it on a normal exit.
      watchdog = spawn("sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; pg_ctl -D "$2" -m immediate -w stop >/dev/null 2>&1; rm -rf "$3"',
        "pg-fixture-watchdog", String(process.pid), data, root], { detached: true, stdio: "ignore" });
      watchdog.unref();
      execFileSync("pg_ctl", ["-D", data, "-l", join(root, "server.log"), "-o", `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700`, "-w", "start"], { stdio: "pipe", timeout: 30000 });
      started = true;
      client = new pg.Client({ host: socket, user: "fixture", database: "postgres" });
      await client.connect();
      await client.query("CREATE TABLE users(id text PRIMARY KEY); INSERT INTO users VALUES ('user:a'),('user:b'); CREATE TABLE admin_fixture(provider text CHECK(provider IN ('github','gitea')), data jsonb); INSERT INTO admin_fixture VALUES ('github','{\"credentialRef\":\"admin-fixture\"}');");
      await client.query(await readFile(new URL("../../../packages/db/migrations/0127_personal_source_control.sql", import.meta.url), "utf8"));
      const legacy = { ownerUserId: "user:a", provider: "gitea", serverUrl: "https://forge.example.test", credentialRef: "encrypted-fixture-reference", status: "CONNECTED", accountLogin: "fixture", connectedAt: "2026-10-01T00:00:00.000Z", checkedAt: null, error: null };
      const binding = { id: "binding:legacy", ownerUserId: "user:a", projectPath: "/workspace/project", provider: "gitea", serverUrl: legacy.serverUrl,
        repository: { id: "legacy-remote-42", fullName: "fixture/repository", cloneUrl: `${legacy.serverUrl}/fixture/repository.git`, webUrl: `${legacy.serverUrl}/fixture/repository`,
          private: true, defaultBranch: "stable", permissions: { pull: true, push: true, admin: false } }, isDefault: true };
      await client.query("INSERT INTO personal_git_connections VALUES ($1,$2,$3)", ["user:a", "gitea", legacy]);
      await client.query("INSERT INTO personal_git_connections VALUES ($1,$2,$3)", ["user:b", "github", { ...legacy, ownerUserId: "user:b", provider: "github", enabled: false }]);
      await client.query("INSERT INTO project_repository_bindings VALUES ($1,$2,$3,$4)", [binding.id, binding.ownerUserId, binding.projectPath, binding]);
      await expect(client.query("INSERT INTO personal_git_connections VALUES ('user:a','gitlab','{}')")).rejects.toMatchObject({ code: "23514" });
      const sql = await readFile(new URL("../../../packages/db/migrations/0148_repository_providers.sql", import.meta.url), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      expect((await client.query("SELECT data FROM personal_git_connections WHERE owner_user_id='user:a'")).rows[0].data).toEqual({ ...legacy, enabled: true });
      expect((await client.query("SELECT data FROM personal_git_connections WHERE owner_user_id='user:b'")).rows[0].data.enabled).toBe(false);
      expect((await client.query("SELECT data FROM project_repository_bindings")).rows[0].data).toEqual({ ...binding, kind: "provider" });
      const repository = new PostgresSourceControlRepository(client);
      for (const provider of ["forgejo", "gitlab", "bitbucket", "azure-devops"] as const) {
        await repository.saveConnection({ ...legacy, provider, enabled: false, status: "NOT_CONNECTED", credentialRef: null });
        expect(await repository.getConnection("user:a", provider)).toMatchObject({ provider, enabled: false });
        expect(await repository.getConnection("user:b", provider)).toBeNull();
      }
      expect(await repository.getBinding("user:a", binding.id)).toEqual({ ...binding, kind: "provider" });
      expect(await repository.getBinding("user:b", binding.id)).toBeNull();
      expect((await client.query("SELECT data FROM admin_fixture")).rows[0].data).toEqual({ credentialRef: "admin-fixture" });
      await expect(client.query("INSERT INTO personal_git_connections VALUES ('user:a','unknown','{}')")).rejects.toMatchObject({ code: "23514" });
      await expect(client.query("INSERT INTO admin_fixture VALUES ('gitlab','{}')")).rejects.toMatchObject({ code: "23514" });
      // Publish claims survive service restarts and enforce a single create per binding.
      await client.query(await readFile(new URL("../../../packages/db/migrations/0149_repository_publish_operations.sql", import.meta.url), "utf8"));
      const operation = { ownerUserId: "user:a", bindingId: binding.id, operationId: "fixture-publish", fingerprint: "fixture-fingerprint", state: "creating" as const, remote: null, errorCode: null, createdAt: new Date().toISOString() };
      expect(await repository.claimPublish(operation)).toBe(true);
      const restarted = new PostgresSourceControlRepository(client);
      expect(await restarted.claimPublish({ ...operation, operationId: "competing-operation" })).toBe(false);
      expect(await restarted.getPublish("user:b", binding.id)).toBeNull();
      expect(await restarted.getPublish("user:a", binding.id)).toEqual(operation);
      await restarted.finishPublish({ ...operation, state: "created", remote: binding.repository });
      expect(await repository.getPublish("user:a", binding.id)).toMatchObject({ state: "created", remote: binding.repository });
      await expect(restarted.finishPublish({ ...operation, ownerUserId: "user:b", state: "unknown" })).rejects.toThrow();
      expect(await repository.claimPublish({ ...operation, operationId: "retry-after-success" })).toBe(false);
      const recoveryBinding = { ...binding, id: "binding:recover", repository: null };
      await repository.saveBinding(recoveryBinding);
      const rejected = { ...operation, bindingId: recoveryBinding.id };
      expect(await repository.claimPublish(rejected)).toBe(true);
      await repository.finishPublish({ ...rejected, state: "rejected", errorCode: "REPOSITORY_COLLISION" });
      expect(await restarted.claimPublish(rejected)).toBe(false);
      const replacement = { ...rejected, operationId: "explicit-new-operation", fingerprint: "new-name" };
      expect(await restarted.claimPublish(replacement)).toBe(true);
      await restarted.finishPublish({ ...replacement, state: "unknown" });
      expect(await repository.getPublish("user:a", recoveryBinding.id)).toMatchObject({ state: "unknown", previousOperationIds: ["fixture-publish"] });
      expect(await restarted.claimPublish({ ...replacement, operationId: "retry-unknown" })).toBe(false);
      // Backfill and constraint replacement are safe on replay, without changing an explicit opt-out.
      await client.query(sql);
      expect((await client.query("SELECT data FROM personal_git_connections WHERE owner_user_id='user:b'")).rows[0].data.enabled).toBe(false);
    } finally {
      watchdog?.kill();
      await client?.end();
      if (started) execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "pipe", timeout: 30000 });
      await rm(root, { recursive: true, force: true });
    }
  }, 90000);
});
