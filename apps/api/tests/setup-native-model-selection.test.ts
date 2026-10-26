import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublicCredentialHost } from "../src/cli-auth-transfer.js";
import { checkNativeSetupFreeModel, nativeFreeModelSelectionSupported, selectNativeSetupFreeModel } from "../src/setup-native-model-selection.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

/**
 * The public CLI container's credential agent: the OpenCode wrapper lists its operations in inspect-env and applies
 * select-free-model only for "opencode/works" (public deploy/docker/credential-agent.mjs, 1.1.8).
 */
async function agent(operations: string | null) {
  // Short path: Unix socket paths are limited to about 100 bytes.
  const root = await mkdtemp("/tmp/space-free-model-");
  const requests: Array<Record<string, string>> = [];
  const server = createServer((socket) => {
    let body = "";
    socket.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
      const request = JSON.parse(body) as Record<string, string>;
      requests.push(request);
      const answer = request.action === "inspect-env"
        ? { exitCode: 0, stdout: `runtime=opencode\nhome=isolated\n${operations === null ? "" : `operations=${operations}\n`}` }
        : request.argument === "opencode/works" || (request.argument === "auto" && request.action === "select-free-model")
          ? { exitCode: 0, stdout: `SPACE_OPENCODE_MODEL_SELECTED ${request.argument}\n` }
          : { exitCode: 1, stdout: "" };
      socket.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(join(root, "credentials.sock"), resolve));
  cleanup.push(async () => { server.close(); await rm(root, { recursive: true, force: true }); });
  const host = createPublicCredentialHost({ publicDistribution: true, cliEnabled: true, cliHostSocketPath: join(root, "host.sock") })!;
  return { host, requests };
}
const wrapper = "/usr/local/bin/opencode-vscode-parity";

describe("native free model choice through the public CLI container's credential agent", () => {
  it("is offered only when the installed OpenCode wrapper lists select-free-model", async () => {
    const current = await agent("select-free-model");
    expect(await nativeFreeModelSelectionSupported(current.host, wrapper)).toBe(true);
    expect(current.requests).toEqual([{ command: "opencode-vscode-parity", action: "inspect-env" }]);
    // run-spaceapp 1.1.7's wrapper lists no operations; an unknown subcommand is never sent to it.
    const older = await agent(null);
    expect(await nativeFreeModelSelectionSupported(older.host, wrapper)).toBe(false);
    expect(older.requests.map((request) => request.action)).toEqual(["inspect-env"]);
  });

  it("sends one validated pick or auto, and reports a failed check", async () => {
    const { host, requests } = await agent("select-free-model");
    await expect(selectNativeSetupFreeModel(host, wrapper, "opencode/free;whoami")).rejects.toThrow("Invalid free model");
    await expect(selectNativeSetupFreeModel(host, wrapper, "opencode/works")).resolves.toBeUndefined();
    await expect(selectNativeSetupFreeModel(host, wrapper, "auto")).resolves.toBeUndefined();
    await expect(selectNativeSetupFreeModel(host, wrapper, "opencode/broken")).rejects.toThrow("did not complete a tool call");
    expect(requests).toEqual([
      { command: "opencode-vscode-parity", action: "select-free-model", argument: "opencode/works" },
      { command: "opencode-vscode-parity", action: "select-free-model", argument: "auto" },
      { command: "opencode-vscode-parity", action: "select-free-model", argument: "opencode/broken" }
    ]);
  });
  it("probes one model without changing it (check-free-model), for the Room Agent setup check", async () => {
    const { host, requests } = await agent("select-free-model,check-free-model");
    expect(await checkNativeSetupFreeModel(host, wrapper, "opencode/works")).toBe(true);
    expect(await checkNativeSetupFreeModel(host, wrapper, "opencode/broken")).toBe(false);
    expect(await checkNativeSetupFreeModel(host, wrapper, "auto")).toBe(false);
    expect(requests).toEqual([
      { command: "opencode-vscode-parity", action: "check-free-model", argument: "opencode/works" },
      { command: "opencode-vscode-parity", action: "check-free-model", argument: "opencode/broken" }
    ]);
  });
});

