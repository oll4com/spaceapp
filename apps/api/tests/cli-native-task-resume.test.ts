import { describe, expect, it, vi } from "vitest";
import {
  hasExactNativeTaskResume,
  resolveNativeTaskResume,
  type NativeTaskResumeContext,
  type NativeTaskResumeDependencies
} from "../src/cli-native-task-resume.js";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { qoderNativeSessionId } from "../src/qoder-native-session.js";

const uuid = "85de09e6-3d1f-4e13-9173-142a9e9a36cf";

function context(runtimeId: string, nativeTaskRef: string | null, cwd: string | null = "/opt/spaceapp/projects/a"): NativeTaskResumeContext {
  return {
    sourceTask: {
      runtimeId,
      firstUserMessage: "Refactor the parser",
      revision: { nativeTaskRef, cwd },
      session: { sessionId: "cli_session:source01" }
    },
    pane: { id: "pane:target01", cwd: "/etc" }
  };
}

function dependencies(overrides: Partial<NativeTaskResumeDependencies> = {}): NativeTaskResumeDependencies {
  return {
    readGeminiPaneConversation: vi.fn(async () => null),
    writeGeminiPaneConversation: vi.fn(async () => undefined),
    readOpenCodeNativeSessionId: vi.fn(async () => null),
    resolveReasonixNativeSessionRef: vi.fn(async () => null),
    devInstance: false,
    ...overrides
  };
}

describe("native task-history resume registry", () => {
  it("keeps the runtimes that resolved an exact task before the registry, plus OpenCode and Qwen", () => {
    expect(cliRuntimeDescriptors.map(item => item.id).filter(hasExactNativeTaskResume).sort())
      .toEqual(["cli:claude", "cli:deepseek", "cli:gemini", "cli:opencode", "cli:qoder", "cli:qwen"]);
    // Codex keeps its explicit thread-claim path in the resume handler.
    expect(hasExactNativeTaskResume("cli:codex")).toBe(false);
  });

  it("never resolves a task recorded by another runtime", async () => {
    const deps = dependencies({ readGeminiPaneConversation: vi.fn(async () => uuid) });
    expect(await resolveNativeTaskResume("cli:gemini", context("cli:claude", uuid), deps)).toBeNull();
    expect(deps.readGeminiPaneConversation).not.toHaveBeenCalled();
    expect(await resolveNativeTaskResume("cli:hermes", context("cli:hermes", uuid), deps)).toBeNull();
    expect(await resolveNativeTaskResume("cli:kimi", context("cli:kimi", uuid), deps)).toBeNull();
  });

  it("uses the recorded OpenCode session, then the Space session mapping, and audits it", async () => {
    const recorded = await resolveNativeTaskResume("cli:opencode", context("cli:opencode", "ses_recorded1"), dependencies());
    expect(recorded).toEqual({ ref: "ses_recorded1", persistAsNativeTaskRef: true, afterAllocate: null,
      auditMetadata: { opencodeNativeSessionId: "ses_recorded1" } });
    const deps = dependencies({ readOpenCodeNativeSessionId: vi.fn(async () => "ses_mapped1") });
    expect((await resolveNativeTaskResume("cli:opencode", context("cli:opencode", "not-a-session"), deps))?.ref).toBe("ses_mapped1");
    expect(deps.readOpenCodeNativeSessionId).toHaveBeenCalledWith("cli_session:source01");
    expect(await resolveNativeTaskResume("cli:opencode", context("cli:opencode", null), dependencies())).toBeNull();
  });

  it("never resolves an OpenCode session on dev, whose copied tasks and mapping files can name a stable pane's", async () => {
    const deps = dependencies({ devInstance: true, readOpenCodeNativeSessionId: vi.fn(async () => "ses_mapped1") });
    expect(await resolveNativeTaskResume("cli:opencode", context("cli:opencode", "ses_recorded1"), deps)).toBeNull();
    expect(deps.readOpenCodeNativeSessionId).not.toHaveBeenCalled();
  });

  it("steers Gemini through the pane conversation without recording a task reference", async () => {
    const deps = dependencies({ readGeminiPaneConversation: vi.fn(async () => uuid) });
    const resolved = await resolveNativeTaskResume("cli:gemini", context("cli:gemini", null), deps);
    expect(resolved).toMatchObject({ ref: uuid, persistAsNativeTaskRef: false, auditMetadata: {} });
    expect(deps.readGeminiPaneConversation).toHaveBeenCalledWith("pane:target01");
    await resolved!.afterAllocate!("pane:target01");
    expect(deps.writeGeminiPaneConversation).toHaveBeenCalledWith("pane:target01", uuid);
    expect((await resolveNativeTaskResume("cli:gemini", context("cli:gemini", uuid), dependencies()))?.ref).toBe(uuid);
    expect(await resolveNativeTaskResume("cli:gemini", context("cli:gemini", null), dependencies())).toBeNull();
  });

  it("matches DeepSeek through the Reasonix session index and fails closed on errors", async () => {
    const ref = `session_${"b".repeat(32)}`;
    const deps = dependencies({ resolveReasonixNativeSessionRef: vi.fn(async () => ref) });
    expect((await resolveNativeTaskResume("cli:deepseek", context("cli:deepseek", null), deps))?.ref).toBe(ref);
    expect(deps.resolveReasonixNativeSessionRef).toHaveBeenCalledWith({ workspace: "/opt/spaceapp/projects/a", firstUserMessage: "Refactor the parser" });
    await resolveNativeTaskResume("cli:deepseek", context("cli:deepseek", null, null), deps);
    expect(deps.resolveReasonixNativeSessionRef).toHaveBeenLastCalledWith({ workspace: "/etc", firstUserMessage: "Refactor the parser" });
    const failing = dependencies({ resolveReasonixNativeSessionRef: vi.fn(async () => { throw new Error("index unavailable"); }) });
    expect(await resolveNativeTaskResume("cli:deepseek", context("cli:deepseek", null), failing)).toBeNull();
  });

  it("accepts only a recorded Claude session id", async () => {
    expect((await resolveNativeTaskResume("cli:claude", context("cli:claude", uuid), dependencies()))?.ref).toBe(uuid);
    expect(await resolveNativeTaskResume("cli:claude", context("cli:claude", "../x"), dependencies())).toBeNull();
  });

  it("accepts only a recorded lowercase Qwen session id", async () => {
    expect((await resolveNativeTaskResume("cli:qwen", context("cli:qwen", uuid), dependencies()))?.ref).toBe(uuid);
    expect(await resolveNativeTaskResume("cli:qwen", context("cli:qwen", uuid.toUpperCase()), dependencies())).toBeNull();
    expect(await resolveNativeTaskResume("cli:qwen", context("cli:qwen", `${uuid} --yolo`), dependencies())).toBeNull();
    expect(await resolveNativeTaskResume("cli:qwen", context("cli:qwen", null), dependencies())).toBeNull();
  });

  it("names the Qoder session from the record or the Space session id", async () => {
    expect((await resolveNativeTaskResume("cli:qoder", context("cli:qoder", uuid), dependencies()))?.ref).toBe(uuid);
    expect((await resolveNativeTaskResume("cli:qoder", context("cli:qoder", null), dependencies()))?.ref)
      .toBe(qoderNativeSessionId("cli_session:source01"));
  });
});
