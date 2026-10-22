import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@space/contracts";
import { createCliAuthTransfer, createPublicCredentialHost, type CredentialHost } from "../src/cli-auth-transfer.js";
import { observeCliRuntimeCredential } from "../src/cli-runtimes.js";

const login = JSON.stringify({ tokens: { refresh_token: "synthetic-refresh-token" } });
const b64 = (text: string) => Buffer.from(text).toString("base64");
const capture = (files: Record<string, string>) => ({ files, capturedAt: "2026-10-14T00:00:00.000Z", sourcePlatform: "linux" });
const runtime = (id: string, authState: "READY" | "LOGIN_REQUIRED" = "READY") =>
  ({ id, displayName: id, authState, detectedCommandPath: `/usr/local/bin/${id.slice(4)}-vscode-parity` }) as unknown as AgentRuntime;

function transfer(options: { publicDistribution?: boolean; answer?: string; exportThroughWrapper?: (path: string) => Promise<string> } = {}) {
  const warn = vi.fn();
  const invalidateRuntimes = vi.fn();
  const run = vi.fn(async () => ({ exitCode: 0, stdout: options.answer ?? "IMPORTED\n" }));
  const credentialHost: Pick<CredentialHost, "run"> = { run };
  const instance = createCliAuthTransfer({
    publicDistribution: options.publicDistribution ?? true,
    readRuntimes: async () => [runtime("cli:codex"), runtime("cli:claude"), runtime("cli:gemini", "LOGIN_REQUIRED")],
    invalidateRuntimes,
    warn,
    credentialHost,
    exportThroughWrapper: options.exportThroughWrapper
  });
  return { instance, run, warn, invalidateRuntimes };
}

describe("CLI login transfer", () => {
  it("hands each login to the target wrapper's credential-install and re-detects the badge", async () => {
    const { instance, run, invalidateRuntimes } = transfer({ answer: "IMPORTED backup=/var/lib/spaceapp-cli/providers/codex/auth.json.bak-1\n" });
    const report = await instance.apply({ "cli:codex": capture({ "auth.json": b64(login) }) }, { conflict: "backup-and-replace" });
    expect(report).toEqual([{ runtimeId: "cli:codex", result: "imported", backup: "/var/lib/spaceapp-cli/providers/codex/auth.json.bak-1", detect: "logged-in" }]);
    expect(run).toHaveBeenCalledExactlyOnceWith("/usr/local/bin/codex-vscode-parity", "credential-install",
      JSON.stringify({ files: { "auth.json": b64(login) }, conflict: "backup-and-replace" }));
    expect(invalidateRuntimes).toHaveBeenCalled();
  });

  it.each([
    ["SKIPPED already-logged-in\n", { result: "skipped", reason: "already-logged-in" }],
    ["FAILED not-a-regular-file\n", { result: "failed", reason: "not-a-regular-file" }],
    ["unexpected output\n", { result: "failed", reason: "write-failed" }]
  ])("reports the installer's answer %j", async (answer, expected) => {
    const { instance } = transfer({ answer });
    expect(await instance.apply({ "cli:claude": capture({ ".credentials.json": b64(login) }) }, { conflict: "skip-if-logged-in" }))
      .toEqual([{ runtimeId: "cli:claude", ...expected }]);
  });

  it.each(["../../.ssh/authorized_keys", "/etc/passwd", "config.toml"])("rejects the whole runtime for file name %s and sends nothing", async (name) => {
    const { instance, run, warn } = transfer();
    const report = await instance.apply({ "cli:codex": capture({ "auth.json": b64(login), [name]: b64("x") }) }, { conflict: "backup-and-replace" });
    expect(report).toEqual([{ runtimeId: "cli:codex", result: "failed", reason: "rejected-file-name" }]);
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("security: rejected CLI login file name for cli:codex");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-refresh-token");
  });

  it("reports CLIs it cannot move or write instead of writing elsewhere", async () => {
    const operator = transfer({ publicDistribution: false });
    expect(await operator.instance.apply({ "cli:codex": capture({ "auth.json": b64(login) }), "cli:hermes": capture({ "auth.json": b64(login) }) }, { conflict: "backup-and-replace" })).toEqual([
      { runtimeId: "cli:codex", result: "failed", reason: "cannot-write-as-runtime-user" },
      { runtimeId: "cli:hermes", result: "skipped", reason: "not-supported-on-target" }
    ]);
    expect(operator.run).not.toHaveBeenCalled();
    const damaged = transfer();
    expect(await damaged.instance.apply({ "cli:codex": capture({ "auth.json": b64("not json") }) }, { conflict: "backup-and-replace" }))
      .toEqual([{ runtimeId: "cli:codex", result: "failed", reason: "unreadable-login-file" }]);
  });

  it("captures operator logins through the wrapper's credential-export only, and none on public installs", async () => {
    const exportThroughWrapper = vi.fn(async (path: string) => path.includes("claude") ? `${b64(login)}\n` : "");
    const operator = transfer({ publicDistribution: false, exportThroughWrapper });
    const { captured, skipped } = await operator.instance.capture(["cli:codex", "cli:claude", "cli:gemini"]);
    expect(Object.keys(captured)).toEqual(["cli:claude"]);
    expect(Buffer.from(captured["cli:claude"]!.files[".credentials.json"]!, "base64").toString("utf8")).toBe(login);
    expect(skipped).toEqual([{ runtimeId: "cli:codex", reason: "not-logged-in" }, { runtimeId: "cli:gemini", reason: "not-exportable" }]);
    expect(exportThroughWrapper).toHaveBeenCalledTimes(2);

    const publicInstall = transfer({ exportThroughWrapper });
    expect((await publicInstall.instance.capture(["cli:codex"])).skipped).toEqual([{ runtimeId: "cli:codex", reason: "not-exportable" }]);
    expect((await publicInstall.instance.list()).every((login) => !login.exportable)).toBe(true);
  });

  it("reads the badge and installs logins through the public CLI credential agent, not in the API container", async () => {
    // Short path: Unix socket paths are limited to about 100 bytes.
    const root = await mkdtemp("/tmp/space-public-cred-");
    const requests: Array<Record<string, string>> = [];
    const agent = createServer((socket) => {
      let body = "";
      socket.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => {
        const request = JSON.parse(body) as Record<string, string>;
        requests.push(request);
        const stdout: Record<string, string> = {
          "credential-status": "READY\n",
          "credential-smoke": "SPACE_CODEX_OK\n",
          "credential-observation": `OBSERVATION:${"a".repeat(64)}\n`,
          "opencode-text": `${JSON.stringify({ type: "step_start" })}\n${JSON.stringify({ type: "text", part: { text: "Agent answer" } })}\n`,
          "opencode-models": JSON.stringify({ data: [{ id: "big-pickle", providerID: "opencode" }] })
        };
        socket.end(JSON.stringify({ exitCode: 0, stdout: stdout[request.action!] ?? "IMPORTED\n" }));
      });
    });
    await new Promise<void>((resolve) => agent.listen(join(root, "credentials.sock"), resolve));
    const host = createPublicCredentialHost({ publicDistribution: true, cliEnabled: true, cliHostSocketPath: join(root, "host.sock") })!;
    try {
      expect(createPublicCredentialHost({ publicDistribution: false, cliEnabled: true, cliHostSocketPath: join(root, "host.sock") })).toBeNull();
      expect(await host.status("/usr/local/bin/codex-vscode-parity")).toBe("READY");
      const instance = createCliAuthTransfer({
        publicDistribution: true, readRuntimes: async () => [runtime("cli:codex")], invalidateRuntimes: () => undefined, warn: () => undefined, credentialHost: host
      });
      expect(await instance.apply({ "cli:codex": capture({ "auth.json": b64(login) }) }, { conflict: "backup-and-replace" }))
        .toEqual([{ runtimeId: "cli:codex", result: "imported", detect: "logged-in" }]);
      expect(requests).toEqual([
        { command: "codex-vscode-parity", action: "credential-status" },
        { command: "codex-vscode-parity", action: "credential-install", input: JSON.stringify({ files: { "auth.json": b64(login) }, conflict: "backup-and-replace" }) }
      ]);
      // Decision B (1.1.7): the core image has no CLIs, so the smoke, the Room Agent's OpenCode tier and the
      // model bench run in the CLI container through the same agent.
      requests.length = 0;
      expect(await host.execute("/usr/local/bin/codex-vscode-parity", ["credential-smoke"], { encoding: "utf8", env: {}, timeout: 1_000, maxBuffer: 1_024 }))
        .toEqual({ stdout: "SPACE_CODEX_OK\n" });
      expect(await observeCliRuntimeCredential(runtime("cli:opencode"), host.execute)).toBe("a".repeat(64));
      await expect(host.execute("/usr/local/bin/codex-vscode-parity", ["login"], { encoding: "utf8", env: {}, timeout: 1_000, maxBuffer: 1_024 })).rejects.toThrow();
      expect(await host.openCodeText("opencode/big-pickle", "Hello", 5_000)).toBe("Agent answer");
      expect(JSON.parse(await host.openCodeModels("opencode")).data[0].id).toBe("big-pickle");
      expect(requests).toEqual([
        { command: "codex-vscode-parity", action: "credential-smoke" },
        { command: "opencode-vscode-parity", action: "credential-observation" },
        { command: "opencode-vscode-parity", action: "opencode-text", input: JSON.stringify({ modelId: "opencode/big-pickle", prompt: "Hello", timeoutMs: 5_000 }) },
        { command: "opencode-vscode-parity", action: "opencode-models", input: JSON.stringify({ provider: "opencode" }) }
      ]);
      const aborted = new AbortController();
      aborted.abort();
      expect(await host.openCodeText("opencode/big-pickle", "Hello", 5_000, aborted.signal)).toBeNull();
      agent.close();
      // No agent (an older public image): the badge stays unverified and imports report it, never write elsewhere.
      expect(await host.status("/usr/local/bin/codex-vscode-parity")).toBeNull();
    } finally {
      agent.close();
    }
  });
});
