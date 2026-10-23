import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('../dev-stack-config.mjs', import.meta.url);
const load = () => import(moduleUrl);

test('reads current image digests and OpenCode package from their source of truth', async t => {
  const { readPins } = await load();
  const pins = await readPins(new URL('../../', import.meta.url));
  assert.match(pins.postgres, /^pgvector\/pgvector:.+@sha256:[a-f0-9]{64}$/);
  assert.match(pins.temporal, /^temporalio\/auto-setup:.+@sha256:[a-f0-9]{64}$/);
  assert.match(pins.opencode, /^(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+/);
  const root = await mkdtemp(join(tmpdir(), 'dev-pins-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/run-spaceapp/templates'), { recursive: true });
  await writeFile(join(root, 'Dockerfile'), 'RUN npm install --global opencode-ai@9.8.7');
  await writeFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), `services:\n  postgres:\n    image: pgvector/test@sha256:${'a'.repeat(64)}\n  temporal:\n    image: temporal/test@sha256:${'b'.repeat(64)}\n`);
  const changed = await readPins(root);
  assert.equal(changed.opencode, 'opencode-ai@9.8.7');
  assert.equal(changed.postgres, `pgvector/test@sha256:${'a'.repeat(64)}`);
  await writeFile(join(root, 'packages/run-spaceapp/templates/compose.yml'), '  postgres:\n    image: pgvector/test:latest');
  await assert.rejects(readPins(root), /pinned postgres/);
});

test('secrets are private and persistent, while container ports stay on loopback', async t => {
  const { initialize, composeDocument, childEnvironment } = await load();
  const root = await mkdtemp(join(tmpdir(), 'dev-stack-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await initialize(root, { SPACE_DEV_API_PORT: '15410', SPACE_DEV_WEB_PORT: '15411' });
  const again = await initialize(root, {});
  assert.equal(again.project, config.project);
  assert.equal(again.ports.api, 15410);
  for (const name of ['postgres-password', 'database-url', 'session-secret', 'setup-token', 'opencode-password']) {
    assert.equal((await stat(join(config.state, 'secrets', name))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(config.state, 'secrets', name), 'utf8'), await readFile(join(again.state, 'secrets', name), 'utf8'));
  }
  const compose = composeDocument(config, { postgres: 'postgres@sha256:abc', temporal: 'temporal@sha256:def' });
  assert.equal(compose.services.postgres.ports[0], '127.0.0.1:15432:5432');
  assert.equal(compose.services.temporal.ports[0], '127.0.0.1:17233:7233');
  assert.deepEqual(Object.keys(compose.services), ['postgres', 'temporal']);
  const env = await childEnvironment(config, { PATH: '/usr/bin:/bin', OPENAI_API_KEY: 'do-not-inherit', SPACE_DEV_LOGIN: 'true', SPACE_DATABASE_URL: 'operator-db', NODE_OPTIONS: '--require bad' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SPACE_DEV_LOGIN, 'false');
  assert.equal(env.SPACE_API_HOST, '127.0.0.1');
  assert.equal(env.SPACE_WEB_HOST, '127.0.0.1');
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, 'true');
  assert.match(env.SPACE_DATABASE_URL, /@127\.0\.0\.1:15432\/spaceapp$/);
  assert.equal(env.SPACE_API_ORIGIN, 'http://127.0.0.1:15410');
});

test('rejects unsafe or duplicate ports and refuses unowned state', async t => {
  const { initialize } = await load();
  const root = await mkdtemp(join(tmpdir(), 'dev-stack-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(initialize(root, { SPACE_DEV_API_PORT: '4910junk' }), /port/i);
  await assert.rejects(initialize(root, { SPACE_DEV_API_PORT: '15411' }), /port/i);
  const config = await initialize(root, {});
  await writeFile(join(config.state, 'owner.json'), JSON.stringify({ root: '/different-checkout' }));
  await assert.rejects(initialize(root, {}), /belong|owned|owner/i);
});

test('repairs the packaged macOS PTY helper without broad dependency permission changes', async t => {
  const { preparePty } = await load();
  const root = await mkdtemp(join(tmpdir(), 'dev-pty-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'node_modules/node-pty/prebuilds/darwin-arm64');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'spawn-helper'), 'fixture', { mode: 0o644 });
  await writeFile(join(directory, 'pty.node'), 'fixture', { mode: 0o644 });
  await preparePty(root, 'darwin', 'arm64');
  assert.equal((await stat(join(directory, 'spawn-helper'))).mode & 0o777, 0o755);
  assert.equal((await stat(join(directory, 'pty.node'))).mode & 0o777, 0o644);
});
