import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { CliRuntimeVisibilityPolicy, defaultCliRuntimeVisibilityFile, resolveCliRuntimeVisibilityFile } from "../src/cli-runtime-visibility.js";

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "cli-visibility-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function policy(visibilityFile?: string | null) {
  return new CliRuntimeVisibilityPolicy({ store: new InMemorySpaceStore(), terminateSession: async () => true, visibilityFile });
}

describe("CLI runtime visibility mirror file", () => {
  it("writes the enabled map to the configured file", async () => {
    const dir = await scratch();
    const file = join(dir, "cli-runtime-visibility.json");
    await policy(file).syncVisibilityFile();
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, boolean>;
    expect(Object.values(written).every((value) => typeof value === "boolean")).toBe(true);
    expect(await readdir(dir)).toEqual(["cli-runtime-visibility.json"]);
  });

  it("removes its temporary file when the rename fails", async () => {
    const dir = await scratch();
    const file = join(dir, "cli-runtime-visibility.json");
    // A non-empty directory at the target makes the rename fail.
    await mkdir(join(file, "blocker"), { recursive: true });
    await policy(file).syncVisibilityFile();
    expect(await readdir(dir)).toEqual(["cli-runtime-visibility.json"]);
  });

  it("never defaults to the live file under tests", () => {
    expect(resolveCliRuntimeVisibilityFile(undefined, { VITEST: "true" })).toBeNull();
    expect(resolveCliRuntimeVisibilityFile(undefined, { NODE_ENV: "test" })).toBeNull();
    expect(resolveCliRuntimeVisibilityFile(undefined, {})).toBe(defaultCliRuntimeVisibilityFile);
    expect(resolveCliRuntimeVisibilityFile(null, {})).toBeNull();
    expect(resolveCliRuntimeVisibilityFile("/tmp/x.json", { VITEST: "true" })).toBe("/tmp/x.json");
  });
});
