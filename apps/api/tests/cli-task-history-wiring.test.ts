import { afterEach, describe, expect, it, vi } from "vitest";

type Input = Record<string, unknown>;
type Session = { runtimeId: string; paneId: string; sessionId: string; cwd?: string; codexThreadId?: string | null };
const { captured } = vi.hoisted(() => ({ captured: { built: [] as Array<{ name: string; input: unknown }>, reads: [] as unknown[][] } }));
vi.mock("../src/codex-parity.js", async (orig) => ({ ...await orig<object>(),
  createCodexParityService: (input: Input) => { captured.built.push({ name: "parity", input }); return { parity: "built" }; } }));
vi.mock("../src/unified-cli-task-registry.js", async (orig) => ({ ...await orig<object>(),
  UnifiedCliTaskRegistry: class { store: unknown; input: Input; constructor(store: unknown, input: Input) { this.store = store; this.input = input; captured.built.push({ name: "registry", input }); } } }));
vi.mock("../src/agent-session-history.js", async (orig) => ({ ...await orig<object>(),
  AgentSessionHistoryService: class { input: Input; constructor(input: Input) { this.input = input; captured.built.push({ name: "history", input }); } } }));
vi.mock("../src/cli-terminal.js", async (orig) => ({ ...await orig<object>(),
  findSafeCodexThreadId: async (input: unknown) => { captured.reads.push(["safe-codex", input]); return "thread-safe"; } }));
vi.mock("../src/opencode-native-session.js", async (orig) => ({ ...await orig<object>(),
  readOpenCodeNativeSessionId: async (sessionId: string, root?: string) => { captured.reads.push(["opencode", sessionId, root]); return "ses_open"; } }));
vi.mock("../src/gemini-native-session.js", async (orig) => ({ ...await orig<object>(),
  readGeminiPaneConversation: async (paneId: string) => (paneId === "pane:file" ? "from-file" : null),
  readGeminiNativeConversationIdFromProcessTree: async (pid: number) => `tree ${pid}` }));
vi.mock("../src/claude-native-turns.js", async (orig) => ({ ...await orig<object>(),
  loadClaudeNativeTurns: async (input: unknown) => { captured.reads.push(["claude", input]); return { nativeSessionId: "claude-native" }; } }));

const { createCliTaskHistory } = await import("../src/cli-task-history-wiring.js");

afterEach(() => { captured.built = []; captured.reads = []; });

const GEMINI_ID = "0123abcd-0123-4abc-8def-0123456789ab";
function build(input: { options?: Input; config?: Input; pids?: (sessions: Session[]) => Promise<Map<string, number>> } = {}) {
  const deps = {
    options: input.options ?? {},
    config: { instance: "stable", codexAppServerHome: undefined, codexAppServerCommand: "codex", codexLbBaseUrl: "http://lb", codexLbKeyFile: "/k", ...input.config },
    store: { kind: "store" },
    cliTerminalManager: { activeSessionPids: input.pids ?? (async (sessions: Session[]) => new Map(sessions.map((session) => [session.sessionId, 4242]))) }
  };
  return createCliTaskHistory(deps as never);
}
const built = (name: string) => captured.built.find((entry) => entry.name === name)!.input as Input;
const resolve = (session: Session) => (built("registry").resolveNativeTaskRef as (s: Session) => Promise<string | null>)(session);

describe("CLI task history wiring (ARCH-001 step 90)", () => {
  it("builds the Codex parity service from the config, without the environment inspector on dev", () => {
    build();
    expect(built("parity")).toEqual({ codexHome: "/var/lib/spaceapp-user/.codex", threadRenameCommand: "codex", codexLbBaseUrl: "http://lb", codexLbKeyFile: "/k" });
    captured.built = [];
    build({ config: { instance: "dev", codexAppServerHome: "/codex" } });
    expect(built("parity")).toMatchObject({ codexHome: "/codex", environmentInspectorCommand: null });
  });

  it("keeps an injected parity service and hands it and the registry to the session history", () => {
    const codexParity = { injected: true };
    const result = build({ options: { codexParity } });
    expect(captured.built.map((entry) => entry.name)).toEqual(["registry", "history"]);
    expect(result.codexParity).toBe(codexParity);
    expect((result.unifiedCliTaskRegistry as unknown as { store: unknown }).store).toEqual({ kind: "store" });
    expect(built("history")).toEqual({ codexParity, unifiedCliTaskRegistry: result.unifiedCliTaskRegistry, codexHome: "/var/lib/spaceapp-user/.codex",
      maxAgeDays: 7, verifyRolloutExistence: true });
    expect((result.agentSessionHistoryService as unknown as { input: unknown }).input).toBe(built("history"));
  });

  it("never reads the CLI terminal manager, which app.ts creates after it, until a native task ref is resolved", async () => {
    const pids = vi.fn(async () => { throw new ReferenceError("Cannot access before initialization"); });
    build({ pids });
    expect(pids).not.toHaveBeenCalled();
    await expect(resolve({ runtimeId: "cli:claude", paneId: "pane:c", sessionId: "s1" })).rejects.toThrow(ReferenceError);
    expect(pids).toHaveBeenCalledTimes(1);
  });

  it("resolves each runtime's native task reference", async () => {
    const findCodexThreadId = async (input: unknown) => { captured.reads.push(["codex", input]); return "thread-own"; };
    build({ options: { opencodeStateRoot: "/state", findCodexThreadId } });
    expect(await resolve({ runtimeId: "cli:codex", paneId: "pane:x", sessionId: "s0", cwd: "/w" })).toBe("thread-own");
    expect(await resolve({ runtimeId: "cli:opencode", paneId: "pane:o", sessionId: "s2" })).toBe("ses_open");
    expect(await resolve({ runtimeId: "cli:gemini", paneId: "pane:g", sessionId: "s3", codexThreadId: GEMINI_ID })).toBe(GEMINI_ID);
    expect(await resolve({ runtimeId: "cli:gemini", paneId: "pane:file", sessionId: "s4", codexThreadId: "not-an-id" })).toBe("from-file");
    expect(await resolve({ runtimeId: "cli:gemini", paneId: "pane:g", sessionId: "s5" })).toBe("tree 4242");
    expect(await resolve({ runtimeId: "cli:claude", paneId: "pane:c", sessionId: "s6" })).toBe("claude-native");
    expect(await resolve({ runtimeId: "cli:kimi", paneId: "pane:k", sessionId: "s7" })).toBeNull();
    expect(captured.reads).toEqual([["codex", { paneId: "pane:x", sessionId: "s0", cwd: "/w" }], ["opencode", "s2", "/state"],
      ["claude", { paneId: "pane:c", sessionId: "s6", rootPid: 4242 }]]);
  });

  it("falls back to the safe Codex thread finder and reads no Gemini tree without a live pid", async () => {
    build({ pids: async () => new Map() });
    expect(await resolve({ runtimeId: "cli:codex", paneId: "pane:x", sessionId: "s0", cwd: "/w" })).toBe("thread-safe");
    expect(await resolve({ runtimeId: "cli:gemini", paneId: "pane:g", sessionId: "s5" })).toBeNull();
    expect(await resolve({ runtimeId: "cli:claude", paneId: "pane:c", sessionId: "s6" })).toBe("claude-native");
    expect(captured.reads).toEqual([["safe-codex", { paneId: "pane:x", sessionId: "s0", cwd: "/w" }], ["claude", { paneId: "pane:c", sessionId: "s6", rootPid: null }]]);
  });
});
