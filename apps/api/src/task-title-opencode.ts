import { spawn } from "node:child_process";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runNativeMetadataCommand } from "./task-title-native.js";

function isolatedEnvironment(root: string, config: unknown): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: "700",
  };
}
export async function resolveNativeOpenCodeRuntime(
  command?: string,
  commandDir?: string | null,
): Promise<string | null> {
  const paths = command
    ? [command]
    : [
        ...(commandDir ? [join(commandDir, "opencode")] : []),
        "/opt/spaceapp/var/cli-versions/opencode/current/node_modules/.bin/opencode",
        ...(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) =>
            join(
              dir,
              process.platform === "win32" ? "opencode.exe" : "opencode",
            ),
          ),
      ];
  const root = await mkdtemp(join(tmpdir(), "space-title-runtime-"));
  try {
    for (const path of [...new Set(paths)]) {
      try {
        await access(path, constants.X_OK);
        const resolved = await realpath(path);
        const version = await runNativeMetadataCommand(
          resolved,
          ["--version"],
          "",
          undefined,
          5000,
          4096,
          { cwd: root, env: isolatedEnvironment(root, {}) },
        );
        // These permission/step/output-limit controls were verified against this
        // native version. An unknown runtime must not silently weaken the limits.
        if (["1.18.29", "1.18.30"].includes(version.trim())) return resolved;
      } catch {}
    }
    return null;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export function parseNativeOpenCodeModels(
  output: string,
): Record<string, unknown> {
  const models: Record<string, unknown> = {};
  const blocks = output.split(/^opencode\//m).slice(1);
  for (const block of blocks) {
    const line = block.indexOf("\n");
    if (line < 0) continue;
    const id = block.slice(0, line).trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) continue;
    try {
      models[id] = JSON.parse(block.slice(line).trim());
    } catch {}
  }
  return models;
}
export async function nativeOpenCodeModelCatalog(
  command: string,
): Promise<{ providers: { id: string; models: Record<string, unknown> }[] }> {
  const root = await mkdtemp(join(tmpdir(), "space-title-catalog-"));
  try {
    const output = await runNativeMetadataCommand(
      command,
      ["models", "opencode", "--verbose"],
      "",
      undefined,
      10000,
      512000,
      {
        cwd: root,
        env: isolatedEnvironment(root, {
          permission: { "*": "deny" },
          mcp: {},
          plugin: [],
          instructions: [],
        }),
      },
    );
    return {
      providers: [
        { id: "opencode", models: parseNativeOpenCodeModels(output) },
      ],
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** One native free-model turn, isolated from operator sessions, skills and credentials. */
export async function generateNativeOpenCodeTitle(input: {
  command: string;
  modelId: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  input.signal.throwIfAborted();
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(input.modelId))
    throw new Error("Invalid title model ID.");
  const root = await mkdtemp(join(tmpdir(), "space-task-title-"));
  try {
    const config = {
      snapshot: false,
      share: "disabled",
      instructions: [],
      plugin: [],
      mcp: {},
      permission: { "*": "deny" },
      agent: {
        "space-title": {
          mode: "primary",
          // Native steps=1 injects a "maximum steps reached" instruction into
          // the very first request. We enforce ONE completion at the process
          // boundary below, before any further model turn can run.
          steps: 2,
          prompt: input.system,
          permission: { "*": "deny" },
          options: { reasoningEffort: "none" },
        },
      },
    };
    const env = isolatedEnvironment(root, config);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        input.command,
        [
          "run",
          "--format",
          "json",
          "--model",
          `opencode/${input.modelId}`,
          "--agent",
          "space-title",
          "--title",
          "Space task summary",
        ],
        {
          cwd: root,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      let output = "", lines = "", starts = 0, completed: string | null = null,
        failure: Error | null = null;
      const kill = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      const stop = () => { failure ??= new Error("Title generation cancelled."); kill(); };
      input.signal.addEventListener("abort", stop, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output) > 128_000) {
          failure = new Error("Oversized native title response.");
          stop();
          return;
        }
        lines += chunk;
        let newline;
        while ((newline = lines.indexOf("\n")) >= 0) {
          const line = lines.slice(0, newline); lines = lines.slice(newline + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "tool_use" || event.type === "error" || (event.type === "step_start" && ++starts > 1)) {
            failure = new Error("Native title request did not complete as text."); kill(); return;
          }
          if (event.type === "step_finish") {
            try { completed = parseNativeTitleOutput(output); }
            catch (error) { failure = error instanceof Error ? error : new Error("Invalid native title output."); }
            kill(); return;
          }
        }
      });
      child.stdin.on("error", () => {});
      child.once("error", () => {
        failure = new Error("Native title runtime unavailable.");
      });
      child.once("close", (code) => {
        input.signal.removeEventListener("abort", stop);
        if (failure || (completed === null && code !== 0))
          reject(failure ?? new Error("Native title generation failed."));
        else resolve(output);
      });
      if (input.signal.aborted) stop();
      else child.stdin.end(input.prompt);
    });
    return parseNativeTitleOutput(stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export function parseNativeTitleOutput(stdout: string): string {
  let text = "",
    turns = 0,
    finishes = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "error" || event.type === "tool_use")
      throw new Error("Native title request did not complete as text.");
    if (event.type === "step_start" && ++turns > 1)
      throw new Error("Native title exceeded its turn limit.");
    if (event.type === "text" && typeof event.part?.text === "string")
      text += event.part.text;
    if (event.type === "step_finish") {
      const tokens = event.part?.tokens;
      const validCount = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
      if (
        ++finishes > 1 ||
        turns !== 1 ||
        event.part?.cost !== 0 ||
        !validCount(tokens?.input) ||
        !validCount(tokens?.output) ||
        !validCount(tokens?.reasoning ?? 0) ||
        !validCount(tokens?.cache?.read ?? 0) ||
        !validCount(tokens?.cache?.write ?? 0) ||
        tokens.output + (tokens.reasoning ?? 0) > 700 ||
        tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) >
          1800
      )
        throw new Error("Native title exceeded its usage policy.");
    }
  }
  if (finishes !== 1 || turns !== 1 || !text.trim())
    throw new Error("No native title response.");
  return text;
}
