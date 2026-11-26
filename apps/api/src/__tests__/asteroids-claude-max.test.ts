import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// nous_msg:0dfab66c: the API-credit key is spent and Claude Max serves only real Claude Code, so the Asteroids
// "API credits" Claude player plays as the headless Claude CLI (agent-chat) instead of calling /v1/messages.
describe("Asteroids API-credits Claude player", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("../safe-child-process.js"); vi.resetModules(); });

  it("runs as Claude Code on Claude Max, never on the spent key", async () => {
    const spawned: Array<{ args: string[]; env: Record<string, string> }> = [];
    vi.doMock("../safe-child-process.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../safe-child-process.js")>()),
      spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
        spawned.push({ args, env: options.env });
        const child = Object.assign(new EventEmitter(), {
          stdout: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
          stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
          stdin: Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => { child.stdout.emit("data", '{"maneuver":"hold"}'); child.emit("close", 0); }) }),
          kill: () => true
        });
        return child;
      }
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { requestAgentReply } = await import("../asteroids-arena/providers.js");
    const reply = await requestAgentReply({ modelId: "space-gateway-claude/claude-haiku-5-5", system: "s", user: "u", snapshot: {} as never, signal: new AbortController().signal, claudeAccount: "crew" });
    expect(reply.text).toBe('{"maneuver":"hold"}');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toContain("agent-chat");
    expect(spawned[0]!.args.join(" ")).toMatch(/cli:claude|claude-vscode-parity/);
    expect(spawned[0]!.env).toMatchObject({ SPACE_AGENT_CHAT_MODEL: "claude-haiku-5-5", SPACE_CLAUDE_ACCOUNT_PROFILE: "crew" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
