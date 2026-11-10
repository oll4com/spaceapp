import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSpacePgPool } from "../../../packages/db/src/space-store.js";
import { PostgresLiveHistoryRepository, type LiveHistoryTurn } from "../../../packages/db/src/live-history-repository.js";
import { disposablePostgresUnavailableReason } from "../../../packages/db/tests/support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

/** Same image as the production compose file (PostgreSQL 17 + pgvector); tests never pull. */
const POSTGRES_IMAGE = process.env.SPACE_TEST_PG_IMAGE ?? "pgvector/pgvector:0.8.7-pg17-trixie";

// Real PostgreSQL, owned synthetic data only. Never reads production config.
// The image must already exist locally; tests never pull or install software.
describe.skipIf(postgresUnavailable)("Live conversation PostgreSQL durability", () => {
  const name = `space-live-history-proof-${randomUUID()}`;
  let created = false, directory: string, url: string, pool: ReturnType<typeof createSpacePgPool>;
  let repository: PostgresLiveHistoryRepository;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const connect = async () => {
    pool = createSpacePgPool(url, { max: 6 });
    repository = new PostgresLiveHistoryRepository(pool);
    let failure = "unknown";
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        // The image's temporary init server also accepts SQL, then shuts down.
        // Wait for PID 1 to become the final server before applying migrations.
        if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error("Initializing proof database.");
        await pool.query("SELECT 1"); return;
      }
      catch (error) { failure = error instanceof Error ? error.message : "unknown"; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw Error(`Owned PostgreSQL proof container did not become ready: ${failure}. ${docker(["logs", "--tail", "5", name])}`);
  };
  beforeAll(async () => {
    docker(["image", "inspect", POSTGRES_IMAGE, "--format", "{{.Id}}"]);
    directory = await mkdtemp(`${tmpdir()}/space-pg-`);
    const socket = `${directory}/pg-socket`;
    await mkdir(socket, { mode: 0o777 });
    docker(["run", "--detach", "--rm", "--pull=never", "--name", name,
      "--label", "space.agent.task=ai-live-history-proof", "--network", "none",
      "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_IMAGE, "-c", "listen_addresses="]);
    created = true;
    url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`;
    await connect();
    await pool.query(await readFile(new URL("../../../packages/db/migrations/0117_live_conversation_history.sql", import.meta.url), "utf8"));
  }, 60_000);
  afterAll(async () => {
    try { await repository?.dispose(); }
    finally {
      if (created) {
        try { docker(["exec", "--user", "root", name, "chmod", "0777", "/var/run/postgresql"]); }
        finally { docker(["rm", "--force", "--volumes", name]); }
      }
      if (directory) await rm(directory, { force: true, recursive: true });
    }
  });
  const turn = (id: string, roomId = "room:synthetic-a", revision = 1): LiveHistoryTurn => ({
    id, sessionId: "session:synthetic", roomId, revision, role: "user", text: `Δοκιμή ${id}, έκδοση ${revision}`,
    createdAtMs: 1_790_000_000_000 + Number(id.replace(/\D/g, "") || 0), timestamp: "synthetic"
  });

  it("retains 24 ordered turns across database restart, isolates owners and deduplicates retries", async () => {
    for (let index = 0; index < 24; index++) expect(await repository.write("owner:a", turn(`turn:${index}`), 0)).toBe(true);
    expect(await repository.write("owner:b", turn("turn:0"), 0)).toBe(true);
    await Promise.all(Array.from({ length: 6 }, () => repository.write("owner:a", turn("turn:0", undefined, 2), 0)));
    expect(await repository.write("owner:a", turn("turn:0"), 0)).toBe(true);
    expect(await repository.write("owner:a", turn("turn:0", "room:other", 3), 0)).toBe(false);
    await repository.dispose();
    docker(["restart", "--time", "5", name]);
    await connect();
    const restored = await repository.read("owner:a");
    expect(restored.items.map(item => item.id)).toEqual(Array.from({ length: 24 }, (_, index) => `turn:${index}`));
    expect(restored.items[0]!.revision).toBe(2);
    expect((await repository.read("owner:b")).items).toHaveLength(1);
    expect((await repository.read("owner:c")).items).toEqual([]);
  }, 60_000);

  it("serializes clear against concurrent writes and keeps tombstones through reconnection", async () => {
    const room = "room:synthetic-clear";
    await repository.write("owner:a", turn("clear:0", room), 0);
    const [epoch] = await Promise.all([
      repository.clear("owner:a", room),
      ...Array.from({ length: 12 }, (_, index) => repository.write("owner:a", turn(`clear:${index}`, room), 0))
    ]);
    expect(epoch).toBe(1);
    expect((await repository.read("owner:a", room)).items).toEqual([]);
    await repository.dispose(); await connect();
    expect(await repository.write("owner:a", turn("clear:late", room), 0)).toBe(false);
    await repository.importLegacy("owner:a", room, [turn("legacy", room)]);
    expect((await repository.read("owner:a", room)).items).toEqual([]);
    expect(await repository.write("owner:a", turn("new", room), epoch)).toBe(true);
    expect((await repository.read("owner:a", room)).items.map(item => item.id)).toEqual(["new"]);
    expect((await repository.read("owner:a", room)).epochs[room]).toBe(1);
  });
});
