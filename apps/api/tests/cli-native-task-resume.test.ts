import { describe, expect, it, vi } from "vitest";
import {
  hasExactNativeTaskResume,
  resolveNativeTaskResume,
  type NativeTaskResumeContext,
  type NativeTaskResumeDependencies
} from "../src/cli-native-task-resume.js";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import { copilotNativeSessionId, cursorNativeSessionId, grokNativeSessionId, qoderNativeSessionId } from "../src/qoder-native-session.js";

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
  it("keeps the runtimes that resolved an exact task before the registry, plus OpenCode, Qwen, omp, Muse, Hermes and Kimi", () => {
    expect(cliRuntimeDescriptors.map(item => item.id).filter(hasExactNativeTaskResume).sort())
      .toEqual(["cli:autohand", "cli:claude", "cli:copilot", "cli:cursor", "cli:deepseek", "cli:droid", "cli:gemini", "cli:grok", "cli:hermes", "cli:kimi", "cli:muse", "cli:omp", "cli:opencode", "cli:qoder", "cli:qwen"]);
    // Codex keeps its explicit thread-claim path in the resume handler.
    expect(hasExactNativeTaskResume("cli:codex")).toBe(false);
  });

  it("uses only Autohand's complete recorded native id, never a prefix, path or newest session", async () => {
    const id = `${uuid}-1793700000000`;
    expect(await resolveNativeTaskResume("cli:autohand", context("cli:autohand", id), dependencies()))
      .toMatchObject({ ref: id, persistAsNativeTaskRef: true });
    for (const invalid of [null, uuid, "../session", `${id} --continue`]) {
      expect(await resolveNativeTaskResume("cli:autohand", context("cli:autohand", invalid), dependencies())).toBeNull();
    }
  });

  it("never resolves a task recorded by another runtime", async () => {
    const deps = dependencies({ readGeminiPaneConversation: vi.fn(async () => uuid) });
    expect(await resolveNativeTaskResume("cli:gemini", context("cli:claude", uuid), deps)).toBeNull();
    expect(deps.readGeminiPaneConversation).not.toHaveBeenCalled();
    expect(await resolveNativeTaskResume("cli:hermes", context("cli:hermes", uuid), deps)).toBeNull();
    const hermesId = `local-${"c".repeat(64)}`;
    expect((await resolveNativeTaskResume("cli:hermes", context("cli:hermes", hermesId), deps))?.ref).toBe(hermesId);
    expect(await resolveNativeTaskResume("cli:kimi", context("cli:kimi", uuid), deps)).toBeNull();
    expect((await resolveNativeTaskResume("cli:kimi", context("cli:kimi", `session_${uuid}`), deps))?.ref).toBe(`session_${uuid}`);
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

  // EXT-G-6 (2/11): the recorded ref is what carries the id into SPACE_GEMINI_CONVERSATION_ID; the pane file alone is not enough on dev.
  it("records Gemini's conversation as the task reference and still writes the pane conversation", async () => {
    const deps = dependencies({ readGeminiPaneConversation: vi.fn(async () => uuid) });
    const resolved = await resolveNativeTaskResume("cli:gemini", context("cli:gemini", null), deps);
    expect(resolved).toMatchObject({ ref: uuid, persistAsNativeTaskRef: true, auditMetadata: {} });
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

  it.each(["cli:qwen", "cli:droid"])("accepts only a recorded lowercase %s session id", async runtimeId => {
    expect((await resolveNativeTaskResume(runtimeId, context(runtimeId, uuid), dependencies()))?.ref).toBe(uuid);
    expect(await resolveNativeTaskResume(runtimeId, context(runtimeId, uuid.toUpperCase()), dependencies())).toBeNull();
    expect(await resolveNativeTaskResume(runtimeId, context(runtimeId, `${uuid} --yolo`), dependencies())).toBeNull();
    expect(await resolveNativeTaskResume(runtimeId, context(runtimeId, null), dependencies())).toBeNull();
  });

  it("names the Qoder session from the record or the Space session id", async () => {
    expect((await resolveNativeTaskResume("cli:qoder", context("cli:qoder", uuid), dependencies()))?.ref).toBe(uuid);
    expect((await resolveNativeTaskResume("cli:qoder", context("cli:qoder", null), dependencies()))?.ref)
      .toBe(qoderNativeSessionId("cli_session:source01"));
  });

  it("names the Copilot session from the record or the Space session id, never Qoder's (ADAPTER-006)", async () => {
    expect((await resolveNativeTaskResume("cli:copilot", context("cli:copilot", uuid), dependencies()))?.ref).toBe(uuid);
    const derived = (await resolveNativeTaskResume("cli:copilot", context("cli:copilot", null), dependencies()))?.ref;
    expect(derived).toBe(copilotNativeSessionId("cli_session:source01"));
    expect(derived).not.toBe(qoderNativeSessionId("cli_session:source01"));
  });

  it("names the Grok session from the record or the Space session id, its own derivation (ADAPTER-006)", async () => {
    expect((await resolveNativeTaskResume("cli:grok", context("cli:grok", uuid), dependencies()))?.ref).toBe(uuid);
    const derived = (await resolveNativeTaskResume("cli:grok", context("cli:grok", null), dependencies()))?.ref;
    expect(derived).toBe(grokNativeSessionId("cli_session:source01"));
    expect(derived).not.toBe(copilotNativeSessionId("cli_session:source01"));
    expect(derived).not.toBe(qoderNativeSessionId("cli_session:source01"));
  });

  it("names the Cursor chat from the record or the Space session id, its own derivation (ADAPTER-006)", async () => {
    expect((await resolveNativeTaskResume("cli:cursor", context("cli:cursor", uuid), dependencies()))?.ref).toBe(uuid);
    const derived = (await resolveNativeTaskResume("cli:cursor", context("cli:cursor", null), dependencies()))?.ref;
    expect(derived).toBe(cursorNativeSessionId("cli_session:source01"));
    expect(derived).not.toBe(grokNativeSessionId("cli_session:source01"));
    expect(derived).not.toBe(copilotNativeSessionId("cli_session:source01"));
  });
});
