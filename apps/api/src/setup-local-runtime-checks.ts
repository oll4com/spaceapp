import { spawn } from "./safe-child-process.js";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { demoVariantDefinitions, resolveServerEntry, resolveVariantAvailability } from "./demo-projects/catalog.js";
import { execGit, WorktreeService } from "./worktrees/worktree-service.js";
import { runGit } from "./source-control/git-engine.js";
import type { SetupFunctionalChecks } from "./setup-production-actions.js";
import type { SpaceStore } from "@space/runtime";
import { assertAccessAllowed, createEntry, deleteEntry, listDirectory, readFileContent, writeFileContent } from "./files-service.js";

export function createSetupFunctionalChecks(options: { demoRoot: string; demoEnabled: boolean; workspaceRoot: string; scratchRoot: string; store?: SpaceStore }): SetupFunctionalChecks {
  return {
    ...(options.store ? { "pane:files": {
      fingerprint: async (ownerId: string) => {
        const actor = await options.store!.getControlActor(ownerId);
        assertAccessAllowed(options.workspaceRoot, "admin", actor, options.workspaceRoot);
        const stats = await lstat(options.workspaceRoot);
        if (!stats.isDirectory()) throw new Error("The permitted file root is unavailable.");
        return createHash("sha256").update(JSON.stringify(["file-roundtrip:v1", await realpath(options.workspaceRoot),
          stats.dev, stats.ino, stats.mode, stats.uid, stats.gid, actor!.id, actor!.role])).digest("hex");
      },
      exercise: async (ownerId: string) => {
        const user = await options.store!.getControlActor(ownerId);
        const workspaceRoot = options.workspaceRoot;
        assertAccessAllowed(workspaceRoot, "admin", user, workspaceRoot);
        await listDirectory({ workspaceRoot, targetPath: workspaceRoot, mode: "user", user });
        const root = await mkdtemp(join(workspaceRoot, ".space-setup-file-check-"));
        try {
          const targetPath = join(root, "probe.txt");
          const content = `SpaceApp owned file check: ${randomUUID()}\n`;
          const scope = { targetPath, workspaceRoot, mode: "admin" as const, user };
          await createEntry({ ...scope, type: "file" });
          await writeFileContent({ ...scope, content });
          const readBack = await readFileContent(scope);
          if (readBack.content !== content || readBack.isBinary) throw new Error("The File Manager round trip did not return its written bytes.");
          const listed = await listDirectory({ workspaceRoot, targetPath: root, mode: "user", user });
          if (!listed.entries.some(entry => entry.name === "probe.txt" && entry.size === Buffer.byteLength(content))) throw new Error("The File Manager round trip did not list its written file.");
          await deleteEntry(scope);
          if ((await listDirectory({ workspaceRoot, targetPath: root, mode: "user", user })).entries.length) throw new Error("The File Manager round trip did not remove its written file.");
        } finally { await rm(root, { recursive: true, force: true }); }
      }
    } } : {}),
    "utility:worktrees": {
      fingerprint: async () => createHash("sha256").update(`${process.platform}:${process.version}:${await runGit(options.workspaceRoot, ["--version"], { timeout: 5_000 })}`).digest("hex"),
      exercise: () => checkSetupWorktreeRuntime(options.scratchRoot)
    },
    ...(options.demoEnabled ? { "pane:demos": {
      fingerprint: async () => {
        const variant = demoVariantDefinitions.find(item => item.projectId === "project-2-crud-playground" && item.id === "javascript-react-node")!;
        const hash = createHash("sha256").update(process.version);
        for (const path of [resolveServerEntry(options.demoRoot, variant), join(options.demoRoot, variant.templateDirectory, variant.webEntry)]) {
          const source = await readFile(path);
          if (source.byteLength > 2 * 1024 * 1024) throw new Error("The sample runtime file exceeds its bounded check.");
          hash.update(source);
        }
        return hash.digest("hex");
      },
      exercise: () => checkSetupDemoRuntime(options.demoRoot, options.scratchRoot)
    } } : {})
  };
}

async function ownedDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return mkdtemp(join(root, "setup-check-"));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("The sample runtime has no local port.");
  return address.port;
}

/** Fixed sample, local HTTP only, no inherited credentials, no user project writes. */
export async function checkSetupDemoRuntime(demoRoot: string, scratchRoot: string): Promise<void> {
  const variant = demoVariantDefinitions.find(item => item.projectId === "project-2-crud-playground" && item.id === "javascript-react-node")!;
  if (!(await resolveVariantAvailability(demoRoot, variant)).available) throw new Error("The built sample demo is unavailable.");
  const root = await ownedDirectory(scratchRoot);
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let exited = false;
  try {
    const port = await freePort();
    const runId = `setup-check-${randomUUID()}`;
    child = spawn(process.execPath, [resolveServerEntry(demoRoot, variant)], {
      cwd: root, stdio: "ignore",
      env: { HOST: "127.0.0.1", PORT: String(port), DEMO_MODE: "SAMPLE", DEMO_RUN_ID: runId,
        DEMO_WORKSPACE_DIR: root, DEMO_DATA_DIR: join(root, "data"), DEMO_SOURCE_ROOT: join(demoRoot, variant.templateDirectory) }
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    closed = new Promise(resolve => child!.once("close", () => { exited = true; resolve(); }));
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    const deadline = Date.now() + 5_000;
    while (!ready && Date.now() < deadline && !failed && !exited) {
      try {
        const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(500) });
        const body = await response.json() as { ok?: boolean; runId?: string; mode?: string };
        ready = response.ok && body.ok === true && body.runId === runId && body.mode === "SAMPLE";
      } catch { /* Wait only for this owned sample to become healthy. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error("The sample demo did not become healthy.");
    const created = await fetch(`${origin}/api/records`, { method: "POST",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(1_000),
      body: JSON.stringify({ title: "SpaceApp setup runtime check", status: "TODO", operationKey: runId }) });
    if (!created.ok) throw new Error("The sample demo could not create its owned check record.");
    const listed = await fetch(`${origin}/api/records`, { signal: AbortSignal.timeout(1_000) });
    const body = await listed.json() as { data?: Array<{ operationKey?: string }> };
    if (!listed.ok || !body.data?.some(record => record.operationKey === runId)) throw new Error("The sample demo could not read its owned check record.");
  } finally {
    if (child && closed && !exited) {
      child.kill("SIGTERM");
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 500))]);
      if (!exited) { child.kill("SIGKILL"); await closed; }
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** Uses the existing service unchanged, with a private registry and repository. */
export async function checkSetupWorktreeRuntime(scratchRoot: string): Promise<void> {
  const root = await ownedDirectory(scratchRoot);
  try {
    const repo = join(root, "repo");
    await mkdir(repo);
    const initialized = await execGit(repo, ["init", "--quiet", "--initial-branch=main"], 5_000);
    if (initialized.code !== 0) throw new Error("Git could not initialize the owned runtime check.");
    await writeFile(join(repo, "README.md"), "SpaceApp owned setup check.\n");
    const service = new WorktreeService(join(root, "worktrees"));
    const worktree = await service.createWorktree({ repoPath: repo, roomId: "room:setup-runtime-check", baseBranch: "main", linkModules: false });
    await access(join(worktree.worktreePath, "README.md"));
    if (!(await service.listWorktrees(repo)).some(item => item.worktreePath === worktree.worktreePath)) throw new Error("The created worktree was not listed.");
    await service.removeWorktree(worktree.worktreePath);
    if ((await service.listWorktrees(repo)).some(item => item.worktreePath === worktree.worktreePath)) throw new Error("The removed worktree remained listed.");
  } finally { await rm(root, { recursive: true, force: true }); }
}
