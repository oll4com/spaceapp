import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  credentialProviders,
  removeCredential,
  writeCredential
} from "../src/index.mjs";

test("credential providers distinguish bundled, owner-installed and experimental CLIs", () => {
  assert.deepEqual(credentialProviders(), {
    bundled: ["codex", "gemini", "opencode", "qwen", "kimi", "grok"],
    ownerInstalled: ["claude"],
    experimental: ["deepseek"]
  });
});

test("credentials are allowlisted, newline-trimmed, and written mode 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-credential-"));

  const path = await writeCredential(root, "gemini", "example-value\n");

  assert.equal(await readFile(path, "utf8"), "example-value");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(
    () => writeCredential(root, "../../escape", "value"),
    /provider/i
  );
  await assert.rejects(() => writeCredential(root, "codex", ""), /empty/i);

  assert.equal(await removeCredential(root, "gemini"), true);
  assert.equal(await removeCredential(root, "gemini"), false);
});
