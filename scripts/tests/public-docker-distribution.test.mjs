import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public Dockerfile provides native multi-arch core, browser, and redistributable pinned CLI targets", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const normalizedDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");

  assert.match(dockerfile, /FROM .* AS core/);
  assert.match(dockerfile, /FROM .* AS browser/);
  assert.match(dockerfile, /FROM .* AS cli/);
  assert.match(dockerfile, /ARG TARGETARCH/);
  assert.match(dockerfile, /await r\.json\(\)/);
  assert.match(dockerfile, /body\.ok !== true/);
  assert.match(dockerfile, /rotate-owner-setup-token\.mjs/);
  for (const dependency of [
    "@openai/codex@0.145.0",
    "@google/gemini-cli@0.52.0",
    "opencode-ai@1.18.4",
    "@qwen-code/qwen-code@0.20.1",
    "@moonshot-ai/kimi-code@0.29.0",
    "@xai-official/grok@0.2.111",
    "run-deepseek-cli@0.1.1"
  ]) {
    assert.match(dockerfile, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code/);
  assert.match(
    normalizedDockerfile,
    /npm install --global --ignore-scripts --no-audit --no-fund\s+run-deepseek-cli@0\.1\.1/
  );
  assert.doesNotMatch(dockerfile, /docker\.sock/);
  assert.match(dockerfile, /COPY --from=build --chown=spaceapp:spaceapp \/app\/LICENSE \/app\/NOTICE \/app\/THIRD_PARTY_NOTICES\.md \.\//);
});

test("public Compose runs without host Docker access or development credentials", async () => {
  const compose = await readFile(
    join(root, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );

  for (const service of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "postgres", "temporal"]) {
    assert.match(compose, new RegExp(`^  ${service}:`, "m"));
  }
  assert.match(compose, /127\.0\.0\.1|SPACEAPP_BIND_HOST/);
  assert.match(compose, /SPACE_BROWSER_SESSIONS_ENABLED: "true"/);
  assert.match(compose, /SPACE_CODEX_HOME: \/var\/lib\/spaceapp-cli\/providers\/codex/);
  assert.match(compose, /SPACE_CODEX_GOALS_DB_PATH: \/var\/lib\/spaceapp\/codex-goals\.sqlite/);
  assert.match(compose, /SPACE_CODEX_APP_SERVER_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CODEX_ROUTE_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CLI_WORKSPACE_ROOT: \/workspaces/);
  assert.match(compose, /SPACE_MEMORY_GRAPH_ROOT: \/var\/lib\/spaceapp\/memory-graph/);
  assert.match(compose, /SPACE_GEMINI_MEMORY_INDEX_PATH: \/var\/lib\/spaceapp\/memory\/gemini_history\.md/);
  assert.match(compose, /SPACE_GEMINI_MEMORY_MONTHLY_PATH: \/var\/lib\/spaceapp\/memory\/gemini_history_monthly\.md/);
  assert.match(compose, /SPACE_GEMINI_MEMORY_LOCK_PATH: \/var\/lib\/spaceapp\/memory\/\.memory\.lock/);
  assert.match(compose, /SPACE_TELEGRAM_SECRET_ROOT: \/var\/lib\/spaceapp\/telegram/);
  assert.match(
    compose,
    /SPACE_TELEGRAM_OWNERSHIP_MANIFEST: \/var\/lib\/spaceapp\/integrations\/telegram\/thread-ownership\.json/
  );
  assert.match(
    compose,
    /SPACE_CODEX_CLI_MODE_DEFAULTS_PROJECTION_PATH: \/var\/lib\/spaceapp\/codex-cli-mode-defaults-v1\.json/
  );
  assert.match(compose, /spaceapp-workspaces:\/workspaces/);
  assert.match(compose, /exec \/etc\/temporal\/entrypoint\.sh autosetup/);
  assert.doesNotMatch(compose, /space-dev|dev-only|docker\.sock/);
  assert.doesNotMatch(compose, /\/srv\/space|\/home\/spaceapp-user|\/etc\/docs|olla\.gr|Legacy/i);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*\S+/);
  assert.doesNotMatch(compose, /^name:/m);

  const coreBlock = compose.match(/^  spaceapp-core:[\s\S]*?(?=^  spaceapp-cli:)/m)?.[0] || "";
  assert.doesNotMatch(coreBlock, /spaceapp-cli-state|spaceapp-secrets\/providers|secrets\/providers/);
});

test("container entrypoints load secrets from files and drop root before application processes", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const cli = await readFile(join(root, "deploy", "docker", "cli-entrypoint.sh"), "utf8");

  assert.match(core, /SPACE_DATABASE_URL_FILE/);
  assert.match(core, /SPACE_SETUP_TOKEN_SOURCE_FILE/);
  assert.match(core, /install -o spaceapp -g spaceapp -m 0400/);
  assert.match(core, /export SPACE_SETUP_TOKEN_FILE/);
  assert.match(core, /gosu spaceapp/);
  assert.match(cli, /gosu spaceapp/);
  assert.match(cli, /rm -f -- "\$destination"/);
  assert.doesNotMatch(`${core}\n${cli}`, /set -x/);
});

test("public CLI wrapper isolates provider state and supports protected DeepSeek setup", async () => {
  const wrapper = await readFile(join(root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8");
  const credentialStatusBlock = wrapper.match(/credential-status\)[\s\S]*?;;/)?.[0] || "";

  assert.match(wrapper, /DISABLE_UPDATES=1/);
  assert.match(wrapper, /umask 077/);
  assert.match(wrapper, /deepseek\.key/);
  assert.match(wrapper, /export USER=spaceapp/);
  assert.match(wrapper, /login\)\n\s+ensure_runtime_dirs/);
  assert.doesNotMatch(credentialStatusBlock, /ensure_runtime_dirs/);
  assert.match(wrapper, /opencode\) exec "\$command_name" auth login/);
  assert.match(wrapper, /vendor\/claude\/node_modules\/\.bin\/claude/);
  assert.doesNotMatch(wrapper, /setup_deepseek_credential|read -r -s/);
  assert.doesNotMatch(wrapper, /Legacy|\/home\/spaceapp-user|\/srv\/space/i);
});

test("core seeds generic starter memory only when mutable owner memory is absent", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const starter = await readFile(join(root, "starter-memory", "gemini_history.md"), "utf8");

  assert.match(core, /SPACE_MEMORY_ROOT/);
  assert.match(core, /SPACE_STARTER_MEMORY_ROOT/);
  assert.match(core, /if \[ ! -e "\$SPACE_MEMORY_ROOT\/gemini_history\.md" \]/);
  assert.match(core, /if \[ ! -e "\$SPACE_GEMINI_MEMORY_MONTHLY_PATH" \]/);
  assert.match(core, /gemini_history\.md/);
  assert.match(core, /gemini_history_monthly\.md/);
  assert.match(starter, /^# SpaceApp Memory/m);
  assert.doesNotMatch(starter, /\/etc\/docs|\/srv\/space|spaceapp-user|oll4\.com/i);
});
