// PR64-03 smoke test (node:test + Node built-ins only).
// Red on base: deploy/docker/container-smoke.mjs does not exist before the per-target smoke lands.
// Green on HEAD: the smoke covers every target on both architectures with no way to leave a check
// out, the workflow runs it unconditionally after the size budget on native runners, and its
// companion images, markers and version pin come from the launcher template and the Dockerfile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const smoke = await import(join(HERE, 'container-smoke.mjs'));
const source = readFileSync(join(HERE, 'container-smoke.mjs'), 'utf8');
const workflow = readFileSync(join(REPO, '.github/workflows/containers.yml'), 'utf8');

// The workflow's steps, as blocks, in order.
const steps = workflow.split(/\n {6}- /).slice(1);
/** The position of the workflow step with this name, or -1. @param {string} name @returns {number} */
const stepIndex = (name) => steps.findIndex((s) => new RegExp(`^name: ${name}`).test(s));

test('smoke covers every target and arch without skips', () => {
  assert.deepEqual(smoke.TARGETS, ['core', 'browser', 'cli']);
  assert.deepEqual(smoke.ARCHES, ['amd64', 'arm64']);
  for (const target of smoke.TARGETS) {
    assert.equal(typeof smoke.SMOKES[target], 'function', `${target} has a smoke`);
    assert.ok(smoke.CHECKS[target].length >= 2, `${target} runs more than one check`);
  }
  assert.ok(smoke.CHECKS.core.includes(smoke.MARKERS.worker), 'core requires the worker RUNNING');
  assert.ok(smoke.CHECKS.cli.includes(smoke.MARKERS.ping), 'cli requires the host ping');
  assert.ok(smoke.CHECKS.browser.includes(smoke.MARKERS.chromium), 'browser requires a Chromium launch');
  // No environment variable or flag turns a check off.
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*(SKIP|DISABLE|ONLY)/i);
  assert.doesNotMatch(source, /--(skip|no-chromium|no-temporal|only)/i);

  // Every matrix cell runs the smoke: the matrix is unchanged and the step is unconditional.
  assert.match(workflow, /target:\n {10}- core\n {10}- browser\n {10}- cli\n {8}arch:\n {10}- amd64\n {10}- arm64/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.arch == 'arm64' && 'ubuntu-24\.04-arm' \|\| 'ubuntu-latest' \}\}/);
  const budget = stepIndex('Enforce container size budget');
  const smokeStep = stepIndex('Smoke test');
  assert.ok(budget >= 0, 'the budget step stays');
  assert.ok(smokeStep > budget, 'the smoke step runs after the budget step');
  const step = steps[smokeStep];
  assert.match(step, /node deploy\/docker\/container-smoke\.mjs/);
  assert.match(step, /--target "\$\{\{ matrix\.target \}\}"/);
  assert.match(step, /--arch "\$\{\{ matrix\.arch \}\}"/);
  assert.match(step, /--image "spaceapp-ci:\$\{\{ matrix\.target \}\}-\$\{\{ matrix\.arch \}\}"/);
  assert.doesNotMatch(step, /^\s*if:/m);
  assert.doesNotMatch(step, /\|\|\s*true/);
});

test('smoke markers are the literal lines CI reads', () => {
  assert.equal(smoke.MARKERS.pass, 'container-smoke: PASS target=');
  assert.equal(smoke.MARKERS.worker, 'worker=RUNNING');
  assert.equal(smoke.MARKERS.ping, 'ping=ok');
  assert.equal(smoke.MARKERS.chromium, 'chromium=launched');
  for (const marker of Object.values(smoke.MARKERS)) assert.ok(source.includes(`'${marker}'`), `source holds ${marker}`);
});

test('smoke takes the OpenCode version from the Dockerfile pin', () => {
  const pinned = readFileSync(join(REPO, 'Dockerfile'), 'utf8').match(/@opencode\/cli@(\d+\.\d+\.\d+)/)[1];
  assert.equal(smoke.opencodePin(), pinned);
  assert.equal(smoke.opencodePin(), '2.0.32');
});

test('smoke takes the companion images and service environments from the launcher template', () => {
  const postgres = smoke.templateService('postgres');
  const temporal = smoke.templateService('temporal');
  assert.match(postgres.image, /^pgvector\/pgvector:[^@\s]+@sha256:[0-9a-f]{64}$/);
  assert.match(temporal.image, /^temporalio\/auto-setup:[^@\s]+@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.fromEntries(postgres.environment), {
    POSTGRES_DB: 'spaceapp',
    POSTGRES_USER: 'spaceapp',
    POSTGRES_PASSWORD_FILE: '/run/secrets/postgres-password',
  });
  assert.equal(Object.fromEntries(temporal.environment).POSTGRES_SEEDS, 'postgres');

  const inputs = {
    SPACEAPP_IMAGE_TAG: 'smoke',
    SPACEAPP_TELEMETRY: 'false',
    SPACEAPP_WORKFLOWS_ENABLED: 'true',
    SPACEAPP_BROWSER_ENABLED: 'false',
  };
  for (const service of ['spaceapp-core', 'spaceapp-cli', 'spaceapp-browser']) {
    const env = Object.fromEntries(smoke.templateService(service).environment.map(([k, v]) => [k, smoke.expand(v, inputs)]));
    assert.equal(env.SPACE_PUBLIC_DISTRIBUTION, 'true', `${service} runs as the public distribution`);
    for (const [key, value] of Object.entries(env)) assert.doesNotMatch(value, /\$\{/, `${service} ${key} is expanded`);
  }
  const core = Object.fromEntries(smoke.templateService('spaceapp-core').environment.map(([k, v]) => [k, smoke.expand(v, inputs)]));
  assert.equal(core.SPACE_RUNTIME_STORE, 'postgres');
  assert.equal(core.SPACE_TEMPORAL_ADDRESS, 'temporal:7233');
  assert.equal(core.SPACE_APP_VERSION, 'smoke');
  assert.equal(core.SPACE_OPTIONAL_MODULES, 'all');
  assert.equal(core.SPACE_INSTALL_ID, '');
  assert.equal(core.SPACE_BROWSER_SESSIONS_ENABLED, 'false');
  assert.equal(core.SPACEAPP_WORKFLOWS_ENABLED, 'true');
  assert.throws(() => smoke.expand('${SPACEAPP_PORT}', inputs), /placeholder \$\{SPACEAPP_PORT\} has no value/);
  assert.equal(smoke.expand('${A:-x}-${B}-${C:-}', { B: 'b' }), 'x-b-');
  assert.throws(() => smoke.templateService('codex'), /no service codex/);
});
