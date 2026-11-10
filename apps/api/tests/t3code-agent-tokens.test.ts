import { tmpdir } from "node:os";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { agentTokenTtlMs, verifyCliBrowserBridgeToken } from "../src/cli-browser-bridge.js";
import { verifyCliAgentFilesToken } from "../src/cli-agent-files.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const config = { internalApiToken: "synthetic-internal-token-for-tests-only", browserToolBridgeEnabled: true,
  host: "0.0.0.0", port: 4910, browserEvidenceTargetOrigin: "https://space.test:4911" };

async function fixture(overrides: Record<string, unknown> = {}) {
  const module = await import("../src/t3code/agent-tokens.js").catch(() => ({} as any));
  expect(typeof module.publishT3AgentTokens, "T3 agent tokens are missing").toBe("function");
  const root = await mkdtemp(join(tmpdir(), "t3-agent-tokens-"));
  cleanup.push(root);
  const dir = join(root, "tokens"), workspace = join(root, "worktree");
  let now = Date.parse("2026-10-12T12:00:00Z");
  const options = { config, dir, groupFrom: root, now: () => now, ...overrides };
  const publish = (input = {}) => module.publishT3AgentTokens(options, { roomId: "room:Pxteh9pfaZnp", paneId: "pane:t3Pane0001", workspaceRoot: workspace, ...input });
  const read = async () => JSON.parse(await readFile(module.t3AgentTokenFile(dir, workspace), "utf8"));
  return { module, root, dir, workspace, publish, read, advance: (ms: number) => { now += ms; }, now: () => now };
}

it("writes pane-bound browser and Agent Files tokens for the T3 agents of one workspace", async () => {
  const f = await fixture();
  expect(await f.publish()).toBe("written");
  const file = await f.read();
  expect(file).toMatchObject({ version: 1, workspaceRoot: f.workspace, roomId: "room:Pxteh9pfaZnp", paneId: "pane:t3Pane0001",
    browser: { contextEndpoint: "https://space.test:4911/api/cli/browser/context", sessionEndpoint: "https://space.test:4911/api/cli/browser/session",
      actionEndpoint: "https://space.test:4911/api/cli/browser/actions", commandEndpoint: "https://space.test:4911/api/cli/browser/commands" },
    agentFiles: { endpoint: "https://space.test:4911/api/cli/agent-files" } });
  const claims = { roomId: "room:Pxteh9pfaZnp", paneId: "pane:t3Pane0001", cliSessionId: "t3code:pane:t3Pane0001" };
  expect(verifyCliBrowserBridgeToken(config, file.browser.token, f.now())).toMatchObject(claims);
  expect(verifyCliAgentFilesToken(config, file.agentFiles.token, f.now())).toMatchObject(claims);
  expect(file.expiresAt).toBe(f.now() + agentTokenTtlMs);
  // Readable by the T3 service group only, never by others.
  const path = f.module.t3AgentTokenFile(f.dir, f.workspace);
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  expect((await stat(f.dir)).mode & 0o7777).toBe(0o2750);
  expect((await stat(path)).gid).toBe((await stat(f.root)).gid);
});

it("refreshes only when the token nears expiry or the pane changes, and prunes expired files", async () => {
  const f = await fixture();
  await f.publish();
  const first = await f.read();
  f.advance(5 * 3_600_000);
  expect(await f.publish()).toBe("fresh");
  expect((await f.read()).browser.token).toBe(first.browser.token);
  expect(await f.publish({ paneId: "pane:t3Pane0002" })).toBe("written");
  expect((await f.read()).paneId).toBe("pane:t3Pane0002");
  // Within six hours of the token lifetime (agentTokenTtlMs) the file is written again.
  f.advance(agentTokenTtlMs - 5 * 3_600_000);
  expect(await f.publish({ paneId: "pane:t3Pane0002" })).toBe("written");
  const stale = join(f.dir, "0".repeat(64) + ".json");
  await writeFile(stale, JSON.stringify({ version: 1, expiresAt: f.now() - 1 }));
  f.advance(agentTokenTtlMs - 5 * 3_600_000);
  await f.publish({ paneId: "pane:t3Pane0002" });
  expect((await readdir(f.dir)).filter(name => name.endsWith(".json"))).toEqual([f.module.t3AgentTokenFile(f.dir, f.workspace).split("/").pop()]);
});

it("publishes nothing without internal API authentication", async () => {
  const f = await fixture({ config: { ...config, internalApiToken: null } });
  expect(await f.publish()).toBe("unavailable");
  await expect(f.read()).rejects.toThrow();
});

it("accepts a T3 principal only for an open T3 pane in the token's room", async () => {
  const f = await fixture();
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "T3 principal", initialPaneCount: 0 });
  const other = store.createRoom({ name: "Other", initialPaneCount: 0 });
  const t3 = store.createPane({ roomId: room.id, mode: "T3CODE", title: "T3" });
  const cli = store.createPane({ roomId: room.id, mode: "TERMINAL", title: "CLI" });
  const claims = (paneId: string, roomId = room.id, cliSessionId = f.module.t3AgentSessionId(paneId)) => ({ roomId, paneId, cliSessionId });
  expect(await f.module.t3AgentPrincipal(store, claims(t3.id))).toBe(true);
  expect(await f.module.t3AgentPrincipal(store, claims(t3.id, other.id))).toBe(false);
  expect(await f.module.t3AgentPrincipal(store, claims(cli.id))).toBe(false);
  expect(await f.module.t3AgentPrincipal(store, claims(t3.id, room.id, f.module.t3AgentSessionId(cli.id)))).toBe(false);
  expect(await f.module.t3AgentPrincipal(store, claims("pane:missing0001"))).toBe(false);
  store.updatePane(t3.id, { isClosed: true });
  expect(await f.module.t3AgentPrincipal(store, claims(t3.id))).toBe(false);
  expect(f.module.isT3AgentSessionId("t3code:pane:x")).toBe(true);
  expect(f.module.isT3AgentSessionId("cli_session:fOItgxjhAJFF")).toBe(false);
});
