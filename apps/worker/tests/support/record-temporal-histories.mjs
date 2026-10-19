import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const vitestCli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const temporary = await mkdtemp(join(tmpdir(), "spaceapp-synthetic-histories-"));
try {
  const result = spawnSync(process.execPath, [vitestCli, "run", "tests/temporal-workflows.test.ts"], {
    stdio: "inherit", env: { ...process.env, SPACE_TEMPORAL_RECORD_HISTORIES: "1", SPACE_TEMPORAL_HISTORY_DIR: temporary }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const destination = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
    await mkdir(destination, { recursive: true });
    let added = 0;
    for (const name of await readdir(temporary)) {
      try {
        await copyFile(join(temporary, name), join(destination, name), constants.COPYFILE_EXCL);
        added++;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        console.log(`Preserved existing history: ${name}`);
      }
    }
    console.log(`Added ${added} synthetic histories. Existing fixtures were preserved; new workflow branches need distinct fixture names.`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
