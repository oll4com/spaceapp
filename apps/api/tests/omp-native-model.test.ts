import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ompTerminalName, readOmpNativeModel } from "../src/omp-native-model.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const identity = { paneId: "pane:Zmdph7umufyB", sessionId: "cli_session:T8YgG1wEsZLJ", rootPid: 3000 };
const identityEnviron = `HOME=/var/lib/spaceapp-user\0SPACE_PANE_ID=${identity.paneId}\0SPACE_CLI_SESSION_ID=${identity.sessionId}\0`;
const cwd = "/opt/spaceapp/var/worktrees/space/wt-mvd4oksn-29e50b";
const line = (value: Record<string, unknown>) => JSON.stringify(value);
// /dev/pts/95 as the kernel reports it in /proc/<pid>/stat (observed on omp 18.11.3, 2026-10-18).
const PTS_95 = 34911;

async function fixture(options: { environ?: string; ompTtyNr?: number; ompChild?: boolean; session?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "omp-native-model-"));
  roots.push(root);
  const procRoot = join(root, "proc"), agentDir = join(root, "omp-agent");
  const proc = async (pid: number, children: number[], ttyNr: number, environ?: string) => {
    await mkdir(join(procRoot, String(pid), "task", String(pid)), { recursive: true });
    await writeFile(join(procRoot, String(pid), "task", String(pid), "children"), children.map(child => `${child} `).join(""));
    await writeFile(join(procRoot, String(pid), "stat"), `${pid} (omp (x)) S 1 ${pid} ${pid} ${ttyNr} ${pid} 0 0`);
    if (environ !== undefined) await writeFile(join(procRoot, String(pid), "environ"), environ);
  };
  // Pane host root (sudo) -> sudo's pty monitor (root-owned environ: unreadable) -> omp.
  await proc(3000, [3100], 0);
  await proc(3100, [3200], PTS_95);
  await proc(3200, options.ompChild ? [3300] : [], options.ompTtyNr ?? PTS_95, options.environ ?? identityEnviron);
  // A child of omp that opened its own pty (a shell tool) and inherited the pane's identity.
  if (options.ompChild) await proc(3300, [], PTS_95, identityEnviron);
  const sessionDir = join(agentDir, "sessions", "--srv-space-var-worktrees-space-wt-mvd4oksn-29e50b--");
  const sessionFile = join(sessionDir, "2026-10-18T01-09-55-999Z_01a14c8e-e69f-73bb-81af-e66c78905f37.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, (options.session ?? [
    line({ type: "session", version: 3, cwd }),
    line({ type: "model_change", model: "space-gateway/gpt-6-sol", resolvedModelIsFallback: false }),
    line({ type: "thinking_level_change", configured: null, thinkingLevel: "medium" }),
    line({ type: "model_change", role: "default", model: "space-gateway-claude/claude-opus-5-5", resolvedModelIsFallback: false }),
    line({ type: "thinking_level_change", configured: "xhigh", thinkingLevel: "xhigh" }),
    // A later model switch keeps the thinking level; conversation text that quotes an entry type is not an entry.
    line({ type: "model_change", role: "temporary", model: "space-gateway-claude/claude-sonnet-5-5" }),
    line({ type: "message", message: { role: "user", content: '{"type":"model_change","model":"evil/model"}' } })
  ]).join("\n") + "\n");
  await mkdir(join(agentDir, "terminal-sessions"), { recursive: true });
  const breadcrumb = (name: string, target: string) => writeFile(join(agentDir, "terminal-sessions", name), `${cwd}\n${target}\ncwdstat 2048 8291940\n`);
  await breadcrumb("pts-95", sessionFile);
  return { procRoot, agentDir, root, sessionFile, breadcrumb };
}

it("reads the newest model and thinking level from the session file of this pane's omp terminal", async () => {
  expect(await readOmpNativeModel(identity, await fixture()))
    .toEqual({ modelId: "space-gateway-claude/claude-sonnet-5-5", reasoningEffort: "xhigh" });
  expect(await readOmpNativeModel(identity, await fixture({ session: [line({ type: "model_change", model: "space-gateway/gpt-6-sol" })] })))
    .toEqual({ modelId: "space-gateway/gpt-6-sol", reasoningEffort: null });
});

it("fails closed for another pane or session, a process outside the pane host tree, or a terminal that is not omp's", async () => {
  const paths = await fixture();
  expect(await readOmpNativeModel({ ...identity, paneId: "pane:OtherPane123" }, paths)).toBeNull();
  expect(await readOmpNativeModel({ ...identity, sessionId: "cli_session:OtherSession1" }, paths)).toBeNull();
  expect(await readOmpNativeModel({ ...identity, rootPid: 4000 }, paths)).toBeNull();
  expect(await readOmpNativeModel({ ...identity, rootPid: null }, paths)).toBeNull();
  // omp on a console (tty1) is not keyed "pts-1", even when a stale pts-1 breadcrumb exists.
  const onConsole = await fixture({ ompTtyNr: (4 << 8) | 1 });
  await onConsole.breadcrumb("pts-1", onConsole.sessionFile);
  expect(await readOmpNativeModel(identity, onConsole)).toBeNull();
  // The process carrying the pane's identity has no terminal: a child's own pty breadcrumb is not omp's session.
  expect(await readOmpNativeModel(identity, await fixture({ ompTtyNr: 0, ompChild: true }))).toBeNull();
});

it("follows a breadcrumb only to a regular session file inside omp's sessions directory", async () => {
  const paths = await fixture();
  const outside = join(paths.root, "outside.jsonl");
  await writeFile(outside, line({ type: "model_change", model: "evil/model" }) + "\n");
  await symlink(outside, join(paths.agentDir, "sessions", "linked.jsonl"));
  await mkdir(join(paths.agentDir, "sessions", "folder.jsonl"));
  for (const target of [outside, `${paths.agentDir}/sessions/../../outside.jsonl`, join(paths.agentDir, "sessions", "linked.jsonl"),
    join(paths.agentDir, "sessions", "folder.jsonl")]) {
    await paths.breadcrumb("pts-95", target);
    expect(await readOmpNativeModel(identity, paths), target).toBeNull();
  }
  await paths.breadcrumb("pts-95", paths.sessionFile);
  expect(await readOmpNativeModel(identity, paths)).toMatchObject({ modelId: "space-gateway-claude/claude-sonnet-5-5" });
});

it("names terminals beyond /dev/pts/255 the way omp keys its breadcrumbs", () => {
  // /dev/pts/300: major 136, minor 300 spills into the high minor bits of tty_nr.
  expect(ompTerminalName((300 & 0xff) | (136 << 8) | ((300 & ~0xff) << 12))).toBe("pts-300");
  expect(ompTerminalName(PTS_95)).toBe("pts-95");
  expect(ompTerminalName(0)).toBeNull();
});
