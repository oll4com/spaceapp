import { expect, it, vi } from "vitest";
import { CliTerminalManager, cliComposerReady } from "../src/cli-terminal.js";
import { claudeRoomState, roomComposerHolds, roomComposerNotReady, roomTerminalState } from "../src/room-terminal-screen.js";

// Composer screens captured in tmux on 2026-10-14 (trimmed).
const idle = {
  "cli:claude": "❯ \n────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "cli:qwen": "*   Type your message or @path/to/file\n  YOLO mode (shift + tab to cycle)",
  "cli:cursor": "  → Plan, search, build anything\n  Auto                    Run Everything",
  "cli:omp": " Connected to MCP server: space_dispatcher.\n π > ⟳ GPT-6 Sol > 🌳 main ▶─2%──\n╰─   ⇧⇥ to change thinking",
  "cli:droid": "╭────\n│ > Try \"Search the documentation for this library\"\n╰────\n? for help           MCP ✓",
  "cli:hermes": " ─ ready │ big pickle │ 9s │ voice off │ 1 session\n ❯ Try \"refactor the auth module\"",
  "cli:grok": "  ╭────\n  │ ❯\n  ╰────",
  // Built 2026-10-28 from the installed bundles (no CLI was run): OpenCode 2.1.2's prompt placeholder (cli-versions/opencode/current/
  // node_modules/@opencode/cli-linux-x64/bin/opencode) over the status line of a real idle pane's AUTO report; Qoder's
  // composer.placeholder.message (/usr/local/bin/qodercli).
  "cli:opencode": "  ┃  Ask anything… \"Fix a TODO in the codebase\"\n  ┃\n  /opt/spaceapp:main                                        0",
  "cli:qoder": "╭────\n│ >   Type your message or @path/to/file\n╰────",
  // tmux 2026-10-29, installed binaries started the way their wrappers start them, nothing typed (trimmed).
  "cli:copilot": " /etc                                     Session: 0 AIC used\n────────\n❯\n────────\n ← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab",
  "cli:deepseek": "────────\n ❯\n────────\n   YOLO  · ready · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLO      MODEL deepseek-flash",
  // ADAPTER-001, tmux 2026-11-03: Muse 1.4.14 started as its wrapper starts it (--yolo) on the echo provider, which needs no sign-in,
  // in a throwaway HOME, nothing typed; its footer (model · directory · YOLO, "YOLO always stays visible" in its binary), path as /etc.
  "cli:muse": "  Muse Code 1.4.14\n────────\n❯\n────────\n  echo · /etc · YOLO",
  // ADAPTER-001, tmux 2026-11-03: Kimi Code 2.4.1 started as its wrapper starts it (--yolo) in a trusted folder, nothing typed (44 columns).
  "cli:kimi": " ╭────────╮\n │ >      │\n ╰────────╯\n Ask When Needed  K3 thinking: max  …/etc\n                         context: 0% (0/1M)"
} as const;

it("knows when each terminal CLI's composer is open, and not while it starts or asks something", () => {
  for (const [runtimeId, screen] of Object.entries(idle)) {
    expect(cliComposerReady(runtimeId, screen), runtimeId).toBe(true);
    expect(cliComposerReady(runtimeId, ""), runtimeId).toBe(false);
    expect(roomTerminalState(screen), runtimeId).toBe("IDLE");
  }
  // Claude Code 2.1.302 in a 42-column pane (tmux 2026-10-17): the hint is cut, the bypass question has no mode label.
  expect(cliComposerReady("cli:claude", "❯ \n──────────\n  ⏵⏵ bypass permissions on (shift+tab to")).toBe(true);
  expect(cliComposerReady("cli:claude", "  ⏸ manual mode on · ? for shortcuts · …")).toBe(true);
  expect(cliComposerReady("cli:claude", "  ❯ No, exit\n    Yes, I accept\n\n  Enter to confirm · Esc to cancel")).toBe(false);
  expect(cliComposerReady("cli:grok", "Do you trust the contents of this directory?\n Yes, proceed  y\n No, quit  n")).toBe(false);
  // Muse's login chooser (same tmux run, default provider, not signed in) owns input before any composer.
  expect(cliComposerReady("cli:muse", "  Muse Code 1.4.14\n  Log in with browser · Enter to choose\n  Set an API key\n  ↓↑ to select · Esc to quit")).toBe(false);
  // OpenCode's finished-turn footer alone (a real AUTO report tail) is not its prompt; a Qoder dialog before the composer is not either.
  expect(cliComposerReady("cli:opencode", "     Build · Claude Sonnet 5.5 (API credits) · 23.5s · 46.5 tok/s\n  /opt/spaceapp:main     6")).toBe(false);
  expect(cliComposerReady("cli:qoder", "Do you trust the files in this folder?\n ● 1. Trust folder\n   2. Don't trust")).toBe(false);
  expect(roomTerminalState(" ⎋ Working…\n ⠇ 2s > ◒ GPT-6 Sol > 🌳 main")).toBe("RUNNING");
});

// ADAPTER-012, dev 4/11: a dev pane's Hermes runs the profile space-dev and prefixes its prompt with it (live screen, trimmed).
it("reads a dev Hermes pane's profile prompt as its composer", () => {
  const dev = " ─ ready │ opus 5.5 xhigh │ 59s │ voice off │ 1 session                                      ─ /etc\n space-dev ❯ Ask me anything…";
  expect(cliComposerReady("cli:hermes", dev)).toBe(true);
  expect(roomTerminalState(dev)).toBe("IDLE");
  const typed = " ─ ready │ opus 5.5 xhigh │ 59s │ voice off │ 1 session\n space-dev ❯ Remember the word";
  expect(roomComposerHolds(typed, "Remember the word")).toBe(true);
  expect(roomComposerNotReady(typed)).toBe("its composer holds text");
  expect(roomTerminalState(" output line\n other-profile ❯ x")).toBe("UNKNOWN");
});

// Spinner lines from Claude panes on stable 2026-10-17, read as UNKNOWN because a narrow pane cut "esc to interrupt".
it("reads Claude Code's spinner as a running turn even when a narrow pane cuts its hint, and its finished line as idle", () => {
  for (const line of ["· Simmering…  5s · thinking with xhigh effort)", "✢ Nesting…     2", "* Whatchamacalliting… (1m 5s · ↓ 2.2k tokens)",
    "● Perambulating…           3"]) {
    expect(roomTerminalState(`${line}\n\n${idle["cli:claude"]}`), line).toBe("RUNNING");
  }
  expect(roomTerminalState("\n\n* Fluttering…  5  11s · ↓ 12.7k tokens)")).toBe("RUNNING");
  expect(roomTerminalState(`✻ Cooked for 13s\n\n${idle["cli:claude"]}`)).toBe("IDLE");
});

function manager(runtimeId: string, controlOutput: string, timeoutMs: number) {
  const session = { sessionId: `cli_session:${runtimeId}`, purpose: "NORMAL", isActive: true, status: "RUNNING", runtimeId };
  const managed = { runtimeId, inputReady: false, closed: false, startupOutput: "", controlOutput };
  const terminal = new CliTerminalManager({ config: {}, hostClient: {}, store: { getPaneCliSession: async () => session },
    startupReadyTimeoutMs: timeoutMs } as never);
  vi.spyOn(terminal, "ensurePaneTransportReady").mockResolvedValue(session as never);
  (terminal as unknown as { sessions: Map<string, unknown> }).sessions.set(session.sessionId, managed);
  return { terminal, managed, session };
}

const waitFor = (terminal: CliTerminalManager, managed: unknown, composer: boolean, signal?: AbortSignal) =>
  (terminal as unknown as { waitForInputReady(managed: unknown, waitForComposer: boolean, signal?: AbortSignal): Promise<void> }).waitForInputReady(managed, composer, signal);

it("holds a prompt until a freshly started CLI opens its composer", async () => {
  const { terminal, managed } = manager("cli:droid", "Loading…", 2000);
  let ready = false;
  const pending = waitFor(terminal, managed, true).then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(ready).toBe(false);
  managed.controlOutput += idle["cli:droid"];
  await pending;
  expect(ready).toBe(true);
});

it("finds the composer on the saved screen of a CLI that was idle before this attachment", async () => {
  const { terminal, managed } = manager("cli:claude", "", 2000);
  vi.spyOn(terminal, "observeRoomScreen").mockResolvedValue({ text: idle["cli:claude"], revision: 1 });
  await expect(waitFor(terminal, managed, true)).resolves.toBeUndefined();
});

// Stable 2026-10-22/23 (Hugo, Leo, Paul): a scheduled task typed into a Claude pane whose process was gone made Space start it
// again with --resume; the old process's footer, in the saved output and screen, let the paste reach the booting CLI.
it("holds a prompt for a CLI started again after host loss until its own output shows the composer", async () => {
  for (const startupOutput of [idle["cli:claude"], ""]) {
    const { terminal, managed } = manager("cli:claude", "", 3000);
    Object.assign(managed, { startupOutput, restartedAfterHostLoss: true });
    vi.spyOn(terminal, "observeRoomScreen").mockResolvedValue({ text: idle["cli:claude"], revision: 1 });
    let ready = false;
    const pending = waitFor(terminal, managed, true).then(() => { ready = true; });
    // Longer than the 750 ms quiet window an old footer would have opened.
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(ready).toBe(false);
    managed.controlOutput += idle["cli:claude"];
    await pending;
    expect(ready).toBe(true);
  }
});

// Stable 2026-10-21: the usage-limit move restarted Emma's Claude on Space Gateway and typed "continue" as an answer (no composer
// wait). Claude draws its footer once, so after that turn neither the 16 kB output buffer nor the DB tail held it: every Space
// Control prompt failed with "has not opened its input yet" while she sat idle at an empty prompt.
it("lets a prompt into a CLI whose composer showed earlier in this attachment, after a long turn pushed it out of the buffers", async () => {
  const { terminal, managed } = manager("cli:claude", "", 2000);
  Object.assign(managed, { controlOutputRevision: 0 });
  const internals = terminal as unknown as Record<string, unknown> & { emitHostOutput(managed: unknown, event: unknown, data: string): void };
  internals.broadcast = () => undefined;
  internals.bufferHostOutput = () => undefined;
  const output = (data: string) => internals.emitHostOutput(managed, { type: "output", stream: "stdout" }, data);
  output(idle["cli:claude"]);
  for (let i = 0; i < 400; i++) output(`\u001b[4A\u001b[2K✻ Fiddle-faddling… (${i}s · ↓ 2.2k tokens)\u001b[4B`);
  output("\u001b[6A\u001b[2K● Done.\u001b[3B\u001b[2K❯ ");
  vi.spyOn(terminal, "observeRoomScreen").mockResolvedValue({ text: "● Done.\n\n❯ \n", revision: 2 });
  expect(cliComposerReady("cli:claude", managed.controlOutput)).toBe(false);
  await expect(waitFor(terminal, managed, true)).resolves.toBeUndefined();
});

it("refuses a prompt when the composer never opens, but an answer or key does not wait for it", async () => {
  const { terminal, managed } = manager("cli:grok", "Do you trust the contents of this directory?", 60);
  await expect(waitFor(terminal, managed, true)).rejects.toThrow("no input was sent");
  await expect(waitFor(terminal, managed, false)).resolves.toBeUndefined();
  // Starting or resuming a pane does not wait for the composer either.
  await expect(terminal.ensurePaneControlReady({} as never, "proof")).resolves.toBeTruthy();
});

// 7/11 Bruno/Kate: a scheduled task reopened an OpenCode pane; its session view has no "Ask anything" placeholder, so each typing waited 45 s
// for it and held the pane's lock long after the command's 8 s watchdog gave up.
it("reads a reopened OpenCode session's prompt footer as its composer, and stops waiting once the caller gives up", async () => {
  const session = "┃\n┃  Build · Claude Opus 5.5 Space Gateway\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n/etc                  15.6K (1%)  ctrl+p commands";
  expect(cliComposerReady("cli:opencode", session)).toBe(true);
  const { terminal, managed } = manager("cli:opencode", "Loading…", 45_000);
  const abort = new AbortController();
  const started = Date.now();
  const pending = waitFor(terminal, managed, true, abort.signal);
  setTimeout(() => abort.abort(new Error("The command timed out")), 100);
  await expect(pending).rejects.toThrow("The command timed out");
  expect(Date.now() - started).toBeLessThan(1000);
});

it("after the composer appears, waits until the CLI's output has been quiet for a moment", async () => {
  const { terminal, managed } = manager("cli:claude", idle["cli:claude"], 3000);
  (managed as { controlOutputRevision?: number }).controlOutputRevision = 1;
  const started = Date.now();
  let readyAt = 0;
  const pending = waitFor(terminal, managed, true).then(() => { readyAt = Date.now(); });
  for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 100)); (managed as { controlOutputRevision: number }).controlOutputRevision += 1; }
  await pending;
  // Output changed for ~600 ms, then 750 ms of quiet were required.
  expect(readyAt - started).toBeGreaterThanOrEqual(1300);
});

it("sends an interrupt key to a busy Codex that never showed its ready composer", async () => {
  const session = { sessionId: "cli_session:codex-busy", purpose: "NORMAL", isActive: true, status: "RUNNING", runtimeId: "cli:codex" };
  const runtime = { id: "cli:codex", adapterStatus: "ENABLED", authState: "READY", status: "ENABLED", detectedCommandPath: "/usr/local/bin/codex" };
  const managed = { runtimeId: "cli:codex", sessionId: session.sessionId, inputReady: false, codexModelControlReady: false, closed: false,
    startupOutput: "• Working (16s • esc to interrupt)", controlOutput: "", pendingHostEvents: [], turnMarkers: new Map() };
  const input = vi.fn(async () => ({ accepted: true, acceptedAtMs: Date.now() }));
  const terminal = new CliTerminalManager({ config: {}, hostClient: {}, startupReadyTimeoutMs: 50,
    store: { getPaneCliSession: async () => session, touchPaneCliSessionActivity: async () => undefined },
    discoverRuntimes: async () => ({ data: [runtime] }) } as never);
  const internals = terminal as unknown as Record<string, unknown>;
  internals.getOrSpawnSession = async () => ({ managed });
  internals.flushHostOutput = async () => undefined;
  internals.appendTranscript = async () => undefined;
  internals.hostForRuntime = () => ({ input });
  await expect(terminal.sendInput(session.sessionId, "\u001b", "trace:esc")).resolves.toMatchObject({ turnMarker: null });
  expect(input).toHaveBeenCalledTimes(1);
  // Any other input still waits for Codex to be ready.
  await expect(terminal.sendInput(session.sessionId, "/model", "trace:cmd")).rejects.toThrow("did not become ready for input");
});

it("lets an idle Claude session read as idle when its room screen cannot tell (R9-9)", () => {
  expect(claudeRoomState("UNKNOWN", { busy: false, status: "idle" })).toBe("IDLE");
  expect(claudeRoomState("RUNNING", { busy: false, status: "idle" })).toBe("IDLE");
  expect(claudeRoomState("IDLE", { busy: true, status: "busy" })).toBe("RUNNING");
  // A question or a status Claude does not call idle keeps what the screen says.
  expect(claudeRoomState("WAITING_FOR_INPUT", { busy: false, status: "waiting" })).toBe("WAITING_FOR_INPUT");
  expect(claudeRoomState("UNKNOWN", { busy: false, status: "waiting" })).toBe("UNKNOWN");
  expect(claudeRoomState("UNKNOWN", { busy: false, status: null })).toBe("UNKNOWN");
});

// ADAPTER-001 (2026-11-03): Kimi Code 2.4.1 in tmux, nothing typed. Its folder-trust menu comes before any composer; with
// `--session` and no id (a resume without a recorded session) it draws its composer and footer, then the session picker over
// them, so the picker reads as open until a composer row follows its "Esc cancel" hint. The raw output stream, ANSI stripped, trimmed.
it("does not read Kimi's folder-trust menu or session picker as its composer", () => {
  const trust = "  Trust this folder?\n  ↑↓ navigate · Enter select · Esc exit\n\n  /etc\n\n   ❯ Trust and continue\n     Exit";
  const composer = " ╭───╮\r\r\n │ >   │\r\r\n ╰───╯\r\r\n Ask When Needed  /etc\r\r\n   context: 0%\r\r\n";
  const picker = " ───\r\r\n Sessions  (type to search)\r\r\n ↑↓ navigate · Ctrl+A all · Ctrl+X delete · Enter select · Esc cancel\r\r\n \r\r\n" +
    " ❯ Reply with exactly the word WORDA and nothing else.  1h ago\r\r\n   session_…   ~/ws\r\r\n ───\r\r\n Ask When Needed  /etc   ctrl+c: cancel\r\r\n   context: 0%\r";
  expect(cliComposerReady("cli:kimi", trust)).toBe(false);
  expect(cliComposerReady("cli:kimi", composer)).toBe(true);
  expect(cliComposerReady("cli:kimi", picker)).toBe(false);
  expect(cliComposerReady("cli:kimi", `${composer}${picker}`)).toBe(false);
  expect(cliComposerReady("cli:kimi", `${composer}${picker}   Resumed session (session_…).\r\r\n${composer}`)).toBe(true);
});

// ADAPTER-001 (2026-11-02): Reasonix 2.56.0 (DeepSeek) with no key, started in a throwaway HOME in tmux, keeps its status line
// on screen under the setup panels, so that line alone read as an open composer while the panel owned input. Screens and the
// panels' part of the raw output stream, trimmed; the key typed was a dummy.
it("does not read DeepSeek's setup panel as its composer, on the screen or in the output stream", async () => {
  const status = "─────\n   YOLO  · ready · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLO   MODEL deepseek-flash   EFFORT auto";
  const picker = `─────\n Configure connection\n ❯ 1. deepseek (active)\n      anthropic · 2 model(s) · key required\n Type to filter · ↑/↓ navigate · Enter select · Esc cancel\n${status}`;
  const keyPanel = `─────\n Configure deepseek\n   API Key\n   Enter credential\n Ctrl+T test · Enter save · Esc cancel\n${status}`;
  const composer = `  · Credential saved for deepseek and applied.\n─────\n ❯\n${status}`;
  expect(cliComposerReady("cli:deepseek", picker)).toBe(false);
  expect(cliComposerReady("cli:deepseek", keyPanel)).toBe(false);
  expect(cliComposerReady("cli:deepseek", composer)).toBe(true);
  // Ink draws the panels after the status line and never redraws it; once the key is saved only the bare composer row follows.
  const stream = "─\r\n ❯ \r\n─\r\n   Ask  · ready · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLOEFFORT auto◆ reasonix  · deepseek-flash\r\n" +
    "  ! deepseek/deepseek-flash has no API key yet. YOLO  · ready · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLOMODEL deepseek-flash\r\n" +
    "─\r\n Configure connection\r\n ❯ 1. deepseek (active)\r\n Type to filter · ↑/↓ navigate · Enter select · Esc cancelws@master" +
    "deepseek\r\n   API Key\r\n   Enter credential\r\n Ctrl+T test · Enter save · Esc cancel";
  expect(cliComposerReady("cli:deepseek", stream)).toBe(false);
  expect(cliComposerReady("cli:deepseek", `${stream}•••••\r\n Saving…\r  · Credential saved for deepseek and applied.\r\n\n\n─\r\n ❯ `)).toBe(true);
  // A prompt waits while the panel is up and goes once the composer shows.
  const { terminal, managed } = manager("cli:deepseek", stream, 3000);
  const screen = vi.spyOn(terminal, "observeRoomScreen").mockResolvedValue({ text: keyPanel, revision: 1 });
  let ready = false;
  const pending = waitFor(terminal, managed, true).then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(ready).toBe(false);
  screen.mockResolvedValue({ text: composer, revision: 2 });
  await pending;
  expect(ready).toBe(true);
});

// ADAPTER-001, Autohand 0.9.9-space.1: actual exported readInstruction in an isolated
// PTY accepted fixture-ready at 100/42 columns; separate real startup stopped at login.
// This is native component evidence, not a signed-in whole-CLI/provider execution proof.
it("recognizes Autohand's native composer and rejects its later login menu", () => {
  const wide = "───────────────────────────────────────────────────────────────────────────────────────────────────\n❯ Plan, search, build anything\n───────────────────────────────────────────────────────────────────────────────────────────────────\nplan:off";
  const narrow = "─────────────────────────────────────────\n❯ Plan, search, build anything\n─────────────────────────────────────────\nplan:off";
  const ansi = "\u001b[38;2;138;138;138m───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\n\u001b[90m❯ Plan, search, build anything\u001b[38;2;160;160;160m                                                                     \u001b[39m\n\u001b[38;2;138;138;138m───────────────────────────────────────────────────────────────────────────────────────────────────\u001b[39m\n\u001b[90mplan:off                                                                                           \u001b[39m";
  const login = " Sign in to continue.\n\n ▸ 1. Login\n   2. Exit\n\n ↑↓ Navigate · ↵ Select · 1-9 Shortcut · ESC Cancel";
  for (const screen of [wide, narrow, ansi]) expect(cliComposerReady("cli:autohand", screen)).toBe(true);
  expect(cliComposerReady("cli:autohand", "")).toBe(false);
  expect(cliComposerReady("cli:autohand", "Plan, search, build anything")).toBe(false);
  expect(cliComposerReady("cli:autohand", login)).toBe(false);
  expect(cliComposerReady("cli:autohand", `${wide}\n${login}`)).toBe(false);
  expect(cliComposerReady("cli:autohand", `${wide}\n${login}\n${narrow}`)).toBe(true);
});
