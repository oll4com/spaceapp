// One host can run two Space installations: the operator's "stable" instance
// and a "dev" instance that receives every change before the operator promotes
// it. Without SPACE_INSTANCE every process behaves exactly as before (stable).

export type SpaceInstance = "stable" | "dev";

type Env = Readonly<Record<string, string | undefined>>;

/** Defaults the stable instance uses; a dev instance must override every one of them. */
export const stableInstanceDefaults = {
  databaseName: "space",
  temporalNamespace: "default",
  temporalTaskQueue: "space-agent-turns",
  apiPort: 4910,
  cliHostSocket: "/run/space-codex-pane-host/pane-host.sock",
  cliAdminHostSocket: "/run/space-admin-pane-host/pane-host.sock",
  browserHostSocket: "/run/space-browser-host/browser-host.sock",
  installRoot: "/opt/spaceapp"
} as const;

const stableSessionCookieName = "space_session";
const devSessionCookieName = "space_session_dev";

export function resolveSpaceInstance(env: Env): SpaceInstance {
  const raw = env.SPACE_INSTANCE?.trim();
  if (!raw || raw === "stable") return "stable";
  if (raw === "dev") return "dev";
  throw new Error(`SPACE_INSTANCE must be "stable" or "dev", got "${raw}".`);
}

/** Browsers share cookies across ports of one host, so each instance needs its own session cookie. */
export function sessionCookieNameFor(instance: SpaceInstance): string {
  return instance === "dev" ? devSessionCookieName : stableSessionCookieName;
}

/**
 * Background jobs that act on copied stable data or on the outside world.
 * A dev instance starts with a copy of the stable database, so running them
 * there would repeat stable's schedules, messages and maintenance.
 */
export const instanceBackgroundJobs = [
  "space-control-ticks",
  "dot-schedules",
  // Scheduled Tasks dock entries are typed into their CLI panes; a dev copy must not run stable's tasks again.
  "task-schedules",
  "maintenance-autopilot",
  "managed-plan-controller",
  "chess-tournament-resume",
  "cli-runtime-visibility-file",
  "plugin-skill-links",
  "telegram-bridge",
  "streaming-bot",
  // Job Copilot files application emails in the owner's real Gmail; a dev copy must not do it twice.
  "job-apply-mail-triage",
  // Mail Copilot polls Gmail history for new mail (notifications, work items); one instance per mailbox.
  "mail-copilot-sync",
  // Marketing Copilot starts runs for approved posts that are due; a dev copy must not publish them twice.
  "marketing-copilot-scheduler",
  // Marketing Copilot records daily public metrics (GitHub, npm); one instance per owner's analytics.
  "marketing-copilot-metrics",
  // Freelance Copilot reads work@example.invalid and starts runs for new mail and due follow-ups; one instance sends.
  "freelance-copilot-scheduler",
  // Security Copilot reads the public vulnerability feeds and matches them to the fleet's inventory; one instance raises the alerts.
  "security-copilot-watch",
  // Notifies the admins when an exhausted Codex account is usable again; one instance announces it.
  "codex-quota-reset-notify",
  // Notifies the admins when the daily Space Memory maintenance run failed; only stable runs the memory workers.
  "memory-maintenance-notify",
  // Notifies the admins when Space Gateway (shared by stable and dev) has been down a minute; one instance announces it.
  "gateway-down-notify",
  // Token usage page: reads Claude Code transcripts through the sudo helper, which only stable has.
  "token-usage-claude",
  // Nous answers panes and copilots on its own from the monitor and the notifications; one instance acts for an owner.
  "nous",
  // Nous's pane board: one cheap Claude summary run per changed batch of panes, in stable's worker only.
  "nous-pane-board"
] as const;
export type InstanceBackgroundJob = (typeof instanceBackgroundJobs)[number];

/**
 * Stable runs every job. Dev runs none of them unless the operator lists the
 * job in SPACE_INSTANCE_ENABLED_JOBS (comma separated) to test it on purpose.
 */
export function instanceBackgroundJobEnabled(env: Env, job: InstanceBackgroundJob): boolean {
  if (resolveSpaceInstance(env) === "stable") return true;
  const enabled = (env.SPACE_INSTANCE_ENABLED_JOBS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return enabled.includes(job);
}

function databaseNameOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
    return name || null;
  } catch {
    return null;
  }
}

function portOf(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export type InstanceIsolationRole = "api" | "worker";

/**
 * Problems that would let a dev process reach stable's data or processes.
 * Every value that falls back to a stable default when unset is required.
 * Returns an empty list for the stable instance.
 */
export function devInstanceIsolationProblems(env: Env, role: InstanceIsolationRole): string[] {
  if (resolveSpaceInstance(env) !== "dev") return [];
  const problems: string[] = [];
  const defaults = stableInstanceDefaults;
  const databaseName = databaseNameOf(env.SPACE_DATABASE_URL);
  if (!databaseName) problems.push("SPACE_DATABASE_URL must name the dev database.");
  else if (databaseName === defaults.databaseName) problems.push(`SPACE_DATABASE_URL points at the stable database "${defaults.databaseName}".`);
  const namespace = env.SPACE_TEMPORAL_NAMESPACE?.trim();
  if (!namespace || namespace === defaults.temporalNamespace) problems.push("SPACE_TEMPORAL_NAMESPACE must be a dev namespace, not the stable one.");
  const taskQueue = env.SPACE_TEMPORAL_TASK_QUEUE?.trim();
  if (!taskQueue || taskQueue === defaults.temporalTaskQueue) problems.push("SPACE_TEMPORAL_TASK_QUEUE must be a dev task queue, not the stable one.");
  const apiPort = portOf(env.SPACE_API_PORT);
  if (apiPort === null || apiPort === defaults.apiPort) problems.push(`SPACE_API_PORT must be set to a dev port, not ${defaults.apiPort}.`);
  if (role === "api") {
    const cliHostSocket = env.SPACE_CLI_HOST_SOCKET?.trim();
    if (!cliHostSocket || cliHostSocket === defaults.cliHostSocket) problems.push("SPACE_CLI_HOST_SOCKET must point at the dev pane host.");
    if (env.SPACE_CLI_ROOT_ENABLED === "true") problems.push("SPACE_CLI_ROOT_ENABLED must stay off in dev: the root admin pane host belongs to stable.");
    const adminSocket = env.SPACE_CLI_ADMIN_HOST_SOCKET?.trim();
    if (adminSocket === defaults.cliAdminHostSocket) problems.push("SPACE_CLI_ADMIN_HOST_SOCKET must not point at the stable admin pane host.");
    const browserSocket = env.SPACE_BROWSER_HOST_SOCKET?.trim();
    if (env.SPACE_BROWSER_HOST_TRANSPORT === "unix" && (!browserSocket || browserSocket === defaults.browserHostSocket)) {
      problems.push("SPACE_BROWSER_HOST_SOCKET must not point at the stable browser host.");
    }
    const installRoot = env.SPACE_INSTALL_ROOT?.trim();
    if (!installRoot || installRoot === defaults.installRoot) problems.push(`SPACE_INSTALL_ROOT must be the dev checkout, not ${defaults.installRoot}.`);
  }
  return problems;
}

/** Throws before a dev process can touch stable state; a no-op for stable. */
export function assertDevInstanceIsolated(env: Env, role: InstanceIsolationRole): SpaceInstance {
  const instance = resolveSpaceInstance(env);
  const problems = devInstanceIsolationProblems(env, role);
  if (problems.length > 0) {
    throw new Error(`Refusing to start the dev ${role}: ${problems.join(" ")}`);
  }
  return instance;
}
