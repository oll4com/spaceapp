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
export async function readOwnedPortPublications(config, owner, { invoke = run, env = dockerEnvironment() } = {}) {
  await assertOwnedDocker(owner, invoke, env);
  const raw = (await invoke('docker', composeArgs(config, owner, ['ps', '--format', 'json']), { env })).trim();
  const services = raw.startsWith('[') ? JSON.parse(raw) : raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const selected = [];
  for (const service of services) {
    if (!/^[a-f0-9]{12,64}$/.test(service.ID || '')) throw new Error('Invalid owned container ID in port proof.');
    // These fields contain port metadata only. Never return the Compose command or inspect Config.Env.
    const ports = JSON.parse(await invoke('docker', ['container', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', service.ID], { env }));
    selected.push({ Service: service.Service, Publishers: Array.isArray(service.Publishers) ? service.Publishers.map(({ URL, TargetPort, PublishedPort, Protocol }) => ({ URL, TargetPort, PublishedPort, Protocol })) : null, NetworkSettingsPorts: ports });
  }
  return selected;
}
export function assertLoopbackPublications(services, ports) {
  const require = (condition, message) => { if (!condition) throw new Error(`Docker loopback proof: ${message}`); };
  const expected = { postgres: { target: 5432, published: ports.postgres }, temporal: { target: 7233, published: ports.temporal } };
  require(Array.isArray(services) && services.length === 2, 'expected exactly the two owned services.');
  const seen = new Set();
  for (const service of services) {
    const wanted = expected[service.Service];
    require(wanted && !seen.has(service.Service), 'unexpected or duplicate service.'); seen.add(service.Service);
    const check = (host, target, published, protocol) => {
      require(host === '127.0.0.1', 'a published host address is not IPv4 loopback.');
      require(target === wanted.target && published === wanted.published && protocol === 'tcp', 'a missing or extra host mapping differs from the expected service port.');
    };
    require(Array.isArray(service.Publishers), 'missing Compose port metadata.');
    let composeCount = 0;
    for (const binding of service.Publishers) {
      require(Number.isInteger(binding.PublishedPort) && binding.PublishedPort >= 0 && binding.PublishedPort <= 65535 && Number.isInteger(binding.TargetPort) && binding.TargetPort > 0 && binding.TargetPort <= 65535 && ['tcp', 'udp'].includes(binding.Protocol), 'malformed Compose port metadata.');
      // Compose includes merely EXPOSED container ports here too. Only numeric zero is unpublished.
      if (binding.PublishedPort === 0) { require(binding.URL === '', 'contradictory unpublished host address.'); continue; }
      check(binding.URL, binding.TargetPort, binding.PublishedPort, binding.Protocol); composeCount++;
    }
    require(composeCount === 1, 'missing or duplicate expected Compose host mapping.');
    require(service.NetworkSettingsPorts && typeof service.NetworkSettingsPorts === 'object' && !Array.isArray(service.NetworkSettingsPorts), 'missing selected container port inspection.');
    let inspectedCount = 0;
    for (const [key, bindings] of Object.entries(service.NetworkSettingsPorts)) {
      const match = /^(\d+)\/(tcp|udp)$/.exec(key); require(match && +match[1] > 0 && +match[1] <= 65535, 'malformed inspected container port.');
      if (bindings === null) continue; // An exposed port without a host publication.
      require(Array.isArray(bindings), 'malformed inspected bindings.');
      for (const binding of bindings) {
        require(typeof binding.HostPort === 'string' && /^\d+$/.test(binding.HostPort), 'malformed inspected host port.');
        check(binding.HostIp, +match[1], +binding.HostPort, match[2]); inspectedCount++;
      }
    }
    require(inspectedCount === 1, 'missing or duplicate expected inspected host mapping.');
  }
}
export async function diagnoseOwnedDocker(config, owner, { output = () => {}, secrets = [], invoke = run, env = dockerEnvironment() } = {}) {
  const signal = AbortSignal.timeout(15000);
  const control = (command, args, options = {}) => invoke(command, args, { env, timeout: 5000, signal, ...options });
  await assertOwnedDocker(owner, control, env);
  const redactor = lineRedactor(secrets, output);
  try {
    output('[dev-stack] Bounded owned-service logs and health probes before cleanup:\n');
    await control('docker', composeArgs(config, owner, ['logs', '--no-color', '--tail', '100', 'postgres', 'temporal']), { secrets, output: chunk => redactor.chunk(chunk) });
    const ids = (await control('docker', ['container', 'ls', '-a', '-q', '--filter', `label=com.docker.compose.project=${owner.project}`])).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      // Health has status/probe output only. Never inspect Config.Env or the whole container.
      await control('docker', ['container', 'inspect', '--format', '{{json .State.Health}}', id], { secrets, output: chunk => redactor.chunk(chunk) });
    }
  } finally { redactor.end(); }
}
export async function removeOwnedDocker(config, owner, { volumes = false, output, secrets, diagnose = false, invoke = run, env = dockerEnvironment() } = {}) {
  await assertOwnedDocker(owner, invoke, env);
  if (diagnose) {
    try { await diagnoseOwnedDocker(config, owner, { output, secrets, invoke, env }); }
    catch { output?.('[dev-stack] Bounded diagnostics unavailable; continuing owned cleanup.\n'); }
  }
  await invoke('docker', composeArgs(config, owner, ['down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])]), { env, output, secrets, timeout: 120000 });
  await assertOwnedDocker(owner, invoke, env);
  for (const kind of ['container', 'network', ...(volumes ? ['volume'] : [])]) {
    const remaining = await invoke('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${owner.project}`], { env });
    if (remaining.trim()) throw new Error(`Owned ${kind} remains; recovery state retained.`);
  }
}
