import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { childProcessEnv } from "../src/child-process-env.js";

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
