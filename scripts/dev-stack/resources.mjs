import { spawn } from 'node:child_process';
import { ownerLabel } from './state.mjs';
import { descendants, lineRedactor, processIdentity, sameProcess, stopRecorded } from './processes.mjs';

export function dockerEnvironment(inherited = process.env) {
  return Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'SSH_AUTH_SOCK'].filter(key => inherited[key]).map(key => [key, inherited[key]]));
}
export function run(command, args, { cwd, env, secrets = [], output = () => {}, timeout = 600000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Command cancelled before startup.')); return; }
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', settled = false, timedOut = false;
    const identity = process.platform === 'win32' ? Promise.resolve(null) : new Promise((resolveIdentity, rejectIdentity) => {
      child.once('spawn', () => { void processIdentity(child.pid).then(resolveIdentity, rejectIdentity); });
      child.once('error', () => resolveIdentity(null));
    });
    const cancel = async () => {
      const original = await identity;
      if (original && await sameProcess({ pid: child.pid, identity: original })) await stopRecorded(await descendants({ pid: child.pid, identity: original }));
      else if (process.platform === 'win32') child.kill();
    };
    // Never fall back to an unverified POSIX PID if identity discovery fails.
    const cancelled = () => { void cancel().catch(() => { output('[dev-stack] Owned command cleanup failed; recovery state is required.\n'); }); };
    signal?.addEventListener('abort', cancelled, { once: true });
    const redactor = lineRedactor(secrets, chunk => { text += chunk; output(chunk); });
    const timer = setTimeout(() => { timedOut = true; cancelled(); }, timeout);
    child.stdout.on('data', x => redactor.chunk(x)); child.stderr.on('data', x => redactor.chunk(x));
    child.once('error', error => { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(new Error(`${command} could not start (${error.code || 'error'}).`)); });
    child.once('close', (code, exitSignal) => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); redactor.end(); if (settled) return; if (code === 0 && !signal?.aborted && !timedOut) resolve(text); else reject(new Error(`${command} failed (${timedOut ? 'timeout' : code ?? exitSignal}); see the redacted output.`)); });
  });
}
export const composeArgs = (config, owner, args) => ['compose', '--project-name', owner.project, '--file', config.compose, ...args];
export async function assertOwnedDocker(owner, invoke = run, env = dockerEnvironment()) {
  for (const kind of ['container', 'volume', 'network']) {
    const ids = (await invoke('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${owner.project}`], { env })).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const raw = await invoke('docker', [kind, 'inspect', '--format', kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}', id], { env });
      const labels = JSON.parse(raw);
      if (labels?.[ownerLabel] !== owner.nonce) throw new Error(`Foreign ${kind} shares this project name; refusing cleanup/start.`);
    }
  }
}
export async function compose(config, owner, args, options = {}) {
  return run('docker', composeArgs(config, owner, args), { env: dockerEnvironment(), ...options });
}
export async function removeOwnedDocker(config, owner, { volumes = false, output, secrets } = {}) {
  await assertOwnedDocker(owner);
  await compose(config, owner, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])], { output, secrets, timeout: 120000 });
  await assertOwnedDocker(owner);
  for (const kind of ['container', 'network', ...(volumes ? ['volume'] : [])]) {
    const remaining = await run('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${owner.project}`], { env: dockerEnvironment() });
    if (remaining.trim()) throw new Error(`Owned ${kind} remains; recovery state retained.`);
  }
}
