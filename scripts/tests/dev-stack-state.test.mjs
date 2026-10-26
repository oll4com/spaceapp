// 龙娘 · 2026-10-26: verify #65 configuration isolation and state ownership without operator data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, prepareState, assertOwnedState } from '../dev-stack/state.mjs';

const digest = 'a'.repeat(64);
const compose = `services:\n  postgres:\n    image: pgvector/pgvector:test@sha256:${digest}\n  temporal:\n    image: temporalio/auto-setup:test@sha256:${digest}\n`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages/run-spaceapp/templates'), { recursive: true });
  await writeFile(path.join(root, 'packages/run-spaceapp/templates/compose.yml'), compose);
  await writeFile(path.join(root, 'Dockerfile'), 'RUN npm install --global @opencode/cli@2.0.32 \\\n    && true\n');
  return root;
}

test('configuration derives pins, ports and distinct canonical checkout identity', async t => {
  const root = await fixture(t);
  const config = await loadConfig(root);
  assert.deepEqual(config.ports, { api: 14910, web: 14911, postgres: 15432, temporal: 17233 });
  assert.equal(config.images.postgres, `pgvector/pgvector:test@sha256:${digest}`);
  assert.equal(config.images.temporal, `temporalio/auto-setup:test@sha256:${digest}`);
  assert.equal(config.openCodePackage, '@opencode/cli@2.0.32');
  assert.match(config.projectName, /^spaceapp-dev-[a-f0-9]{12}$/);
  assert.equal(config.cliSocket, path.join(root, '.dev-stack/cli.sock'));
  assert.equal(config.controlSocket, path.join(root, '.dev-stack/control.sock'));
  const other = await loadConfig(await fixture(t));
  assert.notEqual(other.projectName, config.projectName);
  assert.notEqual(other.stateDir, config.stateDir);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { force: true }));
  await symlink(root, alias);
  assert.deepEqual(await loadConfig(alias), config);
  assert.equal((await loadConfig(root, { SPACE_DEV_API_PORT: '16000' })).ports.api, 16000);
  await writeFile(path.join(root, 'Dockerfile'), 'RUN npm install opencode-ai@7.2.1');
  assert.equal((await loadConfig(root)).openCodePackage, 'opencode-ai@7.2.1');
});

test('configuration rejects invalid, reserved and duplicate ports', async t => {
  const root = await fixture(t);
  for (const value of ['1023', '65536', '4910', '4911', '1.2', 'NaN', '', ' 16000', '16000x']) {
    await assert.rejects(loadConfig(root, { SPACE_DEV_API_PORT: value }), /Invalid development port/);
  }
  await assert.rejects(loadConfig(root, { SPACE_DEV_API_PORT: '14911' }), /distinct/);
  for (const name of ['API', 'WEB', 'POSTGRES', 'TEMPORAL']) {
    assert.equal((await loadConfig(root, { [`SPACE_DEV_${name}_PORT`]: '20000' })).ports[name.toLowerCase()], 20000);
  }
});

test('configuration refuses missing or floating pins and excessive socket bytes', async t => {
  const root = await fixture(t);
  const composePath = path.join(root, 'packages/run-spaceapp/templates/compose.yml');
  await writeFile(composePath, compose.replace(`@sha256:${digest}`, ''));
  await assert.rejects(loadConfig(root), /digest-pinned postgres/);
  await writeFile(composePath, compose.replace('  temporal:', '  renamed:'));
  await assert.rejects(loadConfig(root), /digest-pinned temporal/);
  await writeFile(composePath, compose);
  await writeFile(path.join(root, 'Dockerfile'), 'RUN npm install @opencode/cli@latest');
  await assert.rejects(loadConfig(root), /exact OpenCode/);
  const longRoot = path.join(root, '龙'.repeat(30));
  await mkdir(longRoot);
  await assert.rejects(loadConfig(longRoot), /shorter than 100 bytes/);
});

test('preparation makes private stable generated state and a matching ownership manifest', async t => {
  const root = await fixture(t);
  const config = await loadConfig(root);
  const first = await prepareState(config);
  for (const value of Object.values(first)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(first)).size, 3);
  assert.deepEqual(await prepareState(config), first);
  await assertOwnedState(config);
  for (const relative of ['', 'secrets', 'logs', 'providers', 'providers/opencode', 'workspaces', 'memory', 'memory-graph', 'artifacts', 'bin', 'vendor']) {
    assert.equal((await lstat(path.join(config.stateDir, relative))).mode & 0o777, 0o700);
  }
  for (const relative of ['manifest.json', 'secrets/postgres-password', 'secrets/session-secret', 'secrets/setup-token']) {
    assert.equal((await lstat(path.join(config.stateDir, relative))).mode & 0o777, 0o600);
  }
  const manifest = JSON.parse(await readFile(path.join(config.stateDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { format: 'spaceapp-dev-stack', version: 1, repoRoot: root, projectName: config.projectName, ports: config.ports });
});

test('unknown and symlink state directories are refused without modifying their contents', async t => {
  const root = await fixture(t);
  const config = await loadConfig(root);
  await assert.rejects(assertOwnedState(config), /real directory/);
  await mkdir(config.stateDir);
  await writeFile(path.join(config.stateDir, 'owner-data'), 'keep');
  await assert.rejects(prepareState(config), /valid ownership manifest/);
  assert.equal(await readFile(path.join(config.stateDir, 'owner-data'), 'utf8'), 'keep');
  await rm(config.stateDir, { recursive: true });
  const target = path.join(root, 'target');
  await mkdir(target);
  await symlink(target, config.stateDir);
  await assert.rejects(prepareState(config), /never a symlink/);
});

test('manifest tampering, port drift and unsafe state entries are refused', async t => {
  const root = await fixture(t);
  const config = await loadConfig(root);
  await prepareState(config);
  await assert.rejects(prepareState(await loadConfig(root, { SPACE_DEV_API_PORT: '20000' })), /does not match/);
  const manifestPath = path.join(config.stateDir, 'manifest.json');
  const original = await readFile(manifestPath, 'utf8');
  for (const [key, value] of [['format', 'other'], ['version', 2], ['repoRoot', '/other'], ['projectName', 'other'], ['ports', {}]]) {
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), [key]: value }));
    await assert.rejects(prepareState(config), /does not match/);
  }
  await writeFile(manifestPath, original);
  await rm(path.join(config.stateDir, 'providers/opencode'), { recursive: true });
  await symlink(root, path.join(config.stateDir, 'providers/opencode'));
  await assert.rejects(prepareState(config), /unsafe state directory/);
  await rm(path.join(config.stateDir, 'providers/opencode'));
  const secret = path.join(config.stateDir, 'secrets/setup-token');
  await rm(secret);
  await symlink(path.join(root, 'Dockerfile'), secret);
  await assert.rejects(prepareState(config), /regular state file/);
  await rm(secret);
  await writeFile(secret, 'corrupt');
  await assert.rejects(prepareState(config), /Invalid generated development secret/);
  await rm(manifestPath);
  await symlink(path.join(root, 'Dockerfile'), manifestPath);
  await assert.rejects(assertOwnedState(config), /valid ownership manifest/);
});
