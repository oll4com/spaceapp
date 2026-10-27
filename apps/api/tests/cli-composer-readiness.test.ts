import { expect, it, vi } from "vitest";
import { CliTerminalManager, cliComposerReady } from "../src/cli-terminal.js";
import { roomTerminalState } from "../src/room-terminal-screen.js";

// Composer screens captured in tmux on 2026-10-14 (trimmed).
const idle = {
  "cli:claude": "❯ \n────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  "cli:qwen": "*   Type your message or @path/to/file\n  YOLO mode (shift + tab to cycle)",
  "cli:cursor": "  → Plan, search, build anything\n  Auto                    Run Everything",
  "cli:omp": " Connected to MCP server: space_dispatcher.\n π > ⟳ GPT-6 Sol > 🌳 main ▶─2%──\n╰─   ⇧⇥ to change thinking",
  "cli:droid": "╭────\n│ > Try \"Search the documentation for this library\"\n╰────\n? for help           MCP ✓",
  "cli:hermes": " ─ ready │ big pickle │ 9s │ voice off │ 1 session\n ❯ Try \"refactor the auth module\"",
  "cli:grok": "  ╭────\n  │ ❯\n  ╰────"
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
  expect(cliComposerReady("cli:kimi", "anything")).toBeNull();
  expect(roomTerminalState(" ⎋ Working…\n ⠇ 2s > ◒ GPT-6 Sol > 🌳 main")).toBe("RUNNING");
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

const waitFor = (terminal: CliTerminalManager, managed: unknown, composer: boolean) =>
  (terminal as unknown as { waitForInputReady(managed: unknown, waitForComposer: boolean): Promise<void> }).waitForInputReady(managed, composer);

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
