import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public Dockerfile provides native multi-arch core, browser, and redistributable pinned CLI targets", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const normalizedDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");
  const nodeImage =
    "node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82";
  const nodeStages = Array.from(
    dockerfile.matchAll(/^FROM (\S+) AS (build|runtime-base)$/gm),
    ([, image, stage]) => ({ image, stage })
  );

  assert.match(dockerfile, /FROM .* AS core/);
  assert.match(dockerfile, /FROM .* AS browser/);
  assert.match(dockerfile, /FROM .* AS cli/);
  assert.deepEqual(nodeStages, [
    { image: nodeImage, stage: "build" },
    { image: nodeImage, stage: "runtime-base" }
  ]);
  assert.equal(
    normalizedDockerfile.match(/apt-get install -y --no-install-recommends[^&]*liblzma5/g)?.length,
    3,
    "build, runtime, and browser apt transactions must explicitly install patched liblzma5"
  );
  assert.match(dockerfile, /ARG TARGETARCH/);
  assert.match(dockerfile, /ARG NPM_VERSION=11\.18\.0/);
  assert.match(
    normalizedDockerfile,
    /npm install --global --ignore-scripts --no-audit --no-fund "npm@\$\{NPM_VERSION\}"/
  );
  assert.match(dockerfile, /await r\.json\(\)/);
  assert.match(dockerfile, /body\.ok !== true/);
  assert.match(dockerfile, /rotate-owner-setup-token\.mjs/);
  assert.match(dockerfile, /opencode-ai@1\.18\.4/);
  assert.doesNotMatch(dockerfile, /@openai\/codex|@google\/gemini-cli|@anthropic-ai\/claude-code|run-deepseek-cli/);
  const installer = await readFile(join(root, "deploy/docker/provider-install.mjs"), "utf8");
  assert.match(installer, /@openai\/codex@0\.145\.0/);
  assert.match(installer, /Unsupported optional provider/);
  assert.doesNotMatch(dockerfile, /docker\.sock/);
  assert.match(dockerfile, /COPY --from=build --chown=spaceapp:spaceapp \/app\/LICENSE \/app\/NOTICE \/app\/THIRD_PARTY_NOTICES\.md \.\//);
});

test("public container images identify their repository and license for GHCR", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.source=https:\/\/github\.com\/oll4com\/spaceapp$/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.licenses=BUSL-1\.1$/m
  );
});

test("CLI image removes the npm download cache in the same layer as bundled CLI installation", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const normalizedCliStage = cliStage.replace(/\\\r?\n\s*/g, " ");

  assert.match(
    normalizedCliStage,
    /RUN apt-get update[\s\S]*npm install[\s\S]*opencode-ai@1\.18\.4[\s\S]*&& npm cache clean --force/
  );
  // Pilot F18: agents check their work with python3; the apt lists leave in the same layer.
  assert.match(normalizedCliStage, /apt-get install -y --no-install-recommends python3-minimal\s+&& rm -rf \/var\/lib\/apt\/lists\/\*/);
});

test("CLI image resolves the default room project /opt/spaceapp to the documented /etc session directory", async () => {
  // 1.1.3 devtest: without it the Getting Started OpenCode pane exited with chdir(2) failed.
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  assert.match(cliStage, /^RUN ln -s \/etc \/opt\/spaceapp$/m);
  const coreStage = dockerfile.match(/FROM runtime-base AS core([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  assert.doesNotMatch(coreStage, /ln -s \/etc \/opt\/spaceapp/);
  const agents = await readFile(join(root, "starter-memory", "AGENTS.md"), "utf8");
  assert.match(agents, /cwd=\/etc/);
});

test("runtime images patch fixable vulnerabilities in npm's bundled dependencies", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const runtimeStage =
    dockerfile.match(/FROM [^\n]+ AS runtime-base([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const normalizedRuntimeStage = runtimeStage
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/\s+/g, " ");

  assert.match(
    normalizedRuntimeStage,
    /npm pack --ignore-scripts --no-audit --no-fund --pack-destination \/tmp\/npm-security-patches brace-expansion@5\.0\.12 tar@7\.5\.21 ip-address@10\.7\.1 undici@6\.28\.1 postcss-selector-parser@7\.1\.6/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/brace-expansion-5\.0\.12\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/brace-expansion --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/tar-7\.5\.21\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/ip-address-10\.7\.1\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/ip-address --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/postcss-selector-parser-7\.1\.6\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/postcss-selector-parser --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/undici-6\.28\.1\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/undici --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /rm -rf \/tmp\/npm-security-patches && npm cache clean --force/
  );
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
  assert.match(compose, /SPACE_BROWSER_SESSIONS_ENABLED: "\$\{SPACEAPP_BROWSER_ENABLED\}"/);
  assert.match(compose, /^    profiles: \["standard"\]$/m);
  for (const variable of [
    "SPACEAPP_CORE_MEMORY_LIMIT",
    "SPACEAPP_CLI_MEMORY_LIMIT",
    "SPACEAPP_BROWSER_MEMORY_LIMIT",
    "SPACEAPP_POSTGRES_MEMORY_LIMIT",
    "SPACEAPP_TEMPORAL_MEMORY_LIMIT"
  ]) {
    assert.match(compose, new RegExp(`mem_limit: "\\$\\{${variable}\\}"`));
  }
  assert.match(compose, /SPACE_CODEX_HOME: \/var\/lib\/spaceapp-cli\/providers\/codex/);
  assert.match(compose, /SPACE_CODEX_GOALS_DB_PATH: \/var\/lib\/spaceapp\/codex-goals\.sqlite/);
  assert.match(compose, /SPACE_CODEX_APP_SERVER_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CODEX_ROUTE_COMMAND: \/usr\/local\/bin\/codex-vscode-parity/);
  assert.match(compose, /SPACE_CLI_WORKSPACE_ROOT: \/workspaces/);
  assert.match(compose, /SPACE_MEMORY_GRAPH_ROOT: \/var\/lib\/spaceapp\/memory-graph/);
  assert.match(compose, /SPACE_MEMORY_INDEX_PATH: \/var\/lib\/spaceapp\/memory\/space_memory\.md/);
  assert.match(compose, /SPACE_MEMORY_MONTHLY_PATH: \/var\/lib\/spaceapp\/memory\/space_memory_monthly\.md/);
  assert.match(compose, /SPACE_MEMORY_LOCK_PATH: \/var\/lib\/spaceapp\/memory\/\.memory\.lock/);
  assert.doesNotMatch(compose, /gemini_history|SPACE_GEMINI_MEMORY/);
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
  assert.match(compose, /cluster health.*&& temporal operator namespace describe --namespace default/);
  assert.doesNotMatch(compose, /space-dev|dev-only|docker\.sock/);
  assert.doesNotMatch(compose, /\/srv\/space|\/home\/spaceapp-user|\/etc\/docs|olla\.gr|Legacy/i);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*\S+/);
  assert.doesNotMatch(compose, /^name:/m);

  const coreBlock = compose.match(/^  spaceapp-core:[\s\S]*?(?=^  spaceapp-cli:)/m)?.[0] || "";
  assert.doesNotMatch(coreBlock, /spaceapp-cli-state|spaceapp-secrets\/providers|secrets\/providers/);

  for (const [service, nextService] of [
    ["spaceapp-core", "spaceapp-cli"],
    ["spaceapp-cli", "spaceapp-browser"],
    ["spaceapp-browser", "postgres"]
  ]) {
    const block =
      compose.match(new RegExp(`^  ${service}:[\\s\\S]*?(?=^  ${nextService}:)`, "m"))?.[0] || "";
    assert.match(block, /^    security_opt:\n      - no-new-privileges:true$/m);
    assert.doesNotMatch(block, /cap_drop:/);
  }
});

test("container entrypoints load secrets and keep CLI root only for explicit host-root access", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const cli = await readFile(join(root, "deploy", "docker", "cli-entrypoint.sh"), "utf8");

  assert.match(core, /SPACE_DATABASE_URL_FILE/);
  assert.match(core, /SPACE_SETUP_TOKEN_SOURCE_FILE/);
  assert.match(core, /install -o spaceapp -g spaceapp -m 0400/);
  assert.match(core, /export SPACE_SETUP_TOKEN_FILE/);
  assert.match(core, /gosu spaceapp/);
  assert.match(
    cli,
    /if \[ "\$\{SPACEAPP_CLI_HOST_ROOT_ACCESS:-false\}" = "true" \]; then\s+exec gosu root:spaceapp node packages\/cli-host\/dist\/main\.js\s+fi/
  );
  assert.match(cli, /gosu spaceapp/);
  assert.match(
    cli,
    /chown -hR spaceapp:spaceapp \/var\/lib\/spaceapp-cli \/var\/lib\/spaceapp\/memory/
  );
  assert.doesNotMatch(cli, /chown -R[^\n]*\/workspaces/);
  assert.match(cli, /rm -f -- "\$destination"/);
  assert.doesNotMatch(cli, /(?:-n|-z).*SPACEAPP_CLI_HOST_ROOT_ACCESS/);
  assert.doesNotMatch(`${core}\n${cli}`, /set -x/);
});

test("host-root CLI socket remains accessible to the non-root core service", async () => {
  const cli = await readFile(join(root, "deploy", "docker", "cli-entrypoint.sh"), "utf8");
  const cliMain = await readFile(join(root, "packages", "cli-host", "src", "main.ts"), "utf8");

  assert.match(
    cli,
    /SPACEAPP_CLI_HOST_ROOT_ACCESS:-false\}" = "true" \]; then\s+exec gosu root:spaceapp node packages\/cli-host\/dist\/main\.js\s+fi/
  );
  assert.match(cliMain, /createCliHostServer\(\{ socketPath, socketMode: 0o660, registry \}\)/);
});

test("an OpenCode pane still starts when the first-run free-model check fails; credential smoke stays strict", async () => {
  // 1.1.3 devtest (vm218): a failed check exited the wrapper (set -e) and left the
  // Getting Started pane without a CLI ("CLI process exited with code 1").
  const wrapper = await readFile(join(root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8");
  const launch = wrapper.slice(wrapper.lastIndexOf('if [ "$runtime_name" = "opencode" ]; then'));
  assert.match(launch, /\*\) if ! node \/app\/deploy\/docker\/opencode-first-run\.mjs; then\s+echo "[^"]*OpenCode starts anyway[^"]*" >&2\s+fi ;;/);
  const smoke = wrapper.match(/credential-smoke\)[\s\S]*?;;/)?.[0] || "";
  assert.match(smoke, /^\s+node \/app\/deploy\/docker\/opencode-first-run\.mjs$/m);
  assert.match(wrapper, /^set -euo pipefail$/m);
});

test("public CLI wrapper isolates provider state and supports protected DeepSeek setup", async () => {
  const wrapper = await readFile(join(root, "deploy", "docker", "public-cli-wrapper.sh"), "utf8");
  const credentialStatusBlock = wrapper.match(/credential-status\)[\s\S]*?;;/)?.[0] || "";

  assert.match(wrapper, /DISABLE_UPDATES=1/);
  assert.match(wrapper, /umask 077/);
  assert.match(wrapper, /deepseek\.key/);
  assert.match(wrapper, /export USER=spaceapp/);
  assert.match(wrapper, /login\)\n\s+ensure_optional_provider\n\s+ensure_runtime_dirs/);
  assert.doesNotMatch(credentialStatusBlock, /ensure_runtime_dirs/);
  assert.match(wrapper, /opencode\) exec "\$command_name" auth login/);
  // Pilot finding F4: OpenCode uses the Anthropic and OpenAI keys set for Claude Code and Codex.
  const opencodeBlock = wrapper.match(/\n  opencode\)\n[\s\S]*?;;/)?.[0] || "";
  assert.match(opencodeBlock, /ANTHROPIC_API_KEY="\$\(cat "\$credential_root\/claude\.key"\)"/);
  assert.match(opencodeBlock, /OPENAI_API_KEY="\$\(cat "\$credential_root\/codex\.key"\)"/);
  assert.match(wrapper, /vendor\/claude\/node_modules\/\.bin\/claude/);
  assert.match(wrapper, /autohand\)\n\s+command_name="autohand"/);
  assert.match(wrapper, /AUTOHAND_HOME="\$state_root"/);
  assert.match(wrapper, /AUTOHAND_API_KEY=/);
  assert.match(wrapper, /cursor\)\n\s+command_name="cursor-agent"/);
  assert.match(wrapper, /CURSOR_CONFIG_DIR="\$state_root"/);
  assert.match(wrapper, /AGENT_CLI_CREDENTIAL_STORE="file"/);
  assert.match(wrapper, /copilot\)\n\s+command_name="copilot"/);
  assert.match(wrapper, /COPILOT_HOME="\$state_root"/);
  assert.match(wrapper, /autohand\) \[ -s "\$state_root\/config\.json" \]/);
  assert.match(wrapper, /cursor\) \[ -s "\$state_root\/\.config\/cursor\/auth\.json" \]/);
  assert.match(wrapper, /copilot\) \[ -s "\$state_root\/config\.json" \]/);
  assert.doesNotMatch(wrapper, /setup_deepseek_credential|read -r -s/);
  assert.doesNotMatch(wrapper, /Legacy|\/home\/spaceapp-user|\/srv\/space/i);
});

test("memory-names moves legacy gemini_history memory once and keeps the old names as links (pilot F13)", async () => {
  const memory = await mkdtemp(join(tmpdir(), "spaceapp-memory-names-"));
  try {
    await writeFile(join(memory, "gemini_history.md"), "# owner index\n");
    await writeFile(join(memory, "gemini_history_monthly.md"), "# owner month\n");
    for (let run = 0; run < 2; run += 1) execFileSync("sh", [join(root, "deploy", "docker", "memory-names.sh"), memory]);
    assert.equal(await readFile(join(memory, "space_memory.md"), "utf8"), "# owner index\n");
    assert.equal(await readFile(join(memory, "space_memory_monthly.md"), "utf8"), "# owner month\n");
    assert.equal(await readlink(join(memory, "gemini_history.md")), "space_memory.md");
    assert.equal(await readlink(join(memory, "gemini_history_monthly.md")), "space_memory_monthly.md");
    assert.ok((await lstat(join(memory, "space_memory.md"))).isFile());
  } finally {
    await rm(memory, { recursive: true, force: true });
  }
  const fresh = await mkdtemp(join(tmpdir(), "spaceapp-memory-names-"));
  try {
    execFileSync("sh", [join(root, "deploy", "docker", "memory-names.sh"), fresh]);
    await assert.rejects(lstat(join(fresh, "gemini_history.md")));
    await assert.rejects(lstat(join(fresh, "space_memory.md")));
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("core seeds generic starter memory only when mutable owner memory is absent", async () => {
  const core = await readFile(join(root, "deploy", "docker", "core-entrypoint.sh"), "utf8");
  const starter = await readFile(join(root, "starter-memory", "space_memory.md"), "utf8");

  assert.match(core, /SPACE_MEMORY_ROOT/);
  assert.match(core, /SPACE_STARTER_MEMORY_ROOT/);
  assert.match(core, /sh deploy\/docker\/memory-names\.sh "\$SPACE_MEMORY_ROOT"\nif \[ ! -e "\$SPACE_MEMORY_ROOT\/space_memory\.md" \]/);
  assert.match(core, /if \[ ! -e "\$SPACE_MEMORY_MONTHLY_PATH" \]/);
  assert.match(core, /space_memory_monthly\.md/);
  assert.doesNotMatch(core, /gemini_history|SPACE_GEMINI_MEMORY/);
  assert.match(starter, /^# SpaceApp Memory/m);
  assert.doesNotMatch(starter, /\/etc\/docs|\/srv\/space|spaceapp-user|oll4\.com/i);
});
