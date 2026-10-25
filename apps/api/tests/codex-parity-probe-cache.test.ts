import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexParityService } from "../src/codex-parity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(join(root, "config.toml"), 0o644).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }));
});

async function probeFixture() {
  const root = await mkdtemp(join(tmpdir(), "space-codex-probe-cache-"));
  roots.push(root);
  // An unreadable config forces the redacted sudo-wrapper fallback, as in production.
  await writeFile(join(root, "config.toml"), 'model = "gpt-5.4-mini"\n');
  await chmod(join(root, "config.toml"), 0o000);
  const inspectCount = join(root, "inspect-count.txt");
  const inspectorPath = join(root, "inspect-env.mjs");
  await writeFile(inspectorPath, [
    "#!/usr/bin/env node",
    'import { appendFile } from "node:fs/promises";',
    `await appendFile(${JSON.stringify(inspectCount)}, "1\\n");`,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify({
      codexHome: root,
      stateDbPath: join(root, "state_5.sqlite"),
      config: { modelProvider: "codex-lb", model: "gpt-5.4-mini", reasoningEffort: "low" },
      mcpServers: [],
      skillCount: 0,
      pluginCount: 0,
      memories: { generateMemories: false, useMemories: false },
      features: { plugins: true, memories: false },
      checkedAt: "2026-10-10T00:00:00.000Z"
    })}\n`)});`
  ].join("\n"));
  await chmod(inspectorPath, 0o755);
  const count = async (path: string) =>
    (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return {
    root,
    inspectorPath,
    inspections: () => count(inspectCount)
  };
}

async function settle(ms = 150) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex wrapper probe cache", () => {
  it("reuses inspect-env across short environment refreshes", async () => {
    const fixture = await probeFixture();
    const service = createCodexParityService({
      codexHome: fixture.root,
      stateDbPath: join(fixture.root, "state_5.sqlite"),
      environmentInspectorCommand: fixture.inspectorPath,
      environmentCacheTtlMs: 0
    });

    const first = await service.getEnvironment();
    expect(first).toMatchObject({ config: { model: "gpt-5.4-mini" } });
    for (let index = 0; index < 3; index += 1) {
      await service.getEnvironment();
      await settle();
    }
    const latest = await service.getEnvironment();
    // codex-lb is retired: no route-status probe, and without a gateway URL or key no pooled quota either.
    expect(latest.lbUsage).toBeUndefined();
    expect(await fixture.inspections()).toBe(1);
  }, 30_000);

  it("refreshes the wrapper probes in the background once their window passes", async () => {
    const fixture = await probeFixture();
    const service = createCodexParityService({
      codexHome: fixture.root,
      stateDbPath: join(fixture.root, "state_5.sqlite"),
      environmentInspectorCommand: fixture.inspectorPath,
      environmentCacheTtlMs: 0,
      wrapperProbeCacheTtlMs: 50
    });

    await service.getEnvironment();
    await settle(100);
    // The stale environment is served while one background refresh re-probes.
    await service.getEnvironment();
    await expect.poll(fixture.inspections, { timeout: 10_000 }).toBe(2);
  }, 30_000);
});
