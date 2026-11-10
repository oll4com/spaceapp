import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCodeServerControlResolver } from "../src/opencode-server-control.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function stateRoot(mapping?: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "opencode-control-"));
  roots.push(root);
  await mkdir(join(root, "opencode", "space-cli-sessions"), { recursive: true });
  await writeFile(join(root, "opencode", "space-shared-server.env"), "OPENCODE_SERVER_USERNAME=space\nOPENCODE_SERVER_PASSWORD=pw\n");
  if (mapping) await writeFile(join(root, "opencode", "space-cli-sessions", "cli_s1.json"), JSON.stringify(mapping));
  return root;
}

describe("OpenCode server control resolver", () => {
  it("reads a session's mapping on the shared server", async () => {
    const root = await stateRoot({ nativeSessionId: "ses_abc123", updatedAt: "2026-10-31T00:00:00.000Z" });
    const { readOpenCodeServerControlFromMapping } = createOpenCodeServerControlResolver({ opencodeStateRoot: root });
    await expect(readOpenCodeServerControlFromMapping("cli:s1", root)).resolves.toMatchObject({
      spaceSessionId: "cli:s1", nativeSessionId: "ses_abc123", serverUsername: "space", updatedAt: "2026-10-31T00:00:00.000Z"
    });
  });

  it("ignores a mapping without a native session id, and a missing one", async () => {
    const root = await stateRoot({ nativeSessionId: "not-a-session" });
    const { readOpenCodeServerControlFromMapping } = createOpenCodeServerControlResolver({ opencodeStateRoot: root });
    await expect(readOpenCodeServerControlFromMapping("cli:s1", root)).resolves.toBeNull();
    await expect(readOpenCodeServerControlFromMapping("cli:other", root)).resolves.toBeNull();
  });

  it("refuses when the session has neither a control file nor a mapping", async () => {
    const root = await stateRoot();
    const { resolveOpenCodeServerControl } = createOpenCodeServerControlResolver({ opencodeStateRoot: root });
    await expect(resolveOpenCodeServerControl({ sessionId: "cli:s1", cwd: "/etc" } as any))
      .rejects.toMatchObject({ errorCode: "OPENCODE_SESSION_CONTROL_UNAVAILABLE" });
  });
});
