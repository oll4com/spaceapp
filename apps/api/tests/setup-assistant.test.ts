import Fastify from "fastify";
import { createHash, createHmac } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SetupExecutionCoordinator } from "@space/runtime";
import * as assistant from "../src/setup-assistant.js";
import { writeInstallationUpgradeProof } from "../src/installation-handoff.js";

const secret = "synthetic-installation-secret-for-this-fixture";
async function fixture(mode = "ok") {
  const root = await mkdtemp(join(tmpdir(), "setup-assistant-"));
  const handoffRoot = join(root, "handoff"); await mkdir(handoffRoot);
  const cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  await writeFile(join(root, "installation-model.json"), JSON.stringify({ id: "opencode/fixture-free", verification: "tool-call", cost, verifiedAt: new Date().toISOString() }));
  const memory = "# SpaceApp installation memory\nPlatform: linux\nHardware profile: small\nVerified free model: opencode/fixture-free\nAssistant status: completed a live account-free tool call before Docker setup.\nCompleted installer assistant actions: CHECK_PREREQUISITES\nUntrusted notes: private operator room content\n";
  const payload = { schema: 1, memorySha256: createHash("sha256").update(memory).digest("hex"), modelId: "opencode/fixture-free", completed: true };
  await writeFile(join(handoffRoot, "INSTALLATION_MEMORY.md"), memory);
  await writeFile(join(handoffRoot, "installation-handoff.json"), JSON.stringify({ ...payload, mac: createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex") }));
  const command = join(root, "opencode");
  await writeFile(command, `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),mode=${JSON.stringify(mode)};
if(args[0]==='api') process.stdout.write(JSON.stringify({data:[{id:'fixture-free',providerID:'opencode',status:'active',enabled:true,cost:[{input:0,output:0}],capabilities:{tools:true},time:{released:1}}]})+'\\n');
else { writeFileSync(${JSON.stringify(join(root, "observed.json"))},JSON.stringify({args,config:process.env.OPENCODE_CONFIG,secret:process.env.OPENAI_API_KEY,
  homeConfig:JSON.parse(readFileSync(process.env.XDG_CONFIG_HOME+'/opencode/opencode.json','utf8'))}));
const message=mode==='action'?{message:'Help',action:'RUN_COMMAND'}:{message:'Choose Minimal to start. Live can be skipped without a provider key.'};
process.stdout.write(JSON.stringify({type:'text',part:{type:'text',text:JSON.stringify(message)}})+'\\n');
if(mode==='waiting'){writeFileSync(${JSON.stringify(join(root, "owned-pid"))},String(process.pid));setInterval(()=>{},1000);}
// OpenCode 2 standalone runs end after the answer without a last step_finish; an unfinished run exits with an error.
else if(mode==='incomplete')process.exit(1); }
`);
  await chmod(command, 0o700);
  const store = new InMemorySpaceStore();
  await new SetupExecutionCoordinator(store).updateDraft("user:owner", null, { persona: "everyday", level: "minimal", requestedFeatureIds: ["agent:opencode"], connectionChoices: [] });
  return { root, command, store, handoffRoot, ownerId: "user:owner", scratchRoot: join(root, "checks"), memoryRoot: root, installationSecret: secret,
    close: () => rm(root, { recursive: true, force: true }) };
}
describe("browser setup assistant", () => {
  it("cancels only its owned native task and removes its private runtime", async () => {
    const f = await fixture("waiting"); const controller = new AbortController();
    const task = assistant.answerSetupQuestion({ ...f, signal: controller.signal }, "Help");
    try {
      let pid = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { pid = Number(await readFile(join(f.root, "owned-pid"), "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      expect(pid).toBeGreaterThan(0); controller.abort();
      const observed = await Promise.race([task, new Promise(resolve => setTimeout(() => resolve("NOT_CANCELLED"), 1500))]);
      expect(observed).toMatchObject({ available: false });
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await readdir(f.scratchRoot)).toEqual([]);
    } finally { controller.abort(); await task; await f.close(); }
  }, 30_000);
  it("completes the selected free native conversation with only structured setup and authenticated safe notes", async () => {
    const f = await fixture();
    try {
      const result = await assistant.answerSetupQuestion(f, "Can I skip Live?");
      expect(result).toMatchObject({ available: true, modelId: "opencode/fixture-free", message: "Choose Minimal to start. Live can be skipped without a provider key." });
      const observed = JSON.parse(await readFile(join(f.root, "observed.json"), "utf8"));
      expect(observed.args.slice(0, 2)).toEqual(["run", "--standalone"]);
      expect(observed.args).not.toContain("--pure");
      // Only the read tool, inside a throwaway home: Zen refuses its free tier when every tool is denied (2.0.32, 2026-10-20).
      expect(observed.config).toBeUndefined();
      expect(observed.homeConfig).toEqual({ permission: { "*": "deny", read: "allow" } });
      expect(observed.args[observed.args.indexOf("--model") + 1]).toBe("opencode/fixture-free");
      const prompt = observed.args.at(-1);
      expect(prompt).toContain('"platform":"linux"');
      expect(prompt).toContain("CHECK_PREREQUISITES");
      expect(prompt).not.toContain("private operator room content");
      expect(prompt).not.toContain(secret);
      expect(observed.secret).toBeUndefined();
      expect(await readdir(f.scratchRoot)).toEqual([]);
    } finally { await f.close(); }
  });
  // Review 2026-10-21 #7: without the installer's check the assistant answers on setup's own signed check and is told
  // that no check ran before Docker setup.
  it("answers on setup's own check without the installer's and never says a pre-Docker check ran", async () => {
    const f = await fixture();
    try {
      await rm(f.handoffRoot, { recursive: true, force: true });
      expect(await assistant.answerSetupQuestion(f, "Can I skip Live?")).toMatchObject({ available: false });
      await writeInstallationUpgradeProof(f.root, secret, "opencode/fixture-free", new Date().toISOString());
      expect(await assistant.answerSetupQuestion(f, "Can I skip Live?")).toMatchObject({ available: true });
      const prompt = JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")).args.at(-1);
      expect(prompt).toContain('"assistantCheck":"by setup after installation; no check ran before Docker setup"');
      expect(prompt).toContain('"installation":null');
    } finally { await f.close(); }
  });
  it.each(["incomplete", "action"])("refuses %s model output and returns built-in guidance", async mode => {
    const f = await fixture(mode);
    try {
      expect(await assistant.answerSetupQuestion(f, "Help me choose tools")).toMatchObject({ available: false, modelId: null });
      expect(await readdir(f.scratchRoot)).toEqual([]);
    } finally { await f.close(); }
  });
  it("does not submit a visible credential value to the model", async () => {
    const f = await fixture();
    try {
      await expect(assistant.answerSetupQuestion(f, "api_key=private-fixture-key-value")).rejects.toThrow("dedicated");
      await expect(readFile(join(f.root, "observed.json"))).rejects.toThrow();
    } finally { await f.close(); }
  });
  it("requires a same-origin interactive owner and rejects extra context fields", async () => {
    const f = await fixture(); const app = Fastify(); let role = "ADMIN";
    app.addHook("preHandler", async request => { request.user = { id: "user:owner", email: "owner@example.test", role } as never; });
    assistant.registerSetupAssistantRoutes(app, { ...f, uiOrigin: "http://space.test" });
    try {
      const input = { method: "POST" as const, url: "/api/setup/assistant", headers: { origin: "http://space.test" }, payload: { question: "Can I skip Live?" } };
      expect((await app.inject({ ...input, headers: { origin: "http://foreign.test" } })).statusCode).toBe(403);
      role = "USER"; expect((await app.inject(input)).statusCode).toBe(403); role = "ADMIN";
      expect((await app.inject({ ...input, payload: { question: "Help", context: "private content" } })).statusCode).toBe(422);
      expect((await app.inject(input)).json()).toMatchObject({ available: true });
    } finally { await app.close(); await f.close(); }
  });
  it("refuses a missing Origin even when no alternate UI origin is configured", async () => {
    const f = await fixture(); const app = Fastify();
    app.addHook("preHandler", async request => { request.user = { id: "user:owner", email: "owner@example.test", role: "ADMIN" }; });
    assistant.registerSetupAssistantRoutes(app, f);
    try {
      expect((await app.inject({ method: "POST", url: "/api/setup/assistant", payload: { question: "Help" } })).statusCode).toBe(403);
    } finally { await app.close(); await f.close(); }
  });
  it.each([
    { name: "trusted loopback proxy", remoteAddress: "127.0.0.1", origin: "http://127.0.0.1:4911", expected: 422 },
    { name: "untrusted forwarded host", remoteAddress: "192.0.2.44", origin: "http://127.0.0.1:4911", expected: 403 },
    { name: "foreign origin", remoteAddress: "127.0.0.1", origin: "http://foreign.test", expected: 403 },
    { name: "missing origin", remoteAddress: "127.0.0.1", origin: undefined, expected: 403 }
  ])("uses Fastify's trusted proxy origin for $name", async ({ remoteAddress, origin, expected }) => {
    const f = await fixture();
    const app = Fastify({ trustProxy: ["127.0.0.1"] });
    app.addHook("preHandler", async request => {
      request.user = { id: "user:owner", email: "owner@example.test", role: "ADMIN" };
    });
    assistant.registerSetupAssistantRoutes(app, f);
    try {
      const response = await app.inject({ method: "POST", url: "/api/setup/assistant", remoteAddress,
        headers: { host: "127.0.0.1:4000", "x-forwarded-host": "127.0.0.1:4911",
          "x-forwarded-proto": "http", ...(origin ? { origin } : {}) }, payload: { unexpected: "value" } });
      expect(response.statusCode).toBe(expected);
    } finally { await app.close(); await f.close(); }
  });

  it("on a public install asks the CLI container's OpenCode and runs nothing in core (1.1.7 decision B)", async () => {
    const f = await fixture();
    try {
      const prompts: string[] = [];
      const result = await assistant.answerSetupQuestion({ ...f, command: join(f.root, "no-such-opencode"),
        openCodeModels: async (provider: string) => JSON.stringify({ data: [{ id: "fixture-free", providerID: provider, status: "active", enabled: true,
          cost: [{ input: 0, output: 0 }], capabilities: { tools: true } }] }),
        openCodeText: async (modelId: string, prompt: string) => { prompts.push(`${modelId}|${prompt}`);
          return JSON.stringify({ message: "Choose Minimal to start. Live can be skipped without a provider key." }); } }, "Can I skip Live?");
      expect(result).toMatchObject({ available: true, modelId: "opencode/fixture-free" });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("opencode/fixture-free|You are the SpaceApp setup assistant");
      await expect(readFile(join(f.root, "observed.json"))).rejects.toThrow();
    } finally { await f.close(); }
  });

  it("reads an answer a free model wraps in a json code fence (MiniMax M3.1 Flash on public-host)", async () => {
    const f = await fixture();
    try {
      const result = await assistant.answerSetupQuestion({ ...f, command: join(f.root, "no-such-opencode"),
        openCodeModels: async (provider: string) => JSON.stringify({ data: [{ id: "fixture-free", providerID: provider, status: "active", enabled: true,
          cost: [{ input: 0, output: 0 }], capabilities: { tools: true } }] }),
        openCodeText: async () => "```json\n{\n  \"message\": \"Balanced adds the background services.\"\n}\n```" }, "What does Balanced add?");
      expect(result).toMatchObject({ available: true, message: "Balanced adds the background services." });
    } finally { await f.close(); }
  });
});

