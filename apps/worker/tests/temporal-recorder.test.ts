import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it.each([false, true])("preserves the destination on later recording failure (replace existing: %s)", async replaceExisting => {
  const destination = await mkdtemp(join(tmpdir(), "space-temporal-recorder-"));
  const original = new Map<string, string>(replaceExisting ? [
    ["dummy-turn.json", "Existing synthetic history\n"], ["manifest.json", "Existing synthetic manifest\n"]
  ] : []);
  for (const [name, content] of original) await writeFile(join(destination, name), content);
  const previousArgv = process.argv;
  const started: string[] = [];
  const close = vi.fn(async () => undefined);
  const sandbox = {
    async run(_activities: unknown, body: () => Promise<void>) { await body(); },
    async start(workflowType: string) {
      started.push(workflowType);
      return {
        async result() {
          if (workflowType === "codexAppServerTurnWorkflow") throw new Error("Synthetic later recording failure");
        },
        async fetchHistory() {
          return { events: [{ workflowExecutionStartedEventAttributes: { workflowType: { name: workflowType } } }] };
        }
      };
    },
    close
  };
  vi.doMock("./support/temporal-sandbox.js", () => ({ Sandbox: { create: async () => sandbox } }));
  process.argv = [process.execPath, "record-temporal-histories.ts", "--output", destination,
    ...(replaceExisting ? ["--force", "--patch-id", "synthetic-reviewed-patch"] : [])];
  try {
    await expect(import("../scripts/record-temporal-histories.js")).rejects.toThrow("Synthetic later recording failure");
    expect(started).toEqual(["dummyTurnWorkflow", "codexAppServerTurnWorkflow"]);
    expect((await readdir(destination)).sort()).toEqual([...original.keys()].sort());
    for (const [name, content] of original) expect(await readFile(join(destination, name), "utf8")).toBe(content);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    process.argv = previousArgv;
    vi.doUnmock("./support/temporal-sandbox.js");
    vi.resetModules();
    await rm(destination, { recursive: true, force: true });
  }
}, 15_000);
