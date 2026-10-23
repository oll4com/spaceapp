import { join, relative, isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFileDocxNormalizationError, normalizeAgentFileDocx } from "../src/cli-agent-files.js";

const boundary = vi.hoisted(() => ({ directories: [] as string[], writes: [] as string[], commands: [] as { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] }));
// Every filesystem/process boundary is virtual, including the historical installed
// work directory and sudo broker used by the stable-behavior and negative controls.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    mkdir: vi.fn(async (path: unknown) => { boundary.directories.push(String(path)); }),
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}synthetic`),
    writeFile: vi.fn(async (path: unknown) => { boundary.writes.push(String(path)); }),
    readFile: vi.fn(async (path: unknown) => String(path).endsWith("result.json")
      ? JSON.stringify({ contract: "SpaceAgentDocxNormalizationResultV1", ok: true })
      : Buffer.from([0x50, 0x4b, ...Buffer.from("synthetic-rebuilt")])),
    rm: vi.fn(async () => undefined)
  };
});
vi.mock("../src/safe-child-process.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/safe-child-process.js")>();
  const { promisify } = await import("node:util");
  const execute = vi.fn(async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    boundary.commands.push({ command, args, env: options.env });
    return { stdout: "", stderr: "" };
  });
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execute });
  return { ...actual, execFile };
});

const input = { buffer: Buffer.from([0x50, 0x4b, ...Buffer.from("synthetic-source")]), originalFilename: "synthetic.docx" };
const install = join(process.cwd(), ".dev-stack-synthetic", "install");
beforeEach(() => {
  boundary.directories.length = 0; boundary.writes.length = 0; boundary.commands.length = 0;
  vi.stubEnv("SPACE_INSTANCE", "dev"); vi.stubEnv("SPACE_INSTALL_ROOT", install);
  vi.stubEnv("SPACE_LIBREOFFICE_PATH", undefined); vi.stubEnv("SPACE_AGENT_FILE_DOCX_WORK_ROOT", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("dev DOCX normalization isolation", () => {
  it("fails before any write or installed broker call without an explicit direct normalizer", async () => {
    await expect(normalizeAgentFileDocx(input)).rejects.toThrow(/installed privileged broker is not used/);
    expect(boundary.directories).toEqual([]); expect(boundary.writes).toEqual([]); expect(boundary.commands).toEqual([]);
  });

  it("confines explicitly configured direct normalization to the private install root", async () => {
    const command = join(install, "bin", "synthetic-libreoffice");
    const output = await normalizeAgentFileDocx(input, { command });
    expect(output).not.toEqual(input.buffer);
    expect(boundary.commands).toHaveLength(1);
    expect(boundary.commands[0]!.command).toBe(command);
    for (const path of [...boundary.directories, ...boundary.writes, boundary.commands[0]!.env!.HOME!]) {
      const inside = relative(install, path);
      expect(inside).not.toMatch(/^\.\.(?:[/\\]|$)/); expect(isAbsolute(inside)).toBe(false);
    }
  });

  it("rejects a direct dev normalizer's work-directory escape before writing", async () => {
    await expect(normalizeAgentFileDocx(input, { command: "/synthetic/libreoffice", temporaryRoot: "/opt/spaceapp/var/agent-docx-work" })).rejects.toThrow(/escape/);
    expect(boundary.directories).toEqual([]); expect(boundary.commands).toEqual([]);
  });

  it.each([
    { install, temporaryRoot: "relative" },
    { install, temporaryRoot: "/opt/spaceapp/var/agent-docx-work" },
    { install: undefined, temporaryRoot: undefined },
    { install: "/opt", temporaryRoot: undefined }
  ])("maps private work-root rejection to the DOCX error before any side effect: %j", async ({ install: configured, temporaryRoot }) => {
    vi.stubEnv("SPACE_INSTALL_ROOT", configured);
    await expect(normalizeAgentFileDocx(input, { command: "/synthetic/libreoffice", temporaryRoot })).rejects.toBeInstanceOf(AgentFileDocxNormalizationError);
    expect(boundary.directories).toEqual([]); expect(boundary.writes).toEqual([]); expect(boundary.commands).toEqual([]);
  });

  it("preserves the stable work directory and broker arguments without executing either", async () => {
    vi.stubEnv("SPACE_INSTANCE", "stable");
    await normalizeAgentFileDocx(input);
    expect(boundary.directories[0]).toBe("/opt/spaceapp/var/agent-docx-work");
    expect(boundary.commands).toHaveLength(1);
    expect(boundary.commands[0]).toMatchObject({ command: "/usr/bin/sudo", args: ["-n", "/opt/spaceapp/bin/space-docx-normalizer"] });
  });
});
