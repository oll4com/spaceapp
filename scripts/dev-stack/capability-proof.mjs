// Fail early on real native dependencies before the lengthy stock gates. This
// isolated temporary state is never an operator profile or a provider login.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPins, initialize, loadOwner, locations, secrets, serviceEnvironment } from './state.mjs';
import { verifyOpenCode } from './opencode-runtime.mjs';
import { verifyPtyCapability } from './pty-capability.mjs';
import { run } from './resources.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url))), artifacts = resolve(process.env.SPACE_DEV_PROOF_DIR || '');
const rel = relative(root, artifacts);
assert(process.env.SPACE_DEV_PROOF_DIR && rel && (rel.startsWith('..') || isAbsolute(rel)), 'Private proof directory must be outside the checkout.');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const config = locations(root, { SPACE_DEV_STATE_DIR: `.dev-stack-capability-${randomUUID()}` });
const owner = await initialize(config), env = serviceEnvironment(config, owner, await secrets(config), process.env);
const proof = { source: process.env.SPACE_DEV_CANDIDATE, platform: process.platform, stage: 'before-pty', ok: false, providerCredentials: false, modelInference: false };
try {
  await verifyPtyCapability(root, config.state, { inherited: env, evidence: join(artifacts, 'early-pty-capability.json') });
  const pins = extractPins(await readFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), 'utf8'), await readFile(join(root, 'Dockerfile'), 'utf8'));
  proof.expectedVersion = pins.opencode; proof.stage = 'install-private-pinned-package';
  await run('npm', ['install', '--prefix', join(config.state, 'cli/vendor/opencode'), '--ignore-scripts', '--no-audit', '--no-fund', `opencode-ai@${pins.opencode}`], { cwd: root, env, output: text => process.stdout.write(text) });
  await verifyOpenCode(config.state, pins.opencode, { inherited: env, observe: async value => Object.assign(proof, value) });
  console.log('[dev-stack-capability] PASS actual pinned native --version and real zero-provider printf PTY');
} catch (error) { proof.error ??= { name: error.name, code: error.code ?? null, signal: error.signal ?? null }; throw error;
} finally { await writeFile(join(artifacts, 'early-opencode-capability.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); await loadOwner(config); await rm(config.state, { recursive: true }); }
