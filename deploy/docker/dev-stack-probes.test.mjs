import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { editSource, PipeCdp, replaceOnce, restoreSourceEdit } from "./dev-stack-hotreload.mjs";
import { killOwnedWorkerWithPidfd } from "./dev-stack-worker-probe.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-probe-test-"));
  const backupRoot = join(root, "backup");
  await mkdir(backupRoot);
  const path = join(root, "source.ts");
  await writeFile(path, "// before\r\nexport const unicode = 'こんにちは';\r\n", { mode: 0o640 });
  await chmod(path, 0o640);
  return { root, path, backupRoot };
}

test("source anchors fail closed on missing or ambiguous matches", () => {
  assert.equal(replaceOnce("before", "before", "after"), "after");
  assert.throws(() => replaceOnce("absent", "before", "after"), /exactly once/);
  assert.throws(() => replaceOnce("before before", "before", "after"), /exactly once/);
});

test("source edits restore exact bytes and permissions across serialized receipts", async () => {
  const { root, path, backupRoot } = await fixture();
  try {
    const original = await readFile(path);
    const edit = await editSource("source.ts", text => text.replace("before", "after"), backupRoot, root);
    assert.match(await readFile(path, "utf8"), /after/);
    assert.equal((await stat(edit.backup)).mode & 0o777, 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await restoreSourceEdit(JSON.parse(JSON.stringify(edit)));
    assert.deepEqual(await readFile(path), original);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.equal(existsSync(edit.backup), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restoration preserves concurrent edits and retains its recovery backup", async () => {
  const { root, path, backupRoot } = await fixture();
  try {
    const original = await readFile(path);
    const edit = await editSource("source.ts", text => text.replace("before", "after"), backupRoot, root);
    const edited = await readFile(path);
    await writeFile(path, "// concurrent edit\n");
    await assert.rejects(() => edit.restore(), /Concurrent modification/);
    assert.equal(await readFile(path, "utf8"), "// concurrent edit\n");
    assert.deepEqual(await readFile(edit.backup), original);
    await writeFile(path, edited);
    await edit.restore();
    await edit.restore();
    assert.deepEqual(await readFile(path), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable source receipts recover an interrupted editor without its finally block", { timeout: 5000 }, async () => {
  const { root, path, backupRoot } = await fixture();
  const receiptRoot = join(root, "receipts");
  let editor;
  try {
    const original = await readFile(path);
    const script = join(root, "editor.mjs");
    await writeFile(script, `
      import { editSource } from ${JSON.stringify(new URL("./dev-stack-hotreload.mjs", import.meta.url).href)};
      await editSource("source.ts", text => text.replace("before", "after"), ${JSON.stringify(backupRoot)}, ${JSON.stringify(root)}, ${JSON.stringify(receiptRoot)});
      process.send("edited");
      setInterval(() => {}, 1000);
    `);
    editor = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    await once(editor, "message");
    const exited = once(editor, "exit");
    editor.kill("SIGTERM");
    await exited;
    assert.equal(editor.signalCode, "SIGTERM");
    assert.match(await readFile(path, "utf8"), /after/);
    const receiptFile = join(receiptRoot, "source.ts.json");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);
    await restoreSourceEdit(receipt);
    assert.deepEqual(await readFile(path), original);
    assert.equal(existsSync(receiptFile), false);
    assert.equal(existsSync(receipt.backup), false);
  } finally {
    if (editor?.exitCode === null && editor?.signalCode === null) editor.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered backups and non-regular source targets cannot be restored", async () => {
  const { root, path, backupRoot } = await fixture();
  try {
    const edit = await editSource("source.ts", text => text.replace("before", "after"), backupRoot, root);
    await writeFile(edit.backup, "tampered");
    await assert.rejects(() => edit.restore(), /checksum changed/);
    assert.match(await readFile(path, "utf8"), /after/);
    await rm(path);
    await symlink(edit.backup, path);
    await assert.rejects(() => edit.restore(), /non-regular/);
    await assert.rejects(() => editSource("source.ts", text => text + "x", backupRoot, root), /regular tracked file/);
    await assert.rejects(() => editSource("../outside.ts", text => text, backupRoot, root), /inside its checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CDP pipe handles fragmented and out-of-order responses and rejects closed browsers", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const requests = [];
  child.stdio[3].on("data", bytes => requests.push(JSON.parse(bytes.toString().replace(/\0$/, ""))));
  const cdp = new PipeCdp(child);
  const first = cdp.call("Browser.getVersion");
  const second = cdp.evaluate("1 + 1", "session-id");
  assert.equal(requests[1].sessionId, "session-id");
  const response = JSON.stringify({ id: requests[1].id, result: { result: { value: 2 } } }) + "\0";
  child.stdio[4].write(response.slice(0, 7));
  child.stdio[4].write(response.slice(7) + JSON.stringify({ id: requests[0].id, result: { product: "fixture" } }) + "\0");
  assert.equal(await second, 2);
  assert.deepEqual(await first, { product: "fixture" });
  const error = cdp.call("Unknown.command");
  child.stdio[4].write(JSON.stringify({ id: requests[2].id, error: { code: -32601 } }) + "\0");
  await assert.rejects(() => error, /CDP Unknown.command failed/);
  const pending = cdp.call("Page.enable");
  child.emit("exit", 1);
  await assert.rejects(() => pending, /isolated browser closed/);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(() => cdp.call("Browser.close"), /already closed/);
  child.stdio[3].destroy();
  child.stdio[4].destroy();
});

test("worker pidfd fault injection signals only the exact owned worker", { skip: process.platform !== "linux" }, async (t) => {
  for (const scenario of ["owned", "wrong token", "wrong group", "wrong argv"]) await t.test(scenario, async () => {
    const root = await mkdtemp(join(tmpdir(), "spaceapp-worker-probe-"));
    let child;
    try {
      await mkdir(join(root, "apps/worker/dist"), { recursive: true });
      await writeFile(join(root, "apps/worker/dist/worker.js"), "setInterval(() => {}, 1000);\n");
      const token = "a".repeat(48);
      child = spawn(process.execPath, [scenario === "wrong argv" ? "./apps/worker/dist/worker.js" : "apps/worker/dist/worker.js"], {
        cwd: root, detached: true, stdio: "ignore", env: { ...process.env, SPACE_DEV_PROCESS_TOKEN: token }
      });
      const exited = once(child, "exit");
      const record = { pid: child.pid, pgid: scenario === "wrong group" ? child.pid + 1 : child.pid, sid: child.pid };
      if (scenario === "owned") {
        await killOwnedWorkerWithPidfd(record, token);
        await exited;
        assert.equal(child.signalCode, "SIGKILL");
      } else {
        await assert.rejects(() => killOwnedWorkerWithPidfd(record, scenario === "wrong token" ? "b".repeat(48) : token), /no fallback attempted/);
        assert.doesNotThrow(() => process.kill(child.pid, 0));
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
