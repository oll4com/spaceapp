import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PANE_HIBERNATE_DEFAULT_MINUTES, PANE_TYPES } from "@space/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { CELL_IMAGE_DEFAULTS } from "../src/computer/cell-image.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = join(repo, CELL_IMAGE_DEFAULTS.lightCli.launcher);
const shipped = existsSync(join(repo, "deploy"));
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A fake pi that prints the variables it got and its argv, so a run shows what reached pi.
function run(args: string[], keys: Record<string, { value: string; mode?: number }>, opts: { auth?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-light-"));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\nenv | cut -d= -f1 | sort | tr '\\n' ' '; echo; echo \"ARGV $*\"; printf 'KEY %s\\n' \"$OPENROUTER_API_KEY\"\n", { mode: 0o755 });
  mkdirSync(join(home, ".space-pi/keys"), { recursive: true });
  for (const [name, { value, mode = 0o600 }] of Object.entries(keys)) {
    writeFileSync(join(home, ".space-pi/keys", name), value);
    chmodSync(join(home, ".space-pi/keys", name), mode);
  }
  if (opts.auth) {
    mkdirSync(join(home, ".space-pi/agent"), { recursive: true });
    writeFileSync(join(home, ".space-pi/agent/auth.json"), opts.auth);
  }
  const node = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim();
  const path = `${bin}:${node.slice(0, node.lastIndexOf("/"))}:/usr/bin:/bin`;
  const result = spawnSync("bash", [launcher, ...args], { encoding: "utf8", env: { HOME: home, PATH: path, ...opts.env } });
  return { ...result, home };
}

describe("nous computer cell image defaults", () => {
  it.skipIf(!shipped)("names files that exist in the release", () => {
    for (const file of [...CELL_IMAGE_DEFAULTS.cliKnobs, CELL_IMAGE_DEFAULTS.mcpDispatcher, CELL_IMAGE_DEFAULTS.lightCli.launcher]) {
      expect(existsSync(join(repo, file)), file).toBe(true);
    }
  });

  it("keeps Space's own defaults", () => {
    expect(CELL_IMAGE_DEFAULTS.hibernateMinutes).toBe(PANE_HIBERNATE_DEFAULT_MINUTES);
    expect(PANE_TYPES.some((type) => type.typeId === CELL_IMAGE_DEFAULTS.codexPaneType)).toBe(true);
  });
});

describe.skipIf(!shipped)("pi-light-cli launcher: API keys only", () => {
  it("passes only the API keys and basic variables to pi, the key never in argv", () => {
    const r = run(["-p", "hi"], { OPENROUTER_API_KEY: { value: "sk-or-test" }, ANTHROPIC_OAUTH_TOKEN: { value: "oauth-file" } }, {
      env: { SPACE_INTERNAL_API_TOKEN: "space-secret", ANTHROPIC_OAUTH_TOKEN: "oauth-env", ANTHROPIC_BASE_URL: "http://gateway" }
    });
    expect(r.status, r.stderr).toBe(0);
    const names = r.stdout.split("\n")[0].trim().split(" ");
    expect(names).toContain("OPENROUTER_API_KEY");
    expect(names).toContain("PI_CODING_AGENT_DIR");
    for (const name of ["SPACE_INTERNAL_API_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) expect(names).not.toContain(name);
    expect(r.stdout).toContain("ARGV -p hi\n");
    expect(r.stdout).toContain("KEY sk-or-test\n");
    const auth = join(r.home, ".space-pi/agent/auth.json");
    expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({});
    expect(statSync(auth).mode & 0o777).toBe(0o400);
  });

  it("refuses subscription sign-in, OAuth in auth.json, readable keys and no key", () => {
    const key = { OPENROUTER_API_KEY: { value: "sk-or-test" } };
    expect(run(["auth", "login"], key).status).toBe(64);
    expect(run([], key, { auth: JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }) }).status).toBe(64);
    expect(run([], key, { auth: "[]" }).status).toBe(64);
    expect(run([], { OPENROUTER_API_KEY: { value: "sk-or-test", mode: 0o644 } }).status).toBe(64);
    expect(run([], { ANTHROPIC_OAUTH_TOKEN: { value: "oauth-file" } }).status).toBe(64);
    const ok = run([], key, { auth: JSON.stringify({ openrouter: { type: "api_key", key: "k" } }) });
    expect(ok.status, ok.stderr).toBe(0);
  });
});
