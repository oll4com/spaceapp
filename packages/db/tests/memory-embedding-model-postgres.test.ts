import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSpacePgPool, PostgresSpaceStore } from "../src/space-store.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresDotMemoryRepository } from "../src/dot-memory-repository.js";
import { PostgresDotsRepository } from "../src/dots-repository.js";
import { disposablePostgresUnavailableReason } from "./support/disposable-postgres.js";

const postgresUnavailable = disposablePostgresUnavailableReason();

const vec = (seed: number) => `[${Array.from({ length: 1536 }, (_, index) => (index === seed ? 1 : 0)).join(",")}]`;
const values = (seed: number) => Array.from({ length: 1536 }, (_, index) => (index === seed ? 1 : 0));

/** Migration 0232 (Space Memory embeddings, plan clipboard:o7SATwaOHqca): each vector names its model, so a model switch re-embeds every row. */
it.skipIf(postgresUnavailable)("marks old vectors as OpenAI's, lists rows to re-embed without a vector first, and keeps Dot memory order", async () => {
  const migrations = await loadMigrations();
  const target = migrations.find(item => item.id === "0232_memory_embedding_model");
  expect(target, "Memory embedding model migration must exist").toBeDefined();
  const root = await mkdtemp(`${tmpdir()}/space-pg-`);
  const socket = `${root}/socket`;
  await mkdir(socket); await chmod(socket, 0o777);
  const name = `space-memory-embedding-${randomUUID()}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const pool = createSpacePgPool(`postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socket)}`, { max: 4 });
  let created = false;
  try {
    docker(["run", "--tmpfs", "/var/lib/postgresql/data", "--detach", "--rm", "--pull=never", "--name", name, "--network", "none", "--mount", `type=bind,source=${socket},target=/var/run/postgresql`,
      "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "pgvector/pgvector:0.8.7-pg17-trixie", "-c", "listen_addresses="]);
    created = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if (docker(["exec", name, "cat", "/proc/1/comm"]) !== "postgres") throw Error(); await pool.query("SELECT 1"); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw Error("Owned PostgreSQL did not become ready.");
    for (const item of migrations.filter(item => item.id < target!.id)) await pool.query(item.sql);
    await pool.query("INSERT INTO users(id,email,role) VALUES ('emb:a','a@emb.test','USER')");
    const [orbit] = await new PostgresDotsRepository(pool).list("emb:a");
    // Before 0232: an OpenAI-embedded row and one saved without a vector, in both stores.
    await pool.query(`INSERT INTO memory_records(id,scope,title,body,provenance,embedding,created_at) VALUES
      ('memory:old','SYSTEM','Old','with vector','test',$1::vector,'2030-01-01T00:00:00Z'),
      ('memory:none','SYSTEM','None','without vector','test',NULL,'2030-01-02T00:00:00Z')`, [vec(1)]);
    await pool.query(`INSERT INTO dot_memories(memory_id,owner_user_id,dot_id,scope,text,source,embedding) VALUES
      ($1,'emb:a',$3,'DOT','old dot memory','USER',$4::vector), ($2,'emb:a',$3,'DOT','dot memory without vector','USER',NULL)`,
      [`dot_memory:${"a".repeat(32)}`, `dot_memory:${"b".repeat(32)}`, orbit!.dotId, vec(2)]);
    const before = (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM dot_memories ORDER BY memory_id")).rows.map(row => row.updated_at.toISOString());
    await pool.query(target!.sql);
    await pool.query(target!.sql);

    const store = new PostgresSpaceStore(pool);
    expect(await store.countMemoryRecordEmbeddings()).toEqual({ total: 2, withoutEmbedding: 1, byModel: [{ model: "text-embedding-3-small", count: 1 }] });
    expect(await store.listMemoryRecordsToEmbed("text-embedding-3-small", 10)).toEqual([{ id: "memory:none", title: "None", body: "without vector" }]);
    // Switching models: every row, the one without a vector first.
    expect((await store.listMemoryRecordsToEmbed("gemini-embedding-001", 10)).map(row => row.id)).toEqual(["memory:none", "memory:old"]);
    await store.setMemoryRecordEmbedding("memory:none", values(3), "gemini-embedding-001");
    expect((await store.listMemoryRecordsToEmbed("gemini-embedding-001", 10)).map(row => row.id)).toEqual(["memory:old"]);
    await expect(store.setMemoryRecordEmbedding("memory:missing", values(3), "gemini-embedding-001")).rejects.toThrow(/not found/);
    const saved = await store.createMemoryEntry({ scope: "SYSTEM", title: "New", body: "saved with Gemini", provenance: "test" }, undefined,
      { embedding: values(4), embeddingModel: "gemini-embedding-001" });
    expect(await store.countMemoryRecordEmbeddings()).toEqual({ total: 3, withoutEmbedding: 0,
      byModel: [{ model: "gemini-embedding-001", count: 2 }, { model: "text-embedding-3-small", count: 1 }] });
    // Semantic search compares only vectors of the configured model.
    const found = await store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc", searchMode: "semantic", q: "x" },
      { semanticReady: true, queryEmbedding: values(1), embeddingModel: "gemini-embedding-001" });
    expect(found.map(entry => entry.id).sort()).toEqual(["memory:none", saved.entry.id].sort());

    const dots = new PostgresDotMemoryRepository(pool, "gemini-embedding-001");
    expect((await pool.query<{ updated_at: Date }>("SELECT updated_at FROM dot_memories ORDER BY memory_id")).rows.map(row => row.updated_at.toISOString())).toEqual(before);
    expect(await dots.countEmbeddings()).toEqual({ total: 2, withoutEmbedding: 1, byModel: [{ model: "text-embedding-3-small", count: 1 }] });
    const toEmbed = await dots.listToEmbed("gemini-embedding-001", 10);
    expect(toEmbed.map(row => row.text)).toEqual(["dot memory without vector", "old dot memory"]);
    for (const row of toEmbed) await dots.setEmbedding(row.memoryId, values(5), "gemini-embedding-001");
    expect(await dots.listToEmbed("gemini-embedding-001", 10)).toEqual([]);
    // A re-embedding keeps the memory's place; a text edit moves it.
    expect((await pool.query<{ updated_at: Date }>("SELECT updated_at FROM dot_memories ORDER BY memory_id")).rows.map(row => row.updated_at.toISOString())).toEqual(before);
    const fresh = await dots.create({ ownerUserId: "emb:a", dotId: orbit!.dotId, scope: "DOT", projectKey: null, text: "new", source: "USER", sourceRef: null, embedding: values(5) });
    expect((await pool.query("SELECT embedding_model FROM dot_memories WHERE memory_id=$1", [fresh.memoryId])).rows[0]).toEqual({ embedding_model: "gemini-embedding-001" });
    // Recall by vector only within the configured model: an OpenAI-era vector of the same size is not compared.
    await pool.query("UPDATE dot_memories SET embedding_model='text-embedding-3-small' WHERE memory_id=$1", [`dot_memory:${"a".repeat(32)}`]);
    const recalled = await dots.recall("emb:a", orbit!.dotId, null, { text: "zzz", embedding: values(5) }, 2);
    expect(recalled.map(item => item.memoryId)).not.toContain(`dot_memory:${"a".repeat(32)}`);
    expect(await dots.countEmbeddings()).toMatchObject({ total: 3, withoutEmbedding: 0 });
  } finally {
    await pool.end();
    if (created) docker(["stop", "--time", "5", name]);
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
