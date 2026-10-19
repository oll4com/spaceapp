import { describe, expect, it } from "vitest";
import {
  generateNativeOpenCodeTitle,
  nativeOpenCodeModelCatalog,
  OpenCodeTitleModelRetired,
  openCodeRunRejectsPermissionRequests,
  openCodeTitleRequestPreamble,
  parseNativeTitleOutput,
  resolveNativeOpenCodeRuntime,
  parseNativeOpenCodeModels,
  parseOpenCode2Models,
} from "../src/task-title-opencode.js";
import { mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
function output(overrides: Record<string, unknown> = {}) {
  return [
    { type: "step_start" },
    { type: "text", part: { text: '{"title":"Task title"}' } },
    {
      type: "step_finish",
      part: { cost: 0, tokens: { input: 400, output: 90 }, ...overrides },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}
describe("native title usage boundary", () => {
  it.each([false, true])("stops the isolated runtime at its first finish or tool request (tool=%s)", async (tool) => {
    const root = await mkdtemp(join(tmpdir(), "title-boundary-"));
    const command = join(root, "fake-native"), extra = join(root, "extra-turn");
    try {
      const events = tool ? '{"type":"step_start"}\n{"type":"tool_use"}\n' : output() + "\n";
      await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs');\nprocess.stdin.resume();\nprocess.stdout.write(${JSON.stringify(events)});\nsetTimeout(()=>{fs.writeFileSync(${JSON.stringify(extra)},'unexpected second turn');process.exit(0)},500);\n`, { mode: 0o700 });
      const result = generateNativeOpenCodeTitle({ command, modelId: "test-free", system: "Return JSON.", prompt: "Summarize title repair.", signal: AbortSignal.timeout(3000) });
      if (tool) await expect(result).rejects.toThrow("text");
      else await expect(result).resolves.toBe('{"title":"Task title"}');
      await expect(access(extra)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("parses only valid native model metadata records", () => {
    expect(
      parseNativeOpenCodeModels(
        'opencode/small-free\n{"cost":{"input":0,"output":0}}\nopencode/other\nnot json\nopencode/../../path\n{}',
      ),
    ).toEqual({ "small-free": { cost: { input: 0, output: 0 } } });
  });
  it("accepts one confirmed free text turn", () =>
    expect(parseNativeTitleOutput(output())).toBe('{"title":"Task title"}'));
  it.each([
    { cost: 0.001 },
    { cost: undefined },
    { tokens: { input: 32_001, output: 50 } },
    { tokens: { input: 400, output: 1501 } },
    { tokens: undefined },
    { tokens: { input: 400 } },
    { tokens: { input: -1, output: 50 } },
    { tokens: { input: 400, output: 2.5 } },
    { tokens: { input: 400, output: 1400, reasoning: 101 } },
    { tokens: { input: 400, output: 50, cache: { read: 31_700 } } },
  ])("rejects billing or token-limit violations (%j)", (part) =>
    expect(() => parseNativeTitleOutput(output(part))).toThrow(),
  );
  it("rejects tools, extra turns and missing completion", () => {
    expect(() =>
      parseNativeTitleOutput(output() + '\n{"type":"tool_use"}'),
    ).toThrow();
    expect(() =>
      parseNativeTitleOutput(output() + '\n{"type":"step_start"}'),
    ).toThrow();
    expect(() =>
      parseNativeTitleOutput('{"type":"text","part":{"text":"unfinished"}}'),
    ).toThrow();
  });
  it("runs only where `opencode run` rejects permission requests without --auto", () => {
    // OpenCode 1.19.0 `run --help` wraps the default onto a continuation line.
    const help = [
      "  -i, --interactive  run in direct interactive split-footer mode          [boolean] [default: false]",
      "      --auto         auto-approve permissions that are not explicitly denied (dangerous!)",
      "                                                                          [boolean] [default: false]",
    ].join("\n");
    expect(openCodeRunRejectsPermissionRequests("1.19.0", help)).toBe(true);
    expect(openCodeRunRejectsPermissionRequests("1.20.4", help)).toBe(true);
    expect(openCodeRunRejectsPermissionRequests("1.18.35", help)).toBe(false);
    expect(openCodeRunRejectsPermissionRequests("2.0.0", help)).toBe(false);
    expect(openCodeRunRejectsPermissionRequests("1.19.0", help.replace(/default: false\]$/, "default: true]"))).toBe(false);
    expect(openCodeRunRejectsPermissionRequests("1.19.0", help.split("\n")[0]!)).toBe(false);
    // OpenCode 2.0.31 `opencode --version` and `run --help`; a v2 run rejects requests unless --auto is passed.
    const v2Help = "FLAGS\n  --standalone            Run with a private server instead of the background service\n  --auto                  Auto-approve permissions that are not explicitly denied\n";
    expect(openCodeRunRejectsPermissionRequests("opencode v2.0.31", v2Help)).toBe(true);
    expect(openCodeRunRejectsPermissionRequests("opencode v2.0.31", v2Help.replace(/  --auto.*\n/, ""))).toBe(false);
    expect(openCodeRunRejectsPermissionRequests("opencode v3.0.0", v2Help)).toBe(false);
  });
  it("reads OpenCode 2's model API as the v1 catalog entries with the highest tier's cost", () => {
    const output = JSON.stringify({ data: [
      { id: "big-pickle", providerID: "opencode", name: "Big Pickle", status: "active", enabled: true, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
      { id: "tiered", providerID: "opencode", name: "Tiered", status: "active", cost: [{ input: 0, output: 0 }, { input: 1, output: 4 }] },
      { id: "off", providerID: "opencode", enabled: false, cost: [{ input: 0, output: 0 }] },
      { id: "kimi", providerID: "legacy", cost: [{ input: 0, output: 0 }] }
    ] });
    expect(parseOpenCode2Models(output)).toEqual({
      "big-pickle": { id: "big-pickle", name: "Big Pickle", status: "active", cost: { input: 0, output: 0 } },
      tiered: { id: "tiered", name: "Tiered", status: "active", cost: { input: 1, output: 4 } }
    });
  });
  it("keeps every tool behind a permission request and attaches copies of the images", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-attach-"));
    const command = join(root, "fake-native"), record = join(root, "record.json"), image = join(root, "shot.png");
    try {
      await writeFile(image, "png-bytes");
      const events = output() + "\n";
      await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst files=process.argv.slice(2).flatMap((a,i,all)=>all[i-1]==='--file'?[a]:[]);\nconst stdin=fs.readFileSync(0,'utf8');\nfs.writeFileSync(${JSON.stringify(record)},JSON.stringify({stdin,args:process.argv.slice(2),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),home:process.env.HOME,cwd:process.cwd(),copies:files.map(f=>fs.readFileSync(f,'utf8'))}));\nprocess.stdout.write(${JSON.stringify(events)});\n`, { mode: 0o700 });
      await generateNativeOpenCodeTitle({ command, modelId: "vision-free", system: "Return JSON.", prompt: "Name it.", signal: AbortSignal.timeout(3000), images: [image] });
      const seen = JSON.parse(await readFile(record, "utf8"));
      expect(seen.config.permission).toEqual({ "*": "ask" });
      expect(seen.config.agent["space-title"].permission).toEqual({ "*": "ask" });
      // "none" is refused by some free upstreams; the request is framed as data.
      expect(seen.config.agent["space-title"].options).toEqual({ reasoningEffort: "low" });
      expect(seen.stdin).toBe(openCodeTitleRequestPreamble + "Name it.");
      expect(seen.args).not.toContain("--auto");
      expect(seen.args.slice(-2)).toEqual(["--file", "attachments/image-1.png"]);
      expect(seen.copies).toEqual(["png-bytes"]);
      expect(seen.home).toBe(seen.cwd);
      expect(seen.cwd).not.toBe(root);
      await expect(access(seen.cwd)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each([
    ["1.19.0", "[boolean] [default: false]", true],
    ["1.19.0", "[boolean] [default: true]", false],
    ["1.18.31", "[boolean] [default: false]", false],
  ])("reads the native run help from stderr before trusting OpenCode %s (%s)", async (version, auto, trusted) => {
    const root = await mkdtemp(join(tmpdir(), "title-runtime-"));
    const command = join(root, "opencode");
    try {
      const help = `opencode run [message..]\n      --auto         auto-approve permissions that are not explicitly denied (dangerous!)\n                                                                          ${auto}\n`;
      await writeFile(command, `#!/usr/bin/env node\nconst a=process.argv.slice(2).join(' ');\nif(a==='--version')process.stdout.write(${JSON.stringify(version + "\n")});\nelse if(a==='run --help')process.stderr.write(${JSON.stringify(help)});\nelse process.exit(2);\n`, { mode: 0o700 });
      expect(await resolveNativeOpenCodeRuntime(command)).toBe(trusted ? command : null);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reports a model the service has retired so it can rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-retired-"));
    const command = join(root, "fake-native");
    try {
      const events = '{"type":"error","error":{"name":"APIError","data":{"message":"Model exo-free has been deprecated."}}}\n';
      await writeFile(command, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdout.write(${JSON.stringify(events)});\nsetTimeout(()=>process.exit(1),200);\n`, { mode: 0o700 });
      await expect(generateNativeOpenCodeTitle({ command, modelId: "exo-free", system: "Return JSON.", prompt: "Name it.", signal: AbortSignal.timeout(3000) }))
        .rejects.toBeInstanceOf(OpenCodeTitleModelRetired);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reads the native model catalog once for every refresh within its cache window", async () => {
    const root = await mkdtemp(join(tmpdir(), "title-catalog-"));
    const command = join(root, "opencode"), calls = join(root, "calls");
    try {
      await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)},'x');\nprocess.stdout.write('opencode/small-free\\n{"cost":{"input":0,"output":0}}\\n');\n`, { mode: 0o700 });
      const first = await nativeOpenCodeModelCatalog(command);
      const second = await nativeOpenCodeModelCatalog(command);
      expect(second).toBe(first);
      expect(first.providers[0]?.models).toEqual({ "small-free": { cost: { input: 0, output: 0 } } });
      expect(await readFile(calls, "utf8")).toBe("x");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
