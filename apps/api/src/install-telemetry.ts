import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Anonymous telemetry of public installations, sent only after the owner's telemetry Yes
 * (SPACEAPP_TELEMETRY in compose). Events: first_answer (an agent finished its first answer,
 * plan 1.4), and, only when the launcher passed an install id (the owner said Yes to the wording
 * that names it), setup_completed, first_cli and a daily active event. Every event has a fresh
 * random uid; the install id links the events of one installation and nothing else. Never a
 * prompt, answer, model, account, path or IP address.
 */
export const INSTALL_TELEMETRY_ENDPOINT = "https://spaceapp.dev/install-ping.php";
const TELEMETRY_ON = new Set(["1", "true", "yes", "on"]);
const RETRY_AFTER_MS = 10 * 60 * 1000;
const SEND_TIMEOUT_MS = 5_000;

export type InstallTelemetryEvent = "setup_completed" | "first_cli" | "first_answer" | "active";

/** Optional fields and their patterns, the same as the collector's (spaceapp.dev server/install-ping.php). */
export const INSTALL_TELEMETRY_FIELDS = {
  cli: /^[a-z0-9_-]{1,32}$/,
  screen: /^[0-9]{2,5}x[0-9]{2,5}$/,
  dpr: /^[0-9](\.[0-9]{1,2})?$/,
  browser: /^[a-z]{1,16} [0-9]{1,4}$/,
  lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
} as const;
export type InstallTelemetryFields = Partial<Record<keyof typeof INSTALL_TELEMETRY_FIELDS, string>>;

export interface InstallTelemetryPing extends InstallTelemetryFields {
  app: "spaceapp";
  event: InstallTelemetryEvent;
  uid: string;
  install_id?: string;
  os: "unknown";
  arch: string;
  version: string;
  runtime: string;
  install_date: string;
}

/** On only in the public images, and only after the owner's telemetry Yes. */
export function installTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SPACE_PUBLIC_DISTRIBUTION === "true"
    && TELEMETRY_ON.has(String(env.SPACE_TELEMETRY_ENABLED ?? "").trim().toLowerCase());
}

/** The launcher's random install id (SPACE_INSTALL_ID), or null for installations that consented before it existed. */
export function installTelemetryId(env: NodeJS.ProcessEnv): string | null {
  const id = String(env.SPACE_INSTALL_ID ?? "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

/** Browser family and major version from a User-Agent, e.g. "chrome 141"; undefined when unknown. */
export function browserFromUserAgent(userAgent: string | undefined): string | undefined {
  const ua = userAgent ?? "";
  for (const [name, pattern] of [["edge", /Edg\/(\d+)/], ["opera", /OPR\/(\d+)/], ["firefox", /Firefox\/(\d+)/], ["chrome", /Chrome\/(\d+)/], ["safari", /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//]] as const) {
    const major = pattern.exec(ua)?.[1];
    if (major) return `${name} ${major.slice(0, 4)}`;
  }
  return undefined;
}

export function buildInstallTelemetryPing(input: {
  event: InstallTelemetryEvent;
  version: string;
  arch: string;
  installId?: string | null;
  fields?: InstallTelemetryFields;
  now?: Date;
}): InstallTelemetryPing | null {
  const clean = input.version.trim().replace(/^v/, "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]{1,32})?$/.test(clean)) return null;
  const fields: InstallTelemetryFields = {};
  for (const [key, pattern] of Object.entries(INSTALL_TELEMETRY_FIELDS) as Array<[keyof InstallTelemetryFields, RegExp]>) {
    const value = input.fields?.[key];
    if (value !== undefined && pattern.test(value)) fields[key] = value;
  }
  return {
    app: "spaceapp",
    event: input.event,
    uid: randomUUID(),
    ...(input.installId ? { install_id: input.installId } : {}),
    os: "unknown",
    arch: /^[a-z0-9_]{1,16}$/.test(input.arch) ? input.arch : "unknown",
    version: clean,
    runtime: clean,
    install_date: (input.now ?? new Date()).toISOString().slice(0, 10),
    ...fields
  };
}

async function postPing(payload: InstallTelemetryPing): Promise<boolean> {
  const response = await fetch(INSTALL_TELEMETRY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": `spaceapp-core/${payload.version}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
  });
  return response.ok;
}

/**
 * Sends one event once per installation, or once per day when daily. A marker file in the data
 * volume records success; a failed send is retried at most every ten minutes. observe() never
 * throws and never waits.
 */
export function createInstallTelemetryReporter(options: {
  enabled: boolean;
  event: InstallTelemetryEvent;
  markerFile: string;
  version: string;
  installId?: string | null;
  daily?: boolean;
  arch?: string;
  send?: (payload: InstallTelemetryPing) => Promise<boolean>;
  now?: () => number;
}) {
  const send = options.send ?? postPing;
  const now = options.now ?? Date.now;
  const period = () => options.daily ? new Date(now()).toISOString().slice(0, 10) : "once";
  // Last period sent: undefined until the marker is read; markers without a period predate daily events.
  let sentFor: string | null | undefined = options.enabled ? undefined : "off";
  let sending = false;
  let lastAttemptAt = -Infinity;
  const done = () => sentFor === "off" || sentFor === period();

  async function readMarker() {
    if (sentFor === undefined) {
      sentFor = await readFile(options.markerFile, "utf8")
        .then(text => String((JSON.parse(text) as { period?: unknown }).period ?? "once"))
        .catch(() => null);
    }
  }

  async function run(fields: InstallTelemetryFields) {
    await readMarker();
    if (done() || now() - lastAttemptAt < RETRY_AFTER_MS) return;
    const current = period();
    const payload = buildInstallTelemetryPing({
      event: options.event,
      version: options.version,
      arch: options.arch ?? process.arch,
      installId: options.installId,
      fields,
      now: new Date(now())
    });
    if (!payload) {
      sentFor = "off";
      return;
    }
    lastAttemptAt = now();
    try {
      if (await send(payload)) {
        await mkdir(dirname(options.markerFile), { recursive: true, mode: 0o700 });
        await writeFile(options.markerFile, `${JSON.stringify({ sentAt: new Date(now()).toISOString(), period: current })}\n`, { mode: 0o600 });
        sentFor = current;
      }
    } catch {
      // Offline or blocked: try again later.
    }
  }

  return {
    observe(fields: InstallTelemetryFields = {}): void {
      if (sending || (sentFor !== undefined && done())) return;
      sending = true;
      void run(fields).catch(() => undefined).finally(() => { sending = false; });
    },
    state: () => sending ? "sending" : sentFor === undefined ? "unknown" : done() ? "done" : "pending",
    /** False once the event was sent for this period (its marker included) or telemetry is off. */
    async pending(): Promise<boolean> {
      await readMarker();
      return !done();
    }
  };
}

/**
 * first_answer seen by the server (1.1.7, task:ONrvI6thyHhh): until the event is sent, each minute reads every room's
 * agents the way the agents dashboard does (that read reports a finished answer), so the event no longer waits for a
 * browser to open the dashboard. Stops for good once it is sent, and never starts when telemetry is off.
 */
export function createFirstAnswerWatch(input: {
  reporter: { pending(): Promise<boolean> };
  rooms: () => Promise<Array<{ id: string }>>;
  readRoom: (roomId: string) => Promise<unknown>;
  intervalMs?: number;
}) {
  const intervalMs = input.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };
  async function tick() {
    timer = null;
    if (stopped || !(await input.reporter.pending().catch(() => true))) return;
    for (const room of await input.rooms().catch(() => [])) {
      await input.readRoom(room.id).catch(() => undefined);
      if (!(await input.reporter.pending().catch(() => true))) return;
    }
    schedule();
  }
  return {
    async start() {
      stopped = false;
      if (!timer && await input.reporter.pending().catch(() => true)) schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/** The installation's reporters, with their markers in markerDir; every event but first_answer needs the launcher's install id. */
export function createInstallTelemetry(env: NodeJS.ProcessEnv, markerDir: string) {
  const installId = installTelemetryId(env);
  const reporter = (event: InstallTelemetryEvent, daily = false) => createInstallTelemetryReporter({
    enabled: installTelemetryEnabled(env) && (event === "first_answer" || installId !== null),
    event, installId, daily,
    markerFile: join(markerDir, `${event.replace("_", "-")}.json`),
    version: env.SPACE_APP_VERSION ?? ""
  });
  const firstCli = reporter("first_cli");
  return {
    firstAnswer: reporter("first_answer"),
    setupCompleted: reporter("setup_completed"),
    active: reporter("active", true),
    /** The first CLI session spawned, whatever its runtime, is the first_cli event. */
    observeCliEvent(event: { reason: string; runtimeId: string }) {
      if (event.reason === "INITIAL_ATTACH") firstCli.observe({ cli: event.runtimeId.replace(/^cli:/, "") });
    }
  };
}
