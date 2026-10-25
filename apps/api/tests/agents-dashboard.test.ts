import { describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { claudeDashboardActivity, cliUsageLimited, createCliDashboardActivityReader, DASHBOARD_SCREEN_SETTLE_MS, dashboardScreenState, openCodeDashboardActivity, readDashboardActivity, type CliDashboardActivityReaders } from "../src/agents-dashboard.js";

describe("dashboard native activity", () => {
  it("reports three working native tasks even when every persisted pane is idle", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const panes = Array.from({ length: 5 }, (_, i) => store.createPane({ roomId: room.id, title: `Agent ${i}`, mode: "TERMINAL", terminalRuntimeId: "cli:codex" }));
    const sessions = panes.map(pane => store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", purpose: "NORMAL", status: "RUNNING" }));
    const busy = new Set(sessions.slice(0, 3).map(s => s.sessionId));
    const read = vi.fn(async (session: typeof sessions[number]) => busy.has(session.sessionId) ? "working" as const : "done" as const);
    const { activity, details } = await readDashboardActivity(panes, store, read);
    expect(Object.values(activity).filter(s => s === "working")).toHaveLength(3);
    expect(activity[panes[3]!.id]).toBe("done");
    expect(details[panes[3]!.id]).toMatchObject({ status: "done", source: "screen" });
    busy.delete(sessions[0]!.sessionId);
    expect((await readDashboardActivity(panes, store, read)).activity[panes[0]!.id]).toBe("done");
    expect(read).toHaveBeenCalledTimes(10);
  });
  it("does not launch missing sessions or inspect root and login terminals", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const root = store.createPane({ roomId: room.id, title: "Root", mode: "TERMINAL", terminalRuntimeId: "cli:root" });
    const idle = store.createPane({ roomId: room.id, title: "Idle", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    const login = store.createPane({ roomId: room.id, title: "Login", mode: "TERMINAL", terminalRuntimeId: "cli:codex" });
    store.createPaneCliSession({ paneId: login.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", purpose: "LOGIN", status: "RUNNING" });
    const read = vi.fn();
    const result = await readDashboardActivity([root, idle, login], store, read);
    expect(result.activity).toEqual({ [idle.id]: "idle", [login.id]: "idle" });
    expect(result.details[idle.id]).toMatchObject({ reason: "Not running", source: "session" });
    expect(result.details[login.id]).toMatchObject({ reason: "Sign-in session" });
    expect(read).not.toHaveBeenCalled();
    expect(await store.getActivePaneCliSession(idle.id)).toBeNull();
  });
  it("correctly propagates working status for OpenCode parity sessions", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" });
    store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:opencode", providerId: "opencode", agentId: "opencode", purpose: "NORMAL", status: "RUNNING", cwd: "/etc" });
    const read = vi.fn(async (session: any) => session.runtimeId === "cli:opencode" ? "working" as const : "idle" as const);
    const result = await readDashboardActivity([pane], store, read);
    expect(result.activity[pane.id]).toBe("working");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("correctly propagates working status for Gemini CLI background task sessions", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Gemini CLI", mode: "TERMINAL", terminalRuntimeId: "cli:gemini" });
    store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:gemini", providerId: "gemini", agentId: "gemini", purpose: "NORMAL", status: "RUNNING", cwd: "/etc" });
    const read = vi.fn(async (session: any) => session.runtimeId === "cli:gemini" ? "working" as const : "idle" as const);
    const result = await readDashboardActivity([pane], store, read);
    expect(result.activity[pane.id]).toBe("working");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("reports Claude panes from Claude's own session status instead of the screen", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const panes = ["busy", "waiting", "finished", "fresh", "fallback"].map(title => store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:claude" }));
    const sessions = panes.map(pane => store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "anthropic", agentId: "claude", purpose: "NORMAL", status: "RUNNING", modelId: "claude-opus-5-5" }));
    const task = (status: string, startedAt: string, completedAt: string | null = null) => ({ status, timing: { startedAt, completedAt } });
    const natives: Record<string, Parameters<typeof claudeDashboardActivity>[0] | null> = {
      [sessions[0]!.sessionId]: { busy: true, status: "busy", statusUpdatedAt: "2026-10-11T06:00:05.000Z", modelId: "claude-fable-5-1", tasks: [task("RUNNING", "2026-10-11T06:00:00.000Z")] },
      [sessions[1]!.sessionId]: { busy: false, status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: "2026-10-11T06:01:00.000Z", tasks: [task("INTERRUPTED", "2026-10-11T06:00:00.000Z")] },
      [sessions[2]!.sessionId]: { busy: false, status: "idle", statusUpdatedAt: "2026-10-11T06:03:00.000Z", tasks: [task("COMPLETED", "2026-10-11T06:00:00.000Z", "2026-10-11T06:02:59.000Z")] },
      [sessions[3]!.sessionId]: { busy: false, status: "idle", tasks: [] },
      [sessions[4]!.sessionId]: null
    };
    const readers: CliDashboardActivityReaders = {
      screenText: vi.fn(async () => "⠋ Thinking… (esc to interrupt)"),
      codexTurn: vi.fn(), openCode: vi.fn(), geminiTurns: vi.fn(),
      claude: vi.fn(async session => natives[session.sessionId] ?? null)
    };
    const { activity, details } = await readDashboardActivity(panes, store, createCliDashboardActivityReader(readers));
    expect(panes.map(pane => activity[pane.id])).toEqual(["working", "waiting", "done", "idle", "working"]);
    expect(details[panes[0]!.id]).toEqual({ status: "working", since: "2026-10-11T06:00:00.000Z", modelId: "claude-fable-5-1", source: "native", reason: null });
    expect(details[panes[1]!.id]).toMatchObject({ reason: "Permission prompt", since: "2026-10-11T06:01:00.000Z" });
    expect(details[panes[2]!.id]).toMatchObject({ since: "2026-10-11T06:02:59.000Z", modelId: "claude-opus-5-5" });
    expect(details[panes[4]!.id]).toMatchObject({ source: "screen" });
    // Only the pane whose native reader failed consults the screen.
    expect(readers.screenText).toHaveBeenCalledTimes(1);
    expect(claudeDashboardActivity({ busy: false, status: "shell", tasks: [] }).status).toBe("working");
    expect(claudeDashboardActivity({ busy: false, status: "waiting", waitingFor: "plan approval", tasks: [] }).reason).toBe("Plan approval");
    expect(claudeDashboardActivity({ busy: false, status: "waiting", waitingFor: "anything else", tasks: [] }).reason).toBe("Needs input");
    expect(claudeDashboardActivity({ busy: false, status: "idle", apiError: true, tasks: [] })).toMatchObject({ status: "waiting", reason: "API error" });
    expect(claudeDashboardActivity({ busy: true, status: "busy", apiError: true, tasks: [] }).status).toBe("working");
  });
  it("keeps the rest of the room when one CLI cannot be read", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const panes = ["broken", "healthy"].map(title => store.createPane({ roomId: room.id, title, mode: "TERMINAL", terminalRuntimeId: "cli:codex" }));
    const sessions = panes.map(pane => store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex", purpose: "NORMAL", status: "RUNNING" }));
    const read = vi.fn(async (session: typeof sessions[number]) => {
      if (session.sessionId === sessions[0]!.sessionId) throw new Error("thread binding failed");
      return "working" as const;
    });
    expect((await readDashboardActivity(panes, store, read)).activity).toEqual({ [panes[1]!.id]: "working" });
  });
  it("resolves Codex, Gemini, OpenCode and screen-only CLIs with native state first", async () => {
    const session = (runtimeId: string) => ({ sessionId: `cli_session:${runtimeId.slice(4)}`, runtimeId, paneId: "pane:x" }) as never;
    const screens = { RUNNING: "⠋ Working (3s · esc to interrupt)", IDLE: "› Ask anything", WAITING_FOR_INPUT: "Allow once?  Allow always?", UNKNOWN: "" };
    let screen: keyof typeof screens = "IDLE";
    let codex: Awaited<ReturnType<CliDashboardActivityReaders["codexTurn"]>> = { status: "COMPLETED", lastActivityAtMs: Date.parse("2026-10-11T06:00:00.000Z") };
    let gemini: Array<{ status: string; aborted?: boolean; timing: { startedAt: string | null; completedAt: string | null } }> | null = null;
    let openCode: { busy: boolean; messages: () => Promise<unknown[]> } | null = null;
    const read = createCliDashboardActivityReader({
      screenText: async () => screens[screen], codexTurn: async () => codex, geminiTurns: async () => gemini,
      openCode: async () => openCode, claude: async () => null
    });
    expect(await read(session("cli:codex"))).toMatchObject({ status: "done", since: "2026-10-11T06:00:00.000Z", source: "native" });
    codex = { status: "ABORTED" };
    expect(await read(session("cli:codex"))).toMatchObject({ status: "waiting", reason: "Interrupted" });
    codex = { status: "PENDING" }; screen = "WAITING_FOR_INPUT";
    expect(await read(session("cli:codex"))).toMatchObject({ status: "waiting", reason: "Needs input", source: "screen" });
    screen = "IDLE";
    gemini = [{ status: "COMPLETED", timing: { startedAt: "2026-10-11T05:00:00.000Z", completedAt: "2026-10-11T05:01:00.000Z" } }];
    expect(await read(session("cli:gemini"))).toMatchObject({ status: "done", since: "2026-10-11T05:01:00.000Z" });
    gemini.push({ status: "RUNNING", timing: { startedAt: "2026-10-11T05:02:00.000Z", completedAt: null } });
    expect(await read(session("cli:gemini"))).toMatchObject({ status: "working", since: "2026-10-11T05:02:00.000Z" });
    const assistant = (completed: number | null, extra: Record<string, unknown> = {}) => ({ info: { role: "assistant", modelID: "deepseek-v4-flash-free", time: { created: 1, completed }, finish: "stop", ...extra } });
    openCode = { busy: true, messages: async () => [] };
    expect(await read(session("cli:opencode"))).toMatchObject({ status: "working", source: "native" });
    openCode = { busy: false, messages: async () => [{ info: { role: "user", time: { created: 0 } } }, assistant(Date.parse("2026-10-11T04:00:00.000Z"))] };
    expect(await read(session("cli:opencode"))).toMatchObject({ status: "done", since: "2026-10-11T04:00:00.000Z", modelId: "deepseek-v4-flash-free" });
    openCode = { busy: false, messages: async () => [{ info: { role: "user", time: { created: 5 } } }] };
    expect(await read(session("cli:opencode"))).toMatchObject({ status: "idle", source: "native" });
    expect(openCodeDashboardActivity([assistant(2, { error: { name: "MessageAbortedError" } })])).toMatchObject({ status: "idle", reason: "Interrupted" });
    expect(openCodeDashboardActivity([assistant(null, { finish: "tool-calls" })])).toBeNull();
    screen = "RUNNING";
    expect(await read(session("cli:kimi"))).toMatchObject({ status: "working", source: "screen", rule: "busy-key" });
    expect(await read(session("cli:claude"))).toMatchObject({ status: "working", source: "screen" });
  });
  it("adds Space chat run timing and failures without exposing run text", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Dashboard", initialPaneCount: 0 });
    const [idle, running, failed] = ["Idle chat", "Running chat", "Failed chat"].map(title => store.createPane({ roomId: room.id, title, mode: "CHAT" }));
    expect((await readDashboardActivity([idle!], store, vi.fn())).activity).toEqual({});
    const runFor = (pane: typeof idle) => {
      const session = store.createSpaceAgentSession({ paneId: pane!.id, roomId: room.id, title: pane!.title, selectedProviderId: null,
        selectedModelId: "chat-test", selectedModelConfigId: "chat-test:high", selectedProviderName: null, selectedModelName: "chat-test",
        selectedReasoningKey: "high", selectedToolIds: [] });
      const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "private prompt" });
      const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
      return store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane!.id, roomId: room.id, workflowId: `chat-test:${response.messageId}`,
        temporalRunId: null, status: "RUNNING", promptMessageId: prompt.messageId, responseMessageId: response.messageId, codexThreadId: null, codexTurnId: null });
    };
    const live = runFor(running);
    const broken = runFor(failed);
    store.updateSpaceAgentRun(broken.runId, { status: "FAILED", errorMessage: "secret stack trace", completedAt: "2026-10-11T06:10:00.000Z" });
    const { activity, details } = await readDashboardActivity([running!, failed!], store, vi.fn());
    expect(activity).toEqual({ [running!.id]: "working", [failed!.id]: "waiting" });
    expect(details[running!.id]).toMatchObject({ source: "run", since: new Date(live.startedAt ?? live.createdAt).toISOString() });
    expect(details[failed!.id]).toEqual({ status: "waiting", reason: "Run failed", since: "2026-10-11T06:10:00.000Z", modelId: null, source: "run" });
    expect(JSON.stringify(details)).not.toContain("secret");
  });
  it("keeps the shared screen classifications for the dashboard", () => {
    const cases: Array<[string, string]> = [
      ["•····· esc interrupt          tab agents   ctrl+p commands", "RUNNING"],
      ["esc interrupt", "RUNNING"],
      ["escape cancel", "RUNNING"],
      ["tab agents   ctrl+p commands", "UNKNOWN"],
      ["• [08:34:07] find /var/lib/spaceapp-user/.codex/ /srv/spac... running\n> ", "RUNNING"],
      ["[12:00:15] npm test running", "RUNNING"],
      ["• [task-470] find /opt/spaceapp running (5s)", "RUNNING"],
      ["⡿  Running command...", "RUNNING"],
      ["Running background task...", "RUNNING"],
      ["• [08:34:07] find /var/lib/spaceapp-user/.codex/ /srv/spac... completed\n> ", "IDLE"],
      ["• [08:34:07] ps aux | grep running completed\n> ", "IDLE"],
      ["• Always keep tests running in production\n> ", "IDLE"],
      ["⠋ working · 13s\n\n> []", "RUNNING"],
      ["working · 8s\n\n> []", "RUNNING"],
      ["| thought for 5s\n|\n⠋ working · 8s\n\n> []", "RUNNING"],
      ["thinking...\n\n> []", "RUNNING"],
      ["TURN 14.2K tok · in 13.0K · cached 0 · new 13.0K · out 1.2K · cost n/a\n\n> πεσμου μια ιστορια 1000 λεξεων\n\n> []", "IDLE"],
      ["▸ Thought for 6s, 1.8k tokens\n  Η ιστορία ολοκληρώθηκε.\n>\n? for shortcuts", "IDLE"],
      ["▸ Thought for 6s\n⠋ working · 8s\n>", "RUNNING"],
    ];
    expect(cases.map(([screen]) => dashboardScreenState(screen).state)).toEqual(cases.map(([, state]) => state));
  });
  it("reads busy, question and idle screens of the screen-only CLIs, busy before the composer", () => {
    const qwenBox = (status: string) => `${status}\n╭──────────────────────────────────────────╮\n│ > Type your message or @path/to/file      │\n╰──────────────────────────────────────────╯\n/etc        no sandbox        qwen3.8-coder (99% context left)`;
    const droidBox = (status: string) => `${status}\n Auto (High) · allow all commands        GPT-6.1 Sol (High)\n╭────────╮\n│ > Try something │\n╰──────────────╯\n? for help`;
    const reasonix = (above: string) => `${above}\n${"─".repeat(99)}\n ❯ \n${"─".repeat(99)}\n   YOLO  · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLO  MODEL deepseek-flash   EFFORT auto\n  ${"─".repeat(97)}\n  CTX 11.1K (1%)  COMPACT 84%  BAL $-0.00`;
    const qoder = (status: string) => `${status}\n──────\n Shift+Tab to Accept Edits        1 AGENTS.md file\n──────\n >   Type your message\n──────\n Qwen3.8-Flash Model · ctx 0% · /etc`;
    const expectations: Array<[string, string, string]> = [
      // Qwen keeps its placeholder visible while a turn runs.
      ["qwen busy", qwenBox("⠼ Reticulating splines... (esc to cancel, 5s)"), "RUNNING"],
      ["qwen idle", qwenBox(""), "IDLE"],
      ["qwen approval", "╭──────╮\n│ ? Shell ls -la /etc │\n│ Allow execution of: 'ls'? │\n│ ● 1. Yes, allow once │\n│   2. Yes, allow always │\n│   3. No, suggest changes (esc) │\n╰──────╯", "WAITING_FOR_INPUT"],
      ["droid busy", droidBox("⠋ Thinking...  (Press ESC to stop)"), "RUNNING"],
      ["droid idle", droidBox(""), "IDLE"],
      ["qoder busy", qoder("⠙ Thinking… (esc to interrupt)"), "RUNNING"],
      ["qoder idle", qoder(""), "IDLE"],
      ["cursor busy", "  ⬢ Generating..  ctrl+c to stop\n → Add a follow-up", "RUNNING"],
      ["copilot busy", "∙ Thinking (Esc to cancel)\n> Enter @ to mention files or / for commands", "RUNNING"],
      ["deepseek busy", "⠋ working · 13s\n\n> []", "RUNNING"],
      // Captured from the live DeepSeek (Reasonix) proof pane: the spinner sits above a six-line footer.
      ["deepseek live busy", reasonix("  › SPACE_DASHBOARD_PROOF_V1. Write the whole numbers\n  ⣽ working · 1s"), "RUNNING"],
      ["deepseek live idle", reasonix("  ◆ reasonix  · deepseek-flash\n  Context is kept across turns. Type 'exit' or Ctrl-D to quit."), "IDLE"],
      ["claude-style spinner", "✻ Pondering… (12s · ↑ 1.2k tokens)\n> \n? for shortcuts", "RUNNING"],
      ["yes/no question", "Overwrite /etc/hosts? (y/n)", "WAITING_FOR_INPUT"],
      // Captured from the live Grok Build proof pane on an exhausted free plan.
      ["grok usage limit", "  Read Terms and Privacy Policy.\n  ┃\n  ┃  You hit your free usage limit.\n  ┃\n  ┃  1 (○) Upgrade to SuperGrok        For everyday coding and productivity tasks\n  ┃  2 (○) Upgrade to SuperGrok Plus   Significantly higher usage and rate limits\n  ┃  ↑/↓ navigate · y copy                                                        Enter:submit\n  ┃\n  Tab:next answer  │  Esc:scrollback  │  Shift+x:dismiss", "WAITING_FOR_INPUT"],
      ["grok busy", "    ⠙ Thinking… 1.1s                                                            0.0s ⇣2.02k [stop]\n  Help improve Grok                                                             [Opt out] [Opt in]\n  Off by default. Opt-in to allow SpaceXAI to retain coding data, e.g.,\n  prompts, traces, & metrics, for training and debugging purposes. Change\n  anytime via settings.\n  Read Terms and Privacy Policy.\n  ╭────────────────────────────────╮\n  │ ❯                              │\n  ╰── Grok 4.7 (high) · always-approve ─╯\n  Shift+Tab:mode  │  Ctrl+c:cancel  │  Ctrl+x:shortcuts", "RUNNING"],
      // Captured from the live DeepSeek proof pane on an account without balance: the turn failed at once.
      ["deepseek out of balance", reasonix("  › SPACE_DASHBOARD_PROOF_V1. Write the whole numbers\n  .\n  Insufficient Balance (request_id: <token>)"), "WAITING_FOR_INPUT"],
      // Captured from the live Cursor Agent proof pane: an idle composer, then a free-plan limit.
      ["cursor idle", "  Cursor Agent\n  v2026.10.01-e373342\n  Tip: Use /mcp to connect Cursor to your tools and data sources.\n  → Plan, search, build anything\n  Auto                                                                              Run Everything\n  /etc", "IDLE"],
      ["cursor usage limit", "  Auto                                                                              Run Everything\n  /etc\n  Error: You've hit your usage limit\n  Get Cursor Pro for more Agent usage, unlimited Tab, and more.\n  limitType: included_usage", "WAITING_FOR_INPUT"],
      ["cursor plan limit", "  → SPACE_DASHBOARD_PROOF_V1. Do not use any tools, files or the network.\n  Codex 5.3 Low Fast                                                                Run Everything\n  /etc\n  Error: Named models unavailable\n  Free plans can only use Auto. Switch to Auto or upgrade plans to continue.\n  hideIcon: true\n  hideKeybindings: true", "WAITING_FOR_INPUT"],
      // Captured from the live Hermes proof pane while it runs a shell task, and when it is ready again.
      ["hermes busy", "   command in the current directory and report its output: echo SPACE_DASHBOARD_PROOF_SHELL        ┃\n ─ (｡•́︿•̀｡) mulling…       · 2s │ big pickle       ─  SPACE_DASHBOARD_PROOF_V1. Do not use any too…\n ❯ Ctrl+C to interrupt…", "RUNNING"],
      ["hermes ready", " ─ ready │ big pickle │ 4s │ voice off │ 1 session                                           ─ /etc\n ❯ Ask me anything…", "IDLE"],
      // Captured from the live Oh My Pi proof pane: working, then idle again with its π rail.
      ["omp busy", " Connected to MCP server: mcp_dispatcher.\n SPACE_DASHBOARD_PROOF_V1. Do not use any tools.\n  ⎋ Working…\n ⠹ 2s > ◒ GPT-6 Sol > 📁 /etc ▶─1%────────┃─────────1.1M─\n╰─", "RUNNING"],
      ["omp idle", " SPACE_DASHBOARD_PROOF_DONE\n                                                 Write Space Dashboard Proof\n π > ◒ GPT-6 Sol > 📁 /etc ▶─1%────────┃─────────1.1M─\n╰─", "UNKNOWN"],
      // Captured from the live Qoder proof pane: busy beside its visible placeholder, and out of credits.
      ["qoder live busy", "   directory and report its output: echo SPACE_DASHBOARD_PROOF_SHELL\n ⠸ Generating... (esc to cancel, 1s)                                                ? for shortcuts\n──────\n YOLO Shift+Tab to Auto Mode                           1 AGENTS.md file · 2 MCP servers · 55 skills\n──────\n *   Type your message or @path/to/file\n──────\n Qwen3.8-Flash Model · ctx ▓▓░░░░░░░░ 22% · /etc", "RUNNING"],
      ["qoder credits notice", "   this one response.\n                                    Credits exhausted. Use /usage for details or /upgrade for more.\n──────\n YOLO Shift+Tab to Auto Mode\n──────\n *   Type your message or @path/to/file\n──────\n Qwen3.8-Flash Model · ctx ░░░░░░░░░░ 0% · /etc", "IDLE"],
      // Captured from the live Muse proof pane, which is not signed in.
      ["muse sign-in", "  Muse Code 1.4.6\n  Sign in at this page:\n    https://auth.example.test/oauth/device/?code=ABCD-EFGH\n  confirm this code matches:\n    ABCD-EFGH\n  Waiting for approval…\n  Esc cancel", "WAITING_FOR_INPUT"],
      // Captured from the live Droid proof pane: its composer stays visible beside the busy hint.
      ["droid live busy", "   this one response.\n ⠙ Thinking...  (Press ESC to stop)\n Auto (High) · allow all commands                                                GPT-6.1 Sol (High)\n╭────────────╮\n│ > Enter to steer · Ctrl+Enter to queue │\n╰────────────╯\n4 config issues — /diagnostics                                                         MCP ✓ | IDE ◌", "RUNNING"],
      ["claude spinner frame", "* Levitating…  24s · thinking more with xhigh effort)\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)", "RUNNING"],
      ["markdown bullet", "* Lighthouses use Fresnel lenses…\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)", "IDLE"],
      ["droid no subscription", "   SPACE_DASHBOARD_PROOF_DONE on the last line. Stop after this one response.\n●  No active subscription found.\n   Subscribe to start using Droid.\n   This is re-checked on every message, so if your limit was raised or has reset, send another\n   message to continue. Run /limits to review usage.\n Auto (High) · allow all commands                                                GPT-6.1 Sol (High)\n╭────────────╮\n│ >          │\n╰────────────╯\n[⏱ 1s] 4 config issues — /diagnostics                                                  MCP ✓ | IDE ◌", "WAITING_FOR_INPUT"],
      ["grok idle", "  Help improve Grok                                                             [Opt out] [Opt in]\n  Off by default. Opt-in to allow SpaceXAI to retain coding data, e.g.,\n  ╭──────────────────────────────────────────────╮\n  │ ❯                                            │\n  ╰───────────── Grok 4.7 (high) · always-approve ─╯\n  Enter:send  │  Alt+Enter:newline  │  Shift+Tab:mode  │  Ctrl+x:shortcuts", "IDLE"],
      // Transcript prose above the composer cannot hold an agent in Working.
      ["prose", "- working tree clean\n- Press Esc to cancel a running turn, as documented.\n" + "\n".repeat(2) + Array.from({ length: 18 }, (_, i) => `line ${i}`).join("\n") + "\n› Ask anything", "IDLE"],
      ["finished background job", "Waiting for background terminal (esc to interrupt)\n› Ask Codex to do anything", "IDLE"],
    ];
    expect(Object.fromEntries(expectations.map(([name, screen]) => [name, dashboardScreenState(screen).state])))
      .toEqual(Object.fromEntries(expectations.map(([name, , state]) => [name, state])));
    expect(dashboardScreenState(expectations.find(([name]) => name === "grok usage limit")![1])).toMatchObject({ rule: "choice", reason: "Usage limit" });
    expect(dashboardScreenState(expectations.find(([name]) => name === "deepseek out of balance")![1])).toMatchObject({ rule: "usage-limit", reason: "Usage limit" });
    expect(dashboardScreenState(expectations.find(([name]) => name === "muse sign-in")![1])).toMatchObject({ rule: "approval", reason: "Sign-in required" });
    // A new turn after the failure reads as working even while the old error is still on screen.
    expect(dashboardScreenState(reasonix("  Insufficient Balance (request_id: <token>)\n  ⣽ working · 1s")).state).toBe("RUNNING");
  });
  it("reads a Claude pane's usage limit from its transcript (this session, until the reset), else from the screen", () => {
    // The three ways Claude Code says it (operator, 2026-10-20), above its empty composer.
    const composer = "\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
    for (const said of ["  ⎿  You've hit your session limit · resets 6:30pm (Europe/Athens)", "  ⎿  Claude usage limit reached. Your limit will reset at 8pm.",
      "  Automatic continue cancelled · /rate-limit-options"]) {
      expect(dashboardScreenState(said + composer)).toMatchObject({ state: "WAITING_FOR_INPUT", reason: "Usage limit" });
    }
    const screen = "  ⎿  You've hit your session limit · resets 6:30pm (Europe/Athens)" + composer;
    const now = Date.parse("2026-10-20T14:00:00.000Z");
    const limit = { at: "2026-10-20T13:55:00.000Z", resetsAt: "2026-10-20T15:30:00.000Z" };
    expect(cliUsageLimited(screen, null, null, now)).toBe(true);
    expect(cliUsageLimited(composer, { rateLimit: limit }, "2026-10-20T13:00:00.000Z", now)).toBe(true);
    // The transcript moved on, a later session (moved or restarted) has not hit it, or the reset passed: the old screen text does not count.
    expect(cliUsageLimited(screen, { rateLimit: null }, null, now)).toBe(false);
    expect(cliUsageLimited(screen, { rateLimit: limit }, "2026-10-20T13:58:00.000Z", now)).toBe(false);
    expect(cliUsageLimited(screen, { rateLimit: limit }, null, Date.parse("2026-10-20T15:31:00.000Z"))).toBe(false);
  });
  it("shows Done for screen-only CLIs once a watched turn goes quiet, and when each state began", async () => {
    let clock = Date.parse("2026-10-12T08:00:00.000Z");
    let screen = "> Type your message";
    const read = createCliDashboardActivityReader({
      screenText: async () => screen, codexTurn: vi.fn(), geminiTurns: vi.fn(), openCode: vi.fn(), claude: vi.fn()
    }, () => clock);
    const qwen = { sessionId: "cli_session:qwen", runtimeId: "cli:qwen", paneId: "pane:q" } as never;
    // Idle before any observed work: no completion is invented and idle has no start time.
    expect(await read(qwen)).toEqual({ status: "idle", source: "screen", rule: "composer" });
    screen = "⠼ Working... (esc to cancel, 1s)\n> Type your message";
    expect(await read(qwen)).toMatchObject({ status: "working", since: "2026-10-12T08:00:00.000Z" });
    clock += 30_000;
    expect(await read(qwen)).toMatchObject({ status: "working", since: "2026-10-12T08:00:00.000Z" });
    // A single quiet frame inside a turn does not finish it.
    screen = "> Type your message";
    clock += 1_000;
    expect(await read(qwen)).toMatchObject({ status: "working", since: "2026-10-12T08:00:00.000Z" });
    clock += 1_000;
    screen = "⠼ Working... (esc to cancel, 32s)\n> Type your message";
    expect(await read(qwen)).toMatchObject({ status: "working", since: "2026-10-12T08:00:00.000Z" });
    // Quiet for the settle window: Done, dated from when it went quiet.
    screen = "> Type your message";
    clock += 1_000;
    expect(await read(qwen)).toMatchObject({ status: "working" });
    clock += DASHBOARD_SCREEN_SETTLE_MS;
    expect(await read(qwen)).toMatchObject({ status: "done", since: "2026-10-12T08:00:33.000Z" });
    clock += 60_000;
    expect(await read(qwen)).toMatchObject({ status: "done", since: "2026-10-12T08:00:33.000Z" });
    // A question needs the operator; the next turn starts a new working time.
    screen = "Allow execution? ● 1. Yes, allow once";
    expect(await read(qwen)).toMatchObject({ status: "waiting", reason: "Needs input", since: "2026-10-12T08:01:37.000Z" });
    clock += 5_000;
    screen = "⠼ Working... (esc to cancel, 1s)";
    expect(await read(qwen)).toMatchObject({ status: "working", since: "2026-10-12T08:01:42.000Z" });
    // Native CLIs keep their own times; a running Codex turn without one is dated when first seen.
    const codex = createCliDashboardActivityReader({
      screenText: async () => "", codexTurn: async () => ({ status: "RUNNING" }), geminiTurns: vi.fn(), openCode: vi.fn(), claude: vi.fn()
    }, () => clock);
    const codexSession = { sessionId: "cli_session:codex", runtimeId: "cli:codex", paneId: "pane:c" } as never;
    expect(await codex(codexSession)).toEqual({ status: "working", source: "native", since: "2026-10-12T08:01:42.000Z" });
    clock += 10_000;
    expect(await codex(codexSession)).toEqual({ status: "working", source: "native", since: "2026-10-12T08:01:42.000Z" });
  });
});
