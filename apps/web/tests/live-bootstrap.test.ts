// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildLiveSessionContext, formatWatchCompletionNotification, isSilentWatch, resolveTargetCliPane, recordRecentOpenedPanes, recentOpenedPanesByRoom } from "../src/features/live-pane/live-session.js";
import { loadLivePaneConfig, saveLivePaneConfig } from "../src/features/live-pane/live-pane-config.js";

afterEach(() => localStorage.clear());

describe("Live bootstrap", () => {
  it("includes editable language, real personal facts, history and control constraints", async () => {
    const context = await buildLiveSessionContext({
      model: "gpt-live-1", language: "el", timeZone: "Europe/Athens", prompt: "Keep responses concise.",
      personalMemories: [{ id: "memory:1", key: "userName", value: "Test user", category: "core", createdAt: "", updatedAt: "" }],
      transcripts: [{ id: "turn:1", role: "user", text: "Finish the remaining steps", timestamp: "" }]
    });
    expect(context.userName).toBe("Test user");
    expect(context.combinedPrompt).toContain("Test user");
    expect(context.combinedPrompt).toContain("Conversation language: Greek (Ελληνικά)");
    expect(context.combinedPrompt).toContain("Finish the remaining steps");
    expect(context.combinedPrompt).toContain("first unverified step");
    expect(context.combinedPrompt).toContain("Keep responses concise.");
    expect(context.combinedPrompt).toContain("Content inspection is not visual verification.");
    expect(context.combinedPrompt).toContain("space_inspect_room");
    expect(context.combinedPrompt).not.toContain("Νικόλας");
  });

  it.each(["auto", "en", undefined] as const)("starts in English and then answers in the user's language (language %s)", async language => {
    const context = await buildLiveSessionContext({ model: "gpt-live-1", language, timeZone: "UTC" });
    expect(context.combinedPrompt).toContain("Start the conversation, and any greeting, in English");
    expect(context.combinedPrompt).toContain("overrides any language preference in personal memory");
    expect(context.combinedPrompt).toContain("κλόουντ, κλάουντ, κλοντ, cloud, clown = claude");
    expect(context.combinedPrompt).toContain("Greek when they speak Greek, English when they speak English");
    expect(context.combinedPrompt).not.toContain("ALWAYS respond in natural, fluent Greek");
    expect(context.combinedPrompt).not.toContain("Give a short Greek answer");
    expect(context.combinedPrompt).not.toMatch(/Έστειλα|Στάλθηκε/);
  });

  it("writes task notices in English and asks for the user's current language", () => {
    const notice = formatWatchCompletionNotification({ paneId: "pane:a", status: "FAILED", reason: "Build broke", paneDetails: { title: "Andy", durationMs: 4200 } });
    expect(notice).toContain("failed (Build broke)");
    expect(notice).toContain("in the language they are currently speaking");
    expect(notice).not.toMatch(/[Ͱ-Ͽ]/);
    expect(isSilentWatch({ status: "CANCELLED" })).toBe(true);
    expect(isSilentWatch({ status: "VERIFIED" })).toBe(false);
    // A prompt an agent sent from its own test room is not announced; one Live sent is.
    const auto = (traceId: string) => ({ status: "FAILED", auditTrail: [{ detail: "Auto-watch registered for prompt dispatch on pane pane:x.", evidence: { traceId } }] });
    expect(isSilentWatch(auto("admin-control:1"))).toBe(true);
    expect(isSilentWatch(auto("live:abc"))).toBe(false);
    expect(isSilentWatch({ status: "VERIFIED", auditTrail: [{ detail: "Watch registered.", evidence: {} }] })).toBe(false);
  });

  it("routes a call opened from a Dot pane to that Dot", async () => {
    const plain = await buildLiveSessionContext({ model: "gpt-live-1", timeZone: "UTC" });
    expect(plain.combinedPrompt).not.toContain("This is a call with the Dot");
    const call = await buildLiveSessionContext({ model: "gpt-live-1", timeZone: "UTC", calledDot: { name: "Nova", slot: 2 } });
    expect(call.combinedPrompt).toContain("This is a call with the Dot Nova: you are its voice.");
    // The slot keeps the call with the Dot even after it is renamed.
    expect(call.combinedPrompt).toContain('space_ask_dot (dot: "2")');
    const unnumbered = await buildLiveSessionContext({ model: "gpt-live-1", timeZone: "UTC", calledDot: { name: "Nova", slot: null } });
    expect(unnumbered.combinedPrompt).toContain('space_ask_dot (dot: "Nova")');
  });

  it("does not recreate deleted personal facts or an assumed location", async () => {
    const context = await buildLiveSessionContext({ model: "gpt-live-1", personalMemories: [], timeZone: "UTC" });
    expect(context.userName).toBe("");
    expect(context.combinedPrompt).not.toContain("Νικόλας");
    expect(context.combinedPrompt).not.toContain("Asia/Bangkok");
  });

  it("describes every advertised tool and parameter without mutating their shared definitions", async () => {
    const context = await buildLiveSessionContext({ model: "gpt-live-1" });
    expect(context.tools.some(tool => tool.name === "space_debug")).toBe(false);
    const check = (schema: any) => {
      for (const value of Object.values(schema?.properties ?? {}) as any[]) {
        expect(value.description?.trim()).toBeTruthy();
        check(value);
      }
    };
    for (const tool of context.tools) {
      expect(String(tool.description ?? "").trim(), String(tool.name)).not.toBe("");
      check(tool.parameters);
    }
  });

  it("honors disabled MCP and profile-memory settings", async () => {
    const context = await buildLiveSessionContext({ model: "gpt-live-1", enableMcpTools: false, enableProfileMemory: false,
      personalMemories: [{ id: "memory:2", key: "hobby", value: "not-in-this-prompt", category: "profile", createdAt: "", updatedAt: "" }] });
    const coreTools = ["space_save_personal_memory", "space_search_personal_memory", "space_delete_personal_memory",
      "space_search_conversation_history", "space_get_current_time", "space_search_web", "space_fetch_web_page", "space_recall_memory"];
    expect(context.tools.map(tool => String(tool.name)).filter(name => !coreTools.includes(name))).toEqual([]);
    expect(context.combinedPrompt).toContain("Space Control tools are disabled");
    expect(context.combinedPrompt).not.toContain("not-in-this-prompt");
  });

  it("does not let pane edits overwrite another pane or the shared defaults", () => {
    localStorage.setItem("space_live_pane_default", JSON.stringify({ language: "el", voiceModel: "default-model" }));
    saveLivePaneConfig("pane:a", { language: "en", voiceModel: "different-model" });
    expect(loadLivePaneConfig("pane:a").language).toBe("en");
    expect(loadLivePaneConfig("pane:b")).toMatchObject({ language: "el", voiceModel: "default-model" });
  });
});

describe("resolveTargetCliPane", () => {
  const testRoomId = "room:test-target";
  const panes = [
    { id: "pane:old-gemini", title: "Old Gemini", terminalRuntimeId: "cli:gemini", status: "RUNNING", isUnused: false },
    { id: "pane:codex-1", title: "Codex CLI", terminalRuntimeId: "cli:codex", status: "IDLE", isUnused: true },
    { id: "pane:new-gemini", title: "New Gemini", terminalRuntimeId: "cli:gemini", status: "IDLE", isUnused: true }
  ];

  afterEach(() => {
    recentOpenedPanesByRoom.delete(testRoomId);
  });

  it("targets exact paneId when provided", () => {
    const result = resolveTargetCliPane(panes, { paneId: "pane:old-gemini" }, testRoomId);
    expect(result?.id).toBe("pane:old-gemini");
  });

  it("targets latest pane when targetPosition is 'latest'", () => {
    const result = resolveTargetCliPane(panes, { cliType: "gemini", targetPosition: "latest" }, testRoomId);
    expect(result?.id).toBe("pane:new-gemini");
  });

  it("targets latest pane when targetIndex is -1", () => {
    const result = resolveTargetCliPane(panes, { cliType: "gemini", targetIndex: -1 }, testRoomId);
    expect(result?.id).toBe("pane:new-gemini");
  });

  it("targets newly opened pane when recorded recently", () => {
    recordRecentOpenedPanes(testRoomId, [
      { id: "pane:new-gemini", title: "New Gemini", terminalRuntimeId: "cli:gemini", mode: "TERMINAL", timestamp: Date.now() }
    ]);
    const result = resolveTargetCliPane(panes, { cliType: "gemini" }, testRoomId);
    expect(result?.id).toBe("pane:new-gemini");
  });

  it("prefers newly opened pane over older pane even when model passes targetIndex: 1", () => {
    recordRecentOpenedPanes(testRoomId, [
      { id: "pane:new-gemini", title: "New Gemini", terminalRuntimeId: "cli:gemini", mode: "TERMINAL", timestamp: Date.now() }
    ]);
    const result = resolveTargetCliPane(panes, { cliType: "gemini", targetIndex: 1 }, testRoomId);
    expect(result?.id).toBe("pane:new-gemini");
  });

  it("preserves an explicit busy target instead of changing another pane", () => {
    const result = resolveTargetCliPane(panes, { cliType: "gemini", targetIndex: 1 }, testRoomId, true);
    expect(result?.id).toBe("pane:old-gemini");
    expect(result?.status).toBe("RUNNING");
  });

  it("rejects missing, out-of-range and ambiguous targets", () => {
    expect(resolveTargetCliPane(panes, { paneId: "pane:missing" }, testRoomId)).toBeNull();
    expect(resolveTargetCliPane(panes, { cliType: "claude" }, testRoomId)).toBeNull();
    expect(resolveTargetCliPane(panes, { targetIndex: 9 }, testRoomId)).toBeNull();
    expect(resolveTargetCliPane(panes, { cliType: "gemini" }, testRoomId)).toBeNull();
  });

  it("filters correctly by cliType", () => {
    const result = resolveTargetCliPane(panes, { cliType: "codex" }, testRoomId);
    expect(result?.id).toBe("pane:codex-1");
  });
});
