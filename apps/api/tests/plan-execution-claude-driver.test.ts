import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { CodexManagedTurnDeliveryError } from "@space/codex-app-server";
import { claudeTaskTimeline, type ClaudeNativeTurns } from "../src/claude-native-turns.js";
import { PlanExecutionController } from "../src/plan-execution-controller.js";
import { executionControlPatch } from "../src/plan-execution-mutations.js";
import { claudePaneManagedTurnDriver, claudePlanResultText, claudePlanTarget, createClaudeManagedTurnDriver, type ClaudeManagedTurnDeps } from "../src/plan-execution-claude-driver.js";
import type { RoomPaneObservation } from "../src/room-pane-control.js";

const SESSION = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";
const efforts = ["low", "medium", "high", "xhigh", "max"];
const models = ["claude:haiku", "claude:sonnet", "claude:opus"].map((id) => ({ id, displayName: id.slice(7)[0]!.toUpperCase() + id.slice(8),
  isDefault: false, defaultReasoningEffort: "xhigh", supportedReasoningEfforts: efforts }));

/** A Claude Code pane: its transcript (fixture JSONL read by the real timeline), session status, composer and picker. */
function fakeClaude() {
  const lines: string[] = [];
  let status: "busy" | "idle" | "waiting" = "idle";
  let statusAt = Date.now();
  let turn = 0;
  let streamed = false;
  let clock = 0;
  // suggestion: Claude's faint prompt suggestion, on the plain screen only (the undimmed screen blanks it).
  const pane = { draft: "", suggestion: "", model: "claude:sonnet", effort: "xhigh", usageLimited: false };
  const typed: string[] = [];
  const picks: string[][] = [];
  const keys: string[] = [];
  const at = () => new Date().toISOString();
  const setStatus = (next: typeof status) => { status = next; statusAt = Date.now() + clock; };
  const native = (): ClaudeNativeTurns => ({ nativeSessionId: SESSION, busy: status === "busy", status, waitingFor: null,
    statusUpdatedAt: new Date(statusAt).toISOString(), ...claudeTaskTimeline(lines, status === "busy", at()) });
  const deps: ClaudeManagedTurnDeps = {
    cwd: "/project",
    turns: async () => native(),
    inspect: async () => ({ paneId: "pane", title: "Claude", runtimeId: "cli:claude", sessionId: "session", nativeTaskRef: SESSION, modelId: null,
      nativeMode: null, checkedAt: at(), tasks: [], state: status === "busy" ? "RUNNING" : status === "waiting" ? "WAITING_FOR_INPUT" : "IDLE",
      text: `Claude Code\n❯ ${pane.draft || pane.suggestion}`, promptFingerprint: "fp", usageLimited: pane.usageLimited } satisfies RoomPaneObservation),
    settings: async () => ({ sessionId: "session", threadId: null, models, current: { modelId: pane.model, reasoningEffort: pane.effort },
      controlMode: "NATIVE", isTurnActive: status === "busy" }),
    applyModel: async (modelId, effort) => {
      picks.push([modelId, effort]);
      const named = effort === pane.effort && modelId === pane.model ? "" : ` with \`${effort}\` effort`;
      pane.model = modelId; pane.effort = effort;
      lines.push(JSON.stringify({ type: "user", timestamp: at(), message: { role: "user",
        content: `<local-command-stdout>Set model to \`${modelId[7]!.toUpperCase()}${modelId.slice(8)} 5.5\` for this session only${named}</local-command-stdout>` } }));
    },
    serialize: (work) => work(),
    submit: async (text) => {
      typed.push(text);
      streamed = false;
      lines.push(JSON.stringify({ type: "user", timestamp: at(), promptId: `prompt-${++turn}`, message: { role: "user", content: text } }));
      setStatus("busy");
    },
    press: async (key) => {
      keys.push(key === "\u001b" ? "Escape" : key === "\u0003" ? "Ctrl+C" : key);
      if (key === "\u0003") pane.draft = "";
      if (key !== "\u001b" || status !== "busy") return;
      // Mid-answer Esc records the interrupt; before the first answer Claude Code puts the prompt back into the composer.
      if (streamed) lines.push(JSON.stringify({ type: "user", timestamp: at(), message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
      else pane.draft = typed.at(-1)!.replace(/^\[space-plan:[^\]]+\]\s*/, "");
      setStatus("idle");
    },
    screen: async () => `Claude Code\n${"─".repeat(20)}\n❯ ${pane.draft}\n${"─".repeat(20)}`,
    wait: async () => undefined,
    now: () => Date.now() + clock
  };
  const stream = (text: string) => {
    lines.push(JSON.stringify({ type: "assistant", timestamp: at(), effort: pane.effort, message: { id: `msg-${turn}`, model: `claude-${pane.model.slice(7)}-5-5`, content: [{ type: "text", text }] } }));
    streamed = true;
  };
  const answer = (text: string, model = `claude-${pane.model.slice(7)}-5-5`) => {
    lines.push(JSON.stringify({ type: "assistant", timestamp: at(), effort: pane.effort, message: { id: `msg-${turn}`, model, content: [{ type: "text", text }] } }));
    lines.push(JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: at(), durationMs: 1000 }));
    setStatus("idle");
  };
  const finish = (outcome: string, criterion: string, model?: string) =>
    answer(`Done.\n\n\`\`\`json\n${JSON.stringify({ outcome, summary: `${criterion} checkpoint`, evidence: [{ criterion, result: "test passed" }] })}\n\`\`\``, model);
  return { deps, pane, typed, picks, keys, lines, finish, answer, stream, setStatus, advance: (ms: number) => { clock += ms; } };
}

async function fixture() {
  const store = new InMemorySpaceStore();
  const stages = [
    { id: "one", order: 1, title: "First", modelId: "claude:haiku", reasoningEffort: "low", instructions: "Do first", completionCriteria: ["First tested"] },
    { id: "two", order: 2, title: "Second", modelId: "claude:sonnet", reasoningEffort: "high", instructions: "Do second", completionCriteria: ["Second tested"] }
  ];
  const plan = store.upsertClipboardItem({ ownerUserId: "user:owner", source: "PLAN", minimumModel: "claude:haiku", text: "Plan", steps: stages });
  const execution = await store.planExecutions.create({ ownerUserId: "user:owner", planId: plan.id, paneId: "pane", sessionId: "session",
    threadId: SESSION, cwd: "/project", requestId: "request", snapshot: { text: plan.text, title: null, stages } });
  const claude = fakeClaude();
  const controller = new PlanExecutionController({ repository: store.planExecutions, publish: async () => undefined,
    resolve: async () => createClaudeManagedTurnDriver(claude.deps) });
  const read = async () => (await store.planExecutions.get("user:owner", execution.id))!;
  const control = async (action: "pause" | "resume") => {
    const current = await read();
    await store.planExecutions.update("user:owner", execution.id, current.revision, executionControlPatch(current, action), undefined, true);
  };
  return { store, plan, claude, controller, read, control, tick: () => controller.tick() };
}

describe("managed Claude Code execution", () => {
  it("runs each stage on its model and effort through the session-only picker and reads the stage JSON from the transcript", async () => {
    const f = await fixture();
    await f.tick();
    expect(f.claude.picks).toEqual([["claude:haiku", "low"]]);
    expect(f.claude.typed).toHaveLength(1);
    const first = await f.read();
    expect(f.claude.typed[0]).toMatch(new RegExp(`^\\[space-plan:${first.pendingCommand!.id}\\]\\n`));
    expect(f.claude.typed[0]).toContain("Execute only stage 1: First");
    expect(f.claude.typed[0]).toContain("```json");
    expect(first).toMatchObject({ status: "RUNNING", pendingCommand: { type: "START", status: "SENT", turnId: "prompt-1" } });
    await f.tick();
    expect(f.claude.typed).toHaveLength(1);
    f.claude.finish("COMPLETED", "First tested", "claude-haiku-4-5-20251001");
    await f.tick();
    await f.tick();
    expect(f.claude.picks).toEqual([["claude:haiku", "low"], ["claude:sonnet", "high"]]);
    f.claude.finish("COMPLETED", "Second tested");
    await f.tick();
    const done = await f.read();
    expect(done).toMatchObject({ status: "COMPLETED", completedStageIds: ["one", "two"], checkpoint: "Second tested checkpoint" });
    expect(done.attempts.map((a) => [a.modelId, a.reasoningEffort, a.actualSelection?.modelId, a.status])).toEqual([
      ["claude:haiku", "low", "claude:haiku", "COMPLETED"], ["claude:sonnet", "high", "claude:sonnet", "COMPLETED"]]);
    expect(f.store.getClipboardItem("user:owner", f.plan.id)).toMatchObject({ isCompleted: true, progressPercentage: 100 });
  });

  it("starts the next stage behind Claude's faint prompt suggestion, which is no draft", async () => {
    const f = await fixture();
    f.claude.pane.suggestion = "Try running the tests";
    await f.tick();
    expect(f.claude.typed).toHaveLength(1);
    f.claude.finish("COMPLETED", "First tested", "claude-haiku-4-5-20251001");
    await f.tick();
    await f.tick();
    expect(f.claude.typed).toHaveLength(2);
  });

  it("waits behind a draft or a usage limit without spending attempts", async () => {
    const f = await fixture();
    f.claude.pane.draft = "half-typed operator text";
    await f.tick();
    await f.tick();
    f.claude.pane.draft = "";
    f.claude.pane.usageLimited = true;
    await f.tick();
    expect(f.claude.picks).toEqual([]);
    expect(f.claude.typed).toEqual([]);
    expect((await f.read()).attempts).toEqual([]);
    f.claude.pane.usageLimited = false;
    await f.tick();
    expect(f.claude.typed).toHaveLength(1);
  });

  it("pauses with Esc once the transcript shows the interrupt, and resumes the same stage with a new marker", async () => {
    const f = await fixture();
    await f.tick();
    f.claude.stream("one\ntwo");
    await f.control("pause");
    await f.tick();
    expect(f.claude.keys).toEqual(["Escape"]);
    await f.tick();
    const paused = await f.read();
    expect(paused).toMatchObject({ status: "PAUSED", pendingCommand: null, interruptCommand: null });
    expect(paused.attempts[0]!.status).toBe("INTERRUPTED");
    await f.tick();
    expect(f.claude.typed).toHaveLength(1);
    await f.control("resume");
    await f.tick();
    expect(f.claude.typed).toHaveLength(2);
    const resumed = await f.read();
    expect(f.claude.typed[1]).toMatch(new RegExp(`^\\[space-plan:${resumed.pendingCommand!.id}\\]`));
    expect(resumed.pendingCommand!.id).not.toBe(paused.attempts[0]!.commandId);
    expect(f.claude.typed[1]).toContain("Recovery:");
  });

  it("pauses a turn cancelled before its first answer and clears the prompt Claude Code puts back into the composer", async () => {
    const f = await fixture();
    await f.tick();
    await f.control("pause");
    await f.tick();
    expect(f.claude.keys).toEqual(["Escape", "Ctrl+C"]);
    expect(f.claude.pane.draft).toBe("");
    // Idle with nothing in the transcript reads as running until the idle status has settled.
    await f.tick();
    expect(await f.read()).toMatchObject({ status: "SWITCHING_MODEL" });
    f.claude.advance(6_000);
    await f.tick();
    const paused = await f.read();
    expect(paused).toMatchObject({ status: "PAUSED", correctionCount: 0 });
    expect(paused.attempts[0]!.status).toBe("INTERRUPTED");
    await f.control("resume");
    await f.tick();
    expect(f.claude.typed).toHaveLength(2);
  });

  it("allows one correction turn for an answer without valid stage JSON, then blocks", async () => {
    const f = await fixture();
    await f.tick();
    f.claude.answer("I finished the stage.");
    await f.tick();
    await f.tick();
    expect(f.claude.typed).toHaveLength(2);
    expect(f.claude.typed[1]).toContain("Correction:");
    f.claude.answer("```json\n{\"outcome\":\"COMPLETED\"}\n```");
    await f.tick();
    expect(await f.read()).toMatchObject({ status: "BLOCKED", correctionCount: 2 });
    expect(f.claude.typed).toHaveLength(2);
  });

  it("completes a stage whose criterion comes back without its final period or with other spacing; another criterion gets a correction", async () => {
    for (const echoed of ["First tested.", " First  tested "]) {
      const f = await fixture();
      await f.tick();
      f.claude.finish("COMPLETED", echoed, "claude-haiku-5-5");
      await f.tick();
      await f.tick();
      expect((await f.read()).completedStageIds).toEqual(["one"]);
    }
    const f = await fixture();
    await f.tick();
    f.claude.finish("COMPLETED", "First test", "claude-haiku-5-5");
    await f.tick();
    await f.tick();
    expect(f.claude.typed[1]).toContain("Correction:");
    expect((await f.read()).completedStageIds).toEqual([]);
  });

  it("leaves the picker closed when the transcript and readback already show the stage's model and effort", async () => {
    const f = await fixture();
    await f.tick();
    f.claude.answer("I finished the stage.");
    await f.tick();
    await f.tick();
    expect(f.claude.typed).toHaveLength(2);
    expect(f.claude.typed[1]).toContain("Correction:");
    expect(f.claude.picks).toEqual([["claude:haiku", "low"]]);
  });

  it("opens the picker when the transcript shows other settings than the stage's", async () => {
    const claude = fakeClaude();
    const driver = createClaudeManagedTurnDriver(claude.deps);
    await claude.deps.applyModel("claude:haiku", "medium");
    await driver.updateThreadSettings({ threadId: SESSION, model: "claude:haiku", reasoningEffort: "low" });
    expect(claude.picks).toEqual([["claude:haiku", "medium"], ["claude:haiku", "low"]]);
    // A pick of the same model and effort names no effort: the transcript keeps the earlier one.
    await claude.deps.applyModel("claude:haiku", "low");
    await driver.updateThreadSettings({ threadId: SESSION, model: "claude:haiku", reasoningEffort: "low" });
    expect(claude.picks).toHaveLength(3);
    // Readback and transcript must agree: a stale readback still opens the picker.
    claude.pane.effort = "high";
    await driver.updateThreadSettings({ threadId: SESSION, model: "claude:haiku", reasoningEffort: "low" });
    expect(claude.picks).toHaveLength(4);
  });

  it("blocks when the transcript shows another model answered the stage", async () => {
    const f = await fixture();
    await f.tick();
    f.claude.finish("COMPLETED", "First tested", "claude-opus-5-5");
    await f.tick();
    expect(await f.read()).toMatchObject({ status: "BLOCKED" });
    expect(f.claude.typed).toHaveLength(1);
  });

  it("reports a permission prompt as waiting for input", async () => {
    const f = await fixture();
    await f.tick();
    f.claude.setStatus("waiting");
    await f.tick();
    expect(await f.read()).toMatchObject({ status: "WAITING_FOR_INPUT" });
  });

  it("never types a START whose marker the transcript already holds", async () => {
    const claude = fakeClaude();
    const driver = createClaudeManagedTurnDriver(claude.deps);
    await claude.deps.submit("[space-plan:command-1]\n\nAlready delivered");
    claude.finish("COMPLETED", "x");
    await expect(driver.startManagedTurn!({ threadId: SESSION, prompt: "Again", model: "claude:haiku", reasoningEffort: "low", clientUserMessageId: "command-1" }))
      .rejects.toMatchObject({ delivery: "UNKNOWN" } satisfies Partial<CodexManagedTurnDeliveryError>);
    expect(claude.typed).toHaveLength(1);
  });

  it("reads the session once more, fresh, when the cached read predates it, and keeps a cached confirmed session", async () => {
    const claude = fakeClaude();
    const session = { paneId: "pane", sessionId: "session", cwd: "/project" } as Parameters<typeof claudePlanTarget>[0];
    const native = await claude.deps.turns();
    const reads: unknown[] = [];
    // An inspection cached "no session" just before the start (stable 2026-10-21 03:55).
    const target = await claudePlanTarget(session, async (options) => { reads.push(options); return options.fresh ? native : null; });
    expect(target).toEqual({ paneId: "pane", sessionId: "session", threadId: SESSION, cwd: "/project" });
    expect(reads).toEqual([{}, { fresh: true }]);
    reads.length = 0;
    await claudePlanTarget(session, async (options) => { reads.push(options); return native; });
    expect(reads).toEqual([{}]);
    await expect(claudePlanTarget(session, async () => null)).rejects.toThrow("no confirmed native session");
  });

  it("gives every model switch its own trace, so the pane host never drops a repeated /model as an input it already took", async () => {
    const claude = fakeClaude();
    const traces: string[] = [];
    const session = { paneId: "pane", sessionId: "session", cwd: "/project", isActive: true, status: "RUNNING" };
    const driver = claudePaneManagedTurnDriver({ store: { getActivePaneCliSession: async () => session } as never,
      terminal: { runSerializedTerminalMutation: (_id: string, work: () => Promise<unknown>) => work() } as never,
      pane: { id: "pane" } as never, session: session as never, executionId: "execution", cwd: "/project",
      readTurns: async () => claude.deps.turns(), inspect: async () => claude.deps.inspect(), settings: async () => claude.deps.settings(),
      applyModel: async (input) => { traces.push(input.traceId); await claude.deps.applyModel(input.modelId, input.reasoningEffort); } });
    await driver.updateThreadSettings({ threadId: SESSION, model: "claude:haiku", reasoningEffort: "low" });
    await driver.updateThreadSettings({ threadId: SESSION, model: "claude:haiku", reasoningEffort: "medium" });
    expect(claude.picks).toEqual([["claude:haiku", "low"], ["claude:haiku", "medium"]]);
    expect(traces).toHaveLength(2);
    expect(new Set(traces).size).toBe(2);
    expect(traces.every((trace) => trace.startsWith("trace:managed-plan:execution:"))).toBe(true);
  });

  it("takes the last json block of the final answer", () => {
    expect(claudePlanResultText("a\n```json\n{\"a\":1}\n```\nb\n```json\n{\"b\":2}\n```")).toBe("{\"b\":2}");
    expect(claudePlanResultText("no block")).toBeNull();
  });
});
