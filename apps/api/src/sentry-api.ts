import { readFileSync } from "node:fs";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

/**
 * Sentry's web API for Nous and the Monitoring Copilot (plan clipboard:vK0t_Fa5yrBR step 8), read-only. Two tokens, each a 0600/0640 file:
 * the org auth token (org:ci: releases and deploys, never issues) in SPACE_SENTRY_TOKEN_FILE, and a read token (event:read,
 * project:read) in SPACE_SENTRY_READ_TOKEN_FILE. No file, no call. Issue titles are what the shared scrubber left (type, "[Filtered]").
 */
export const SENTRY_ORG = "spaceapp-u9";
const SENTRY_BASE = "https://sentry.io"; // the org lives in the EU region; sentry.io routes an org's calls there
const DEFAULT_FILES = { SPACE_SENTRY_TOKEN_FILE: `${SPACE_INSTALL_ROOT}/secrets/sentry.token`, SPACE_SENTRY_READ_TOKEN_FILE: `${SPACE_INSTALL_ROOT}/secrets/sentry-read.token` };

export function sentryToken(name: keyof typeof DEFAULT_FILES, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try { return readFileSync(env[name] || DEFAULT_FILES[name], "utf8").trim() || undefined; } catch { return undefined; }
}

export class SentryApiError extends Error {
  constructor(readonly status: number) { super(`Sentry answered HTTP ${status}`); }
}

/** Every page of a list (Sentry's Link header), while `more` says the next page still matters. */
async function pages<T>(path: string, token: string, fetchImpl: typeof fetch, more: (page: T[]) => boolean = () => true): Promise<T[]> {
  const all: T[] = [];
  for (let url: string | null = `${SENTRY_BASE}/api/0/organizations/${SENTRY_ORG}/${path}`; url;) {
    const response: Response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new SentryApiError(response.status);
    const page = await response.json() as T[];
    all.push(...page);
    const next: string | undefined = /<([^>]+)>;\s*rel="next";\s*results="true"/.exec(response.headers.get("link") ?? "")?.[1];
    url = next && next.startsWith(`${SENTRY_BASE}/`) && more(page) ? next : null;
  }
  return all;
}

export interface SentryDeployedRelease { version: string; environment: string; deployedAt: string; newIssues: number }
interface ReleaseRow { version: string; dateCreated: string; newGroups?: number; lastDeploy?: { environment?: string; dateFinished?: string } | null }

/** Releases deployed since `since` with the issues first seen in each (Sentry's newGroups); newest first. */
export async function sentryReleasesDeployedSince(token: string, since: string, fetchImpl: typeof fetch = fetch): Promise<SentryDeployedRelease[]> {
  // Newest first: a page whose releases were all created before `since` ends the reading (an older one cannot have a newer deploy that matters
  // unless it was redeployed, which the queue never does: every deploy is a new SHA).
  const rows = await pages<ReleaseRow>("releases/?per_page=100", token, fetchImpl, (page) => page.some((row) => row.dateCreated >= since));
  return rows.flatMap((row) => row.lastDeploy?.dateFinished && row.lastDeploy.dateFinished >= since
    ? [{ version: row.version, environment: row.lastDeploy.environment ?? "?", deployedAt: row.lastDeploy.dateFinished, newIssues: row.newGroups ?? 0 }] : [])
    .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));
}

export interface SentryIssue { id: string; shortId: string; title: string; culprit: string; project: string; level: string; substatus: string;
  count: number; firstSeen: string; lastSeen: string; permalink: string }
interface IssueRow { id: string; shortId?: string; title?: string; culprit?: string; project?: { slug?: string }; level?: string; substatus?: string | null;
  count?: string | number; firstSeen?: string; lastSeen?: string; permalink?: string }

/** Every unresolved issue of the org (Sentry's default 14-day window of activity). */
export async function sentryUnresolvedIssues(token: string, fetchImpl: typeof fetch = fetch): Promise<SentryIssue[]> {
  const rows = await pages<IssueRow>("issues/?query=is%3Aunresolved&limit=100", token, fetchImpl);
  return rows.map((row) => ({ id: String(row.id), shortId: row.shortId ?? String(row.id), title: row.title ?? "Error", culprit: row.culprit ?? "",
    project: row.project?.slug ?? "?", level: row.level ?? "error", substatus: row.substatus ?? "ongoing", count: Number(row.count ?? 0),
    firstSeen: row.firstSeen ?? "", lastSeen: row.lastSeen ?? "", permalink: row.permalink ?? "" }));
}

/** The daily review's lines: new issues per release deployed since then. */
export function sentryReleaseLines(releases: SentryDeployedRelease[] | Error | null): string[] {
  if (releases === null) return ["- Not read: no Sentry token file (SPACE_SENTRY_TOKEN_FILE)."];
  if (releases instanceof Error) return [`- Not read: ${releases.message}.`];
  if (!releases.length) return ["- No release was deployed since then."];
  return releases.map((release) => `- ${release.version.slice(0, 10)} ${release.environment}, deployed ${release.deployedAt.slice(0, 16).replace("T", " ")} UTC: ${release.newIssues} new issue${release.newIssues === 1 ? "" : "s"}`);
}
