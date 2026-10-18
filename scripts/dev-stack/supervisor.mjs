import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { watch } from 'node:fs';
import { appendFile, chmod, copyFile, lstat, readFile, rm, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlainState, composeDocument, extractPins, initialize, loadOwner, locations, privateWrite, readJson, secrets, serviceEnvironment } from './state.mjs';
import { delay, descendants, LaunchBarrier, lineRedactor, processIdentity, sameProcess, stopRecorded } from './processes.mjs';
import { assertOwnedDocker, compose, dockerEnvironment, removeOwnedDocker, run } from './resources.mjs';
import { verifyOpenCode } from './opencode-runtime.mjs';
import { verifyPtyCapability } from './pty-capability.mjs';
import { ReadinessEpoch } from './readiness.mjs';
import { buildSourceServices } from './source-build.mjs';
import { debounceSourceChanges, ReloadReceipt } from './reload-debounce.mjs';
import { observeReloadProof, openReloadProofChannel } from './reload-proof-channel.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const say = text => process.stdout.write(`[dev-stack] ${text}\n`);
async function assertFreePort(port) { await new Promise((resolvePromise, reject) => { const s = createServer(); s.once('error', () => reject(new Error(`Loopback port ${port} is already in use; choose SPACE_DEV_*_PORT values.`))); s.listen(port, '127.0.0.1', () => s.close(resolvePromise)); }); }
/** Stop verified owned processes and containers; preserve database/state and propagate failures for recovery. */
export async function down(config) {
  const owner = await loadOwner(config);
  const record = await readJson(config.supervisor).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (record?.nonce !== undefined && record.nonce !== owner.nonce) throw new Error('Foreign supervisor record.');
  if (record && await sameProcess(record)) {
    process.kill(record.pid, 'SIGTERM');
    for (let i = 0; i < 1800 && await sameProcess(record); i++) await delay(100);
    if (await sameProcess(record)) throw new Error('Supervisor did not stop; recovery state retained.');
  }
  // Recover owned children even when the supervisor crashed before it could shut them down.
  const processes = record?.children || [];
  const owned = [];
  for (const item of processes) if (await sameProcess(item)) owned.push(...await descendants(item));
  await stopRecorded(owned);
  await removeOwnedDocker(config, owner);
  await unlink(config.supervisor).catch(e => { if (e.code !== 'ENOENT') throw e; });
  say('Stopped owned services; state/volumes retained for the next start.');
}
/** After owned shutdown and nonce/path rechecks, remove this stack's volumes and private state only. */
export async function reset(config) {
  await assertPlainState(config);
  if (!await lstat(config.state).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) { say('No dev-stack state to reset.'); return; }
  const owner = await loadOwner(config);
  await down(config);
  await removeOwnedDocker(config, owner, { volumes: true });
  // Verify the resolved absolute deletion target and ownership again after external commands.
  await assertPlainState(config); await loadOwner(config);
  await rm(config.state, { recursive: true });
  say('Removed only this dev stack’s containers, volumes and state.');
}
/** Start isolated source services; supervise reload/readiness and keep recovery records when owned shutdown fails. */
export async function start(config, inherited = process.env) {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Run dev:stack in Linux, macOS, or Windows 11 WSL2. Native Windows is not the supported Unix-socket environment.');
  await run('docker', ['compose', 'version'], { env: dockerEnvironment(inherited) });
  await Promise.all(Object.values(config.ports).map(assertFreePort));
  const owner = await initialize(config);
  if (JSON.stringify(owner.ports) !== JSON.stringify(config.ports)) throw new Error('Existing state has different ports. Reset it first or use its original SPACE_DEV_*_PORT values.');
  const old = await readJson(config.supervisor).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (old) { if (old.nonce !== owner.nonce || await sameProcess(old) || (await Promise.all((old.children || []).map(x => sameProcess(x)))).some(Boolean)) throw new Error('A prior supervisor/child is still alive; use down before restarting.'); await unlink(config.supervisor); }
  const reload = new ReloadReceipt();
  const record = { nonce: owner.nonce, pid: process.pid, identity: await processIdentity(process.pid), children: [], reload: reload.snapshot() };
  await privateWrite(config.supervisor, JSON.stringify(record), { flag: 'wx' });
  const secret = await secrets(config), redactions = [secret.password, encodeURIComponent(secret.password), secret.session, secret.token];
  const env = serviceEnvironment(config, owner, secret, inherited), children = new Map(), watchers = [];
  const launches = new LaunchBarrier();
  const readiness = new ReadinessEpoch();
  let stopping = false, restarting = false, queued = false, startupComplete = false, statusTimer, readyTimer, sourceChanges;
  const cancellation = new AbortController();
  let activeCommand = Promise.resolve(), writeTail = Promise.resolve(), stopTail = Promise.resolve(), receiptClosed = false, proofChannel;
  const perform = fn => { activeCommand = fn(); return activeCommand; };
  const recordChildren = () => { record.children = [...children.values()].map(x => x.record); record.reload = reload.snapshot(); const text = JSON.stringify(record); writeTail = writeTail.then(() => privateWrite(config.supervisor, text)); return writeTail; };
  const publishReload = () => { if (!receiptClosed) void recordChildren().catch(() => { void shutdown(1); }); };
  const log = chunk => process.stdout.write(chunk);
  async function command(args, executable = 'npm') { return perform(() => run(executable, args, { cwd: config.root, env, secrets: redactions, output: log, signal: cancellation.signal })); }
  const stopChildren = (names = [...children.keys()]) => {
    const job = stopTail.then(async () => {
    for (const name of names) {
      const item = children.get(name); if (!item) continue;
      item.expected = true;
      if (!item.record.identity && item.child.exitCode === null && item.child.signalCode === null) throw new Error(`Unverified ${name} launch; recovery state retained.`);
      const targets = await sameProcess(item.record) ? await descendants(item.record) : [];
      await stopRecorded(targets); children.delete(name);
    }
    await recordChildren();
    });
    stopTail = job.catch(() => {});
    return job;
  };
  async function shutdown(code = 0) {
    if (stopping) return; stopping = true;
    proofChannel?.stopAdmission();
    reload.stop(); publishReload();
    readiness.pause();
    cancellation.abort();
    sourceChanges?.stop(); clearInterval(statusTimer); clearInterval(readyTimer); for (const w of watchers) w.close();
    try { await activeCommand.catch(() => {}); await launches.stop(); await stopChildren(); await removeOwnedDocker(config, owner, { output: log, secrets: redactions, diagnose: code !== 0 }); receiptClosed = true; await writeTail; await proofChannel?.close(); await unlink(config.supervisor); }
    catch (error) { say(`Cleanup failed: ${error.message} Recovery state kept; retry down/reset.`); process.exitCode = 1; return; }
    say('All owned services stopped.'); process.exitCode = code;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  const launch = (name, args, cwd = config.root) => launches.track(async () => {
    if (stopping) throw new Error('Startup/reload interrupted by shutdown.');
    const child = spawn(process.execPath, [`--title=spaceapp-dev-${owner.nonce}-${name}`, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const spawned = new Promise((resolvePromise, reject) => { child.once('spawn', resolvePromise); child.once('error', reject); });
    const item = { child, record: { name, pid: child.pid, identity: null }, expected: false };
    children.set(name, item);
    const output = lineRedactor(redactions, text => { log(`[${name}] ${text}`); void appendFile(join(config.state, 'logs', `${name}.log`), text, { mode: 0o600 }).catch(error => { say(`${name} log write failed (${error.code || 'error'}).`); void shutdown(1); }); });
    child.stdout.on('data', x => output.chunk(x)); child.stderr.on('data', x => output.chunk(x));
    child.once('exit', (code, signal) => { output.end(); if (!item.expected && !stopping) { say(`${name} exited unexpectedly (${code ?? signal}); stopping the stack.`); void shutdown(1); } });
    await spawned;
    item.record.identity = await processIdentity(child.pid);
    await recordChildren();
    if (!item.record.identity) throw new Error(`${name} ended before its process identity could be registered.`);
  });
  const sourceServices = async () => {
    await launch('cli-host', ['packages/cli-host/dist/main.js']);
    await launch('worker', ['apps/worker/dist/worker.js']);
    await launch('api', ['--import', 'tsx', 'apps/api/src/server.ts']);
  };
  const rebuild = async (kind, generation) => {
    if (stopping) return;
    if (restarting) { queued = true; reload.enqueued(generation); publishReload(); return; }
    restarting = true;
    reload.started(kind, generation); publishReload();
    readiness.pause();
    let rebuilt = false;
    try {
      const names = kind === 'api' ? ['api'] : ['api', 'worker', 'cli-host'];
      await stopChildren(names);
      if (kind !== 'api') await buildSourceServices((executable, args) => command(args, executable === 'node' ? process.execPath : 'npm'), () => stopping);
      if (stopping) return;
      if (kind === 'api') await launch('api', ['--import', 'tsx', 'apps/api/src/server.ts']); else await sourceServices();
      if (stopping) return;
      readiness.start();
      rebuilt = true;
      say(`${kind} source change rebuilt/restarted; waiting for readiness.`);
    } catch (error) { say(`Reload failed: ${error.message}`); await shutdown(1); }
    finally { restarting = false; reload.finished(generation, rebuilt); publishReload(); if (queued && !stopping) { queued = false; const next = reload.releaseQueued(); publishReload(); void rebuild('packages', next); } }
  };
  try {
    await launches.track(async () => {
      proofChannel = await openReloadProofChannel(config, { nonce: record.nonce, pid: record.pid, identity: record.identity }, () => observeReloadProof({
        tail: () => writeTail,
        closed: () => stopping || receiptClosed,
        snapshot: () => ({ nonce: record.nonce, pid: record.pid, identity: record.identity, reload: reload.snapshot(), children: [...children.values()].map(item => ({ ...item.record })) }),
      }));
      if (stopping) await proofChannel.close();
      else { record.proofSocket = proofChannel.name; await recordChildren(); }
    });
    if (stopping) return;
    const pins = extractPins(await readFile(join(config.root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'), await readFile(join(config.root, 'Dockerfile'), 'utf8'));
    await privateWrite(config.compose, JSON.stringify(composeDocument(owner, pins, secret.password), null, 2) + '\n');
    await verifyPtyCapability(config.root, config.state, { inherited: env });
    await assertOwnedDocker(owner);
    say('Starting canonical digest-pinned PostgreSQL and Temporal on loopback.');
    await perform(() => compose(config, owner, ['up', '-d', '--wait', '--wait-timeout', '240'], { output: log, secrets: redactions, timeout: 420000, signal: cancellation.signal }));
    await command(['run', 'build']);
    const vendor = join(config.state, 'cli/vendor/opencode');
    const installed = await readJson(join(vendor, 'node_modules/opencode-ai/package.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (installed?.version !== pins.opencode) await command(['install', '--prefix', vendor, '--ignore-scripts', '--no-audit', '--no-fund', `opencode-ai@${pins.opencode}`]);
    await verifyOpenCode(config.state, pins.opencode, { inherited: env });
    await privateWrite(join(config.state, 'cli/opencode-version'), pins.opencode);
    const wrapper = join(config.state, 'cli/bin/opencode-vscode-parity');
    await copyFile(join(root, 'scripts/dev-stack/opencode-wrapper.mjs'), wrapper); await chmod(wrapper, 0o700);
    await copyFile(join(root, 'scripts/dev-stack/opencode-runtime.mjs'), join(config.state, 'cli/bin/opencode-runtime.mjs'));
    await perform(() => run(process.execPath, ['packages/db/dist/migrate.js'], { cwd: config.root, env, secrets: redactions, output: log, signal: cancellation.signal }));
    await sourceServices();
    await launch('web', [join(config.root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(owner.ports.web), '--strictPort'], join(config.root, 'apps/web'));
    startupComplete = true;
    say(`URL http://127.0.0.1:${owner.ports.web}  API http://127.0.0.1:${owner.ports.api}`);
    const tokenDisplay = inherited.CI || inherited.SPACE_DEV_REDACT_SETUP === 'true' ? '[redacted: private state file]' : secret.token || '[already consumed]';
    say(`One-time owner setup token: ${tokenDisplay}`);
    say(`State ${config.state}; down stops, reset removes only owned state. Browser/companion/root services are disabled. No provider account or inference is used.`);
    sourceChanges = debounceSourceChanges(rebuild, state => { reload.debounced(state); publishReload(); });
    for (const [dir, kind] of [['apps/api/src', 'api'], ['apps/worker/src', 'packages'], ['packages', 'packages']]) {
      watchers.push(watch(join(config.root, dir), { recursive: true }, (_event, file) => { if (file && !/(?:^|[\\/])(?:node_modules|dist|\.git)(?:[\\/]|$)/.test(file) && /\.(?:ts|tsx|js|mjs|json)$/.test(file)) sourceChanges.change(kind); }));
    }
    readiness.start();
    readyTimer = setInterval(async () => {
      if (restarting || stopping) return;
      const probe = readiness.beginProbe(); if (!probe) return;
      let result, failed = 'API readiness';
      try {
        const response = await fetch(`http://127.0.0.1:${owner.ports.api}/readyz`, { signal: AbortSignal.timeout(6000) });
        const body = await response.json(), ready = response.ok && body.ok === true;
        failed = Object.entries(body.dependencies || {}).filter(([key, value]) => ['database', 'worker', 'cliHost'].includes(key) && ['ERROR', 'UNAVAILABLE', 'STOPPED'].includes(value)).map(([key]) => key).join(', ') || 'API/workflows';
        result = readiness.settle(probe, ready ? 'ready' : 'unavailable');
      } catch { result = readiness.settle(probe, 'unreachable'); }
      finally { readiness.release(probe); }
      if (!result) return; // Completion/finally of a deliberately stopped epoch is inert.
      if (result.changed) say(result.outcome === 'ready' ? 'readyz ok: workflows and source services are ready.' : result.outcome === 'unreachable' ? 'readyz failed: API is not responding.' : `readyz failed: ${failed} unavailable; inspect its service log.`);
      if (result.fatal) { say(`Required service failure: ${failed}; readiness generation ${result.epoch}, failures ${result.failures}; stopping the stack.`); await shutdown(1); }
    }, 4000);
    statusTimer = setInterval(() => { if (startupComplete && !stopping) void recordChildren().catch(() => { void shutdown(1); }); }, 3000);
  } catch (error) { say(error.message); await shutdown(1); }
}
export async function main(args = process.argv.slice(2)) {
  const config = locations(root, process.env), action = args[0] || 'up';
  if (args.length > 1 || !['up', 'down', 'reset', 'status'].includes(action)) throw new Error('Usage: npm run dev:stack [-- down|reset|status]');
  if (action === 'up') return start(config);
  if (action === 'status') { const owner = await loadOwner(config), record = await readJson(config.supervisor).catch(() => null); say(JSON.stringify({ project: owner.project, ports: owner.ports, running: record ? await sameProcess(record) : false })); return; }
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Lifecycle commands require the same Linux/macOS/WSL2 environment that started this stack.');
  return action === 'down' ? down(config) : reset(config);
}
