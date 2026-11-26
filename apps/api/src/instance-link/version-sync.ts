import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { SPACE_INSTALL_ROOT } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { resolveGitRoot, runGit } from "../app-version.js";
import { execFile } from "../safe-child-process.js";
import { sendApiError } from "../http-errors.js";
import { recordAudit } from "../request-audit.js";
import { hostServerOpsRunner, type ServerOpsRunner } from "../server-ops-routes.js";
import { LinkNotSentError } from "./preflight.js";

// Space Link version sync (operator nous_msg:2c4707988f754da5b0719dd5): the SpaceApp that manages this one asks it to run the commit it
// runs. This side decides: scripts/space-version-sync.sh (space-version-sync.service) refuses anything not on its official main, a
// downgrade, a dirty checkout or a running Gradle/emulator, builds beside, swaps, verifies /version and rolls back on failure.

export type VersionSyncState = { state: "running" | "ok" | "refused" | "failed" | "rolled-back"; from: string | null; target: string;
  startedAt: string; finishedAt: string | null; reason: string | null };
/** GET /api/version-sync: what this SpaceApp runs and its last sync (the script's state file). No secrets: commit ids and fixed reasons. */
export type VersionSyncAnswer = { commit: string | null; version: string; enabled: boolean; last: VersionSyncState | null };

export const VERSION_SYNC_UNIT = "space-version-sync.service";
const bodySchema = z.object({ commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional() }).strict();

/**
 * Nous names commits by their short id (space_remote ×24 in 7 d answered 400): before a POST /api/version-sync leaves, a short id
 * becomes the full one this repository knows; one it does not know is refused here, unsent, with why.
 */
export async function withFullCommit(body: unknown,
  resolve = (short: string) => runGit(["rev-parse", "--verify", "--quiet", `${short}^{commit}`], resolveGitRoot(process.env))): Promise<unknown> {
  const commit = body && typeof body === "object" ? (body as { commit?: unknown }).commit : undefined;
  if (typeof commit !== "string" || !/^[0-9a-fA-F]{4,39}$/.test(commit.trim())) return body;
  const full = await resolve(commit.trim().toLowerCase());
  if (!full || !/^[0-9a-f]{40}$/.test(full)) throw new LinkNotSentError(`Not sent: commit ${commit} is not a commit this SpaceApp's repository knows; give its full 40-character id.`);
  return { ...(body as object), commit: full };
}

export function registerVersionSyncRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "recordAuditEvent" | "upsertUser">; routeOptions: Pick<RouteShorthandOptions, "config">; assertPerson: (request: FastifyRequest) => void;
  version: string; commit: () => Promise<string | null>;
  /** False on a dev instance or a packaged install: it answers what it runs and refuses to update. */
  enabled: boolean; root?: string; runner?: Pick<ServerOpsRunner, "run">;
}) {
  const root = options.root ?? SPACE_INSTALL_ROOT, runner = options.runner ?? hostServerOpsRunner;
  const last = async (): Promise<VersionSyncState | null> => JSON.parse(await readFile(join(root, "var/version-sync.json"), "utf8").catch(() => "null")) as VersionSyncState | null;
  // A link device (the only device whose table lists these routes) or this SpaceApp's ADMIN in person.
  const denied = (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.mobileDevice) options.assertPerson(request);
    return request.user?.role === "ADMIN" ? null : sendApiError(reply, 403, "ADMIN_REQUIRED", "Only this SpaceApp's ADMIN updates it.");
  };

  app.get("/api/version-sync", options.routeOptions, async (request, reply): Promise<VersionSyncAnswer | FastifyReply> =>
    denied(request, reply) ?? { commit: await options.commit(), version: options.version, enabled: options.enabled, last: await last() });

  app.post("/api/version-sync", options.routeOptions, async (request, reply) => {
    const refusal = denied(request, reply);
    if (refusal) return refusal;
    const input = bodySchema.safeParse(request.body ?? {});
    const from = input.success ? await options.commit() : null;
    const target = input.success ? await fullSyncCommit(input.data.commit, from) : null;
    if (!target) return sendApiError(reply, 400, "INVALID_INPUT", "The body takes commit: a full 40-character commit id.");
    if (!options.enabled) return sendApiError(reply, 409, "VERSION_SYNC_OFF", "This SpaceApp does not update itself from a link (a dev instance or a packaged install).");
    if ((await last())?.state === "running") return sendApiError(reply, 409, "VERSION_SYNC_BUSY", "This SpaceApp is already updating itself.");
    if (from === target) return { status: "current", commit: from };
    await writeFile(join(root, "var/version-sync-target"), `${target}\n`);
    try { await runner.run("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "--no-block", "start", VERSION_SYNC_UNIT]); } catch {
      return sendApiError(reply, 409, "VERSION_SYNC_UNAVAILABLE", `This SpaceApp cannot start ${VERSION_SYNC_UNIT}; install it with its next deploy.`);
    }
    await recordAudit(options.store, request, { action: "version_sync.requested", targetType: "server", targetId: target, metadata: { from } });
    return reply.code(202).send({ status: "started", from, target });
  });
}

const execFileAsync = promisify(execFile);
/**
 * The full commit id for space_remote's POST /api/version-sync (Daily Nous errors 18/11, x24 400 INVALID_INPUT on a short id): none given is
 * the commit this side runs; a 7-40 hex id is the one this side runs when it starts so, else what this side's git resolves it to. Null: unknown.
 */
export async function fullSyncCommit(given: unknown, local: string | null = null, gitRoot = resolveGitRoot(process.env)): Promise<string | null> {
  const raw = typeof given === "string" ? given.trim().replace(/^(?:commit|sha|git):/i, "").trim().toLowerCase() : "";
  if (/^[0-9a-f]{40}$/.test(raw)) return raw;
  const empty = given === undefined || given === null || raw === "";
  if (empty && local && /^[0-9a-f]{40}$/.test(local)) return local;
  // DEV3D-030: raw is lowercased, and git knows only "HEAD", not "head".
  const ref = empty || raw === "head" ? "HEAD" : /^[0-9a-f]{7,40}$/.test(raw) || /^(?:main|dev)$/.test(raw) ? raw : null;
  if (!ref) return null;
  if (!empty && local && /^[0-9a-f]{40}$/.test(local) && local.startsWith(ref)) return local;
  for (const cwd of [...new Set([gitRoot, SPACE_INSTALL_ROOT, `${SPACE_INSTALL_ROOT}-dev`])]) {
    const full = await execFileAsync("git", ["-c", `safe.directory=${cwd}`, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd })
      .then((result) => result.stdout.trim(), () => "");
    if (/^[0-9a-f]{40}$/.test(full)) return full;
  }
  return null;
}

/** The managing side's view of one link's version: what it runs, its last sync there, and why this side could not ask. */
export type LinkVersion = { commit: string | null; version: string | null; last: VersionSyncState | null; error: string | null; checkedAt: string };
type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
const said = (answer: { status: number; body: unknown }) => {
  const message = (answer.body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message : `It answered ${answer.status}.`;
};

/**
 * Reads one link's version and, when it runs another commit, asks it to run `local`. A target it already ran, failed or rolled back is
 * never asked again (its own state file says so, across restarts here); a refusal or a busy answer is asked again on the next pass.
 * `now` (its person's "Upgrade to this version") asks even then, and lets that side say why it cannot.
 */
export async function syncLinkVersion(call: Call, local: string | null, now = false): Promise<LinkVersion> {
  const entry: LinkVersion = { commit: null, version: null, last: null, error: null, checkedAt: new Date().toISOString() };
  try {
    const read = await call("GET", "/api/version-sync");
    if (read.status !== 200) return { ...entry, error: read.status === 403 || read.status === 404 ? `${said(read)} It updates itself from a link once it runs a version with Space Link version sync.` : said(read) };
    const there = read.body as VersionSyncAnswer;
    Object.assign(entry, { commit: there.commit, version: there.version, last: there.last });
    const settled = there.last?.target === local && ["running", "failed", "rolled-back"].includes(there.last.state);
    if (!local || !there.commit || there.commit === local || (!now && (!there.enabled || settled))) return entry;
    const sent = await call("POST", "/api/version-sync", { commit: local });
    if (sent.status === 403) entry.error = `${said(sent)} It needs the upgrade scope: its person allows it there in Settings > Account > Devices.`;
    else if (sent.status >= 400) entry.error = said(sent);
    else if (sent.status === 202) entry.last = { state: "running", from: there.commit, target: local, startedAt: entry.checkedAt, finishedAt: null, reason: null };
  } catch (error) {
    entry.error = error instanceof Error ? error.message : "It did not answer.";
  }
  return entry;
}
