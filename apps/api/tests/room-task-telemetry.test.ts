import { roomOpenCodeTerminalState } from "../src/room-terminal-screen.js";
import { describe, expect, it } from "vitest";
import { codexTaskTimelineReducer, openCodeTaskTimeline, summarizeNativeTasks } from "../src/room-task-telemetry.js";
import { projectRoomTerminalScreen, roomTerminalState, roomTerminalInterruptKey, roomTerminalMode } from "../src/room-terminal-screen.js";
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 5, 10, 0, seconds)).toISOString();
const event = (seconds: number, type: string, payload: unknown) => JSON.stringify({ timestamp: at(seconds), type, payload });

describe("Room native task evidence", () => {
  it("finds the operator task beyond native Chat tool context without losing recovery markers", () => {
    const prompt = 'Find the solar story\n\nUser prompt:\nKeep this literal example.\n<space-room-action marker="proof-marker">Internal recovery marker; ignore and do not mention.</space-room-action>';
    const wrapped = `Space private clipboard tools selected:\n${"tool context ".repeat(400)}\n\nUser prompt:\n${prompt}`;
    for (const kind of ["event_msg", "response_item"]) {
      const reader = codexTaskTimelineReducer();
      reader.accept(event(1, "event_msg", { type: "task_started", turn_id: "story" }));
      reader.accept(event(2, kind, kind === "event_msg" ? { type: "user_message", message: wrapped }
        : { type: "message", role: "user", content: [{ type: "input_text", text: wrapped }] }));
      expect(reader.result()[0]!.title).toBe(prompt);
      expect(reader.result()[0]!.timing.startedAt).toBe(at(1));
    }
    expect(openCodeTaskTimeline([{ info: { id: "u", role: "user" }, parts: [{ type: "text", text: wrapped }] }], false, at(5))[0]!.title).toBe(prompt);
    const ordinary = "Explain this example:\n\nUser prompt:\nHello";
    expect(openCodeTaskTimeline([{ info: { id: "u", role: "user" }, parts: [{ type: "text", text: ordinary }] }], false, at(5))[0]!.title).toBe(ordinary);
  });
  it("preserves the start before turn identity, model changes, exact finish and incremental checkpoints", () => {
    const reader = codexTaskTimelineReducer();
    reader.accept(event(1, "event_msg", { type: "task_started" }));
    const restored = codexTaskTimelineReducer();
    restored.restore!(reader.checkpoint!());
    restored.accept([
      event(2, "turn_context", { turn_id: "turn-a", model: "model-a", effort: "high" }),
      event(3, "event_msg", { type: "user_message", message: "Write a story" }),
      event(5, "turn_context", { turn_id: "turn-a", model: "model-b", effort: "low" }),
      event(9, "event_msg", { type: "task_complete", turn_id: "turn-a" })
    ].join("\n"));
    const tasks = restored.result();
    expect(tasks[0]).toMatchObject({ taskId: "turn-a", title: "Write a story", status: "COMPLETED", timing: { startedAt: at(1), completedAt: at(9), durationMs: 8000, source: "NATIVE" } });
    expect(tasks[0]!.modelsUsed.map((model) => [model.modelId, model.startedAt, model.completedAt])).toEqual([["model-a", at(2), at(5)], ["model-b", at(5), at(9)]]);
    expect(summarizeNativeTasks(tasks, Date.parse(at(0)), at(30)).timing.completedAt).toBe(at(9));
  });
  it("does not invent a missing start or finish from observation time", () => {
    const reader = codexTaskTimelineReducer();
    reader.accept(event(4, "turn_context", { turn_id: "missing-start", model: "model-a" }));
    reader.accept(event(8, "event_msg", { type: "task_complete" }));
    expect(reader.result()[0]!.timing).toMatchObject({ startedAt: null, durationMs: null });
    expect(summarizeNativeTasks(reader.result(), 0, at(30)).timing).toMatchObject({ source: "UNKNOWN", startedAt: null, durationMs: null });
  });
  it("does not summarize a partial interrupted timeline as fully finished", () => {
    const task = (end: string | null) => ({ taskId: "interrupted", title: "Wait", status: "INTERRUPTED" as const,
      timing: { startedAt: at(1), completedAt: end, durationMs: null, source: "NATIVE" as const, observedAt: at(9) }, modelsUsed: [] });
    expect(summarizeNativeTasks([task(at(5)), task(null)], 0, at(30)).timing).toMatchObject({ completedAt: null, durationMs: null });
  });
  it("reads native response-item task titles and keeps millisecond event timestamps over coarse epoch seconds", () => {
    const reader = codexTaskTimelineReducer();
    reader.accept([
      JSON.stringify({ timestamp: "2026-09-05T15:44:53.881Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-native" } }),
      JSON.stringify({ timestamp: "2026-09-05T15:44:53.902Z", type: "turn_context", payload: { turn_id: "turn-native", model: "model-a" } }),
      JSON.stringify({ timestamp: "2026-09-05T15:44:53.935Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find this story" }] } }),
      JSON.stringify({ timestamp: "2026-09-05T15:45:04.559Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-native", completed_at: 1788623104 } })
    ].join("\n"));
    expect(reader.result()[0]).toMatchObject({ title: "Find this story", status: "COMPLETED", timing: { startedAt: "2026-09-05T15:44:53.881Z", completedAt: "2026-09-05T15:45:04.559Z", durationMs: 10678 } });
  });
  it("groups OpenCode tool steps and model changes without declaring busy tasks finished", () => {
    const messages = [{ info: { id: "u", role: "user", time: { created: Date.parse(at(0)) } }, parts: [{ type: "text", text: "Story" }] },
      { info: { id: "a", parentID: "u", role: "assistant", modelID: "first", providerID: "p", finish: "tool-calls", time: { created: Date.parse(at(1)), completed: Date.parse(at(4)) } } },
      { info: { id: "b", parentID: "u", role: "assistant", modelID: "second", providerID: "p", finish: "stop", time: { created: Date.parse(at(5)), completed: Date.parse(at(9)) } } }];
    expect(openCodeTaskTimeline(messages, false, at(30))[0]).toMatchObject({ status: "COMPLETED", timing: { startedAt: at(1), completedAt: at(9), durationMs: 8000 }, modelsUsed: [{ modelId: "first" }, { modelId: "second" }] });
    expect(openCodeTaskTimeline(messages, true, at(30))[0]).toMatchObject({ status: "RUNNING", timing: { completedAt: null, durationMs: null } });
  });
  it("projects ANSI erase/redraw so obsolete busy text does not survive into the menu", async () => {
    const screen = await projectRoomTerminalScreen(["thinking...\r\n", "\x1b[2J\x1b[HSelect a model\r\n❯ model-b"]);
    expect(screen).not.toContain("thinking");
    expect(roomTerminalState(screen)).toBe("WAITING_FOR_INPUT");
  });
  it("detects OpenCode active running state from esc interrupt shortcut footer", () => {
    expect(roomTerminalState("•····· esc interrupt          tab agents   ctrl+p commands")).toBe("RUNNING");
    expect(roomTerminalState("esc interrupt")).toBe("RUNNING");
    expect(roomTerminalState("escape cancel")).toBe("RUNNING");
    expect(roomTerminalState("tab agents   ctrl+p commands")).toBe("UNKNOWN");
  });
  it("detects Antigravity/Gemini background tasks and running commands as RUNNING", () => {
    expect(roomTerminalState("• [08:34:07] find /var/lib/spaceapp-user/.codex/ /srv/spac... running\n> ")).toBe("RUNNING");
    expect(roomTerminalState("• [08:34:07] find /var/lib/spaceapp-user/.codex/ /srv/spac... running")).toBe("RUNNING");
    expect(roomTerminalState("[12:00:15] npm test running")).toBe("RUNNING");
    expect(roomTerminalState("• [task-470] find /opt/spaceapp running (5s)")).toBe("RUNNING");
    expect(roomTerminalState("⡿  Running command...")).toBe("RUNNING");
    expect(roomTerminalState("Running background task...")).toBe("RUNNING");
    expect(roomTerminalState("• [08:34:07] find /var/lib/spaceapp-user/.codex/ /srv/spac... completed\n> ")).toBe("IDLE");
    expect(roomTerminalState("• [08:34:07] ps aux | grep running completed\n> ")).toBe("IDLE");
    expect(roomTerminalState("• Always keep tests running in production\n> ")).toBe("IDLE");
  });
  it("detects Reasonix/DeepSeek CLI active running state from working and thought indicators", () => {
    expect(roomTerminalState("⠋ working · 13s\n\n> []")).toBe("RUNNING");
    expect(roomTerminalState("working · 8s\n\n> []")).toBe("RUNNING");
    expect(roomTerminalState("| thought for 5s\n|\n⠋ working · 8s\n\n> []")).toBe("RUNNING");
    expect(roomTerminalState("thinking...\n\n> []")).toBe("RUNNING");
    expect(roomTerminalState("TURN 14.2K tok · in 13.0K · cached 0 · new 13.0K · out 1.2K · cost n/a\n\n> πεσμου μια ιστορια 1000 λεξεων\n\n> []")).toBe("IDLE");
    expect(roomTerminalMode("cli:deepseek", "[ Workspace · ready · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO ]")).toBe("workspace");
    expect(roomTerminalMode("cli:deepseek", "[ YOLO · ready · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO ]")).toBe("yolo");
    expect(roomTerminalMode("cli:deepseek", "[ Plan · ready · Shift+Tab read-only/workspace/YOLO/plan · Ctrl+Y YOLO ]")).toBe("plan");
  });
});


it("uses the same native Stop key as the CLI floating controls", () => {
  // Escape stops a turn in Codex, Claude Code, Muse Code, Oh My Pi and Droid (cliTurnInterruptKey).
  for (const runtime of ["cli:codex", "cli:claude", "cli:muse", "cli:omp", "cli:droid"]) {
    expect(roomTerminalInterruptKey(runtime)).toBe("\u001b");
  }
  for (const runtime of ["cli:hermes", "cli:gemini", "cli:qwen", "cli:kimi", "cli:deepseek"]) {
    expect(roomTerminalInterruptKey(runtime)).toBe("\u0003");
  }
});

it("recognizes the observed Codex default footer without treating a pending slash command as a mode change", () => {
  const footer = "gpt-5.6-sol low · /etc";
  expect(roomTerminalMode("cli:codex", `Old output: Plan mode\n\n› Ask Codex to do anything\n${footer}\n? for shortcuts\n`)).toBe("default");
  expect(roomTerminalMode("cli:codex", `Old output\n› Ask Codex to do anything\n${footer}\n`)).toBe("default");
  expect(roomTerminalMode("cli:codex", `› /plan\n${footer}\n`)).toBeNull();
  expect(roomTerminalMode("cli:codex", `› Ask Codex to do anything\nPlan mode (shift+tab to switch)\n${footer}\n`)).toBe("plan");
  expect(roomTerminalMode("cli:codex", `• Model changed to gpt-5.6-sol xhigh for Plan mode.\n› Ask Codex to do anything\n${footer}      Plan mode (shift+tab to cycle)\n`)).toBe("plan");
  expect(roomTerminalMode("cli:codex", `› /plan\n/plan  switch to Plan mode\n`)).toBeNull();
  expect(roomTerminalMode("cli:codex", `• Model changed to gpt-5.6-sol xhigh for Plan mode.\n› Ask Codex to do anything\n${footer}\n`)).toBe("default");
  expect(roomTerminalMode("cli:codex", "Select a model\n› gpt-5.6-sol low")).toBeNull();
});

it("reads OpenCode modes from its bordered ANSI composer and agent controls", async () => {
  const ansi = "\x1b[2J\x1b[HOld output: Plan\x1b[27;3H\x1b[38;2;92;156;245m┃\x1b[27;6HBuild\x1b[27;12H·\x1b[27;14HMuse Spark 1.2 Free\x1b[27;34HOpenCode Zen\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72Htab agents\x1b[29;84Hctrl+p commands\x1b[0m";
  const screen = await projectRoomTerminalScreen([ansi]);
  expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
  const plan = await projectRoomTerminalScreen([ansi, "\x1b[27;6HPlan "]);
  expect(roomTerminalMode("cli:opencode", plan, ["build", "plan"])).toBe("plan");
  expect(roomTerminalMode("cli:opencode", "Build a feature\nPlan the work\n", ["build", "plan"])).toBeNull();
  expect(roomTerminalMode("cli:opencode", screen, ["plan"])).toBeNull();
});

it('can join soft wraps for native settings without changing default terminal projection', async()=>{
  const chunks=['Model set to Gemini 3.8 Flash (High)\r\n>'];
  expect(await projectRoomTerminalScreen(chunks,20,10,true)).toContain('Model set to Gemini 3.8 Flash (High)');
  expect(await projectRoomTerminalScreen(chunks,20,10)).not.toContain('Model set to Gemini 3.8 Flash (High)');
});

it("recognizes the compact OpenCode input box without accepting historical mode labels", async () => {
  const compact = "▣ Build · Muse Spark 1.2 Free · 1.9s\r\n┃\r\n┃\r\n┃  Build · Muse Spark 1.2 Free OpenCode Zen · xhigh\r\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀";
  const screen = await projectRoomTerminalScreen([compact]);
  expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
  expect(roomOpenCodeTerminalState(screen, false, ["build", "plan"])).toBe("IDLE");
  expect(roomOpenCodeTerminalState(screen, true, ["build", "plan"])).toBe("RUNNING");
  expect(roomTerminalMode("cli:opencode", screen.replace("┃  Build", "┃  Plan"), ["build", "plan"])).toBe("plan");
  for (const invalid of [
    "▣ Build · Muse Spark 1.2 Free · 1.9s",
    "Build · Muse Spark 1.2 Free\n╹▀▀▀▀▀▀▀▀",
    "┃  Build · Muse Spark 1.2 Free\n╹▀▀▀▀▀▀▀▀",
    compact + "\nSelect a session",
    compact.replace("┃\r\n┃  Build", "┃ pending input\r\n┃  Build")
  ]) expect(roomTerminalMode("cli:opencode", invalid, ["build", "plan"])).toBeNull();
});


it("does not treat an idle OpenCode server as a ready terminal before its composer renders", () => {
  const modes = ["build", "plan"];
  expect(roomOpenCodeTerminalState("", false, modes)).toBe("UNKNOWN");
  expect(roomOpenCodeTerminalState("OpenCode is starting", false, modes)).toBe("UNKNOWN");
  const composer = "┃  Build · Muse Spark 1.2 Free OpenCode Zen · xhigh\n/etc                  tab agents    ctrl+p commands";
  expect(roomOpenCodeTerminalState(composer, false, modes)).toBe("IDLE");
  expect(roomOpenCodeTerminalState(composer, true, modes)).toBe("RUNNING");
  expect(roomOpenCodeTerminalState(`Select a session\n${composer}`, false, modes)).toBe("WAITING_FOR_INPUT");
});

it("accepts the observed compact OpenCode cwd/context footer after the composer border", async () => {
  // Positions and trailing status from opencode-controls-inspect7a, 2026-09-06.
  const ansi = "\x1b[2J\x1b[14;6H▣ Build · Muse Spark 1.2 Free · 1.9s\x1b[26;3H┃\x1b[27;3H┃  Build · Muse Spark 1.2 Free OpenCode Zen · xhigh\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72H15.5K (1%)";
  const screen = await projectRoomTerminalScreen([ansi]);
  expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
  expect(roomOpenCodeTerminalState(screen, false, ["build", "plan"])).toBe("IDLE");
  const plan = await projectRoomTerminalScreen([ansi, "\x1b[27;6HPlan "]);
  expect(roomTerminalMode("cli:opencode", plan, ["build", "plan"])).toBe("plan");
  expect(roomTerminalMode("cli:opencode", screen, ["plan"])).toBeNull();
  for (const invalid of [
    screen.replace("15.5K (1%)", "Select a session"),
    screen.replace("/etc", "Some prose"),
    screen.replace("┃  Build", "▣ Build"),
    screen.replace("╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", ""),
    screen.replace("┃  Build", "┃ pending input\n┃  Build"),
    screen.trimEnd() + "\nSelect a session"
  ]) expect(roomTerminalMode("cli:opencode", invalid, ["build", "plan"])).toBeNull();
});

it("recognizes a wrapped OpenCode mode only inside the complete empty composer", () => {
  const screen = "┃\n┃  Buil  Muse Spark 1.3 Free OpenCod  xhi\n┃  d                         e Zen    gh\n┃\n╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n/etc            tab agents  ctrl+p commands";
  expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
  expect(roomOpenCodeTerminalState(screen, false, ["build", "plan"])).toBe("IDLE");
  expect(roomOpenCodeTerminalState(screen, true, ["build", "plan"])).toBe("RUNNING");
  expect(roomOpenCodeTerminalState(screen.replace("tab agents", "17.4K (2%)"), false, ["build", "plan"])).toBe("IDLE");
  expect(roomOpenCodeTerminalState(`Select a session\n${screen}`, false, ["build"])).toBe("WAITING_FOR_INPUT");
  for (const invalid of [screen.replace(/^┃\n/, "┃ pending input\n"), screen.replace("tab agents", "starting"), screen.replace("┃  d ", "┃  x "), screen.replace(/╹[^\n]+\n/, "")]) {
    expect(roomOpenCodeTerminalState(invalid, false, ["build", "plan"])).toBe("UNKNOWN");
  }
});


it("does not count a completed Gemini thought as an active native task", () => {
  expect(roomTerminalState("▸ Thought for 6s, 1.8k tokens\n  Η ιστορία ολοκληρώθηκε.\n>\n? for shortcuts")).toBe("IDLE");
  expect(roomTerminalState("▸ Thought for 6s\n⠋ working · 8s\n>")).toBe("RUNNING");
});
