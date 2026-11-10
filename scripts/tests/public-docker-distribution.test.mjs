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
    "node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39";
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
  assert.match(dockerfile, /ARG NPM_VERSION=11\.21\.1/);
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
    /npm pack --ignore-scripts --no-audit --no-fund --pack-destination \/tmp\/npm-security-patches brace-expansion@5\.0\.12 tar@7\.5\.22 ip-address@10\.7\.4 undici@6\.29\.1 postcss-selector-parser@7\.1\.6/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/brace-expansion-5\.0\.12\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/brace-expansion --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/tar-7\.5\.22\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/tar --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/ip-address-10\.7\.4\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/ip-address --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/postcss-selector-parser-7\.1\.6\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/postcss-selector-parser --strip-components=1/
  );
  assert.match(
    normalizedRuntimeStage,
    /tar -xzf \/tmp\/npm-security-patches\/undici-6\.29\.1\.tgz -C \/usr\/local\/lib\/node_modules\/npm\/node_modules\/undici --strip-components=1/
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

test("the core image carries the Python the SQLite worker needs (1.1.8)", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = Object.fromEntries(dockerfile.split(/^(?=FROM )/m).map((stage) => [stage.match(/^FROM \S+ AS (\S+)/)?.[1], stage]));
  const core = stages.core.replace(/\\\n/g, " ");
  assert.match(core, /apt-get install -y --no-install-recommends python3\s+&& rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(stages.core, /import sqlite3, sys; assert sys\.version_info >= \(3, 12\)/);
  assert.ok((await readFile(join(root, "apps", "api", "src", "databases", "sqlite-adapter.ts"), "utf8")).includes("python3"));
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
  assert.deepEqual(found, ["cli-runtimes.ts", "cli-terminal.ts", "opencode-model-bench.ts", "room-agent-model-resolver.ts", "setup-assistant.ts", "setup-room-agent-check.ts"]);
  // Each one takes the public credential host's path when there is one.
  const app = await read("app.ts");
  assert.match(app, /const publicCredentialHost = createPublicCredentialHost\(config\);\n  const runOpenCode = publicCredentialHost\?\.openCodeText \?\? runOpenCodeText;/);
  assert.match(app, /new CliTerminalManager\(\{[^}]*?credentialHost: publicCredentialHost,/);
  assert.match(app, /checkCredential: \(runtime\) => checkCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  assert.match(app, /observeCredential: \(runtime\) => observeCliRuntimeCredential\(runtime, publicCredentialHost\?\.execute\)/);
  // ARCH-001 step 88 moved the model bench into system-analytics-wiring.ts; app.ts hands it the credential host.
  assert.match(await read("system-analytics-wiring.ts"), /new OpencodeModelBenchService\(\{\n    execVerbose: publicCredentialHost\n      \? \(provider\) => publicCredentialHost\.openCodeModels\(provider\)/);
  assert.match(app, /createSystemAnalyticsServices\(\{[^}]*publicCredentialHost \}\)/);
  assert.match(app, /createOpenCodeTextModel\(\{ run: runOpenCode \}\)/);
  assert.match(app, /completeRoomAgentPrompt\(\{[^}]*\brunOpenCode[,\s]/);
  assert.doesNotMatch(app, /createOpenCodeTextModel\(\)|checkCliRuntimeCredential\(runtime\)|observeCliRuntimeCredential\(runtime\)/);
  assert.match(await read("cli-terminal.ts"), /this\.options\.credentialHost\n\s+\? await this\.options\.credentialHost\.execute\(runtime\.detectedCommandPath, \["credential-smoke"\]/);
  // First Setup (1.1.8): the setup assistant and the Room Agent check take the credential host's OpenCode before their own.
  const setupWiring = await read("setup-wiring.ts");
  assert.match(setupWiring, /\.\.\.\(publicCredentialHost \? \{ openCodeText: publicCredentialHost\.openCodeText, openCodeModels: publicCredentialHost\.openCodeModels \} : \{\}\)/);
  assert.match(setupWiring, /\.\.\.\(publicCredentialHost \? \{ openCodeModels: publicCredentialHost\.openCodeModels,\s+checkFreeModel: \(modelId: string\) => checkNativeSetupFreeModel\(publicCredentialHost, "opencode-vscode-parity", modelId\) \} : \{\}\)/);
  const setupAssistant = await read("setup-assistant.ts");
  assert.ok(setupAssistant.indexOf("if (options.openCodeText && options.openCodeModels)") >= 0 &&
    setupAssistant.indexOf("if (options.openCodeText && options.openCodeModels)") < setupAssistant.indexOf("openCodeExecutor("));
  const roomAgentCheck = await read("setup-room-agent-check.ts");
  assert.ok(roomAgentCheck.indexOf("if (options.checkFreeModel && options.openCodeModels)") >= 0 &&
    roomAgentCheck.indexOf("if (options.checkFreeModel && options.openCodeModels)") < roomAgentCheck.indexOf("openCodeExecutor("));
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

test("runtime images carry no TypeScript compiler (TypeScript 7's Go binary brought fixable Go stdlib CVEs, 1.2.0)", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const build = dockerfile.split(/^(?=FROM )/m).find((stage) => / AS build$/m.test(stage)).replace(/\\\r?\n\s*/g, " ");
  assert.match(build, /npm prune --omit=dev\s+&& rm -rf node_modules\/typescript node_modules\/@typescript\s/);
});

test("core supervisor starts the web proxy without Space credentials and the api with them (INT5-C-F5)", async () => {
  // The image's policy module: packages/runtime builds it into dist (export from Space dev after 6b0a6cebe9).
  assert.match(await readFile(join(root, "packages", "runtime", "src", "child-process-env.ts"), "utf8"), /export function childProcessEnv\(/);
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-supervisor-"));
  try {
    const { cp, mkdir } = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const { setTimeout: delay } = await import("node:timers/promises");
    await mkdir(join(dir, "deploy", "docker"), { recursive: true });
    await cp(join(root, "deploy", "docker", "core-supervisor.mjs"), join(dir, "deploy", "docker", "core-supervisor.mjs"));
    // Stand-in policy and services: each service records whether it saw the secret, then waits for the supervisor's stop.
    await mkdir(join(dir, "packages", "runtime", "dist"), { recursive: true });
    await writeFile(join(dir, "packages", "runtime", "dist", "child-process-env.js"),
      'export const childProcessEnv = () => ({ PATH: process.env.PATH, FILTERED: "1" });\n');
    const service = (name) => `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({ secret: process.env.SPACE_SESSION_SECRET ?? null, filtered: process.env.FILTERED ?? null }));\n` +
      "setInterval(() => {}, 1000);\n";
    for (const [name, path] of [["api", "apps/api/dist/server.js"], ["web", "apps/web/server.mjs"]]) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), service(name));
    }
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    const supervisor = spawn(process.execPath, ["deploy/docker/core-supervisor.mjs"], {
      cwd: dir, stdio: "ignore",
      env: { PATH: process.env.PATH, SPACE_SESSION_SECRET: "fixture-session-secret", SPACEAPP_WORKFLOWS_ENABLED: "false" }
    });
    const exited = new Promise((done) => supervisor.once("exit", done));
    const read = async (name) => JSON.parse(await readFile(join(dir, `${name}.json`), "utf8"));
    for (let i = 0; i < 100; i++) {
      if (await read("api").then(() => read("web"), () => null).catch(() => null)) break;
      await delay(50);
    }
    supervisor.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.deepEqual(await read("api"), { secret: "fixture-session-secret", filtered: null });
    assert.deepEqual(await read("web"), { secret: null, filtered: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("core entrypoint runs migrations without the session secret and hands it to the supervisor (EXT-C-F8)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-entrypoint-"));
  try {
    const { chmod, cp, mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "deploy", "docker"), { recursive: true });
    await cp(join(root, "deploy", "docker", "core-entrypoint.sh"), join(dir, "deploy", "docker", "core-entrypoint.sh"));
    await writeFile(join(dir, "deploy", "docker", "memory-names.sh"), "exit 0\n");
    // Stand-ins: install writes nothing, gosu drops its user, each node step records which credentials it saw.
    await mkdir(join(dir, "bin"));
    for (const [name, body] of [["install", "exit 0"], ["gosu", 'shift\nexec "$@"']]) {
      await writeFile(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
      await chmod(join(dir, "bin", name), 0o755);
    }
    const step = (name) => `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({ db: process.env.SPACE_DATABASE_URL ?? null, secret: process.env.SPACE_SESSION_SECRET ?? null, agent: process.env.SPACE_AGENT_TOKEN_SECRET ?? null }));\n`;
    await mkdir(join(dir, "packages", "db", "dist"), { recursive: true });
    await writeFile(join(dir, "packages", "db", "dist", "migrate.js"), step("migrate"));
    await writeFile(join(dir, "deploy", "docker", "core-supervisor.mjs"), step("supervisor"));
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    for (const [name, value] of [["database-url", "postgres://fixture"], ["session-secret", "fixture-session-secret"], ["agent-token-secret", "fixture-agent-secret"], ["setup-token", "fixture-setup-token"]]) {
      await writeFile(join(dir, name), value);
    }
    execFileSync("sh", ["deploy/docker/core-entrypoint.sh"], {
      cwd: dir, stdio: "ignore",
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        SPACE_DATABASE_URL_SOURCE_FILE: join(dir, "database-url"), SPACE_DATABASE_URL_FILE: join(dir, "database-url-runtime"),
        SPACE_SESSION_SECRET_FILE: join(dir, "session-secret"), SPACE_AGENT_TOKEN_SECRET_FILE: join(dir, "agent-token-secret"),
        SPACE_SETUP_TOKEN_SOURCE_FILE: join(dir, "setup-token"), SPACE_SETUP_TOKEN_RUNTIME_FILE: join(dir, "setup-token-runtime"),
        SPACE_MEMORY_ROOT: join(dir, "memory"), SPACE_MEMORY_GRAPH_ROOT: join(dir, "graph"), SPACE_STARTER_MEMORY_ROOT: join(dir, "starter"),
        SPACE_TELEGRAM_SECRET_ROOT: join(dir, "telegram"), SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(dir, "telegram", "owners.json")
      }
    });
    const read = async (name) => JSON.parse(await readFile(join(dir, `${name}.json`), "utf8"));
    assert.deepEqual(await read("migrate"), { db: "postgres://fixture", secret: null, agent: null });
    assert.deepEqual(await read("supervisor"), { db: "postgres://fixture", secret: "fixture-session-secret", agent: "fixture-agent-secret" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("core supervisor gives the worker the database URL without the session secret (EXT-C-F8)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spaceapp-supervisor-worker-"));
  try {
    const { cp, mkdir } = await import("node:fs/promises");
    const { spawn } = await import("node:child_process");
    const { setTimeout: delay } = await import("node:timers/promises");
    await mkdir(join(dir, "deploy", "docker"), { recursive: true });
    await cp(join(root, "deploy", "docker", "core-supervisor.mjs"), join(dir, "deploy", "docker", "core-supervisor.mjs"));
    await mkdir(join(dir, "packages", "runtime", "dist"), { recursive: true });
    await writeFile(join(dir, "packages", "runtime", "dist", "child-process-env.js"), "export const childProcessEnv = () => ({ PATH: process.env.PATH });\n");
    const services = [["api", "apps/api/dist/server.js"], ["worker", "apps/worker/dist/worker.js"], ["web", "apps/web/server.mjs"]];
    for (const [name, path] of services) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({ db: process.env.SPACE_DATABASE_URL ?? null, secret: process.env.SPACE_SESSION_SECRET ?? null, agent: process.env.SPACE_AGENT_TOKEN_SECRET ?? null }));\n` +
        "setInterval(() => {}, 1000);\n");
    }
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    const supervisor = spawn(process.execPath, ["deploy/docker/core-supervisor.mjs"], {
      cwd: dir, stdio: "ignore",
      env: { PATH: process.env.PATH, SPACE_DATABASE_URL: "postgres://fixture", SPACE_SESSION_SECRET: "fixture-session-secret", SPACE_AGENT_TOKEN_SECRET: "fixture-agent-secret" }
    });
    const exited = new Promise((done) => supervisor.once("exit", done));
    const read = async (name) => JSON.parse(await readFile(join(dir, `${name}.json`), "utf8"));
    for (let i = 0; i < 100 && !(await Promise.all(services.map(([name]) => read(name))).catch(() => null)); i++) await delay(50);
    supervisor.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.deepEqual(await read("api"), { db: "postgres://fixture", secret: "fixture-session-secret", agent: "fixture-agent-secret" });
    assert.deepEqual(await read("worker"), { db: "postgres://fixture", secret: null, agent: null });
    assert.deepEqual(await read("web"), { db: null, secret: null, agent: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Review 5/5 F5 (plan clipboard:NtzEOzE3Ew00 step 4): every image a build or an install pulls from someone else is
// pinned by digest, so a moved tag never changes what ships; SpaceApp's own images are pinned by images.lock.json.
test("every third-party image in the Dockerfile and the compose template is pinned by digest", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const stages = new Set(Array.from(dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm), ([, stage]) => stage));
  const bases = Array.from(dockerfile.matchAll(/^FROM (\S+)/gm), ([, image]) => image).filter((image) => !stages.has(image));
  const copied = Array.from(dockerfile.matchAll(/--from=(\S+)/g), ([, image]) => image).filter((image) => !stages.has(image));
  const compose = await readFile(join(root, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  const pulled = Array.from(compose.matchAll(/^\s*image: (\S+)$/gm), ([, image]) => image)
    .filter((image) => !image.startsWith("ghcr.io/oll4com/spaceapp-"));
  assert.ok(bases.length > 0 && pulled.length > 0);
  for (const image of [...bases, ...copied, ...pulled]) {
    assert.match(image, /^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `${image} must carry a tag and its digest`);
  }
  for (const image of compose.matchAll(/^\s*image: (ghcr\.io\/oll4com\/spaceapp-\S+)$/gm)) {
    assert.match(image[1], /:\$\{SPACEAPP_IMAGE_TAG\}\$\{SPACEAPP_(CORE|CLI|BROWSER)_IMAGE_DIGEST:-\}$/);
  }
});

test("1.2.0: every script agent-bootstrap.ts names, and every script the API and worker load, is in the image under /opt/spaceapp/scripts", async () => {
  const { runtimeScripts, runtimeScriptData } = await import("../public-export.mjs");
  const dockerfile = (await readFile(join(root, "Dockerfile"), "utf8")).replace(/\\\r?\n\s*/g, " ");
  // What the runtime stages copy from the build stage's /app: each COPY's sources, files or whole folders.
  const copied = [...dockerfile.matchAll(/^COPY --from=build\b(.*)$/gm)].flatMap(([, line]) => {
    const words = line.trim().split(/\s+/).filter((word) => !word.startsWith("--"));
    return words.slice(0, -1).filter((word) => word.startsWith("/app/")).map((word) => word.slice("/app/".length));
  });
  const inImage = (path) => copied.some((source) => path === source || path.startsWith(`${source}/`));
  const wanted = [...runtimeScripts(root), ...[...runtimeScriptData.keys()].map((dir) => `${dir}/x`)];
  assert.ok(wanted.includes("scripts/space-progress.mjs"));
  assert.deepEqual(wanted.filter((path) => !inImage(path)), []);
  // SPACE_INSTALL_ROOT is /opt/spaceapp on a public install; both images point its scripts folder at /app/scripts.
  const hostPaths = await readFile(join(root, "packages/contracts/src/host-paths.ts"), "utf8").catch(() => "");
  if (hostPaths) assert.match(hostPaths, /SPACE_INSTALL_ROOT = "\/opt\/spaceapp"/);
  const stage = (name) => dockerfile.match(new RegExp(`FROM runtime-base AS ${name}([\\s\\S]*?)(?=\\nFROM |\\s*$)`))?.[1] || "";
  assert.match(stage("core"), /^RUN ln -s \/app\/scripts \/opt\/spaceapp\/scripts$/m);
  // The CLI image's /opt/spaceapp is /etc (the panes' session folder), so its scripts folder is /etc/scripts.
  assert.match(stage("cli"), /^RUN ln -s \/etc \/opt\/spaceapp$/m);
  assert.match(stage("cli"), /^RUN ln -s \/app\/scripts \/etc\/scripts$/m);
});
