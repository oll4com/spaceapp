import { describe, expect, it } from "vitest";
import {
  matchReasonixNativeSession,
  normalizeReasonixPrompt,
  parseReasonixSessionIndex,
  readReasonixSessionIndex,
  reasonixNativeSessionRefPattern,
  type ReasonixSessionIndexEntry
} from "../reasonix-native-session.js";

const legacyRef =
  "/var/lib/spaceapp-user/.reasonix/projects/-etc/sessions/20260920-120000.000000000-deepseek-flash.jsonl";
const otherRef =
  "/var/lib/spaceapp-user/.reasonix/projects/-etc/sessions/20260920-130000.000000000-deepseek-flash.jsonl";

function entry(overrides: Partial<ReasonixSessionIndexEntry> = {}): ReasonixSessionIndexEntry {
  return {
    sessionId: "0".repeat(32),
    store: "linear-v4",
    resumableRef: legacyRef,
    createdAt: "2026-09-20T12:00:00.000Z",
    updatedAt: "2026-09-20T12:10:00.000Z",
    model: "deepseek-flash/deepseek-flash",
    turns: 1,
    preview: "συνεχισε αυτο το τασκ",
    logBytes: 1024,
    ...overrides
  };
}

describe("reasonixNativeSessionRefPattern", () => {
  it("accepts only refs the CLI can still resolve", () => {
    expect(reasonixNativeSessionRefPattern.test(legacyRef)).toBe(true);
    expect(reasonixNativeSessionRefPattern.test(`session_${"a".repeat(32)}`)).toBe(true);
    // linear/v4 session ids are written by the CLI but not resumable today
    expect(reasonixNativeSessionRefPattern.test("a".repeat(32))).toBe(false);
    expect(reasonixNativeSessionRefPattern.test("/var/lib/spaceapp-user/.reasonix/projects/-etc/sessions/x.txt")).toBe(false);
    expect(reasonixNativeSessionRefPattern.test("")).toBe(false);
  });
});

describe("parseReasonixSessionIndex", () => {
  it("keeps bounded entries and drops invalid or unresumable refs", () => {
    const parsed = parseReasonixSessionIndex(
      JSON.stringify({
        version: 1,
        cwd: "/etc",
        projectKey: "-etc",
        sessions: [
          { ...entry(), sessionId: "a".repeat(32) },
          { ...entry(), sessionId: "b".repeat(32), resumableRef: "a".repeat(32) },
          { sessionId: "", resumableRef: legacyRef },
          "not-an-object"
        ]
      })
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.sessionId).toBe("a".repeat(32));
    expect(parsed[0]?.resumableRef).toBe(legacyRef);
    expect(parsed[1]?.resumableRef).toBeNull();
  });

  it("ignores malformed payloads instead of throwing", () => {
    expect(parseReasonixSessionIndex("nope")).toEqual([]);
    expect(parseReasonixSessionIndex(JSON.stringify({ version: 2, sessions: [] }))).toEqual([]);
    expect(parseReasonixSessionIndex(JSON.stringify({ version: 1, sessions: "x" }))).toEqual([]);
  });
});

describe("normalizeReasonixPrompt", () => {
  it("strips attachment labels and normalizes case, accents and spacing", () => {
    expect(normalizeReasonixPrompt("[Image #1] Συνεχισε   αυτό το ΤΑΣΚ")).toBe("συνεχισε αυτο το τασκ");
    expect(normalizeReasonixPrompt("[File #12][Image #2]δες αυτό")).toBe("δες αυτο");
    expect(normalizeReasonixPrompt(null)).toBe("");
  });
});

describe("matchReasonixNativeSession", () => {
  it("matches by first user message even when the stored preview is truncated", () => {
    const longPrompt =
      "βρες γιατι το κανει αυτο και ενημερωσε με, χωρις αλλαγες στο /opt/spaceapp, μονο διαγνωση";
    const matched = matchReasonixNativeSession({
      sessions: [
        entry({ sessionId: "a".repeat(32), preview: longPrompt.slice(0, 88) + "…" }),
        entry({ sessionId: "b".repeat(32), resumableRef: otherRef, preview: "ασχετο prompt" })
      ],
      firstUserMessage: longPrompt
    });
    expect(matched).toBe(legacyRef);
  });

  it("ignores candidates without a resumable ref", () => {
    const matched = matchReasonixNativeSession({
      sessions: [entry({ resumableRef: null, preview: "συνεχισε αυτο το τασκ" })],
      firstUserMessage: "συνεχισε αυτο το τασκ"
    });
    expect(matched).toBeNull();
  });

  it("falls back to a bounded recency match around the pane start", () => {
    const matched = matchReasonixNativeSession({
      sessions: [entry({ createdAt: "2026-09-20T12:00:00.000Z" })],
      paneStartedAtMs: Date.parse("2026-09-20T12:01:00.000Z")
    });
    expect(matched).toBe(legacyRef);

    const stale = matchReasonixNativeSession({
      sessions: [entry({ createdAt: "2026-09-20T09:00:00.000Z" })],
      paneStartedAtMs: Date.parse("2026-09-20T12:01:00.000Z")
    });
    expect(stale).toBeNull();
  });

  it("returns null when nothing can be proven", () => {
    expect(matchReasonixNativeSession({ sessions: [] })).toBeNull();
    expect(matchReasonixNativeSession({ sessions: [entry()] })).toBeNull();
  });
});

describe("readReasonixSessionIndex", () => {
  it("runs the parity wrapper as spaceapp-user and parses the index", async () => {
    const calls: Array<{ file: string; args: readonly string[]; env: Record<string, unknown> }> = [];
    const sessions = await readReasonixSessionIndex({
      workspace: "/etc",
      command: "/opt/spaceapp/bin/deepseek-vscode-parity",
      execImpl: async (file, args, options) => {
        calls.push({ file, args, env: options.env as Record<string, unknown> });
        return {
          stdout: JSON.stringify({ version: 1, cwd: "/etc", projectKey: "-etc", sessions: [entry()] })
        };
      }
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.resumableRef).toBe(legacyRef);
    expect(calls[0]?.file).toBe("/usr/bin/sudo");
    expect(calls[0]?.args).toEqual([
      "-n",
      "-u",
      "spaceapp-user",
      "--",
      "/opt/spaceapp/bin/deepseek-vscode-parity",
      "--run-inner",
      "sessions"
    ]);
    expect(calls[0]?.env.SPACE_CLI_WORKSPACE).toBe("/etc");
  });

  it("returns no sessions when the wrapper fails", async () => {
    const sessions = await readReasonixSessionIndex({
      workspace: "/etc",
      execImpl: async () => {
        throw new Error("sudo: a password is required");
      }
    });
    expect(sessions).toEqual([]);
  });
});
