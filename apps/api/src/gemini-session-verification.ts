import { readFile, readdir, readlink, stat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  geminiNativeConversationIdPattern,
  normalizeGeminiPaneId,
  readGeminiPaneConversation,
  writeGeminiPaneConversation
} from "./gemini-native-session.js";
import type { Pane, PaneCliSession } from "@space/contracts";

export interface GeminiVerificationEvidence {
  processFound: boolean;
  pid?: number | null;
  cmdlineModel?: string | null;
  cmdlineEffort?: string | null;
  logFile?: string | null;
  logEmail?: string | null;
  logModelLabel?: string | null;
  screenModelId?: string | null;
  accountSource: "process_env" | "cli_log" | "session_store" | "unverified" | "unknown";
  modelSource: "cli_log" | "screen" | "cmdline" | "transcript" | "session_store" | "unknown";
  accountVerified: boolean;
  modelVerified: boolean;
  staleMetadata?: boolean;
  details: string;
}

export interface GeminiPaneVerification {
  paneId: string;
  sessionId: string | null;
  pid: number | null;
  nativeTaskRef: string | null;
  configuredModelId: string | null;
  effectiveModelId: string | null;
  liveModelLabel: string | null;
  modelVerificationStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  configuredAccountProfileId: string | null;
  liveAccountProfileId: string | null;
  accountProfileId: string | null;
  accountEmail: string | null;
  accountVerificationStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  verificationEvidence: GeminiVerificationEvidence;
}

const geminiConversationPattern = /(?:presence|conversations)\/([0-9a-fA-F-]{36})\.(?:lock|db)/;
const geminiLogFilePattern = /(?:^|\/)cli-[0-9]{8}_[0-9]{6}\.log$/;

export function mapGeminiModelLabelToId(
  label: string | null | undefined,
  catalog?: Array<{ id: string; displayName: string }>
): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;

  if (catalog && catalog.length > 0) {
    const direct = catalog.find(
      (m) =>
        m.id.toLowerCase() === trimmed.toLowerCase() ||
        m.displayName.toLowerCase() === trimmed.toLowerCase()
    );
    if (direct) return direct.id;
  }

  // Common Antigravity / Gemini model mappings
  const lower = trimmed.toLowerCase();
  if (lower.includes("gemini 3.8 flash")) {
    if (lower.includes("high")) return "gemini-3.8-flash-high";
    if (lower.includes("low")) return "gemini-3.8-flash-low";
    return "gemini-3.8-flash-medium";
  }
  if (lower.includes("gemini 3.7 flash")) {
    if (lower.includes("high")) return "gemini-3.7-flash-high";
    if (lower.includes("low")) return "gemini-3.7-flash-low";
    return "gemini-3.7-flash-medium";
  }
  if (lower.includes("gemini 3.6 flash")) {
    if (lower.includes("high")) return "gemini-3.6-flash-high";
    if (lower.includes("low")) return "gemini-3.6-flash-low";
    return "gemini-3.6-flash-medium";
  }
  if (lower.includes("gemini 3.1 pro")) {
    if (lower.includes("low")) return "gemini-3.1-pro-low";
    return "gemini-3.1-pro-high";
  }
  if (lower.includes("claude opus 4.6")) return "claude-opus-4-6-thinking";
  if (lower.includes("claude sonnet 4.6")) return "claude-sonnet-4-6";
  if (lower.includes("gpt-oss 120b")) return "gpt-oss-120b-medium";

  // If already formatted like a model ID (allowing dots and hyphens)
  if (/^[a-z0-9]+([.-][a-z0-9]+)*$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface ProcessInfo {
  pid: number;
  home?: string;
  accountProfile?: string;
  paneId?: string;
  sessionId?: string;
  cmdline: string[];
  conversationId?: string;
  logFile?: string;
}

export async function readProcEnviron(pid: number, procRoot = "/proc"): Promise<Record<string, string>> {
  try {
    const envBuf = await readFile(join(procRoot, String(pid), "environ"));
    const entries = envBuf.toString().split("\0");
    const result: Record<string, string> = {};
    for (const entry of entries) {
      const idx = entry.indexOf("=");
      if (idx > 0) {
        result[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function readProcCmdline(pid: number, procRoot = "/proc"): Promise<string[]> {
  try {
    const buf = await readFile(join(procRoot, String(pid), "cmdline"));
    return buf.toString().split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

export async function inspectProcessFds(
  pid: number,
  procRoot = "/proc"
): Promise<{ conversationId?: string; logFile?: string }> {
  const result: { conversationId?: string; logFile?: string } = {};
  try {
    const fds = await readdir(join(procRoot, String(pid), "fd"));
    for (const fd of fds) {
      try {
        const target = await readlink(join(procRoot, String(pid), "fd", fd));
        if (!result.conversationId) {
          const match = target.match(geminiConversationPattern);
          if (match?.[1] && geminiNativeConversationIdPattern.test(match[1])) {
            result.conversationId = match[1];
          }
        }
        if (!result.logFile && geminiLogFilePattern.test(target)) {
          result.logFile = target;
        }
      } catch {}
    }
  } catch {}
  return result;
}

export async function readLogTail(filePath: string, maxBytes = 131072): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    const size = fileStat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const fh = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await fh.read(buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

export function parseLogEvidence(logContent: string): { email: string | null; modelLabel: string | null } {
  let email: string | null = null;
  let modelLabel: string | null = null;

  if (logContent) {
    const emailMatches = [
      ...logContent.matchAll(
        /(?:email=([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|authenticated successfully as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|authenticated as ([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}))/g
      )
    ];
    if (emailMatches.length > 0) {
      const last = emailMatches[emailMatches.length - 1]!;
      email = last[1] || last[2] || last[3] || null;
    }

    const modelMatches = [
      ...logContent.matchAll(
        /(?:Propagating selected model override to backend: label="([^"]+)"|Resolving model ([^\n\r]+))/g
      )
    ];
    if (modelMatches.length > 0) {
      const last = modelMatches[modelMatches.length - 1]!;
      modelLabel = (last[1] || last[2] || "").trim() || null;
    }
  }

  return { email, modelLabel };
}

export function parseAccountProfileFromHome(homePath?: string | null): string | null {
  if (!homePath) return null;
  const matchProfile = homePath.match(/space-gemini\/profiles\/([a-zA-Z0-9_-]+)\/home/);
  if (matchProfile?.[1]) return matchProfile[1];
  if (homePath.endsWith("space-gemini/home") || homePath.includes("space-gemini/home/")) return "main";
  return null;
}

export async function findGeminiProcessTree(
  rootPid: number,
  procRoot = "/proc"
): Promise<ProcessInfo | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  const pending = [rootPid];
  const visited = new Set<number>();

  let bestProc: ProcessInfo | null = null;

  while (pending.length > 0 && visited.size < 256) {
    const pid = pending.shift();
    if (!pid || visited.has(pid)) continue;
    visited.add(pid);

    const env = await readProcEnviron(pid, procRoot);
    const cmdline = await readProcCmdline(pid, procRoot);
    const fds = await inspectProcessFds(pid, procRoot);

    const home = env.HOME;
    const accountProfile = env.SPACE_GEMINI_ACCOUNT_PROFILE || parseAccountProfileFromHome(home) || undefined;
    const paneId = env.SPACE_PANE_ID;
    const sessionId = env.SPACE_CLI_SESSION_ID;

    const isAgy = cmdline.some((arg) => arg.includes("agy"));
    if (isAgy || fds.conversationId || fds.logFile || accountProfile) {
      bestProc = {
        pid,
        home,
        accountProfile,
        paneId,
        sessionId,
        cmdline,
        conversationId: fds.conversationId,
        logFile: fds.logFile
      };
      if (fds.conversationId && fds.logFile && isAgy) {
        return bestProc;
      }
    }

    try {
      const taskIds = (await readdir(join(procRoot, String(pid), "task"))).slice(0, 64);
      for (const taskId of taskIds) {
        const children = (
          await readFile(join(procRoot, String(pid), "task", taskId, "children"), "utf8").catch(() => "")
        )
          .trim()
          .split(/\s+/)
          .map((v) => Number.parseInt(v, 10))
          .filter((v) => Number.isSafeInteger(v) && v > 0);
        pending.push(...children);
      }
    } catch {}
  }

  return bestProc;
}

export async function readPaneStateRecord(cleanPaneId: string): Promise<{
  conversationId?: string;
  sessionId?: string;
  paneId?: string;
  accountProfile?: string;
  home?: string;
  logFile?: string;
  pid?: number;
} | null> {
  for (const filename of [
    `/opt/spaceapp/var/gemini-pane-conversations/pane-${cleanPaneId}.json`,
    `/opt/spaceapp/var/gemini-pane-conversations/pane-pane:${cleanPaneId}.json`
  ]) {
    try {
      const raw = await readFile(filename, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

export async function findLatestLogForHome(homePath?: string | null): Promise<string | null> {
  if (!homePath) return null;
  const logDir = join(homePath, ".gemini", "antigravity-cli", "log");
  try {
    const entries = await readdir(logDir);
    const logFiles = entries.filter((f) => geminiLogFilePattern.test(f)).sort().reverse();
    if (logFiles.length > 0) {
      return join(logDir, logFiles[0]!);
    }
  } catch {}
  return null;
}

export async function scanForPaneGeminiProcess(
  cleanPaneId: string,
  targetSessionId?: string | null,
  procRoot = "/proc"
): Promise<ProcessInfo | null> {
  // 1. Try reading the pane state recorded by gemini-vscode-parity
  const stateRecord = await readPaneStateRecord(cleanPaneId);
  if (stateRecord?.pid) {
    const pid = stateRecord.pid;
    const isAlive = await stat(join(procRoot, String(pid))).then((s) => s.isDirectory()).catch(() => false);
    if (isAlive) {
      const cmdline = await readProcCmdline(pid, procRoot);
      const logFile = stateRecord.logFile || (await findLatestLogForHome(stateRecord.home));
      return {
        pid,
        home: stateRecord.home,
        accountProfile: stateRecord.accountProfile,
        paneId: stateRecord.paneId,
        sessionId: stateRecord.sessionId,
        cmdline,
        conversationId: stateRecord.conversationId,
        logFile: logFile ?? undefined
      };
    }
  }

  // 2. Scan /proc
  try {
    const entries = await readdir(procRoot);
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      const env = await readProcEnviron(pid, procRoot);
      const rawPaneId = env.SPACE_PANE_ID;
      const rawSessionId = env.SPACE_CLI_SESSION_ID;
      if (!rawPaneId && !rawSessionId) continue;

      const paneMatch = rawPaneId && normalizeGeminiPaneId(rawPaneId) === cleanPaneId;
      const sessionMatch = targetSessionId && rawSessionId === targetSessionId;

      if (paneMatch || sessionMatch) {
        const info = await findGeminiProcessTree(pid, procRoot);
        if (info) return info;
      }
    }
  } catch {}
  return null;
}

export async function verifyGeminiPaneSession(options: {
  pane: Pane;
  session?: PaneCliSession | null;
  rootPid?: number | null;
  screenText?: string | null;
  catalog?: Array<{ id: string; displayName: string }>;
  usageAccounts?: Array<{ id: string; email?: string | null; status?: string; gemini?: unknown }>;
  procRoot?: string;
}): Promise<GeminiPaneVerification> {
  const { pane, session, procRoot = "/proc", catalog = [], usageAccounts = [] } = options;
  const cleanPaneId = normalizeGeminiPaneId(pane.id);
  const configuredModelId = session?.modelId ?? pane.modelId ?? null;
  const configuredAccountProfileId = session?.accountProfileId ?? "main";

  let procInfo: ProcessInfo | null = null;
  if (options.rootPid && options.rootPid > 0) {
    procInfo = await findGeminiProcessTree(options.rootPid, procRoot);
  }
  if (!procInfo) {
    procInfo = await scanForPaneGeminiProcess(cleanPaneId, session?.sessionId, procRoot);
  }

  // Enrich procInfo if missing accountProfile or logFile
  const stateRecord = await readPaneStateRecord(cleanPaneId);
  if (procInfo && stateRecord) {
    if (!procInfo.accountProfile && stateRecord.accountProfile) {
      procInfo.accountProfile = stateRecord.accountProfile;
    }
    if (!procInfo.home && stateRecord.home) {
      procInfo.home = stateRecord.home;
    }
    if (!procInfo.conversationId && stateRecord.conversationId) {
      procInfo.conversationId = stateRecord.conversationId;
    }
    if (!procInfo.logFile && stateRecord.logFile) {
      procInfo.logFile = stateRecord.logFile;
    }
  }

  if (procInfo && !procInfo.accountProfile && session?.accountProfileId) {
    procInfo.accountProfile = session.accountProfileId;
    procInfo.home = session.accountProfileId === "main"
      ? "/var/lib/spaceapp-user/.codex/space-gemini/home"
      : `/var/lib/spaceapp-user/.codex/space-gemini/profiles/${session.accountProfileId}/home`;
  }

  if (procInfo && !procInfo.logFile && procInfo.home) {
    procInfo.logFile = (await findLatestLogForHome(procInfo.home)) ?? undefined;
  }

  // Conversation identification
  let nativeTaskRef: string | null = procInfo?.conversationId ?? null;
  if (!nativeTaskRef) {
    nativeTaskRef = await readGeminiPaneConversation(pane.id).catch(() => null);
  }
  if (!nativeTaskRef && session?.codexThreadId && geminiNativeConversationIdPattern.test(session.codexThreadId)) {
    nativeTaskRef = session.codexThreadId;
  }
  if (nativeTaskRef && geminiNativeConversationIdPattern.test(nativeTaskRef)) {
    void writeGeminiPaneConversation(pane.id, nativeTaskRef).catch(() => {});
  }

  // Account identification & verification
  let liveAccountProfileId: string | null = procInfo?.accountProfile || null;
  if (!liveAccountProfileId && procInfo?.home) {
    liveAccountProfileId = parseAccountProfileFromHome(procInfo.home);
  }

  let accountProfileId: string | null = liveAccountProfileId ?? configuredAccountProfileId;
  let accountEmail: string | null = null;
  let accountVerificationStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN" = "UNKNOWN";
  let accountSource: GeminiVerificationEvidence["accountSource"] = "unknown";
  let staleMetadata = false;

  let logEmail: string | null = null;
  let logModelLabel: string | null = null;

  if (procInfo?.logFile) {
    const logTail = await readLogTail(procInfo.logFile);
    const logEv = parseLogEvidence(logTail);
    logEmail = logEv.email;
    logModelLabel = logEv.modelLabel;
  }

  if (liveAccountProfileId) {
    accountProfileId = liveAccountProfileId;
    accountVerificationStatus = "VERIFIED";
    accountSource = "process_env";
    if (configuredAccountProfileId && configuredAccountProfileId !== liveAccountProfileId) {
      staleMetadata = true;
    }
  } else if (configuredAccountProfileId) {
    accountProfileId = configuredAccountProfileId;
    accountVerificationStatus = "UNVERIFIED";
    accountSource = "session_store";
  } else {
    accountProfileId = null;
    accountVerificationStatus = "UNKNOWN";
    accountSource = "unknown";
  }

  if (logEmail) {
    accountEmail = logEmail;
  } else if (accountProfileId) {
    const matchedUsage = usageAccounts.find((a) => a.id === accountProfileId);
    if (matchedUsage?.email) {
      accountEmail = matchedUsage.email;
    }
  }

  // Model identification & verification
  let cmdlineModel: string | null = null;
  let cmdlineEffort: string | null = null;
  if (procInfo?.cmdline) {
    const mIdx = procInfo.cmdline.indexOf("--model");
    if (mIdx >= 0 && procInfo.cmdline[mIdx + 1]) {
      cmdlineModel = procInfo.cmdline[mIdx + 1]!;
    }
    const eIdx = procInfo.cmdline.indexOf("--effort");
    if (eIdx >= 0 && procInfo.cmdline[eIdx + 1]) {
      cmdlineEffort = procInfo.cmdline[eIdx + 1]!;
    }
  }

  let effectiveModelId: string | null = null;
  let liveModelLabel: string | null = logModelLabel;
  let modelVerificationStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN" = "UNKNOWN";
  let modelSource: GeminiVerificationEvidence["modelSource"] = "unknown";

  if (logModelLabel) {
    const mapped = mapGeminiModelLabelToId(logModelLabel, catalog);
    if (mapped) {
      effectiveModelId = mapped;
      modelVerificationStatus = "VERIFIED";
      modelSource = "cli_log";
    }
  }

  if (!effectiveModelId && cmdlineModel) {
    effectiveModelId = cmdlineModel;
    modelVerificationStatus = "VERIFIED";
    modelSource = "cmdline";
  }

  // Fallback: If no live evidence can be observed
  if (!effectiveModelId) {
    modelVerificationStatus = configuredModelId ? "UNVERIFIED" : "UNKNOWN";
    effectiveModelId = null;
    modelSource = "unknown";
  }

  const detailsParts: string[] = [];
  if (procInfo) {
    detailsParts.push(`Live PID ${procInfo.pid}`);
  } else {
    detailsParts.push("No active CLI process found");
  }

  if (accountVerificationStatus === "VERIFIED") {
    detailsParts.push(`Account profile "${accountProfileId}" verified via process environment`);
  } else if (accountVerificationStatus === "UNVERIFIED") {
    detailsParts.push(`Account profile "${accountProfileId}" unverified (from session metadata only)`);
  } else {
    detailsParts.push("Account profile unknown");
  }

  if (modelVerificationStatus === "VERIFIED") {
    detailsParts.push(`Live model "${effectiveModelId}" verified via ${modelSource}${liveModelLabel ? ` (${liveModelLabel})` : ""}`);
    if (configuredModelId && configuredModelId !== effectiveModelId) {
      detailsParts.push(`Configured model was "${configuredModelId}" (discrepancy detected)`);
    }
  } else {
    detailsParts.push(
      configuredModelId
        ? `Configured model is "${configuredModelId}", but live model is unverified`
        : "Live model is unverified and no configured model is set"
    );
  }

  return {
    paneId: pane.id,
    sessionId: session?.sessionId ?? null,
    pid: procInfo?.pid ?? null,
    nativeTaskRef,
    configuredModelId,
    effectiveModelId,
    liveModelLabel,
    modelVerificationStatus,
    configuredAccountProfileId,
    liveAccountProfileId,
    accountProfileId,
    accountEmail,
    accountVerificationStatus,
    verificationEvidence: {
      processFound: Boolean(procInfo),
      pid: procInfo?.pid ?? null,
      cmdlineModel,
      cmdlineEffort,
      logFile: procInfo?.logFile ?? null,
      logEmail,
      logModelLabel,
      accountSource,
      modelSource,
      accountVerified: accountVerificationStatus === "VERIFIED",
      modelVerified: modelVerificationStatus === "VERIFIED",
      staleMetadata,
      details: detailsParts.join("; ")
    }
  };
}
