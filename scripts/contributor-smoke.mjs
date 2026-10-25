import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliHostClient, CliHostSessionRegistry, createCliHostServer, spawnNodePty
} from "@space/cli-host";

const defaultFixture = fileURLToPath(new URL("./fixtures/offline-cli.mjs", import.meta.url));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

/** Real transport, synthetic task runtime. Never connects to an installed Space service. */
export async function runContributorSmoke({ temporaryRoot = tmpdir(), fixturePath = defaultFixture, signal } = {}) {
  if (process.platform === "win32") throw new Error("Use the Linux development container or WSL for this Unix PTY smoke check.");
  const root = await mkdtemp(join(temporaryRoot, "sc-"));
  const socketPath = join(root, "h.sock");
  const registry = new CliHostSessionRegistry({ spawn: spawnNodePty });
  const clients = [];
  let server;
  let childPid;
  let failure;
  let output = "";
  let latestSequence = -1;
  const records = [];
  const identity = {
    cliSessionId: "cli_session:offline", paneId: "pane:offline", roomId: "room:offline",
    runtimeId: "fixture:offline", codexThreadId: null, modelId: null, reasoningEffort: null
  };
  const receive = event => {
    if (event.type === "status") {
      failure = new Error("Synthetic runtime exited before smoke completion.");
      return;
    }
    latestSequence = event.sequence;
    output += event.data;
    if (Buffer.byteLength(output) > 65536) failure = new Error("Synthetic runtime output limit exceeded.");
    for (const match of output.matchAll(/OFFLINE_RESULT:([^\r\n]+)[\r\n]/g)) {
      try {
        const record = JSON.parse(match[1]);
        if (!records.some(item => item.offset === match.index)) records.push({ ...record, offset: match.index });
      } catch { failure = new Error("Synthetic runtime returned invalid JSON."); }
    }
  };
  const waitFor = async (predicate, stage, checkFailure = true) => {
    const deadline = Date.now() + 3000;
    do {
      if (checkFailure && failure) throw failure;
      if (checkFailure) signal?.throwIfAborted();
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    throw new Error(`Offline smoke timed out: ${stage}.`);
  };
  // Cleanup failures are thrown after the finally block, so a failed smoke keeps its own error.
  const errors = [];
  try {
    if (Buffer.byteLength(socketPath) > 100) throw new Error("Set TMPDIR to a shorter owned directory for Unix sockets.");
    server = await createCliHostServer({ socketPath, registry });
    const first = new CliHostClient({ socketPath });
    clients.push(first);
    const attached = await first.attach({
      identity,
      spawn: {
        command: process.execPath, args: [resolve(fixturePath)], cwd: root,
        // Explicit environment prevents inherited API keys, tokens, provider
        // homes, preload hooks or shell startup files from reaching the fixture.
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8" },
        cols: 100, rows: 30
      }, afterSequence: -1
    }, receive);
    childPid = attached.session.pid;
    attached.replay.forEach(receive);
    await waitFor(() => output.includes("OFFLINE_READY"), "readiness");
    const firstTask = JSON.stringify({ id: "sum:one", numbers: [19, 23] }) + "\n";
    await first.input(identity, attached.attachmentId, firstTask, "visible", "offline:one");
    await waitFor(() => records.length >= 1, "first result");
    if (records[0].id !== "sum:one" || records[0].total !== 42 || records[0].executionCount !== 1) {
      throw new Error("Offline task acceptance failed: first result.");
    }
    await first.detach(identity, attached.attachmentId);
    await first.close();
    const second = new CliHostClient({ socketPath });
    clients.push(second);
    const reattached = await second.attach({ identity, afterSequence: latestSequence }, receive);
    reattached.replay.forEach(receive);
    if (reattached.session.pid !== childPid || reattached.session.generationId !== attached.session.generationId) {
      throw new Error("Offline task acceptance failed: process continuity.");
    }
    await second.input(identity, reattached.attachmentId, firstTask, "visible", "offline:one");
    await second.input(identity, reattached.attachmentId,
      JSON.stringify({ id: "sum:two", numbers: [-5, 12] }) + "\n", "visible", "offline:two");
    await waitFor(() => records.length >= 2, "second result");
    if (records.length !== 2 || records[1].id !== "sum:two" || records[1].total !== 7 || records[1].executionCount !== 2) {
      throw new Error("Offline task acceptance failed: duplicate suppression or continuation.");
    }
  } finally {
    registry.terminateAll();
    if (childPid) {
      try { await waitFor(() => !alive(childPid), "owned process cleanup", false); }
      catch (error) { errors.push(error); }
    }
    for (const client of clients) {
      try { await client.close(); } catch (error) { errors.push(error); }
    }
    try { await server?.close(); } catch (error) { errors.push(error); }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Offline smoke cleanup failed.");
  return {
    mode: "SIMULATED_RUNTIME", transport: "REAL_PTY_UNIX_IPC", passed: true,
    completedTasks: 2, sameProcessAfterReconnect: true, duplicateInputSuppressed: true, cleaned: true
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController();
  const stop = () => abort.abort(new Error("Offline smoke interrupted."));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.stdout.write(`${JSON.stringify(await runContributorSmoke({ signal: abort.signal }))}\n`);
  } catch {
    // Never export raw fixture output or inherited environment in diagnostics.
    process.stderr.write("Offline contributor smoke failed. Run its regression tests for a local diagnosis.\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
