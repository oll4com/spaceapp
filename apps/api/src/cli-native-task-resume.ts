import { claudeNativeSessionIdPattern } from "./claude-native-turns.js";
import {
  geminiNativeConversationIdPattern,
  readGeminiPaneConversation,
  writeGeminiPaneConversation
} from "./gemini-native-session.js";
import { opencodeNativeSessionIdPattern, readOpenCodeNativeSessionId } from "./opencode-native-session.js";
import { qoderNativeSessionId, qoderNativeSessionIdPattern } from "./qoder-native-session.js";
import { resolveReasonixNativeSessionRef } from "./reasonix-native-session.js";
import { qwenNativeSessionIdPattern } from "./task-title-native.js";
import type { ResolvedSpaceCliTask } from "./unified-cli-task-registry.js";

/**
 * Exact native task resume from Space task history, per runtime. The central
 * resume handler asks this registry for the recorded reference instead of
 * branching on runtime ids, so a provider gains exact task-history resume by
 * registering a resolver here (with its buildCliSpawnArgs branch and launch-gate
 * admission) and no new branch in apps/api/src/app.ts.
 *
 * Codex is deliberately absent: its thread references carry Space-owned thread
 * claims and history attachment (claimPaneCliCodexThread,
 * codexHistoryAccessCoordinator) that no other runtime has.
 */
export interface NativeTaskResumeContext {
  sourceTask: Pick<ResolvedSpaceCliTask, "runtimeId" | "firstUserMessage"> & {
    revision: Pick<ResolvedSpaceCliTask["revision"], "nativeTaskRef" | "cwd">;
    session: Pick<ResolvedSpaceCliTask["session"], "sessionId">;
  };
  pane: { id: string; cwd: string | null };
}

export interface NativeTaskResume {
  /** The recorded reference a RESUME launch passes to the CLI. */
  ref: string;
  /** Whether the new revision records the reference as its nativeTaskRef. */
  persistAsNativeTaskRef: boolean;
  /** Runtime-owned state written once the replacement session is allocated. */
  afterAllocate: ((paneId: string) => Promise<void>) | null;
  /** Extra audit metadata, kept identical to the earlier per-runtime audit fields. */
  auditMetadata: Readonly<Record<string, string>>;
}

export interface NativeTaskResumeDependencies {
  readGeminiPaneConversation: (paneId: string) => Promise<string | null>;
  writeGeminiPaneConversation: (paneId: string, conversationId: string) => Promise<void>;
  readOpenCodeNativeSessionId: (spaceSessionId: string) => Promise<string | null>;
  resolveReasonixNativeSessionRef: (input: { workspace: string; firstUserMessage: string | null }) => Promise<string | null>;
  /** Dev shares stable's OpenCode server: its copied task refs and mapping files can name a stable pane's session. */
  devInstance: boolean;
}

const defaultDependencies: NativeTaskResumeDependencies = {
  readGeminiPaneConversation: (paneId) => readGeminiPaneConversation(paneId),
  writeGeminiPaneConversation,
  readOpenCodeNativeSessionId: (spaceSessionId) => readOpenCodeNativeSessionId(spaceSessionId),
  resolveReasonixNativeSessionRef: (input) => resolveReasonixNativeSessionRef(input),
  devInstance: process.env.SPACE_INSTANCE === "dev"
};

type Resolver = (context: NativeTaskResumeContext, dependencies: NativeTaskResumeDependencies) => Promise<NativeTaskResume | null>;

function recorded(ref: string | null): NativeTaskResume | null {
  return ref ? { ref, persistAsNativeTaskRef: true, afterAllocate: null, auditMetadata: {} } : null;
}

function matching(pattern: RegExp, value: string | null | undefined): string | null {
  return value && pattern.test(value) ? value : null;
}

const resolvers: Readonly<Record<string, Resolver>> = {
  "cli:opencode": async ({ sourceTask }, dependencies) => {
    if (dependencies.devInstance) return null;
    const ref = matching(opencodeNativeSessionIdPattern, sourceTask.revision.nativeTaskRef)
      ?? await dependencies.readOpenCodeNativeSessionId(sourceTask.session.sessionId);
    return ref ? { ...recorded(ref)!, auditMetadata: { opencodeNativeSessionId: ref } } : null;
  },
  // The launch passes `--continue`; the wrapper steers it to the pane's recorded conversation.
  "cli:gemini": async ({ sourceTask, pane }, dependencies) => {
    const ref = matching(geminiNativeConversationIdPattern, sourceTask.revision.nativeTaskRef)
      ?? await dependencies.readGeminiPaneConversation(pane.id);
    return ref
      ? {
          ref,
          persistAsNativeTaskRef: false,
          afterAllocate: (paneId) => dependencies.writeGeminiPaneConversation(paneId, ref),
          auditMetadata: {}
        }
      : null;
  },
  "cli:deepseek": async ({ sourceTask, pane }, dependencies) => recorded(
    await dependencies.resolveReasonixNativeSessionRef({
      workspace: sourceTask.revision.cwd ?? pane.cwd ?? "/etc",
      firstUserMessage: sourceTask.firstUserMessage
    }).catch(() => null)
  ),
  "cli:claude": async ({ sourceTask }) => recorded(matching(claudeNativeSessionIdPattern, sourceTask.revision.nativeTaskRef)),
  // The metadata bridge records the session it bound to the pane's Qwen process; without one,
  // the launch falls back to Qwen's provider-selection `--continue`.
  "cli:qwen": async ({ sourceTask }) => recorded(matching(qwenNativeSessionIdPattern, sourceTask.revision.nativeTaskRef)),
  // Qoder runs each Space session under a Space-named session id (qoder-native-session.ts).
  "cli:qoder": async ({ sourceTask }) => recorded(
    matching(qoderNativeSessionIdPattern, sourceTask.revision.nativeTaskRef) ?? qoderNativeSessionId(sourceTask.session.sessionId)
  )
};

/** Runtimes (besides Codex) whose task-history resume can reach an exact native task. */
export function hasExactNativeTaskResume(runtimeId: string): boolean {
  return Object.hasOwn(resolvers, runtimeId);
}

/** The recorded native reference for resuming `sourceTask` in `targetRuntimeId`, or null. */
export async function resolveNativeTaskResume(
  targetRuntimeId: string,
  context: NativeTaskResumeContext,
  dependencies: NativeTaskResumeDependencies = defaultDependencies
): Promise<NativeTaskResume | null> {
  if (context.sourceTask.runtimeId !== targetRuntimeId || !hasExactNativeTaskResume(targetRuntimeId)) return null;
  return resolvers[targetRuntimeId]!(context, dependencies);
}
