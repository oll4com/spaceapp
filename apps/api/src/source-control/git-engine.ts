import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitDiffHunk, GitFileChange, GitFileDiff, GitOperation, GitOperationResult, GitStatusSnapshot } from "@space/contracts";
import { GIT_NOT_FOUND_EXIT_CODE, spawnGroupWritableGit } from "../group-writable-git.js";
import { GitControlError } from "./errors.js";

type CommandOptions = { input?: string; env?: NodeJS.ProcessEnv; accepted?: number[]; timeout?: number };
export function runGit(root: string, args: string[], options: CommandOptions = {}): Promise<string> {
  return new Promise((resolveResult, reject) => {
    // No caller-controlled shell, inherited Git overrides, credential helpers, external diff or pagers.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LITERAL_PATHSPECS: "1", ...options.env
    };
    const ownProcessGroup = process.platform !== "win32";
    const child = spawnGroupWritableGit(["--no-optional-locks", "-c", `safe.directory=${root}`, "-c", "credential.helper=", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-C", root, ...args], env);
    const stop = () => { try { if (ownProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} };
    let output = ""; let error = ""; let exceeded = false; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeout ?? 15000);
    const collect = (part: Buffer, stderr: boolean) => {
      if (stderr) error += part.toString("utf8"); else output += part.toString("utf8");
      if (Buffer.byteLength(output) + Buffer.byteLength(error) > 8 * 1024 * 1024) { exceeded = true; stop(); }
    };
    child.stdout.on("data", (p: Buffer) => collect(p, false)); child.stderr.on("data", (p: Buffer) => collect(p, true));
    child.on("error", () => { clearTimeout(timer); reject(new GitControlError("GIT_UNAVAILABLE", "Git could not start.", 503)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut || exceeded) return reject(new GitControlError("GIT_LIMIT", timedOut ? "Git operation timed out." : "Git output exceeded its limit.", 422));
      if (ownProcessGroup && code === GIT_NOT_FOUND_EXIT_CODE) return reject(new GitControlError("GIT_UNAVAILABLE", "Git could not start.", 503));
      if (!(options.accepted ?? [0]).includes(code ?? -1)) {
        // Credentials and hook output never enter an API response.
        const message = /non-fast-forward|fetch first|rejected/i.test(error) ? "Push rejected. Fetch and resolve outgoing commits before retrying."
          : /conflict|not possible to fast-forward/i.test(error) ? "Pull requires conflict resolution or a fast-forward."
          : /Authentication failed|could not read Username|403|401/i.test(error) ? "Authentication failed or repository permission is insufficient."
          : /hook|identity|user.email|user.name/i.test(error) ? "Commit failed. Check the repository identity and commit hooks."
          : "Git operation failed. Check repository state, permissions and connectivity.";
        return reject(new GitControlError("GIT_FAILED", message, 409));
      }
      resolveResult(output);
    });
    child.stdin.on("error", () => undefined); child.stdin.end(options.input);
  });
}

export interface RemoteComparisonTarget { url: string; defaultBranch?: string }
export type EngineOperation = {
  operation: GitOperation; expectedVersion: string; paths?: string[]; hunkId?: string;
  message?: string; confirmed?: boolean; remoteUrl?: string; comparison?: RemoteComparisonTarget; env?: NodeJS.ProcessEnv;
  author?: { name: string; email: string };
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (root: string, target: string) => { const path = relative(root, target); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };

export class GitEngine {
  private queues = new Map<string, Promise<unknown>>();
  private reads = new Map<string, Promise<GitStatusSnapshot>>();
  private remoteChecks = new Map<string, string>();

  async root(project: string): Promise<string> {
    const root = await realpath(project);
    if (!(await lstat(root)).isDirectory()) throw new GitControlError("INVALID_ROOT", "Project must be a directory.");
    const metadata = join(root, ".git");
    try {
      const info = await lstat(metadata);
      if (info.isSymbolicLink()) throw new GitControlError("INVALID_ROOT", "Symlinked Git metadata is not allowed.");
      const gitDir = info.isFile() ? resolve(root, (await readFile(metadata, "utf8")).match(/^gitdir: (.+)\r?\n?$/)?.[1]?.trim() ?? "INVALID") : metadata;
      await this.checkedMetadata(root, gitDir);
      let commonDir = gitDir;
      try { commonDir = resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.checkedMetadata(root, commonDir);
      for (const directory of new Set([gitDir, commonDir])) {
        for (const path of ["index", "HEAD", "config", "config.worktree", "objects", "refs", "packed-refs", "hooks", "info", "objects/info", "objects/info/alternates"]) {
          await this.checkedMetadata(root, join(directory, path), true);
        }
        try {
          const alternates = (await readFile(join(directory, "objects/info/alternates"), "utf8")).split("\n").filter(Boolean);
          for (const alternate of alternates) await this.checkedMetadata(root, resolve(directory, "objects", alternate));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const top = await runGit(root, ["rev-parse", "--show-toplevel"], { accepted: [0, 128] });
    if (top.trim() && await realpath(top.trim()) !== root) throw new GitControlError("INVALID_ROOT", "Select the actual repository root.");
    return root;
  }

  private async checkedMetadata(root: string, path: string, optional = false): Promise<void> {
    if (!inside(root, path)) throw new GitControlError("INVALID_ROOT", "Git metadata must stay inside the selected project.");
    try {
      if (!inside(root, await realpath(path))) throw new GitControlError("INVALID_ROOT", "Git metadata escapes the selected project.");
    } catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.checkedMetadata(root, dirname(path), true); }
  }

  private async checkedPath(root: string, path: string): Promise<void> {
    if (!path || isAbsolute(path) || path.includes("\0") || path.split("/").some(p => p === ".." || p.toLowerCase() === ".git") || !inside(root, resolve(root, path))) throw new GitControlError("INVALID_PATH", "Invalid repository-relative path.");
    // Check every ancestor, including for deleted files; final symlinks may only point inside the root.
    let target = resolve(root, path);
    for (;;) {
      try { if (!inside(root, await realpath(target))) throw new GitControlError("INVALID_PATH", "Path escapes the project through a symlink."); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; target = resolve(target, ".."); }
      if (!inside(root, target)) throw new GitControlError("INVALID_PATH", "Path escapes the project.");
    }
  }

  async status(project: string, comparison?: RemoteComparisonTarget): Promise<GitStatusSnapshot> {
    const root = await this.root(project);
    const key = JSON.stringify([root, comparison]);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const read = (async () => { await this.queues.get(root)?.catch(() => undefined); return this.snapshot(root, comparison); })();
    this.reads.set(key, read);
    try { return await read; } finally { if (this.reads.get(key) === read) this.reads.delete(key); }
  }

  private async comparisonRef(root: string, target: RemoteComparisonTarget, branch: string) {
    await runGit(root, ["check-ref-format", `refs/heads/${branch}`]);
    const prefix = `refs/space-source-control/${digest(target.url)}`;
    const ref = `${prefix}/${branch}`;
    const path = (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", ref])).trim();
    await this.checkedMetadata(root, path, true);
    return { prefix, ref, key: JSON.stringify([root, ref]) };
  }

  private async snapshot(root: string, target?: RemoteComparisonTarget): Promise<GitStatusSnapshot> {
    const initialized = Boolean((await runGit(root, ["rev-parse", "--show-toplevel"], { accepted: [0, 128] })).trim());
    const hash = createHash("sha256");
    if (!initialized) {
      hash.update(JSON.stringify(await readdir(root, { withFileTypes: false })));
      return { version: hash.digest("hex"), initialized: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], staged: [], conflicts: [], outgoing: [], remoteUrl: null };
    }
    const [raw, head, branch, upstream, remote] = await Promise.all([
      runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      runGit(root, ["rev-parse", "--verify", "HEAD"], { accepted: [0, 128] }),
      runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"], { accepted: [0, 1] }),
      runGit(root, ["rev-parse", "--verify", "--quiet", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { accepted: [0, 1, 128] }),
      runGit(root, ["config", "--get", "remote.origin.url"], { accepted: [0, 1] })
    ]);
    const changes: GitFileChange[] = [], staged: GitFileChange[] = [], conflicts: GitFileChange[] = [];
    const entries = raw.split("\0"); const paths = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]; if (!entry) continue;
      const x = entry[0]!, y = entry[1]!; const path = entry.slice(3);
      const originalPath = /[RC]/.test(x + y) ? entries[++i] ?? null : null;
      paths.add(path); if (originalPath) paths.add(originalPath);
      if (x === "U" || y === "U" || ["AA", "DD"].includes(x + y)) { conflicts.push({ path, originalPath, status: "U" }); continue; }
      if (x !== " " && x !== "?") staged.push({ path, originalPath, status: x });
      if (y !== " " || x === "?") changes.push({ path, originalPath, status: x === "?" ? "A" : y });
    }
    if (paths.size > 2000) throw new GitControlError("GIT_LIMIT", "Repository has too many changed paths.", 422);
    hash.update(raw).update(head).update(branch).update(upstream).update(remote);
    hash.update(await runGit(root, ["ls-files", "--stage", "-z"]));
    for (const path of [...paths].sort()) {
      const full = join(root, path); hash.update(path);
      try {
        const info = await lstat(full);
        if (info.isSymbolicLink()) { await this.checkedPath(root, relative(root, resolve(full, "..")) || "."); hash.update(await readlink(full)); }
        else if (info.isFile()) { await this.checkedPath(root, path); for await (const bytes of createReadStream(full)) hash.update(bytes); }
        else hash.update(`${info.mode}:${info.mtimeMs}:${info.size}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; hash.update("deleted"); }
    }
    let ahead = 0, behind = 0; let outgoing: { id: string; message: string }[] = [];
    let headShort: string | null = null;
    let headDate: string | null = null;
    let headMessage: string | null = null;
    let projectVersion: string | null = null;
    let projectPillars: { core?: string; desktop?: string; mobile?: string; setup?: string } | null = null;
    if (head.trim()) {
      headShort = (await runGit(root, ["rev-parse", "--short", "HEAD"], { accepted: [0, 128] })).trim() || null;
      headDate = (await runGit(root, ["log", "-1", "--format=%cd", "--date=iso-strict", "HEAD"], { accepted: [0, 128] })).trim() || null;
      headMessage = (await runGit(root, ["log", "-1", "--format=%s", "HEAD"], { accepted: [0, 128] })).trim() || null;
      try {
        const vRaw = await readFile(join(root, "version.json"), "utf8");
        const vJson = JSON.parse(vRaw);
        if (typeof vJson.platform?.version === "string" && vJson.platform.version.trim()) {
          projectVersion = vJson.platform.version.trim();
        }
        if (vJson.pillars && typeof vJson.pillars === "object") {
          projectPillars = {
            core: vJson.pillars.core?.version,
            desktop: vJson.pillars.desktop?.version,
            mobile: vJson.pillars.mobile?.version,
            setup: vJson.pillars.setup?.version
          };
        }
      } catch {
        // version.json missing or invalid JSON
      }
      if (!projectVersion) {
        try {
          const pkgRaw = await readFile(join(root, "package.json"), "utf8");
          const pkg = JSON.parse(pkgRaw);
          if (typeof pkg.version === "string" && pkg.version.trim()) {
            projectVersion = pkg.version.trim();
          }
        } catch {
          // package.json missing or invalid JSON
        }
      }
      if (!projectVersion) {
        const tag = (await runGit(root, ["describe", "--tags", "--always"], { accepted: [0, 128] })).trim();
        if (tag) projectVersion = tag;
      }
    }
    if (head.trim() && !target) {
      if (upstream.trim()) {
        const counts = (await runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).trim().split(/\s+/);
        ahead = Number(counts[0]); behind = Number(counts[1]);
      }
      const log = await runGit(root, ["log", "--format=%H%x00%s", ...(upstream.trim() ? ["@{upstream}..HEAD"] : ["HEAD"])]);
      outgoing = log.trimEnd().split("\n").filter(Boolean).map(line => { const [id, message] = line.split("\0"); return { id: id!, message: message ?? "" }; });
      if (!upstream.trim()) ahead = outgoing.length;
      hash.update(JSON.stringify({ ahead, behind, outgoing }));
    }
    let comparison: GitStatusSnapshot["comparison"];
    if (target) {
      const remoteBranch = branch.trim() || target.defaultBranch || "main";
      const reference = await this.comparisonRef(root, target, remoteBranch);
      const remoteHead = (await runGit(root, ["rev-parse", "--verify", "--quiet", `${reference.ref}^{commit}`], { accepted: [0, 1, 128] })).trim() || null;
      const checkedAt = this.remoteChecks.get(reference.key) ?? null;
      const ready = Boolean(remoteHead || checkedAt);
      let remoteHeadShort: string | null = null;
      let remoteHeadDate: string | null = null;
      let remoteHeadMessage: string | null = null;
      let repoVersion: string | null = null;
      let repoPillars: { core?: string; desktop?: string; mobile?: string; setup?: string } | null = null;
      if (remoteHead) {
        remoteHeadShort = (await runGit(root, ["rev-parse", "--short", remoteHead], { accepted: [0, 128] })).trim() || null;
        remoteHeadDate = (await runGit(root, ["log", "-1", "--format=%cd", "--date=iso-strict", remoteHead], { accepted: [0, 128] })).trim() || null;
        remoteHeadMessage = (await runGit(root, ["log", "-1", "--format=%s", remoteHead], { accepted: [0, 128] })).trim() || null;
        try {
          const remoteVRaw = await runGit(root, ["show", `${remoteHead}:version.json`], { accepted: [0, 128] });
          if (remoteVRaw.trim()) {
            const remoteV = JSON.parse(remoteVRaw);
            if (typeof remoteV.platform?.version === "string" && remoteV.platform.version.trim()) {
              repoVersion = remoteV.platform.version.trim();
            }
            if (remoteV.pillars && typeof remoteV.pillars === "object") {
              repoPillars = {
                core: remoteV.pillars.core?.version,
                desktop: remoteV.pillars.desktop?.version,
                mobile: remoteV.pillars.mobile?.version,
                setup: remoteV.pillars.setup?.version
              };
            }
          }
        } catch {
          // No version.json at remote commit
        }
        if (!repoVersion) {
          try {
            const remotePkgRaw = await runGit(root, ["show", `${remoteHead}:package.json`], { accepted: [0, 128] });
            if (remotePkgRaw.trim()) {
              const remotePkg = JSON.parse(remotePkgRaw);
              if (typeof remotePkg.version === "string" && remotePkg.version.trim()) {
                repoVersion = remotePkg.version.trim();
              }
            }
          } catch {
            // No package.json at remote commit
          }
        }
        if (!repoVersion) {
          const rTag = (await runGit(root, ["describe", "--tags", remoteHead], { accepted: [0, 128] })).trim();
          if (rTag) repoVersion = rTag;
        }
      }
      const comp = {
        ready,
        branch: remoteBranch,
        head: remoteHead,
        headShort: remoteHeadShort,
        headDate: remoteHeadDate,
        headMessage: remoteHeadMessage,
        repoVersion,
        repoPillars,
        checkedAt,
        related: null as boolean | null,
        changes: [] as GitFileChange[]
      };
      comparison = comp;
      ahead = 0; behind = 0; outgoing = [];
      if (ready && head.trim()) {
        const base = remoteHead ?? (await runGit(root, ["mktree"], { input: "" })).trim();
        if (remoteHead) {
          const counts = (await runGit(root, ["rev-list", "--left-right", "--count", `HEAD...${remoteHead}`])).trim().split(/\s+/);
          ahead = Number(counts[0]); behind = Number(counts[1]);
          comp.related = Boolean((await runGit(root, ["merge-base", "HEAD", remoteHead], { accepted: [0, 1] })).trim());
        } else comp.related = true;
        const log = await runGit(root, ["log", "--format=%H%x00%s", remoteHead ? `${remoteHead}..HEAD` : "HEAD"]);
        outgoing = log.trimEnd().split("\n").filter(Boolean).map(line => { const [id, message] = line.split("\0"); return { id: id!, message: message ?? "" }; });
        if (!remoteHead) ahead = outgoing.length;
        const changed = (await runGit(root, ["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "HEAD", "--"])).split("\0");
        for (let i = 0; i < changed.length - 1; i += 2) comp.changes.push({ status: changed[i]!, path: changed[i + 1]!, originalPath: null });
        if (comp.changes.length > 10000) throw new GitControlError("GIT_LIMIT", "Remote comparison has too many changed files.", 422);
      }
      hash.update(JSON.stringify([target, remoteBranch, remoteHead, ready, comp.changes]));
    }
    // Do not expose credentials from old remote URLs.
    let remoteUrl: string | null = remote.trim() || null;
    if (remoteUrl) { try { const url = new URL(remoteUrl); url.username = ""; url.password = ""; remoteUrl = url.toString(); } catch { remoteUrl = remoteUrl.replace(/\/\/[^/@]+@/, "//"); } }
    return {
      version: hash.digest("hex"),
      initialized: true,
      branch: branch.trim() || null,
      head: head.trim() || null,
      headShort,
      headDate,
      headMessage,
      projectVersion,
      projectPillars,
      upstream: upstream.trim() || null,
      ahead,
      behind,
      changes,
      staged,
      conflicts,
      outgoing,
      remoteUrl,
      ...(comparison ? { comparison } : {})
    };
  }

  private async diffAt(root: string, path: string, staged: boolean, snapshot: GitStatusSnapshot): Promise<GitFileDiff> {
    await this.checkedPath(root, path);
    const tracked = (staged ? snapshot.staged : [...snapshot.changes, ...snapshot.conflicts]).find(f => f.path === path);
    if (!tracked) throw new GitControlError("INVALID_PATH", "File is not in the selected change list.", 409);
    const untracked = !staged && !(await runGit(root, ["ls-files", "--", path])).trim();
    const text = untracked
      ? await runGit(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path], { accepted: [0, 1] })
      : await runGit(root, ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-renames", "--", path]);
    const hunks: GitDiffHunk[] = []; const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("@@ ")) hunks.push({ id: "", header: line, lines: [] });
      else if (hunks.length) hunks.at(-1)!.lines.push(line);
    }
    for (const hunk of hunks) { while (hunk.lines.at(-1) === "") hunk.lines.pop(); hunk.id = digest(`${path}:${staged}:${hunk.header}\n${hunk.lines.join("\n")}`); }
    return { path, staged, text, binary: /Binary files|GIT binary patch/.test(text), hunks, version: snapshot.version };
  }
  async diff(project: string, path: string, staged: boolean, target?: RemoteComparisonTarget, remoteComparison = false): Promise<GitFileDiff> {
    const root = await this.root(project); await this.queues.get(root)?.catch(() => undefined);
    const before = await this.snapshot(root, target);
    let diff: GitFileDiff;
    if (remoteComparison) {
      await this.checkedPath(root, path);
      if (!before.comparison?.ready || !before.comparison.changes.some(file => file.path === path)) throw new GitControlError("INVALID_PATH", "File is not in the remote change list. Fetch and refresh first.", 409);
      const base = before.comparison.head ?? (await runGit(root, ["mktree"], { input: "" })).trim();
      const text = await runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, "HEAD", "--", path]);
      const hunks: GitDiffHunk[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("@@ ")) hunks.push({ id: digest(`${base}:${path}:${line}`), header: line, lines: [] });
        else if (hunks.length) hunks.at(-1)!.lines.push(line);
      }
      diff = { path, staged: false, text, binary: /Binary files|GIT binary patch/.test(text), hunks, version: before.version };
    } else diff = await this.diffAt(root, path, staged, before);
    if ((await this.snapshot(root, target)).version !== before.version) throw new GitControlError("STALE_STATE", "Repository changed. Refresh the diff.", 409);
    return diff;
  }

  async operate(project: string, input: EngineOperation): Promise<GitOperationResult> {
    const root = await this.root(project);
    const previous = this.queues.get(root) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.mutate(root, input));
    this.queues.set(root, operation);
    try { return await operation; } finally { if (this.queues.get(root) === operation) this.queues.delete(root); }
  }

  private async commitPreview(root: string, input: EngineOperation): Promise<void> {
    const index = (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    const lockPath = `${index}.lock`;
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new GitControlError("INDEX_LOCKED", "Git index is busy. Wait for the other operation and retry.", 409); }
    let temporary: string | undefined;
    let published = false;
    try {
      await lock.chmod((await lstat(index)).mode & 0o777);
      if ((await this.snapshot(root, input.comparison)).version !== input.expectedVersion) throw new GitControlError("STALE_STATE", "Repository changed. Refresh before committing.", 409);
      temporary = await mkdtemp(join(dirname(index), "space-commit-"));
      const temporaryIndex = join(temporary, "index");
      await copyFile(index, temporaryIndex);
      const env = { GIT_INDEX_FILE: temporaryIndex, ...(input.author ? { GIT_AUTHOR_NAME: input.author.name, GIT_AUTHOR_EMAIL: input.author.email, GIT_COMMITTER_NAME: input.author.name, GIT_COMMITTER_EMAIL: input.author.email } : {}) };
      const tree = (await runGit(root, ["write-tree"], { env })).trim();
      const hooks = (await runGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"])).trim();
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      // Run real hooks against a private index; reject changes before Git writes HEAD.
      for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
        const original = join(hooks, hook);
        const check = hook === "post-commit" ? "" : `\ntree=$(git -c core.fsmonitor=false write-tree) || exit $?\n[ \"$tree\" = ${quote(tree)} ] || { printf '%s\\n' 'Commit hook changed the previewed staging.' >&2; exit 1; }\n`;
        await writeFile(join(temporary, hook), `#!/bin/sh\nif [ -x ${quote(original)} ]; then ${quote(original)} \"$@\" || exit $?; fi\n${check}`, { mode: 0o700 });
      }
      await runGit(root, ["-c", `core.hooksPath=${temporary}`, "commit", "-m", input.message!], { env, timeout: 30000 });
      // HEAD contains the approved tree. Preserve any normal post-commit index edits.
      await lock.writeFile(await readFile(temporaryIndex)); await lock.sync(); await lock.close();
      await rename(lockPath, index); published = true;
    } finally {
      await lock.close().catch(() => undefined);
      if (!published) await rm(lockPath, { force: true });
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  private async mutate(root: string, input: EngineOperation): Promise<GitOperationResult> {
    const before = await this.snapshot(root, input.comparison);
    if (before.version !== input.expectedVersion) throw new GitControlError("STALE_STATE", "Repository changed. Refresh before applying this selection.", 409);
    const synchronize = ["fetch", "pull", "push", "commit-push", "publish"].includes(input.operation);
    let configured = "";
    if (synchronize) {
      if (!input.remoteUrl) throw new GitControlError("REMOTE_REQUIRED", "Bind a repository before synchronizing.");
      configured = (await runGit(root, ["config", "--get", "remote.origin.url"], { accepted: [0, 1] })).trim();
      if (!input.comparison && configured && configured !== input.remoteUrl) throw new GitControlError("REMOTE_MISMATCH", "Existing origin differs from the selected repository. It has not been replaced.", 409);
      if (input.comparison && input.comparison.url !== input.remoteUrl) throw new GitControlError("REMOTE_MISMATCH", "Synchronization must use the selected repository.", 409);
      if (["push", "commit-push"].includes(input.operation) && before.comparison && !before.comparison.ready) throw new GitControlError("FETCH_REQUIRED", "Fetch the selected repository before pushing.", 409);
      if (["pull", "push", "commit-push"].includes(input.operation) && before.comparison?.related === false) throw new GitControlError("UNRELATED_HISTORY", "Selected repository has unrelated history. Select the repository for this project.", 409);
      if (["push", "commit-push"].includes(input.operation) && !before.branch) throw new GitControlError("DETACHED_HEAD", "Check out a branch before pushing.");
    }
    const paths = input.paths ?? [];
    for (const path of paths) await this.checkedPath(root, path);
    let committed = false, pushed = false;
    const exec = (args: string[], options: CommandOptions = {}) => runGit(root, args, { env: input.env, ...options });
    if (input.operation === "initialize") {
      if (before.initialized) throw new GitControlError("ALREADY_INITIALIZED", "Project already has a repository.", 409);
      await exec(["init", "-b", "main"]);
    } else if (input.operation === "clone") {
      if (before.initialized || (await readdir(root)).length) throw new GitControlError("NOT_EMPTY", "Clone requires an empty project directory.", 409);
      if (!input.remoteUrl) throw new GitControlError("REMOTE_REQUIRED", "Select a repository.");
      await exec(["clone", "--", input.remoteUrl, "."], { timeout: 120000 });
    } else {
      if (!before.initialized) throw new GitControlError("NOT_INITIALIZED", "Initialize or clone a repository first.", 409);
      if (["stage", "unstage", "discard"].includes(input.operation)) {
        if (!paths.length) throw new GitControlError("PATHS_REQUIRED", "Select files first.");
        const selected = input.operation === "unstage" ? before.staged : input.operation === "stage" ? [...before.changes, ...before.conflicts] : before.changes;
        if (paths.some(path => !selected.some(f => f.path === path))) throw new GitControlError("STALE_STATE", "Selection no longer matches the change list.", 409);
        if (input.hunkId) {
          if (paths.length !== 1 || input.operation === "discard") throw new GitControlError("INVALID_HUNK", "Select exactly one file to stage or unstage a hunk.");
          const diff = await this.diffAt(root, paths[0]!, input.operation === "unstage", before);
          const hunk = diff.hunks.find(h => h.id === input.hunkId);
          if (!hunk || diff.binary) throw new GitControlError("STALE_DIFF", "Hunk changed. Refresh the diff.", 409);
          let prefix = diff.text.split("@@ ")[0]!;
          // Unstaging part of an added file leaves the remaining index content.
          if (input.operation === "unstage" && prefix.includes("new file mode")) {
            prefix = prefix.replace(/^new file mode.*\n/m, "").replace(/^--- \/dev\/null/m, `--- a/${paths[0]}`);
          }
          const patch = prefix + hunk.header + "\n" + hunk.lines.join("\n") + "\n";
          const args = ["apply", "--cached", "--recount", "--whitespace=nowarn", ...(input.operation === "unstage" ? ["--reverse"] : [])];
          await exec([...args, "--check", "-"], { input: patch }); await exec([...args, "-"], { input: patch });
        } else if (input.operation === "stage") {
          const renamed = before.changes.filter(f => paths.includes(f.path) && f.originalPath).map(f => f.originalPath!);
          await exec(["add", "--", ...paths, ...renamed]);
        } else if (input.operation === "unstage") {
          const renamed = before.staged.filter(f => paths.includes(f.path) && f.originalPath).map(f => f.originalPath!);
          await exec(before.head ? ["reset", "-q", "HEAD", "--", ...paths, ...renamed] : ["rm", "--cached", "-q", "--", ...paths]);
        } else {
          if (!input.confirmed) throw new GitControlError("CONFIRMATION_REQUIRED", "Confirm discarding the selected files.");
          const tracked: string[] = [], untracked: string[] = [];
          for (const path of paths) { ((await exec(["ls-files", "--", path])).trim() ? tracked : untracked).push(path); }
          if (tracked.length) await exec(["restore", "--worktree", "--", ...tracked]);
          if (untracked.length) await exec(["clean", "-f", "--", ...untracked]);
        }
      } else if (["commit", "commit-push"].includes(input.operation)) {
        if (!input.message?.trim()) throw new GitControlError("MESSAGE_REQUIRED", "Enter a commit message.");
        if (!before.staged.length || before.conflicts.length) throw new GitControlError("STAGING_REQUIRED", "Stage changes and resolve conflicts before committing.");
        await this.commitPreview(root, input); committed = true;
      }
      if (["fetch", "pull", "push", "commit-push", "publish"].includes(input.operation)) {
        if (!input.remoteUrl) throw new GitControlError("REMOTE_REQUIRED", "Bind a repository before synchronizing.");
        if (input.comparison) {
          const reference = await this.comparisonRef(root, input.comparison, before.branch || input.comparison.defaultBranch || "main");
          const fetchSelected = async () => {
            await exec(["fetch", "--prune", "--no-tags", "--no-recurse-submodules", "--", input.remoteUrl!, `+refs/heads/*:${reference.prefix}/*`], { timeout: 60000 });
            this.remoteChecks.set(reference.key, new Date().toISOString());
          };
          if (input.operation === "publish") {
            if (!configured) await exec(["remote", "add", "origin", input.remoteUrl]);
            await fetchSelected();
          } else if (input.operation === "fetch") await fetchSelected();
          else if (input.operation === "pull") { await fetchSelected(); await exec(["merge", "--ff-only", reference.ref]); }
          else {
            try {
              await exec(["push", "--", input.remoteUrl, `HEAD:refs/heads/${before.branch || input.comparison.defaultBranch || "main"}`], { timeout: 60000 }); pushed = true;
              await exec(["update-ref", reference.ref, (await exec(["rev-parse", "HEAD"])).trim()]);
              this.remoteChecks.set(reference.key, new Date().toISOString());
            } catch (error) {
              if (pushed) return { ok: false, committed, pushed: true, message: "Push succeeded, but the local comparison could not refresh. Use Fetch to update it.", snapshot: await this.snapshot(root, input.comparison) };
              if (!committed) throw error;
              return { ok: false, committed: true, pushed: false, message: "Commit succeeded, but push failed. Retry Push without creating another commit.", snapshot: await this.snapshot(root, input.comparison) };
            }
          }
        } else {
          if (!configured) await exec(["remote", "add", "origin", input.remoteUrl]);
          if (input.operation === "fetch") await exec(["fetch", "--no-recurse-submodules", "origin"], { timeout: 60000 });
          else if (input.operation === "pull") await exec(["pull", "--ff-only", "--no-recurse-submodules", "origin", before.branch ?? "main"], { timeout: 60000 });
          else if (input.operation !== "publish") {
            if (!before.branch) throw new GitControlError("DETACHED_HEAD", "Check out a branch before pushing.");
            try { await exec(["push", "--set-upstream", "origin", `HEAD:refs/heads/${before.branch}`], { timeout: 60000 }); pushed = true; }
            catch (error) {
              if (!committed) throw error;
              return { ok: false, committed: true, pushed: false, message: "Commit succeeded, but push failed. Retry Push without creating another commit.", snapshot: await this.snapshot(root, input.comparison) };
            }
          }
        }
      }
    }
    return { ok: true, committed, pushed, message: `${input.operation === "commit-push" ? "Commit and push" : input.operation} completed.`, snapshot: await this.snapshot(root, input.comparison) };
  }
}
