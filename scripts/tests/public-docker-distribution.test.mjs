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
  assert.match(dockerfile, /@opencode\/cli@2\.0\.32/);
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
    /^LABEL org\.opencontainers\.image\.licenses=MIT$/m
  );
});

test("CLI image removes the npm download cache in the same layer as bundled CLI installation", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const normalizedCliStage = cliStage.replace(/\\\r?\n\s*/g, " ");

  assert.match(
    normalizedCliStage,
    /RUN apt-get update[\s\S]*npm install[\s\S]*@opencode\/cli@2\.0\.32[\s\S]*&& npm cache clean --force/
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

test("core never runs OpenCode itself", async () => {
  // 1.1.7 (decision B): CLIs live only in the CLI container; core asks its credential agent instead.
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = Object.fromEntries(dockerfile.split(/^(?=FROM )/m).map((stage) => [stage.match(/^FROM \S+ AS (\S+)/)?.[1], stage]));
  assert.match(stages.cli, /@opencode\/cli@/);
  for (const name of ["build", "runtime-base", "core", "browser"]) assert.doesNotMatch(stages[name], /@opencode\/cli|opencode-ai/, name);

  const src = join(root, "apps", "api", "src");
  const read = (name) => readFile(join(src, name), "utf8");
  // The only places that start OpenCode or a wrapper's credential-smoke or credential-observation in the API process.
  const direct = /spawn\("opencode"|"\/usr\/local\/bin\/opencode"|\["credential-smoke"\]|\[definition\.credentialObservationAction\]/;
  const found = execFileSync("grep", ["-rlE", direct.source, "--include=*.ts", "--exclude-dir=__tests__", src], { encoding: "utf8" })
    .trim().split("\n").map((path) => path.slice(src.length + 1)).sort();
  assert.deepEqual(found, ["cli-runtimes.ts", "cli-terminal.ts", "opencode-model-bench.ts", "room-agent-model-resolver.ts"]);
  // Each one takes the public credential host's path when there is one.
  const app = await read("app.ts");
  assert.match(app, /const publicCredentialHost = createPublicCredentialHost\(config\);\n  const runOpenCode = publicCredentialHost\?\.openCodeText \?\? runOpenCodeText;/);
  assert.match(app, /new CliTerminalManager\(\{[^}]*?credentialHost: publicCredentialHost,/);
  assert.match(app, /checkCredential: \(runtime\) => checkCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  assert.match(app, /observeCredential: \(runtime\) => observeCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  assert.match(app, /new OpencodeModelBenchService\(\{\n    execVerbose: publicCredentialHost\n      \? \(provider\) => publicCredentialHost\.openCodeModels\(provider\)/);
  assert.match(app, /createOpenCodeTextModel\(\{ run: runOpenCode \}\)/);
  assert.match(app, /completeRoomAgentPrompt\(\{[^}]*runOpenCode \}\)/);
  assert.doesNotMatch(app, /createOpenCodeTextModel\(\)|checkCliRuntimeCredential\(runtime\)|observeCliRuntimeCredential\(runtime\)/);
  assert.match(await read("cli-terminal.ts"), /this\.options\.credentialHost\n\s+\? await this\.options\.credentialHost\.execute\(runtime\.detectedCommandPath, \["credential-smoke"\]/);
  assert.match(await read("room-agent.ts"), /runOpenCode = runOpenCodeText \} = input;/);
  assert.doesNotMatch(await read("room-agent.ts"), /await runOpenCodeText\(/);
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

test("Dockerfile stages per-target /app-targets trees instead of copying the full monorepo into runtime-base", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const buildStage = dockerfile.match(/FROM [^\n]+ AS build([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const runtimeBaseStage =
    dockerfile.match(/FROM [^\n]+ AS runtime-base([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const coreStage = dockerfile.match(/FROM runtime-base AS core([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const browserStage =
    dockerfile.match(/FROM runtime-base AS browser([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";

  const { isPublicExportPath } = await import("../public-export.mjs");

  assert.equal(isPublicExportPath("scripts/stage-container-runtime.mjs"), true);
  assert.equal(isPublicExportPath("scripts/smoke-container-image.mjs"), true);
  assert.match(
    buildStage,
    /node scripts\/stage-container-runtime\.mjs --source \/app --output \/app-targets --arch "\$\{TARGETARCH:-\}"/
  );
  assert.doesNotMatch(
    runtimeBaseStage,
    /COPY --from=build[^\n]*\/app\/(?:node_modules|apps|packages|demos|starter-memory|agent-skills|scripts)/
  );
  assert.match(coreStage, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/core\/ \.\//);
  assert.match(browserStage, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/browser\/ \.\//);
  assert.match(cliStage, /COPY --from=build --chown=spaceapp:spaceapp \/app-targets\/cli\/ \.\//);
});

test("stageContainerRuntime isolates core, browser, and cli runtime trees and strips cross-arch native artifacts", async () => {
  const { existsSync } = await import("node:fs");
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolveTemporalBridgeReleaseTarget, stageContainerRuntime } = await import(
    "../stage-container-runtime.mjs"
  );
  const { parsePostgresImageFromCompose, parseSmokeArgs } = await import("../smoke-container-image.mjs");

  assert.equal(resolveTemporalBridgeReleaseTarget("amd64"), "x86_64-unknown-linux-gnu");
  assert.equal(resolveTemporalBridgeReleaseTarget("arm64"), "aarch64-unknown-linux-gnu");

  const parsedSmoke = parseSmokeArgs([
    "--target",
    "core",
    "--arch",
    "amd64",
    "--image",
    "spaceapp-ci:core-amd64"
  ]);
  assert.equal(parsedSmoke.target, "core");
  assert.equal(parsedSmoke.arch, "amd64");
  assert.equal(parsedSmoke.image, "spaceapp-ci:core-amd64");
  assert.equal(parsedSmoke.postgresImage, parsePostgresImageFromCompose());
  assert.match(parsedSmoke.postgresImage, /^pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64}$/);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "spaceapp-stage-test-"));
  const sourceRoot = join(fixtureRoot, "source");
  const outputRoot = join(fixtureRoot, "output");

  try {
    await mkdir(join(sourceRoot, "apps/api/dist/services"), { recursive: true });
    await mkdir(join(sourceRoot, "apps/api/src"), { recursive: true });
    await mkdir(join(sourceRoot, "apps/web/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "apps/web/src"), { recursive: true });
    await mkdir(join(sourceRoot, "apps/worker/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/browser-host/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/cli-host/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/contracts/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/db/dist/migrations"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/gateway/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/gateway/grammars"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/memory-graph/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "packages/runtime/dist"), { recursive: true });
    await mkdir(join(sourceRoot, "demos/starter"), { recursive: true });
    await mkdir(join(sourceRoot, "starter-memory"), { recursive: true });
    await mkdir(join(sourceRoot, "agent-skills/skill-a"), { recursive: true });
    await mkdir(join(sourceRoot, "scripts"), { recursive: true });

    await writeFile(
      join(sourceRoot, "package.json"),
      JSON.stringify({ name: "spaceapp", private: true, workspaces: ["apps/*", "packages/*"] })
    );
    await writeFile(
      join(sourceRoot, "apps/api/package.json"),
      JSON.stringify({
        name: "@space/api",
        version: "0.2.5",
        dependencies: {
          "@space/browser-host": "0.2.5",
          "@space/cli-host": "0.2.5",
          "@space/contracts": "0.2.5",
          "@space/db": "0.2.5",
          "@space/gateway": "0.2.5",
          "@space/memory-graph": "0.2.5",
          "@space/runtime": "0.2.5",
          fastify: "5.12.5"
        }
      })
    );
    await writeFile(
      join(sourceRoot, "apps/api/dist/server.js"),
      'import "fastify";\nexport const server = true;\n'
    );
    await writeFile(
      join(sourceRoot, "apps/api/dist/browser-host-main.js"),
      'import { helper } from "./services/browser-helper.js";\nimport "@space/browser-host";\nexport const main = helper;\n'
    );
    await writeFile(
      join(sourceRoot, "apps/api/dist/services/browser-helper.js"),
      'import "@space/db";\nexport const helper = "ok";\n'
    );
    await writeFile(join(sourceRoot, "apps/api/src/server.ts"), "export const raw = true;\n");
    await writeFile(
      join(sourceRoot, "apps/web/package.json"),
      JSON.stringify({ name: "@space/web", version: "0.2.5", dependencies: { react: "19.0.0" } })
    );
    await writeFile(join(sourceRoot, "apps/web/dist/index.html"), "<html></html>\n");
    await writeFile(join(sourceRoot, "apps/web/src/App.tsx"), "export default null;\n");
    await writeFile(
      join(sourceRoot, "apps/worker/package.json"),
      JSON.stringify({
        name: "@space/worker",
        version: "0.2.5",
        dependencies: { "@temporalio/worker": "1.24.0" }
      })
    );
    await writeFile(join(sourceRoot, "apps/worker/dist/index.js"), "export const worker = true;\n");

    for (const [pkg, deps] of [
      ["browser-host", { "playwright-core": "1.59.1" }],
      ["cli-host", { "node-pty": "1.1.0" }],
      ["codex-app-server", {}],
      ["contracts", {}],
      ["db", { pg: "8.18.0" }],
      ["gateway", {}],
      ["memory-graph", {}],
      ["opencode-control", {}],
      ["runtime", {}],
      ["streaming", {}]
    ]) {
      await mkdir(join(sourceRoot, "packages", pkg, "dist"), { recursive: true });
      await writeFile(
        join(sourceRoot, "packages", pkg, "package.json"),
        JSON.stringify({ name: `@space/${pkg}`, version: "0.2.5", dependencies: deps })
      );
      await writeFile(join(sourceRoot, "packages", pkg, "dist/index.js"), "export {};\n");
      await writeFile(join(sourceRoot, "packages", pkg, "dist/index.d.ts"), "export {};\n");
    }
    await writeFile(join(sourceRoot, "packages/db/dist/migrations/001.sql"), "SELECT 1;\n");
    await writeFile(join(sourceRoot, "packages/gateway/grammars/tree-sitter-c.wasm"), "wasm");
    await writeFile(join(sourceRoot, "demos/starter/README.md"), "# Demo\n");
    await writeFile(join(sourceRoot, "starter-memory/AGENTS.md"), "# Memory\n");
    await writeFile(join(sourceRoot, "agent-skills/skill-a/SKILL.md"), "# Skill\n");
    for (const script of [
      "rotate-owner-setup-token.mjs",
      "reset-owner-password.mjs",
      "portable-backup.mjs",
      "portable-restore.mjs"
    ]) {
      await writeFile(join(sourceRoot, "scripts", script), "export {};\n");
    }

    // Populate node_modules with target-specific packages and cross-arch native artifacts
    await mkdir(join(sourceRoot, "node_modules/fastify"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules/fastify/package.json"),
      JSON.stringify({ name: "fastify", version: "5.12.5" })
    );
    await mkdir(join(sourceRoot, "node_modules/playwright-core"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules/playwright-core/package.json"),
      JSON.stringify({ name: "playwright-core", version: "1.59.1" })
    );
    await mkdir(join(sourceRoot, "node_modules/pg"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules/pg/package.json"),
      JSON.stringify({ name: "pg", version: "8.18.0" })
    );
    await mkdir(join(sourceRoot, "node_modules/react"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules/react/package.json"),
      JSON.stringify({ name: "react", version: "19.0.0" })
    );
    await mkdir(join(sourceRoot, "node_modules/node-pty/prebuilds/linux-x64"), { recursive: true });
    await mkdir(join(sourceRoot, "node_modules/node-pty/prebuilds/win32-x64"), { recursive: true });
    await writeFile(
      join(sourceRoot, "node_modules/node-pty/package.json"),
      JSON.stringify({ name: "node-pty", version: "1.1.0" })
    );
    await writeFile(join(sourceRoot, "node_modules/node-pty/prebuilds/linux-x64/pty.node"), "elf");
    await writeFile(join(sourceRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"), "pe");

    await mkdir(
      join(sourceRoot, "node_modules/@temporalio/worker"),
      { recursive: true }
    );
    await writeFile(
      join(sourceRoot, "node_modules/@temporalio/worker/package.json"),
      JSON.stringify({
        name: "@temporalio/worker",
        version: "1.24.0",
        dependencies: { "@temporalio/core-bridge": "1.24.0" }
      })
    );
    await mkdir(
      join(sourceRoot, "node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu"),
      { recursive: true }
    );
    await mkdir(
      join(sourceRoot, "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin"),
      { recursive: true }
    );
    await mkdir(join(sourceRoot, "node_modules/@temporalio/core-bridge/sdk-core"), {
      recursive: true
    });
    await writeFile(
      join(sourceRoot, "node_modules/@temporalio/core-bridge/package.json"),
      JSON.stringify({ name: "@temporalio/core-bridge", version: "1.24.0" })
    );
    await writeFile(
      join(sourceRoot, "node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/index.node"),
      "linux-amd64"
    );
    await writeFile(
      join(sourceRoot, "node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin/index.node"),
      "darwin-arm64"
    );
    await writeFile(join(sourceRoot, "node_modules/@temporalio/core-bridge/sdk-core/Cargo.toml"), "");

    await writeFile(
      join(sourceRoot, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { workspaces: ["apps/*", "packages/*"] },
          "apps/api": {
            name: "@space/api",
            dependencies: {
              "@space/browser-host": "0.2.5",
              "@space/cli-host": "0.2.5",
              "@space/contracts": "0.2.5",
              "@space/db": "0.2.5",
              "@space/gateway": "0.2.5",
              "@space/memory-graph": "0.2.5",
              "@space/runtime": "0.2.5",
              fastify: "5.12.5"
            }
          },
          "apps/web": { name: "@space/web", dependencies: { react: "19.0.0" } },
          "apps/worker": {
            name: "@space/worker",
            dependencies: { "@temporalio/worker": "1.24.0" }
          },
          "packages/browser-host": {
            name: "@space/browser-host",
            dependencies: { "playwright-core": "1.59.1" }
          },
          "packages/cli-host": {
            name: "@space/cli-host",
            dependencies: { "node-pty": "1.1.0" }
          },
          "packages/contracts": { name: "@space/contracts" },
          "packages/db": { name: "@space/db", dependencies: { pg: "8.18.0" } },
          "packages/gateway": { name: "@space/gateway" },
          "packages/memory-graph": { name: "@space/memory-graph" },
          "packages/runtime": { name: "@space/runtime" },
          "node_modules/fastify": { version: "5.12.5" },
          "node_modules/playwright-core": { version: "1.59.1" },
          "node_modules/pg": { version: "8.18.0" },
          "node_modules/react": { version: "19.0.0" },
          "node_modules/node-pty": { version: "1.1.0" },
          "node_modules/@temporalio/worker": {
            version: "1.24.0",
            dependencies: { "@temporalio/core-bridge": "1.24.0" }
          },
          "node_modules/@temporalio/core-bridge": { version: "1.24.0" }
        }
      })
    );

    await stageContainerRuntime({ sourceRoot, outputRoot, arch: "amd64" });

    // Core assertions
    assert.equal(existsSync(join(outputRoot, "core/apps/api/dist/server.js")), true);
    assert.equal(existsSync(join(outputRoot, "core/apps/api/src/server.ts")), false);
    assert.equal(existsSync(join(outputRoot, "core/apps/web/dist/index.html")), true);
    assert.equal(existsSync(join(outputRoot, "core/apps/web/src/App.tsx")), false);
    assert.equal(existsSync(join(outputRoot, "core/apps/worker/dist/index.js")), true);
    assert.equal(existsSync(join(outputRoot, "core/node_modules/fastify/package.json")), true);
    assert.equal(existsSync(join(outputRoot, "core/node_modules/react")), false);
    assert.equal(existsSync(join(outputRoot, "core/node_modules/node-pty")), false);
    assert.equal(existsSync(join(outputRoot, "core/agent-skills/skill-a/SKILL.md")), true);
    assert.equal(
      existsSync(
        join(outputRoot, "core/node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/index.node")
      ),
      true
    );
    assert.equal(
      existsSync(
        join(outputRoot, "core/node_modules/@temporalio/core-bridge/releases/aarch64-apple-darwin")
      ),
      false
    );
    assert.equal(
      existsSync(join(outputRoot, "core/node_modules/@temporalio/core-bridge/sdk-core")),
      false
    );

    // Browser assertions
    assert.equal(existsSync(join(outputRoot, "browser/apps/api/dist/browser-host-main.js")), true);
    assert.equal(existsSync(join(outputRoot, "browser/apps/api/dist/services/browser-helper.js")), true);
    assert.equal(existsSync(join(outputRoot, "browser/apps/api/dist/server.js")), false);
    assert.equal(existsSync(join(outputRoot, "browser/apps/web")), false);
    assert.equal(existsSync(join(outputRoot, "browser/apps/worker")), false);
    assert.equal(existsSync(join(outputRoot, "browser/node_modules/playwright-core/package.json")), true);
    assert.equal(existsSync(join(outputRoot, "browser/node_modules/pg/package.json")), true);
    assert.equal(existsSync(join(outputRoot, "browser/node_modules/fastify")), false);
    assert.equal(existsSync(join(outputRoot, "browser/node_modules/node-pty")), false);
    assert.equal(existsSync(join(outputRoot, "browser/node_modules/@temporalio")), false);
    assert.equal(existsSync(join(outputRoot, "browser/agent-skills")), false);
    assert.equal(existsSync(join(outputRoot, "browser/demos")), false);
    assert.equal(existsSync(join(outputRoot, "browser/starter-memory")), false);

    // CLI assertions
    assert.equal(existsSync(join(outputRoot, "cli/packages/cli-host/dist/index.js")), true);
    assert.equal(existsSync(join(outputRoot, "cli/packages/cli-host/dist/index.d.ts")), false);
    assert.equal(existsSync(join(outputRoot, "cli/agent-skills/skill-a/SKILL.md")), true);
    assert.equal(existsSync(join(outputRoot, "cli/node_modules/node-pty/prebuilds/linux-x64/pty.node")), true);
    assert.equal(existsSync(join(outputRoot, "cli/node_modules/node-pty/prebuilds/win32-x64")), false);
    assert.equal(existsSync(join(outputRoot, "cli/apps")), false);
    assert.equal(existsSync(join(outputRoot, "cli/node_modules/playwright-core")), false);
    assert.equal(existsSync(join(outputRoot, "cli/node_modules/fastify")), false);
    assert.equal(existsSync(join(outputRoot, "cli/demos")), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

