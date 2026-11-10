import { describe, expect, it, vi } from "vitest";
import { clearIdleClaudeSession, cliPromptNotReady, rememberSpaceTyped, spaceTypedDraft, spaceTypedTexts, submitCliPrompt } from "../src/cli-prompt-submit.js";
import { roomComposerNotReady, roomComposerShowsOnly } from "../src/room-terminal-screen.js";

const rule = "─".repeat(60);
const empty = [rule, "❯ ", rule].join("\n");
const draft = (text: string) => [rule, `❯ ${text}`, rule].join("\n");
const kickoff = "Freelance Copilot run flrun:ASUITVBtk_Gq started in this pane. Read the space-freelance-copilot skill, then loop.";

/** A terminal whose composer shows `screens` in turn (the last one repeats); it records what was typed. */
function terminal(...screens: string[]) {
  const typed: string[] = [];
  let read = 0;
  return {
    typed,
    sendInput: vi.fn(async (_session: string, data: string) => { typed.push(data); return { turnMarker: null, markerAtMs: 0 }; }),
    observeRoomScreenUndimmed: vi.fn(async () => screens[Math.min(read++, screens.length - 1)]!)
  };
}

describe("typing a prompt into a CLI pane", () => {
  it("pastes the prompt bracketed and presses Enter once when the composer lets go", async () => {
    const cli = terminal(empty, empty);
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed).toEqual([`\u001b[200~${kickoff}\u001b[201~`, "\r"]);
  });

  // OBS-006: a typed prompt starts no native turn to carry its request id, so the typing logs it with the pane and keeps it with the text.
  it("logs and keeps the request that typed the prompt; an id outside printable ASCII 1-120 is dropped", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await submitCliPrompt(terminal(empty, empty), "cli_session:obs6", "First prompt", "trace:a", "k:a", { delayMs: 0, requestId: "req:abc", paneId: "pane:obs6" });
    await submitCliPrompt(terminal(empty, empty), "cli_session:obs6", "Second prompt", "trace:b", "k:b", { delayMs: 0, requestId: "bad id", paneId: "pane:obs6" });
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      expect.objectContaining({ event: "cli_prompt.typed", requestId: "req:abc", paneId: "pane:obs6", sessionId: "cli_session:obs6" }),
      expect.objectContaining({ event: "cli_prompt.typed", requestId: null, paneId: "pane:obs6" })]);
    expect(spaceTypedTexts("cli_session:obs6").map(({ text, requestId }) => ({ text, requestId }))).toEqual([
      { text: "First prompt", requestId: "req:abc" }, { text: "Second prompt", requestId: undefined }]);
    log.mockRestore();
  });

  // 7/11 Bruno/Kate: "cli_prompt.typed" was logged before the composer wait that then failed; the caller's signal reaches the wait.
  it("logs a prompt as typed only once it reached the CLI, and hands the caller's abort signal to the input", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const cli = terminal(empty);
    cli.sendInput.mockRejectedValueOnce(new Error("The command timed out"));
    const signal = new AbortController().signal;
    await expect(submitCliPrompt(cli, "cli_session:late", kickoff, "trace:l", "k:l", { delayMs: 0, signal })).rejects.toThrow("timed out");
    expect(cli.sendInput.mock.calls[0]!.slice(5)).toEqual([true, signal]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  // Bruno/Cody's run kickoff sat as an unsent draft from 00:20 to 01:36 UTC on 2026-10-20 until Enter was pressed.
  it("presses Enter again while the composer still holds the prompt, inline or as Claude's paste placeholder", async () => {
    const cli = terminal(empty, draft(kickoff), draft("[Pasted text #1]"), empty);
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed.slice(1)).toEqual(["\r", "\r", "\r"]);
  });

  it("fails instead of reporting a prompt sent that stays a draft", async () => {
    const cli = terminal(empty, draft(kickoff));
    await expect(submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 }))
      .rejects.toThrow(/unsent draft/);
    expect(cli.typed.filter((data) => data === "\r")).toHaveLength(3);
  });

  // The pinned Claude Code 2.1.307 in a PTY (2026-10-23), projected like observeRoomScreenUndimmed: a paste that reached it
  // while it booted (--resume) stayed in its composer, scrolled to its end, and the Enter after it was dropped.
  it("waits for the composer and presses Enter again on Claude Code 2.1.307's own draft screen", async () => {
    const sentence = "This is a long scheduled objective sentence that keeps going to mimic a real scheduled task prompt. ";
    const scheduled = `Scheduled task “Repro draft check” (Every day at 03:00 (UTC), Space task task:REPRO0000001): ${sentence.repeat(12)}`;
    const claudeRule = "─".repeat(100);
    const claudeIdle = [claudeRule, "❯", claudeRule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    const claudeDraft = [
      "                                                                                 ◉ xhigh · /effort",
      claudeRule,
      "❯ scheduled task prompt. This is a long scheduled objective sentence that keeps going to mimic a",
      "  real scheduled task prompt. This is a long scheduled objective sentence that keeps going to",
      "  mimic a real scheduled task prompt. This is a long scheduled objective sentence that keeps going",
      "  to mimic a real scheduled task prompt. This is a long scheduled objective sentence that keeps",
      "  going to mimic a real scheduled task prompt. This is a long scheduled objective sentence that",
      "  keeps going to mimic a real scheduled task prompt. This is a long scheduled objective sentence",
      "  that keeps going to mimic a real scheduled task prompt. This is a long scheduled objective",
      "  sentence that keeps going to mimic a real scheduled task prompt. This is a long scheduled",
      "  objective sentence that keeps going to mimic a real scheduled task prompt. This is a long",
      "  scheduled objective sentence that keeps going to mimic a real scheduled task prompt.",
      claudeRule,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
    ].join("\n");
    const cli = terminal(claudeIdle, claudeDraft, claudeIdle);
    await submitCliPrompt(cli, "cli_session:1", scheduled, "trace:1", "trace:1:task", { delayMs: 0 });
    expect((cli.sendInput.mock.calls[0] as unknown[])[5]).toBe(true);
    expect(cli.typed.slice(1)).toEqual(["\r", "\r"]);
    // Still a draft after every Enter: the run fails instead of being recorded as sent.
    await expect(submitCliPrompt(terminal(claudeIdle, claudeDraft), "cli_session:1", scheduled, "trace:2", "trace:2:task", { delayMs: 0 }))
      .rejects.toThrow(/unsent draft/);
  });

  // 31/10 Alex/Max: Nous's text was typed while Claude worked and stayed an unsent draft in its composer.
  it("types nothing into a CLI still working or a held composer when asked to wait for an empty prompt", async () => {
    const working = ["● Bash(npm test)", "  ⎿  Running…", "✻ Percolating… (12s · esc to interrupt)", rule, "❯ ", rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    for (const [screen, reason] of [[working, /its CLI is working/], [draft("half a sentence"), /its composer holds text/]] as const) {
      const cli = terminal(screen);
      await expect(submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:nous", { delayMs: 0, onlyWhenReady: true }))
        .rejects.toThrow(reason);
      expect(cli.typed).toEqual([]);
    }
    // A finished turn's status and a lost composer are no reason to wait.
    expect(roomComposerNotReady(["✻ Cooked for 13s", rule, "❯ ", rule].join("\n"))).toBeNull();
    expect(roomComposerNotReady("● Running the tests… and they passed")).toBeNull();
    const idle = terminal(empty, empty);
    await submitCliPrompt(idle, "cli_session:1", kickoff, "trace:1", "trace:1:nous", { delayMs: 0, onlyWhenReady: true });
    expect(idle.typed).toEqual([`\u001b[200~${kickoff}\u001b[201~`, "\r"]);
  });

  // Goal 35813e48 (3/11 Bruno/Paul): the scheduler's paste stayed in an idle composer (Claude Code "Compacted while idle") and every prompt after it waited.
  it("presses Enter on an idle composer that shows only a text Space typed, never on anyone else's draft", async () => {
    const task = "Scheduled task “Temu watch” (Every 2 hours, Space task task:temu00001): Check Temu prices and report drops.";
    rememberSpaceTyped("cli_session:held", task);
    expect(spaceTypedDraft("cli_session:held", draft(task))).toBe(task);
    // A long paste scrolled to its end shows its tail only; a placeholder, someone's words around it or another session's text are no match.
    expect(roomComposerShowsOnly(draft(task.slice(40)), task)).toBe(true);
    for (const screen of [draft("[Pasted text #1]"), draft(`my note ${task}`), draft(`${task} and more`), draft("drops.")]) expect(spaceTypedDraft("cli_session:held", screen)).toBeNull();
    expect(spaceTypedDraft("cli_session:other", draft(task))).toBeNull();
    // Space Control's next-empty-prompt wait (Nous's sends) submits it instead of waiting, and still types nothing new now.
    const held = terminal(draft(task), empty);
    await expect(submitCliPrompt(held, "cli_session:held", kickoff, "trace:1", "trace:1:nous", { delayMs: 0, onlyWhenReady: true }))
      .rejects.toThrow(/its composer holds text Space typed earlier, now submitted; nothing was typed/);
    expect(held.typed).toEqual(["\r"]);
    const claude = terminal(draft(task), empty);
    expect(await cliPromptNotReady(claude, { runtimeId: "cli:claude", sessionId: "cli_session:held" })).toMatch(/now submitted/);
    expect(claude.typed).toEqual(["\r"]);
    const operator = terminal(draft("my own words"));
    expect(await cliPromptNotReady(operator, { runtimeId: "cli:claude", sessionId: "cli_session:held" })).toBe("its composer holds text");
    expect(operator.typed).toEqual([]);
  });

  // 3/11 20:41 UTC Bruno/Oscar (cli:codex): Nous's text stayed in Codex's composer, read as sent, and no pane-draft line came. Codex
  // 0.165/0.166 draws its footer right under the composer, no blank row (codex-readiness-real-screen.test.ts); the faint placeholder reads blank.
  it("sees a Codex draft above its footer, and its long-paste placeholder, as unsent", async () => {
    const footer = ["  GPT-6.1-sol xhigh · /opt/spaceapp", "  ← for agents · ? for shortcuts"];
    const codex = (composer: string) => ["• Done.", "", composer, ...footer].join("\n");
    const idle = codex("›");
    const cli = terminal(idle, codex(`› ${kickoff}`));
    await expect(submitCliPrompt(cli, "cli_session:codex", kickoff, "trace:1", "trace:1:nous", { delayMs: 0 })).rejects.toThrow(/unsent draft/);
    expect(cli.typed.filter((data) => data === "\r")).toHaveLength(3);
    const pasted = terminal(idle, codex("› [Pasted Content 1532 chars]"), idle);
    await submitCliPrompt(pasted, "cli_session:codex", kickoff, "trace:2", "trace:2:nous", { delayMs: 0 });
    expect(pasted.typed.slice(1)).toEqual(["\r", "\r"]);
    // Sent: an empty composer, or Codex's undimmed placeholder (0.166 added three), is no draft.
    for (const sent of [idle, codex("› Will this algorithm scale well?")]) {
      const done = terminal(idle, sent);
      await submitCliPrompt(done, "cli_session:codex", kickoff, "trace:3", "trace:3:nous", { delayMs: 0 });
      expect(done.typed.slice(1)).toEqual(["\r"]);
    }
    // Space Control's wait for an empty prompt reads Codex too: its own text left there is submitted, the operator's words wait.
    rememberSpaceTyped("cli_session:codex", kickoff);
    const held = terminal(codex(`› ${kickoff}`), idle);
    expect(await cliPromptNotReady(held, { runtimeId: "cli:codex", sessionId: "cli_session:codex" })).toMatch(/now submitted/);
    expect(held.typed).toEqual(["\r"]);
    expect(await cliPromptNotReady(terminal(codex("› my own words")), { runtimeId: "cli:codex", sessionId: "cli_session:codex" })).toBe("its composer holds text");
    expect(await cliPromptNotReady(terminal(codex("› my own words")), { runtimeId: "cli:opencode", sessionId: "cli_session:codex" })).toBeNull();
  });

  it("never presses Enter again when the composer was not empty before typing", async () => {
    const cli = terminal(draft("the operator's own note"), draft(`the operator's own note ${kickoff}`));
    await submitCliPrompt(cli, "cli_session:1", kickoff, "trace:1", "trace:1:kickoff", { delayMs: 0 });
    expect(cli.typed.filter((data) => data === "\r")).toHaveLength(1);
  });
});

// Plan clipboard:qH5emwVaV6yO step 4: new copilot work starts a fresh Claude session, never over a draft, a working CLI or another CLI.
describe("a fresh Claude session before new copilot work", () => {
  const claude = { runtimeId: "cli:claude", sessionId: "cli_session:fresh" };
  it("types /clear at an idle empty Claude prompt and waits for the empty prompt again", async () => {
    const cli = terminal(empty, empty, empty, "Clearing conversation…", empty);
    expect(await clearIdleClaudeSession(cli, claude, "trace:f", "k:f", { delayMs: 0 })).toBe(true);
    expect(cli.typed).toEqual(["\u001b[200~/clear\u001b[201~", "\r"]);
    expect(cli.observeRoomScreenUndimmed).toHaveBeenCalledTimes(5);
  });
  it("leaves a draft, a working CLI and other CLIs alone", async () => {
    for (const [session, screen] of [[claude, draft("operator words")], [claude, ["✻ Working… (esc to interrupt)", empty].join("\n")],
      [{ ...claude, runtimeId: "cli:codex" }, empty]] as const) {
      const cli = terminal(screen);
      expect(await clearIdleClaudeSession(cli, session, "trace:f", "k:f", { delayMs: 0 })).toBe(false);
      expect(cli.typed).toEqual([]);
    }
  });
});
