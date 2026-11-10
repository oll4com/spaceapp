import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resumePaneCliSessionResponseSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { authedApp, closeOwnedApps, csrfHeaderName, enabledCliConfig } from "./support/cli-runtimes-harness.js";

afterEach(closeOwnedApps);

// ADAPTER-013, dev 4/11: Hermes 0.22 reads an Enter that shares a read with other input as a newline, so the fallback
// context (sent raw with its Enter) stayed an unsent draft of paste chips. It is now pasted, then submitted on its own.
it("types the Space fallback context into Hermes and submits it with a separate Enter", async () => {
  const commandDir = await mkdtemp(join(tmpdir(), "space-cli-hermes-fallback-"));
  await writeFile(join(commandDir, "hermes-vscode-parity"),
    "#!/bin/sh\nprintf ' ─ ready │ opus 5.5 xhigh │ 1s\\n ❯ \\n'\nwhile IFS= read -r line; do printf 'hermes-input:%s\\n' \"$line\"; done\n", "utf8");
  await chmod(join(commandDir, "hermes-vscode-parity"), 0o755);
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Hermes Fallback", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Hermes task", mode: "TERMINAL", terminalRuntimeId: "cli:hermes", cwd: "/etc" });
  const source = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:hermes", providerId: "hermes", agentId: "hermes",
    modelId: null, reasoningEffort: "medium", launchMode: "FRESH", cwd: "/etc", codexThreadId: null, status: "EXITED", isActive: false });
  store.appendPaneCliTranscriptChunk({ sessionId: source.sessionId, paneId: pane.id, roomId: room.id, sequence: 0, stream: "stdin",
    content: "Remember the word HRD80916\r" });
  store.appendPaneCliTranscriptChunk({ sessionId: source.sessionId, paneId: pane.id, roomId: room.id, sequence: 1, stream: "stdout",
    content: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") });
  const { app, cookie, csrfToken } = await authedApp({ store, config: await enabledCliConfig(commandDir) });

  const response = await app.inject({ method: "POST", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/resume`,
    headers: { cookie, [csrfHeaderName]: csrfToken }, payload: { taskId: source.cliTaskId } });

  expect(response.statusCode, response.body).toBe(200);
  const resumed = resumePaneCliSessionResponseSchema.parse(response.json());
  expect(resumed.mode).toBe("SPACE_FALLBACK");
  const input = resumed.transcript.filter((chunk) => chunk.stream === "stdin").map((chunk) => chunk.content);
  const context = input.findIndex((text) => text.startsWith("\u001b[200~[SPACE_SHARED_HISTORY_CONTEXT_BEGIN]"));
  expect(context, JSON.stringify(input.map((text) => text.slice(0, 40)))).toBeGreaterThanOrEqual(0);
  expect(input[context]!.endsWith("\u001b[201~")).toBe(true);
  expect(input[context]).toContain("HRD80916");
  expect(input[context + 1]).toBe("\r");
});
