import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IncrementalRolloutReader, type RolloutReducer } from "../src/codex-rollout-reader.js";
import { findRecentCodexCliTurnActivity, findRecentNullAgentMessageDiagnostic } from "../src/codex-rollout-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "space-codex-incremental-"));
  roots.push(home);
  const day = join(home, "sessions", "2026", "09", "05");
  await mkdir(day, { recursive: true });
  return { home, day, path: join(day, "rollout-target.jsonl") };
}
function countReducer(): RolloutReducer<number> {
  let count = 0;
  return {
    accept(line) { try { if (JSON.parse(line).count === true) count += 1; } catch {} },
    result: () => count,
    checkpoint: () => count,
    restore: (value) => { count = value as number; }
  };
}
const meta = (id: string) => JSON.stringify({ type: "session_meta", payload: { id, cwd: "/etc" } });
const event = (type: string, payload: object, at: number) => JSON.stringify({ type, timestamp: new Date(at).toISOString(), payload });

describe("incremental Codex rollout polling", () => {
  it("does not reread unchanged history and reads only the appended bytes plus identity checks", async () => {
    const f = await fixture();
    await writeFile(f.path, `${JSON.stringify({ ignored: "x".repeat(2 * 1024 * 1024) })}\n{"count":true}\n`);
    const reader = new IncrementalRolloutReader();
    const input = { ...f, key: "count", create: countReducer };
    expect((await reader.read(input)).value).toBe(1);
    const coldBytes = reader.metrics.bytesRead;
    expect((await reader.read(input)).value).toBe(1);
    expect(reader.metrics.bytesRead).toBe(coldBytes);
    const addition = '{"count":true}\n';
    await appendFile(f.path, addition);
    expect((await reader.read(input)).value).toBe(2);
    expect(reader.metrics.bytesRead - coldBytes).toBeLessThanOrEqual(Buffer.byteLength(addition) + 256);
    expect(reader.metrics.recordsRead).toBe(3);
  });

  it("shares simultaneous polls and safely previews an EOF record until its newline arrives", async () => {
    const f = await fixture();
    await writeFile(f.path, '{"count":true}');
    const reader = new IncrementalRolloutReader();
    const input = { ...f, key: "partial", create: countReducer };
    const results = await Promise.all(Array.from({ length: 8 }, () => reader.read(input)));
    expect(results.map((r) => r.value)).toEqual(Array(8).fill(1));
    expect(reader.metrics.bytesRead).toBe(14);
    await appendFile(f.path, '\n{"cou');
    expect((await reader.read(input)).value).toBe(1);
    await appendFile(f.path, 'nt":true}\n');
    expect((await reader.read(input)).value).toBe(2);
  });

  it("resets on replacement, truncation and a rewritten prefix followed by growth", async () => {
    const f = await fixture();
    await writeFile(f.path, '{"count":true}\n{"count":true}\n');
    const reader = new IncrementalRolloutReader();
    const input = { ...f, key: "replace", create: countReducer };
    expect((await reader.read(input)).value).toBe(2);
    await writeFile(`${f.path}.new`, '{"count":true}\n');
    await rename(`${f.path}.new`, f.path);
    expect((await reader.read(input)).value).toBe(1);
    await writeFile(f.path, '');
    expect((await reader.read(input)).value).toBe(0);
    await writeFile(f.path, '{"count":true}\n');
    expect((await reader.read(input)).value).toBe(1);
    await writeFile(f.path, '{"count":false}\n{"count":true}\n{"count":true}\n');
    expect((await reader.read(input)).value).toBe(2);
    expect(reader.metrics.resets).toBe(3);
  });

  it("matches literal input across UTF-8 read boundaries and rejects paths outside the home", async () => {
    const f = await fixture();
    await writeFile(f.path, ' '.repeat(65535) + 'Ελληνικά');
    const reader = new IncrementalRolloutReader();
    expect((await reader.read({ ...f, key: "utf8", contains: "Ελληνικά", create: countReducer })).matched).toBe(true);
    const other = await fixture();
    await writeFile(other.path, '{"count":true}');
    await symlink(other.path, join(f.day, "escape.jsonl"));
    await expect(reader.read({ home: f.home, path: join(f.day, "escape.jsonl"), key: "escape", create: countReducer })).rejects.toThrow("outside");
  });

  it("resolves the exact database thread beyond the recent-file limit and follows goal completion incrementally", async () => {
    const f = await fixture();
    const start = Date.now() - 1000;
    const lines = [meta("thread:target"),
      event("turn_context", { turn_id: "turn:seed" }, start + 10),
      event("event_msg", { type: "user_message", turn_id: "turn:seed", message: "marker-123" }, start + 20),
      event("event_msg", { type: "thread_goal_updated", goal: { status: "active" } }, start + 30),
      event("turn_context", { turn_id: "turn:goal" }, start + 40)];
    await writeFile(f.path, lines.join("\n") + "\n");
    for (let i = 0; i < 14; i += 1) await writeFile(join(f.day, `rollout-other-${i}.jsonl`), meta(`thread:other-${i}`));
    execFileSync("sqlite3", [join(f.home, "state_5.sqlite"), `CREATE TABLE threads(id TEXT, rollout_path TEXT); INSERT INTO threads VALUES('thread:target','${f.path.replaceAll("'", "''")}');`]);
    const input = { codexHome: f.home, threadId: "thread:target", markerAtMs: start, inputMarker: "marker-123", maxFiles: 1 };
    expect(await findRecentCodexCliTurnActivity(input)).toMatchObject({ status: "RUNNING", turnId: "turn:goal" });
    const end = [event("event_msg", { type: "thread_goal_updated", goal: { status: "complete" } }, start + 50),
      event("event_msg", { type: "task_complete", turn_id: "turn:goal", completed_at: (start + 60) / 1000 }, start + 60)];
    await appendFile(f.path, end.join("\n"));
    expect(await findRecentCodexCliTurnActivity(input)).toEqual({ status: "COMPLETED", turnId: "turn:goal" });
    await writeFile(f.path, meta("thread:foreign") + "\n" + end.join("\n"));
    expect(await findRecentCodexCliTurnActivity(input)).toEqual({ status: "PENDING", turnId: null });
  });

  it("preserves null-message attribution, input matching and freshness across append and rotation", async () => {
    const f = await fixture();
    const start = Date.now() - 1000;
    await writeFile(f.path, meta("thread:target") + '\n' + event("event_msg", { type: "user_message", message: "expected input" }, start + 10) + '\n');
    const input = { codexHome: f.home, threadId: "thread:target", sinceMs: start, inputText: "expected input", cwd: "/etc" };
    expect(await findRecentNullAgentMessageDiagnostic(input)).toBeNull();
    await appendFile(f.path, event("event_msg", { type: "task_complete", turn_id: "turn:end", last_agent_message: null, completed_at: (start + 100) / 1000 }, start + 100));
    expect(await findRecentNullAgentMessageDiagnostic(input)).toMatchObject({ sessionId: "thread:target", turnId: "turn:end" });
    expect(await findRecentNullAgentMessageDiagnostic({ ...input, inputText: "wrong input" })).toBeNull();
    expect(await findRecentNullAgentMessageDiagnostic({ ...input, sinceMs: start + 200 })).toBeNull();
    await writeFile(`${f.path}.new`, meta("thread:foreign") + '\n');
    await rename(`${f.path}.new`, f.path);
    expect(await findRecentNullAgentMessageDiagnostic(input)).toBeNull();
  });
});
