import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { childProcessEnv } from "../src/child-process-env.js";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { buildCliEnvironment } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

it("keeps Space credentials out of child processes and keeps everything else", () => {
  Object.assign(process.env, {
    SPACE_SESSION_SECRET: "x", SPACE_DATABASE_URL: "x", SPACE_INTERNAL_API_TOKEN: "x", SPACE_CONNECTOR_SECRET: "x",
    SPACE_MCP_SERVERS_JSON: "x", SPACE_LOCAL_VOICE_PROVIDER_TOKEN: "x",
    SPACE_SESSION_SECRET_FILE: "/run/secrets/session-secret", SPACE_API_PORT: "4910", GEMINI_API_KEY: "provider-key"
  });
  const env = childProcessEnv();
  for (const name of ["SPACE_SESSION_SECRET", "SPACE_DATABASE_URL", "SPACE_INTERNAL_API_TOKEN", "SPACE_CONNECTOR_SECRET", "SPACE_MCP_SERVERS_JSON", "SPACE_LOCAL_VOICE_PROVIDER_TOKEN"]) {
    expect(env).not.toHaveProperty(name);
  }
  expect(env).toMatchObject({ SPACE_SESSION_SECRET_FILE: "/run/secrets/session-secret", SPACE_API_PORT: "4910", GEMINI_API_KEY: "provider-key", PATH: process.env.PATH });
  const custom = { SPACE_SESSION_SECRET: "custom-secret", PATH: "/tools", MODEL_DIR: "/models" };
  expect(childProcessEnv(custom)).toEqual({ PATH: "/tools", MODEL_DIR: "/models" });
  expect(custom.SPACE_SESSION_SECRET).toBe("custom-secret");
});

it("spawns children with childProcessEnv() instead of spreading process.env", async () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const offenders: string[] = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith(".ts") || entry.includes("__tests__")) continue;
    if ((await readFile(join(root, entry), "utf8")).includes("...process.env")) offenders.push(entry);
  }
  expect(offenders).toEqual([]);
});

// EXT-C-F8: a CLI pane's PTY gets only buildCliEnvironment's allowlist (the pane host passes it to node-pty as is,
// and sudo keeps only its env_keep list), never the API's own credentials or provider keys.
it("starts CLI pane terminals without the API's credentials or provider keys", () => {
  const planted = {
    SPACE_SESSION_SECRET: "leak-session-secret-marker-0123456789abcdef", SPACE_DATABASE_URL: "postgres://leak-db-marker@127.0.0.1:5432/space",
    SPACE_INTERNAL_API_TOKEN: "leak-internal-token-marker", SPACE_CONNECTOR_SECRET: "leak-connector-marker", SPACE_MCP_SERVERS_JSON: "[]",
    OPENAI_API_KEY: "leak-openai-marker", ANTHROPIC_API_KEY: "leak-anthropic-marker", GEMINI_API_KEY: "leak-gemini-marker"
  };
  Object.assign(process.env, planted);
  const config = getApiConfig({ ...planted, SPACE_MCP_SERVERS_JSON: undefined });
  const markers = Object.values(planted).filter((value) => value.includes("marker"));
  const runtimes = [...cliRuntimeDescriptors.map((descriptor) => descriptor.id), "cli:root"];
  for (const runtimeId of runtimes) for (const purpose of ["NORMAL", "LOGIN"] as const) {
    const env = buildCliEnvironment(config, { runtimeId, purpose, paneId: "pane:leakcheck01", roomId: "room:leakcheck01", cliSessionId: "cli_session_leakcheck1", cwd: "/opt/spaceapp" });
    const leaked = Object.entries(env).filter(([name, value]) => name in planted || markers.some((marker) => value?.includes(marker)));
    expect(leaked.map(([name]) => `${runtimeId} ${purpose}: ${name}`)).toEqual([]);
  }
});

// ADAPTER-012: only dev's CLI panes are told their instance (the Hermes wrapper runs a profile of its own there).
it("marks only dev's CLI panes with SPACE_CLI_INSTANCE", () => {
  const env = (instance: string) => buildCliEnvironment(getApiConfig({ SPACE_INSTANCE: instance }), { runtimeId: "cli:hermes", purpose: "NORMAL", cwd: "/etc" });
  expect(env("dev").SPACE_CLI_INSTANCE).toBe("dev");
  expect(env("stable").SPACE_CLI_INSTANCE).toBeUndefined();
});
