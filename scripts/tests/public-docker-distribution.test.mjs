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

test("Dockerfile stages isolated per-service runtime trees instead of copying the full monorepo into runtime-base", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const buildStage = dockerfile.match(/FROM [^\n]+ AS build([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const runtimeBaseStage =
    dockerfile.match(/FROM [^\n]+ AS runtime-base([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const coreStage = dockerfile.match(/FROM runtime-base AS core([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const browserStage =
    dockerfile.match(/FROM runtime-base AS browser([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";
  const cliStage = dockerfile.match(/FROM runtime-base AS cli([\s\S]*?)(?=\nFROM |\s*$)/)?.[1] || "";

  assert.match(
    buildStage,
    /node \/app\/deploy\/docker\/prepare-container-targets\.mjs --target-arch "\$\{TARGETARCH:-amd64\}"/
  );
  assert.doesNotMatch(runtimeBaseStage, /COPY --from=build[^\n]*\/app\/(?:node_modules|packages|apps|agent-skills|starter-memory)\b/);
  assert.match(coreStage, /COPY --from=build --chown=spaceapp:spaceapp \/app\/targets\/core\/ \/app\//);
  assert.match(coreStage, /COPY --from=build --chown=spaceapp:spaceapp \/app\/starter-memory \/opt\/spaceapp\/starter-memory/);
  assert.match(browserStage, /COPY --from=build --chown=spaceapp:spaceapp \/app\/targets\/browser\/ \/app\//);
  assert.doesNotMatch(browserStage, /starter-memory|reset-owner-password|rotate-owner-setup-token|portable-backup|portable-restore/);
  assert.match(cliStage, /COPY --from=build --chown=spaceapp:spaceapp \/app\/targets\/cli\/ \/app\//);
  assert.doesNotMatch(cliStage, /starter-memory|reset-owner-password|rotate-owner-setup-token|portable-backup|portable-restore/);
});

test("prepareContainerTargets stages only each service's runtime closure and target-arch native binaries", async () => {
  const { access, mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const {
    coreOperatorScripts,
    coreWorkspacePackages,
    parseTargetArch,
    prepareContainerTargets
  } = await import("../../deploy/docker/prepare-container-targets.mjs");

  assert.equal(parseTargetArch(["--target-arch", "amd64"]), "amd64");
  assert.equal(parseTargetArch(["--target-arch=arm64"]), "arm64");
  assert.throws(() => parseTargetArch(["--target-arch", "riscv64"]), /Unsupported target architecture/);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "spaceapp-targets-fixture-"));
  try {
    const writeJson = async (relPath, value) => {
      const fullPath = join(fixtureRoot, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    };
    const writeText = async (relPath, content) => {
      const fullPath = join(fixtureRoot, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    };
    const exists = async (relPath) => {
      try {
        await access(join(fixtureRoot, relPath));
        return true;
      } catch {
        return false;
      }
    };

    await writeJson("package.json", { name: "space", version: "0.2.5", private: true });
    await writeText("agent-skills/space-superpowers/SKILL.md", "# Skill\n");
    for (const scriptRel of coreOperatorScripts) {
      await writeText(scriptRel, "export const ok = true;\n");
    }

    for (const wsRel of coreWorkspacePackages) {
      const shortName = wsRel.split("/")[1];
      const pkgName = `@space/${shortName}`;
      const deps =
        wsRel === "apps/api"
          ? {
              "@space/browser-host": "0.2.5",
              "@space/cli-host": "0.2.5",
              "@space/contracts": "0.2.5",
              "@space/db": "0.2.5",
              "@space/runtime": "0.2.5",
              "@t3-oss/env-core": "^0.13.11",
              "@temporalio/client": "1.24.0",
              fastify: "5.12.5",
              nanoid: "^5.1.6",
              "node-pty": "^1.1.0",
              "pdfjs-dist": "6.3.289",
              zod: "^4.2.1"
            }
          : wsRel === "apps/worker"
            ? {
                "@space/contracts": "0.2.5",
                "@space/db": "0.2.5",
                "@temporalio/worker": "1.24.0"
              }
            : wsRel === "packages/db"
              ? {
                  "@space/contracts": "0.2.5",
                  "@space/runtime": "0.2.5",
                  pg: "^8.22.0"
                }
              : wsRel === "packages/runtime"
                ? {
                    "@space/contracts": "0.2.5",
                    "@space/memory-graph": "0.2.5",
                    nanoid: "^5.1.6",
                    zod: "^4.2.1"
                  }
                : wsRel === "packages/memory-graph"
                  ? {
                      "@space/contracts": "0.2.5",
                      graphology: "0.26.0"
                    }
                  : wsRel === "packages/cli-host"
                    ? {
                        "node-pty": "^1.1.0"
                      }
                    : {};
      await writeJson(`${wsRel}/package.json`, { name: pkgName, version: "0.2.5", type: "module", dependencies: deps });
      await writeText(`${wsRel}/dist/index.js`, "export const ready = true;\n");
      await writeText(`${wsRel}/dist/index.js.map`, "{}\n");
      await writeText(`${wsRel}/dist/index.d.ts`, "export declare const ready: boolean;\n");
      await writeText(`${wsRel}/src/index.ts`, "export const ready = true;\n");
    }

    await writeText("packages/db/migrations/0001_init.sql", "SELECT 1;\n");
    await writeText("packages/gateway/grammars/tree-sitter-javascript.wasm", "wasm");
    await writeText(
      "apps/api/dist/server.js",
      'import { CliHostClient } from "@space/cli-host";\nexport const server = Boolean(CliHostClient);\n'
    );
    await writeText("apps/api/dist/__tests__/server.test.js", 'import "vitest";\n');
    await writeText(
      "apps/api/dist/browser-host-main.js",
      'import "@space/browser-host";\nimport "@space/contracts";\nimport "@space/db";\nimport { getApiConfig } from "./config.js";\nimport { createBrowserSessions } from "./browser-sessions.js";\nexport { getApiConfig, createBrowserSessions };\n'
    );
    await writeText(
      "apps/api/dist/config.js",
      'import "@t3-oss/env-core";\nimport "zod";\nexport const getApiConfig = () => ({});\n'
    );
    await writeText(
      "apps/api/dist/browser-sessions.js",
      'import "nanoid";\nimport "@space/runtime";\nexport const createBrowserSessions = () => ({});\n'
    );

    await writeJson("apps/web/package.json", {
      name: "@space/web",
      version: "0.2.5",
      dependencies: { "lucide-react": "^0.562.0", "react-dom": "^19.3.0" }
    });
    await writeText("apps/web/server.mjs", "export const web = true;\n");
    await writeText("apps/web/server-routing.mjs", "export const routing = true;\n");
    await writeText("apps/web/dist/index.html", "<!doctype html><html></html>\n");
    await writeText("apps/web/src/App.tsx", "export default function App() {}\n");

    const npmPackages = {
      "@modelcontextprotocol/sdk": {},
      ws: {},
      "@t3-oss/env-core": {
        peerDependencies: { typescript: ">=5.0.0" },
        peerDependenciesMeta: { typescript: { optional: true } }
      },
      "@temporalio/client": {},
      "@temporalio/worker": { dependencies: { "@temporalio/core-bridge": "1.24.0" } },
      "@temporalio/core-bridge": {},
      fastify: {},
      nanoid: {},
      "node-pty": { dependencies: { "node-addon-api": "^7.1.0" } },
      "node-addon-api": {},
      "pdfjs-dist": { optionalDependencies: { "@napi-rs/canvas": "^1.0.9" } },
      "@napi-rs/canvas": {
        optionalDependencies: {
          "@napi-rs/canvas-linux-x64-gnu": "1.0.9",
          "@napi-rs/canvas-linux-arm64-gnu": "1.0.9"
        }
      },
      "@napi-rs/canvas-linux-x64-gnu": {},
      "@napi-rs/canvas-linux-arm64-gnu": {},
      pg: {},
      graphology: {},
      zod: {},
      "lucide-react": {},
      "react-dom": {},
      typescript: {}
    };

    for (const [name, meta] of Object.entries(npmPackages)) {
      await writeJson(`node_modules/${name}/package.json`, { name, version: "1.0.0", ...meta });
      await writeText(`node_modules/${name}/index.js`, "export default {};\n");
    }

    await writeText("node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/index.node", "x64");
    await writeText("node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu/index.node", "arm64");
    await writeText("node_modules/@temporalio/core-bridge/releases/x86_64-apple-darwin/index.node", "mac");
    await writeText("node_modules/@temporalio/core-bridge/sdk-core/Cargo.toml", "[package]\n");
    await writeText("node_modules/node-pty/prebuilds/linux-x64/pty.node", "x64");
    await writeText("node_modules/node-pty/prebuilds/darwin-arm64/pty.node", "mac");
    await writeText("node_modules/node-pty/third_party/conpty.cc", "// win\n");

    await prepareContainerTargets({
      rootDir: fixtureRoot,
      outputDir: join(fixtureRoot, "targets"),
      targetArch: "amd64"
    });

    // Core checks
    assert.equal(await exists("targets/core/apps/api/dist/server.js"), true);
    assert.equal(await exists("targets/core/apps/api/dist/__tests__/server.test.js"), false);
    assert.equal(await exists("targets/core/apps/api/dist/index.js.map"), false);
    assert.equal(await exists("targets/core/apps/api/src/index.ts"), false);
    assert.equal(await exists("targets/core/apps/web/server.mjs"), true);
    assert.equal(await exists("targets/core/apps/web/dist/index.html"), true);
    assert.equal(await exists("targets/core/apps/web/src/App.tsx"), false);
    assert.equal(await exists("targets/core/packages/db/migrations/0001_init.sql"), true);
    assert.equal(await exists("targets/core/packages/gateway/grammars/tree-sitter-javascript.wasm"), true);
    assert.equal(await exists("targets/core/packages/cli-host/dist/index.js"), true);
    assert.equal(await exists("targets/core/node_modules/node-pty"), false);
    assert.equal(await exists("targets/core/node_modules/lucide-react"), false);
    assert.equal(await exists("targets/core/node_modules/react-dom"), false);
    assert.equal(await exists("targets/core/node_modules/typescript"), false);
    assert.equal(
      await exists("targets/core/node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/index.node"),
      true
    );
    assert.equal(
      await exists("targets/core/node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu"),
      false
    );
    assert.equal(
      await exists("targets/core/node_modules/@temporalio/core-bridge/sdk-core"),
      false
    );
    assert.equal(await exists("targets/core/node_modules/@napi-rs/canvas-linux-x64-gnu"), true);
    assert.equal(await exists("targets/core/node_modules/@napi-rs/canvas-linux-arm64-gnu"), false);

    // Browser checks
    assert.equal(await exists("targets/browser/apps/api/dist/browser-host-main.js"), true);
    assert.equal(await exists("targets/browser/apps/api/dist/config.js"), true);
    assert.equal(await exists("targets/browser/apps/api/dist/browser-sessions.js"), true);
    assert.equal(await exists("targets/browser/apps/api/dist/server.js"), false);
    assert.equal(await exists("targets/browser/packages/browser-host/dist/index.js"), true);
    assert.equal(await exists("targets/browser/packages/db/migrations/0001_init.sql"), true);
    assert.equal(await exists("targets/browser/node_modules/pg/package.json"), true);
    assert.equal(await exists("targets/browser/node_modules/nanoid/package.json"), true);
    assert.equal(await exists("targets/browser/node_modules/zod/package.json"), true);
    assert.equal(await exists("targets/browser/node_modules/@temporalio"), false);
    assert.equal(await exists("targets/browser/node_modules/pdfjs-dist"), false);
    assert.equal(await exists("targets/browser/node_modules/@napi-rs"), false);
    assert.equal(await exists("targets/browser/node_modules/node-pty"), false);
    assert.equal(await exists("targets/browser/apps/web"), false);
    assert.equal(await exists("targets/browser/apps/worker"), false);

    // CLI checks
    assert.equal(await exists("targets/cli/packages/cli-host/dist/index.js"), true);
    assert.equal(await exists("targets/cli/agent-skills/space-superpowers/SKILL.md"), true);
    assert.equal(await exists("targets/cli/node_modules/node-pty/package.json"), true);
    assert.equal(await exists("targets/cli/node_modules/node-addon-api/package.json"), true);
    assert.equal(await exists("targets/cli/node_modules/node-pty/prebuilds/linux-x64/pty.node"), true);
    assert.equal(await exists("targets/cli/node_modules/node-pty/prebuilds/darwin-arm64"), false);
    assert.equal(await exists("targets/cli/node_modules/node-pty/third_party"), false);
    assert.equal(await exists("targets/cli/apps"), false);
    assert.equal(await exists("targets/cli/packages/db"), false);
    assert.equal(await exists("targets/cli/node_modules/pg"), false);
    assert.equal(await exists("targets/cli/node_modules/@temporalio"), false);

    // Verify arm64 pruning keeps arm64 native binaries instead of amd64
    await prepareContainerTargets({
      rootDir: fixtureRoot,
      outputDir: join(fixtureRoot, "targets-arm64"),
      targetArch: "arm64"
    });
    assert.equal(
      await exists("targets-arm64/core/node_modules/@temporalio/core-bridge/releases/aarch64-unknown-linux-gnu/index.node"),
      true
    );
    assert.equal(
      await exists("targets-arm64/core/node_modules/@temporalio/core-bridge/releases/x86_64-unknown-linux-gnu"),
      false
    );
    assert.equal(await exists("targets-arm64/core/node_modules/@napi-rs/canvas-linux-arm64-gnu"), true);
    assert.equal(await exists("targets-arm64/core/node_modules/@napi-rs/canvas-linux-x64-gnu"), false);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

