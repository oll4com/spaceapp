import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";

const version = "v1.40.0";
const cacheDirectory = fileURLToPath(new URL(`../../../.cache/temporal-test-server/${version}/${process.platform}-${process.arch}/`, import.meta.url));
const cachedExecutable = join(cacheDirectory, `temporal-test-server-${version}${process.platform === "win32" ? ".exe" : ""}`);

/** Resolve a provisioned executable without downloading anything during tests. */
export async function temporalTestServerPath() {
  const executable = process.env.SPACE_TEMPORAL_TEST_SERVER_PATH
    ? resolve(process.env.SPACE_TEMPORAL_TEST_SERVER_PATH) : cachedExecutable;
  try {
    if (!(await stat(executable)).isFile()) throw new Error("The path is not a file.");
    await access(executable, constants.R_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(`Temporal test server is unavailable at ${executable}. Run npm run test:setup -w @space/worker while online, or set SPACE_TEMPORAL_TEST_SERVER_PATH to a provisioned executable for offline tests.`, { cause });
  }
  return executable;
}

/** Prepare a pinned SDK-managed download once; reuse the cache or local override offline. */
export async function prepareTemporalTestServer() {
  try { return await temporalTestServerPath(); }
  catch (error) {
    if (process.env.SPACE_TEMPORAL_TEST_SERVER_PATH || error.cause?.code !== "ENOENT") throw error;
  }
  await mkdir(cacheDirectory, { recursive: true });
  let environment;
  try {
    environment = await TestWorkflowEnvironment.createTimeSkipping({
      server: { executable: { type: "cached-download", version, downloadDir: cacheDirectory } }
    });
    return await temporalTestServerPath();
  } catch (cause) {
    throw new Error("Could not provision the Temporal test server. Run npm run test:setup -w @space/worker with network access, or set SPACE_TEMPORAL_TEST_SERVER_PATH to an existing executable for offline tests.", { cause });
  } finally { await environment?.teardown(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Temporal test server ready: ${await prepareTemporalTestServer()}`);
}
