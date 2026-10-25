import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as checks from "../src/setup-room-agent-check.js";

// OpenCode 2's /api/model entry (shape recorded from 2.0.31).
const model = { id: "fixture-free", providerID: "opencode", status: "active", enabled: true,
  cost: [{ input: 0, output: 0 }], capabilities: { tools: true }, time: { released: 1 } };

async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), "setup-room-agent-proof-"));
  const command = join(root, "opencode"); const scratchRoot = join(root, "checks");
  await writeFile(join(root, "installation-model.json"), JSON.stringify({ id: "opencode/fixture-free", verification: "tool-call",
    cost: { input: 0, output: 0 }, verifiedAt: new Date().toISOString() }));
  await writeFile(command, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args=process.argv.slice(2),mode=${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(join(root, "observed.jsonl"))},JSON.stringify({args,env:{OPENAI_API_KEY:process.env.OPENAI_API_KEY,OPENCODE_CONFIG:process.env.OPENCODE_CONFIG,HOME:process.env.HOME}})+'\\n');
const line=e=>process.stdout.write(JSON.stringify(e)+'\\n');
if(args[0]==='api') {
  const entry=${JSON.stringify(model)}; if(mode==='billed') entry.cost=[{input:1,output:2}];
  line({data:[entry]});
} else {
  const token=readFileSync('spaceapp-check.txt','utf8').trim();
  if(mode==='error') { line({type:'error',error:{message:'private-provider-error'}}); process.exit(1); }
  if(mode!=='no-tool') line({type:'tool_use',part:{tool:'read',state:{status:'completed'}}});
  line({type:'text',part:{type:'text',text:mode==='wrong'?'General fallback response.':token}});
}
`);
  await chmod(command, 0o700);
  return { root, command, scratchRoot };
}
const observed = async (root: string) => (await readFile(join(root, "observed.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));

describe("selected Room Agent setup proof", () => {
  it("needs the selected free model to complete a real tool call in an isolated OpenCode 2 standalone run", async () => {
    const f = await fixture("ok");
    try {
      const check = checks.createSetupRoomAgentCheck({ ...f, memoryRoot: f.root });
      expect(await check.fingerprint()).toMatch(/^[a-f0-9]{64}$/);
      await expect(check.exercise()).resolves.toBeUndefined();
      const [catalog, run] = await observed(f.root);
      expect(catalog.args).toEqual(["api", "GET", "/api/model", "--standalone"]);
      expect(run.args.slice(0, 2)).toEqual(["run", "--standalone"]);
      expect(run.args).not.toContain("--pure");
      expect(run.args[run.args.indexOf("--model") + 1]).toBe("opencode/fixture-free");
      expect(run.args.at(-1)).toContain("read tool");
      // No OpenCode config of ours and no provider key; the home is a throwaway, never the panes' store.
      expect(run.env.OPENCODE_CONFIG).toBeUndefined();
      expect(run.env.OPENAI_API_KEY).toBeUndefined();
      expect(run.env.HOME.startsWith(f.scratchRoot)).toBe(true);
      expect(await readdir(f.scratchRoot)).toEqual([]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["error", "no-tool", "wrong", "billed"])("refuses %s evidence and cleans its owned native runtime", async mode => {
    const f = await fixture(mode);
    try {
      const check = checks.createSetupRoomAgentCheck({ ...f, memoryRoot: f.root });
      await expect(check.exercise()).rejects.toThrow();
      expect(await readdir(f.scratchRoot)).toEqual([]);
      if (mode === "billed") expect((await observed(f.root)).map((call) => call.args[0])).toEqual(["api"]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("on a public install probes the selected model in the CLI container and runs nothing in core (1.1.7 decision B)", async () => {
    const f = await fixture("ok");
    try {
      const probed: string[] = [];
      const models = async (provider: string) => JSON.stringify({ data: [{ ...model, providerID: provider }] });
      const passing = checks.createSetupRoomAgentCheck({ ...f, memoryRoot: f.root, command: join(f.root, "no-such-opencode"), openCodeModels: models,
        checkFreeModel: async (modelId: string) => { probed.push(modelId); return true; } });
      await expect(passing.exercise()).resolves.toBeUndefined();
      expect(probed).toEqual(["opencode/fixture-free"]);
      const failing = checks.createSetupRoomAgentCheck({ ...f, memoryRoot: f.root, command: join(f.root, "no-such-opencode"), openCodeModels: models,
        checkFreeModel: async () => false });
      await expect(failing.exercise()).rejects.toThrow();
      await expect(readFile(join(f.root, "observed.jsonl"))).rejects.toThrow();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});

