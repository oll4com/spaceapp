import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CliHostError as ClientError } from "../src/client-entry.js";
import { CliHostError as HostError } from "../src/session-registry.js";

it("loads the remote client without node-pty while retaining the full host entry point", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-cli-client-"));
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const isolatedPackage = join(root, "node_modules", "@space", "cli-host");
  try {
    // Public checks build workspace packages before running their tests. Copy
    // the actual output into a clean module tree without any native dependency.
    await cp(join(packageRoot, "dist"), join(isolatedPackage, "dist"), { recursive: true });
    await writeFile(join(isolatedPackage, "package.json"), await readFile(join(packageRoot, "package.json")));
    const runner = join(root, "check.mjs");
    await writeFile(runner, `
      const client = await import("@space/cli-host/client");
      const error = new client.CliHostError("SYNTHETIC", "Synthetic remote error");
      let hostImport;
      if (!process.argv.includes("--client-only")) {
        try {
          await import("@space/cli-host");
          hostImport = { loaded: true };
        } catch (failure) {
          hostImport = { loaded: false, code: failure.code, message: failure.message };
        }
      }
      process.stdout.write(JSON.stringify({
        client: typeof client.CliHostClient,
        error: { name: error.name, code: error.code, message: error.message },
        mask: typeof client.maskUploadPaths,
        split: typeof client.splitUploadPathOutput,
        framing: typeof client.encodeLengthPrefixedJson,
        hostImport
      }));
    `);
    const result = JSON.parse(execFileSync(process.execPath, [runner], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" }
    }));
    expect(result).toMatchObject({
      client: "function",
      error: { name: "CliHostError", code: "SYNTHETIC", message: "Synthetic remote error" },
      mask: "function",
      split: "function",
      framing: "function",
      hostImport: { loaded: false, code: "ERR_MODULE_NOT_FOUND" }
    });
    expect(result.hostImport.message).toMatch(/Cannot find package 'node-pty'/);
    expect(ClientError).toBe(HostError);
    // A core image keeps only the client closure, not the session host code.
    for (const file of ["session-registry.js", "server.js", "node-pty-spawn.js", "admin-policy.js", "main.js", "admin-main.js"]) {
      await rm(join(isolatedPackage, "dist", file), { force: true });
    }
    const clientOnly = JSON.parse(execFileSync(process.execPath, [runner, "--client-only"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" }
    }));
    expect(clientOnly).toMatchObject({
      client: "function",
      error: { name: "CliHostError", code: "SYNTHETIC", message: "Synthetic remote error" },
      mask: "function",
      split: "function",
      framing: "function"
    });
    expect(clientOnly).not.toHaveProperty("hostImport");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
