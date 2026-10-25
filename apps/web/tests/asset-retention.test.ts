import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { retainOpenTabAssets } from "../vite.asset-retention.js";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it("preserves current and recent lazy chunks while expiring old chunks and compressed variants", async () => {
  root = await mkdtemp(path.join(tmpdir(), 'asset-retention-'));
  const assets = path.join(root, 'dist/assets');
  await mkdir(assets, { recursive: true });
  for (const name of ['current.js', 'current.js.br', 'recent.js', 'expired.js', 'expired.js.gz']) {
    const file = path.join(assets, name);
    await writeFile(file, 'fixture');
    if (!['recent.js', 'expired.js.gz'].includes(name)) await utimes(file, new Date(0), new Date(0));
  }
  const plugin = retainOpenTabAssets();
  (plugin.configResolved as Function)({ root, build: { outDir: 'dist' } });
  (plugin.generateBundle as Function)({}, { 'assets/current.js': {} });
  await (plugin.closeBundle as Function)();
  expect((await readdir(assets)).sort()).toEqual(['current.js', 'current.js.br', 'recent.js']);
});

it("does not hide an earlier build failure when no output directory exists", async () => {
  root = await mkdtemp(path.join(tmpdir(), 'asset-retention-'));
  const plugin = retainOpenTabAssets();
  (plugin.configResolved as Function)({ root, build: { outDir: 'dist' } });
  await expect((plugin.closeBundle as Function)()).resolves.toBeUndefined();
});
