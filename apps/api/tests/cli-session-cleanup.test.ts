import { describe, expect, it, vi } from "vitest";
import { createCliSessionCleanupService } from "../src/cli-session-cleanup.js";

const counts = {
  opencode: { sessions: 2, newSessionSessions: 1, emptySessions: 1, mappingFiles: 0 },
  opencodeTmp: { entries: 3, bytes: 4096 },
  codexOrphans: { rolloutFiles: 1, bytes: 1024 },
  codexPaneHomes: { dirs: 0, bytes: 0 },
  cliStores: [],
  totalBytes: 5120
};
const cleaned = {
  opencode: { sessions: 2, newSessionSessions: 1, emptySessions: 1, mappingFiles: 0 },
  opencodeTmp: { entries: 3, bytes: 4096 },
  codex: { status: "SKIPPED", threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
  codexOrphans: { rolloutFiles: 1, bytes: 1024 },
  codexPaneHomes: { dirs: 0, bytes: 0 },
  cliStores: []
};

describe("CLI session cleanup", () => {
  it("never runs the Codex history purge, which would remove every inactive Codex thread", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) =>
      JSON.stringify(args[0] === "preview" ? counts : { cleaned, failures: [] }));
    const service = createCliSessionCleanupService({ command: "/fixed/cleanup", runCommand });
    const input = { actorId: "user:admin", protectedThreadIds: [], codexEnabled: true };

    const preview = await service.preview(input);
    expect(preview.status).toBe("READY");
    expect(preview.counts.codex).toEqual({ status: "NOOP", previewId: null, threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 });

    const result = await service.execute({ ...input, previewId: preview.previewId });
    expect(result.cleaned.codex).toEqual({ status: "NOOP", threads: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 });
    expect(result.cleaned.opencode.sessions).toBe(2);
    expect(result.status).toBe("COMPLETED");
    // Only the fixed cleanup worker ran; no other helper (such as the history purge) was invoked.
    expect(runCommand.mock.calls.map(([command, args]) => [command, args[0]])).toEqual([
      ["/fixed/cleanup", "preview"],
      ["/fixed/cleanup", "execute"]
    ]);
  });
});
