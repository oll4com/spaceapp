import type { NousDecision } from "@space/contracts";
import { restartCommit, restartHostOf, type RestartHost } from "./allowances.js";

// W45 step 3 (plan clipboard:6UFy8Pm_4MiE): most stale decisions of the week were asks events had overtaken (a restart done, a reply sent,
// the pane's work done) that Nous withdrew by hand hours later. Each is read from a fact Space can check; none runs an action.

export interface OvertakenFacts {
  /** A reply or forward that went out in the thread after `since` (none, or unreadable: empty). */
  threadReplies?(account: string, threadId: string, since: string): Promise<Array<{ action: string; occurredAt: string; actor: string }>>;
  /** The running host's start and build (null: unknown). */
  host?(host: RestartHost): Promise<{ startedAt: string; buildCommit?: string | null } | null>;
  /** Whether `commit` is in `ref` of the Space repository (null: git cannot tell). */
  contains?(commit: string, ref: string): Promise<boolean | null>;
  /** One pane's reports, newest first. */
  paneReports?(paneId: string): Promise<Array<{ at: string; status: string; source: string; summary: string; body: string | null; planId: string | null; percent: number | null }>>;
}

const HOST_NAME: Record<RestartHost, string> = { BROWSER_HOST: "Browser Host", PANE_HOST: "pane host" };
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Why an open decision no longer needs the operator, or null when nothing Space can check says so. */
export async function overtakenEvidence(decision: NousDecision, facts: OvertakenFacts): Promise<string | null> {
  const asked = Date.parse(decision.createdAt);
  const thread = decision.refs?.mailThread;
  // The same fact queue item 27 holds an approved send on: approving it would send nothing.
  if (decision.category === "EXTERNAL" && thread && facts.threadReplies) {
    const [reply] = await facts.threadReplies(thread.account, thread.threadId, decision.createdAt);
    if (reply) return `a ${reply.action.toLowerCase()} went out in the ${thread.account} thread at ${utc(reply.occurredAt)}`;
  }
  const host = restartHostOf(decision);
  if (host && facts.host) {
    const running = await facts.host(host);
    if (running && Date.parse(running.startedAt) > asked) {
      // A crash restart onto an older build is no restart for the named commit.
      const commit = decision.action?.type === "PANE_TEXT" ? restartCommit(decision.action.text) : null;
      const has = commit ? (running.buildCommit && facts.contains ? await facts.contains(commit, running.buildCommit) : null) : true;
      if (has) return `the ${HOST_NAME[host]} restarted at ${utc(running.startedAt)}${commit ? ` on a build holding ${commit}` : ""}`;
    }
  }
  if (decision.action?.type === "PANE_TEXT" && facts.paneReports) {
    const short = decision.id.split(":").at(-1)!.slice(0, 8);
    const names = new RegExp(`\\b${short}`, "i");
    const plan = decision.refs?.planId;
    const done = (await facts.paneReports(decision.action.paneId)).find((report) => report.status === "DONE" && report.source === "AGENT" && Date.parse(report.at) > asked
      && (names.test(`${report.summary}\n${report.body ?? ""}`) || (plan && report.planId === plan && report.percent === 100)));
    if (done) return `the pane reported done at ${utc(done.at)}: ${done.summary.slice(0, 160)}`;
  }
  return null;
}
