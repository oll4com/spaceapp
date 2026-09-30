import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Reasonix sessions the CLI can still resume natively.
 *
 * The CLI writes new sessions into its linear/v4 store
 * (`~/.reasonix/projects/<key>/sessions-v4/<32hex>/`), while its own resume
 * resolver (`--resume <ref>`, the resume picker and `session list`) only
 * enumerates the legacy JSONL store (`.../sessions/<name>.jsonl`). A session is
 * therefore only resumable while a legacy JSONL file exists for it - that path
 * (or a `session_*` machine id) is the only accepted ref today.
 */
export const reasonixNativeSessionRefPattern =
  /^(?:\/home\/spaceapp-user\/\.reasonix\/projects\/[A-Za-z0-9._-]+\/sessions\/[A-Za-z0-9._-]+\.jsonl|session_[0-9a-f]{32})$/u;

export const reasonixSessionIndexCommand = "/opt/spaceapp/bin/deepseek-vscode-parity";
export const reasonixSessionIndexTimeoutMs = 15_000;
const reasonixSessionIndexMaxBytes = 512 * 1024;
const reasonixSessionIndexMaxSessions = 200;
const reasonixSessionIdMaxChars = 128;
const reasonixPreviewMaxChars = 240;
const reasonixPromptMatchMinChars = 24;
const reasonixPromptCompareChars = 80;
const reasonixRecencyWindowMs = 30 * 60_000;
const reasonixRecencyLookbackMs = 60_000;
const reasonixPromptMaxChars = 512;

export type ReasonixSessionIndexEntry = {
  sessionId: string;
  store: string;
  resumableRef: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  model: string | null;
  turns: number;
  preview: string;
  logBytes: number;
};

type ExecResult = { stdout: string | Buffer };
type ExecImpl = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>
) => Promise<ExecResult>;

export type ReadReasonixSessionIndexInput = {
  workspace: string;
  command?: string;
  sudoPath?: string;
  runAsUser?: string;
  timeoutMs?: number;
  execImpl?: ExecImpl;
};

export type ResolveReasonixNativeSessionInput = ReadReasonixSessionIndexInput & {
  firstUserMessage?: string | null;
  paneStartedAtMs?: number | null;
  recencyWindowMs?: number;
};

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function isoOrNull(value: unknown): string | null {
  const text = boundedString(value, 64);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseEntry(value: unknown): ReasonixSessionIndexEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sessionId = boundedString(record.sessionId, reasonixSessionIdMaxChars);
  if (!sessionId) return null;
  const resumableRef = boundedString(record.resumableRef, 512);
  return {
    sessionId,
    store: boundedString(record.store, 32) ?? "unknown",
    resumableRef:
      resumableRef && reasonixNativeSessionRefPattern.test(resumableRef) ? resumableRef : null,
    createdAt: isoOrNull(record.createdAt),
    updatedAt: isoOrNull(record.updatedAt),
    model: boundedString(record.model, 160),
    turns: Number.isSafeInteger(record.turns) ? (record.turns as number) : 0,
    preview: boundedString(record.preview, reasonixPreviewMaxChars) ?? "",
    logBytes: Number.isSafeInteger(record.logBytes) ? (record.logBytes as number) : 0
  };
}

/** Parses the pane-side index; malformed input yields no sessions instead of throwing. */
export function parseReasonixSessionIndex(text: string): ReasonixSessionIndexEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const index = parsed as { version?: unknown; sessions?: unknown };
  if (index.version !== 1 || !Array.isArray(index.sessions)) return [];
  return index.sessions
    .slice(0, reasonixSessionIndexMaxSessions)
    .map(parseEntry)
    .filter((entry): entry is ReasonixSessionIndexEntry => entry !== null);
}

/** Reads the CLI's own session index through the pane-side parity wrapper (runs as spaceapp-user). */
export async function readReasonixSessionIndex(
  input: ReadReasonixSessionIndexInput
): Promise<ReasonixSessionIndexEntry[]> {
  const command = input.command ?? reasonixSessionIndexCommand;
  const sudoPath = input.sudoPath ?? "/usr/bin/sudo";
  const runAsUser = input.runAsUser ?? "spaceapp-user";
  const exec = input.execImpl ?? (execFileAsync as unknown as ExecImpl);
  try {
    const result = await exec(
      sudoPath,
      ["-n", "-u", runAsUser, "--", command, "--run-inner", "sessions"],
      {
        encoding: "utf8",
        timeout: input.timeoutMs ?? reasonixSessionIndexTimeoutMs,
        maxBuffer: reasonixSessionIndexMaxBytes,
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
          SPACE_CLI_WORKSPACE: input.workspace
        }
      }
    );
    return parseReasonixSessionIndex(String(result.stdout ?? ""));
  } catch {
    return [];
  }
}

const reasonixPromptLeadLabelPattern = /^(?:\[(?:image|screenshot|file|video)\s*#\d+\]\s*)+/iu;

/** Normalizes a pane prompt/session preview for tolerant comparison (labels, case, accents, spacing). */
export function normalizeReasonixPrompt(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text
    .replace(reasonixPromptLeadLabelPattern, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, reasonixPromptMaxChars);
}

function newestByCreatedAt(
  entries: readonly ReasonixSessionIndexEntry[]
): ReasonixSessionIndexEntry | null {
  let newest: ReasonixSessionIndexEntry | null = null;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const time = Date.parse(entry.createdAt ?? "");
    if (!Number.isFinite(time)) continue;
    if (time > newestTime) {
      newest = entry;
      newestTime = time;
    }
  }
  return newest ?? entries[0] ?? null;
}

/**
 * Picks the resumable ref of the session that belongs to a pane: an explicit
 * first-user-message match wins, otherwise a bounded recency match around the
 * pane's start. Returns null when nothing can be proven (callers then fall back
 * to Space's transcript replay).
 */
export function matchReasonixNativeSession(input: {
  sessions: readonly ReasonixSessionIndexEntry[];
  firstUserMessage?: string | null;
  paneStartedAtMs?: number | null;
  recencyWindowMs?: number;
}): string | null {
  const candidates = input.sessions.filter(
    (entry): entry is ReasonixSessionIndexEntry & { resumableRef: string } =>
      typeof entry.resumableRef === "string" && reasonixNativeSessionRefPattern.test(entry.resumableRef)
  );
  if (candidates.length === 0) return null;

  const prompt = normalizeReasonixPrompt(input.firstUserMessage);
  if (prompt.length >= reasonixPromptMatchMinChars) {
    const promptHead = prompt.slice(0, reasonixPromptCompareChars);
    const matches = candidates.filter((entry) => {
      const preview = normalizeReasonixPrompt(entry.preview);
      if (!preview) return false;
      const previewHead = preview.slice(0, reasonixPromptCompareChars);
      const sharedChars = Math.min(previewHead.length, promptHead.length);
      return (
        sharedChars >= reasonixPromptMatchMinChars &&
        previewHead.slice(0, sharedChars) === promptHead.slice(0, sharedChars)
      );
    });
    const matched = newestByCreatedAt(matches);
    if (matched?.resumableRef) return matched.resumableRef;
  }

  const startedAt = input.paneStartedAtMs;
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
    const window = input.recencyWindowMs ?? reasonixRecencyWindowMs;
    const inWindow = candidates.filter((entry) => {
      const created = Date.parse(entry.createdAt ?? "");
      if (!Number.isFinite(created)) return false;
      return created >= startedAt - reasonixRecencyLookbackMs && created <= startedAt + window;
    });
    const matched = newestByCreatedAt(inWindow);
    if (matched?.resumableRef) return matched.resumableRef;
  }

  return null;
}

/** Resolves the exact native resume ref for a DeepSeek pane, or null when it cannot be proven. */
export async function resolveReasonixNativeSessionRef(
  input: ResolveReasonixNativeSessionInput
): Promise<string | null> {
  const sessions = await readReasonixSessionIndex(input);
  return matchReasonixNativeSession({
    sessions,
    firstUserMessage: input.firstUserMessage,
    paneStartedAtMs: input.paneStartedAtMs,
    recencyWindowMs: input.recencyWindowMs
  });
}
