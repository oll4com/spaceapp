import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliAccountProfileCommands } from "../src/cli-account-profile-commands.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CLI account profile commands", () => {
  it("caches a profile's identity, forgets it on invalidate and reads a failure as UNAVAILABLE", async () => {
    const readGeminiAccountProfileDetails = vi.fn(async () => ({ authStatus: "CONNECTED" as const, email: "a@example.com" }));
    const commands = createCliAccountProfileCommands({
      readGeminiAccountProfileDetails,
      readClaudeAccountProfileDetails: async () => { throw new Error("wrapper missing"); }
    }, { cliCommandPath: "/nonexistent" } as any);

    await expect(commands.readCachedCliAccountIdentity("cli:gemini", "p1")).resolves.toEqual({ authStatus: "CONNECTED", email: "a@example.com" });
    await commands.readCachedCliAccountIdentity("cli:gemini", "p1");
    expect(readGeminiAccountProfileDetails).toHaveBeenCalledTimes(1);
    commands.invalidateCliAccountIdentity("cli:gemini", "p1");
    await commands.readCachedCliAccountIdentity("cli:gemini", "p1");
    expect(readGeminiAccountProfileDetails).toHaveBeenCalledTimes(2);
    await expect(commands.readCachedCliAccountIdentity("cli:claude", "p1")).resolves.toEqual({ authStatus: "UNAVAILABLE", email: null });
    expect(commands.cliAccountProfileKey("cli:kimi", "p2")).toBe("cli:kimi/p2");
  });

  it("runs the default commands through the CLI's parity wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-wrappers-"));
    roots.push(root);
    const wrapper = join(root, "kimi-vscode-parity");
    await writeFile(wrapper, "#!/bin/sh\n[ \"$1\" = profile-info ] && [ \"$2\" = p1 ] && echo '{\"authStatus\":\"CONNECTED\",\"email\":\"k@example.com\"}'\n");
    await chmod(wrapper, 0o755);
    const commands = createCliAccountProfileCommands({}, { cliCommandPath: root } as any);
    await expect(commands.readCliAccountProfileDetails("cli:kimi", "p1")).resolves.toEqual({ authStatus: "CONNECTED", email: "k@example.com" });
  });
});
