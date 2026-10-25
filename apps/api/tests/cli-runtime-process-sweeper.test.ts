import { describe, expect, it, vi } from "vitest";
import {
  CliRuntimeProcessSweepError,
  matchRuntimeProcessArgs,
  sweepRuntimeProcesses,
  type RuntimeProcessTableRow
} from "../src/cli-runtime-process-sweeper.js";

function row(pid: number, args: string): RuntimeProcessTableRow {
  return { pid, args };
}

const opencodeServe = row(910809, "/var/lib/spaceapp-user/.npm-global/bin/opencode serve --port 35161");
const opencodeTui = row(910747, "node /opt/spaceapp/bin/opencode-space-full-tui.mjs");
const codexAppServer = row(3397, "node /var/lib/spaceapp-user/.npm-global/bin/codex app-server --listen unix:///s");
const infraProxy = row(888, "/usr/bin/python3 /var/lib/spaceapp-user/scripts/codex_lb_vscode_proxy.py");

describe("matchRuntimeProcessArgs", () => {
  it("matches processes by the direct parity wrapper command name", () => {
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/bin/sudo -n -u spaceapp-user -- /opt/spaceapp/bin/codex-vscode-parity --run-inner")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:opencode", "/usr/bin/sudo -n -u spaceapp-user -- /opt/spaceapp/bin/opencode-vscode-parity --run-inner")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:claude", "/usr/bin/sudo -n -u spaceapp-user -- /opt/spaceapp/bin/claude-vscode-parity --run-inner")).toBe(true);
  });

  it("matches detached daemon/child processes by the runtime key word boundary", () => {
    expect(matchRuntimeProcessArgs("cli:opencode", "/var/lib/spaceapp-user/.npm-global/bin/opencode serve --port 35161")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:opencode", "/var/lib/spaceapp-user/.npm-global/bin/opencode attach http://127.0.0.1:35161 --dir /etc")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:opencode", "node /opt/spaceapp/bin/opencode-space-full-tui.mjs")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:codex", "node /var/lib/spaceapp-user/.npm-global/bin/codex app-server --listen unix:///s")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:codex", "node /var/lib/spaceapp-user/.npm-global/bin/codex app-server proxy")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:opencode", "/usr/bin/sudo -n /opt/spaceapp/bin/space-cli-vpn-broker exec cli:opencode")).toBe(true);
  });

  it("does not match underscore-separated infra scripts for the codex runtime", () => {
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/bin/python3 /var/lib/spaceapp-user/scripts/codex_lb_vscode_proxy.py")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/bin/python3 /var/lib/spaceapp-user/scripts/codex_telegram_bridge.py")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/bin/python3 /var/lib/spaceapp-user/scripts/codex_eval_webhook_worker.py")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/bin/python3 /var/lib/spaceapp-user/scripts/claude_code_codexlb_adapter.py")).toBe(false);
  });

  it("does not match service daemons that omit the runtime key", () => {
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/local/bin/node apps/api/dist/server.js")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/local/bin/node apps/worker/dist/worker.js")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:codex", "/usr/local/bin/node packages/cli-host/dist/main.js")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:opencode", "/usr/local/bin/node packages/cli-host/dist/main.js")).toBe(false);
  });

  it("never matches the devtools/vision MCP bridge even with a codex profile path", () => {
    const args = "/usr/local/bin/node /var/lib/spaceapp-user/scripts/chrome_devtools_mcp_stdio_bridge.js --userDataDir /var/lib/spaceapp-user/.cache/chrome-devtools-mcp/profiles/codex-d6c28bfd099a-954190";
    expect(matchRuntimeProcessArgs("cli:codex", args)).toBe(false);
    expect(matchRuntimeProcessArgs("cli:opencode", args)).toBe(false);
  });

  it("never matches deepseek-harness or dsh service processes when sweeping cli:deepseek", () => {
    const dshServiceArgs = "/opt/spaceapp/var/cli-versions/deepseek-harness/current/node_modules/.bin/dsh --profile web --patch /opt/spaceapp/var/deepseek-harness/integration/space-harness.patch.yml";
    const dshRelayArgs = "/usr/bin/socat TCP4-LISTEN:3080,fork,reuseaddr EXEC:'ip netns exec space-cli-harness socat - TCP4:127.0.0.1:3080'";
    expect(matchRuntimeProcessArgs("cli:deepseek", dshServiceArgs)).toBe(false);
    expect(matchRuntimeProcessArgs("cli:deepseek", dshRelayArgs)).toBe(false);
    expect(matchRuntimeProcessArgs("cli:deepseek", "node /opt/spaceapp/var/cli-versions/deepseek-harness/0.2.0-rc.2/node_modules/.bin/dsh")).toBe(false);
  });

  it("matches a runtime's own executables and state paths, never the same word in another process", () => {
    expect(matchRuntimeProcessArgs("cli:copilot", "node /opt/spaceapp/var/cli-versions/copilot/1.0.97/node_modules/@github/copilot/index.js")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:gemini", "/var/lib/spaceapp-user/.codex/space-gemini/cli/agy --dangerously-skip-permissions")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:cursor", "/var/lib/spaceapp-user/.codex/space-cursor/cli/cursor-agent")).toBe(true);
    expect(matchRuntimeProcessArgs("cli:grok", "grok --no-auto-update")).toBe(true);
    // Processes that only mention the runtime: Mail Copilot's MCP, another agent's queue submit, an agent shell.
    expect(matchRuntimeProcessArgs("cli:copilot", "/usr/bin/node /opt/spaceapp/scripts/space-mail-copilot-mcp.mjs")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:copilot", "node /var/lib/spaceapp-user/bin/space-queue submit --summary read-only Job copilot views")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:grok", "/bin/bash -c for t in grok cursor copilot omp; do node test-runtime.mjs $t; done")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:omp", "node test-runtime.mjs omp")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:droid", "/bin/bash -c sleep 230; cat /var/lib/spaceapp-user/agent-workspace/reports/x/droid-log.json")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:claude", "/bin/bash -c source /var/lib/spaceapp-user/.codex/space-claude/profiles/p/shell-snapshots/s.sh")).toBe(false);
    expect(matchRuntimeProcessArgs("cli:grok", "node /opt/spaceapp/scripts/space-admin-action.mjs cli-runtime-disable cli:grok token")).toBe(false);
  });

  it("rejects unknown runtime ids and null inputs", () => {
    expect(matchRuntimeProcessArgs("cli:nonexistent", "opencode serve")).toBe(false);
    expect(matchRuntimeProcessArgs(null, "opencode serve")).toBe(false);
    expect(matchRuntimeProcessArgs(undefined, "opencode serve")).toBe(false);
  });
});

describe("sweepRuntimeProcesses", () => {
  it("kills matched processes and reports killed pids", async () => {
    let table = [opencodeServe, opencodeTui, infraProxy];
    const readProcessTable = vi.fn(async () => table);
    const killPids = vi.fn(async () => {
      table = table.filter((entry) => entry.pid !== opencodeServe.pid && entry.pid !== opencodeTui.pid);
    });
    const result = await sweepRuntimeProcesses("cli:opencode", { readProcessTable, killPids });
    expect(readProcessTable).toHaveBeenCalledTimes(2);
    expect(killPids).toHaveBeenCalledWith([910747, 910809]);
    expect(result).toEqual({
      matchedPids: [910747, 910809],
      killedPids: [910747, 910809],
      remainingPids: []
    });
  });

  it("reports remaining pids that survive the kill", async () => {
    let table = [opencodeServe, opencodeTui];
    const readProcessTable = vi.fn(async () => table);
    const killPids = vi.fn(async () => {
      table = table.filter((entry) => entry.pid === opencodeServe.pid);
    });
    const result = await sweepRuntimeProcesses("cli:opencode", { readProcessTable, killPids });
    expect(result).toEqual({
      matchedPids: [910747, 910809],
      killedPids: [910747],
      remainingPids: [910809]
    });
  });

  it("returns empty result and skips the kill when no processes match", async () => {
    const readProcessTable = vi.fn(async () => [infraProxy]);
    const killPids = vi.fn(async () => undefined);
    const result = await sweepRuntimeProcesses("cli:opencode", { readProcessTable, killPids });
    expect(result).toEqual({ matchedPids: [], killedPids: [], remainingPids: [] });
    expect(killPids).not.toHaveBeenCalled();
  });

  it("throws a sweep error when the kill fails so the disable flow can record processSweepFailed", async () => {
    const readProcessTable = vi.fn(async () => [opencodeServe]);
    const killPids = vi.fn(async () => {
      throw new Error("permission denied");
    });
    await expect(sweepRuntimeProcesses("cli:opencode", { readProcessTable, killPids }))
      .rejects.toBeInstanceOf(CliRuntimeProcessSweepError);
  });

  it("excludes non-matching infra processes from the kill list", async () => {
    let table = [opencodeServe, codexAppServer, opencodeTui, infraProxy];
    const readProcessTable = vi.fn(async () => table);
    const killPids = vi.fn(async () => {
      table = table.filter((entry) => entry.pid !== codexAppServer.pid);
    });
    const result = await sweepRuntimeProcesses("cli:codex", { readProcessTable, killPids });
    expect(killPids).toHaveBeenCalledWith([3397]);
    expect(result).toEqual({ matchedPids: [3397], killedPids: [3397], remainingPids: [] });
  });
});