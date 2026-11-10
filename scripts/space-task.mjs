#!/usr/bin/env node
// space-task: a pane CLI's access to the operator's Tasks dock (operator request 2026-10-15). Timed work goes here,
// not into a session-only cron: Space types a scheduled task into this pane when it is due, at an empty prompt.
//
//   space-task list [--all]
//   space-task add --title "..." --prompt "..." [--at 2026-10-16T09:00 | --daily 09:00 | --weekly mon,thu@09:00 | --every 2h] [--tz Asia/Bangkok]
//   Without --tz the task runs in the owner's working time zone (Settings → Date & time).
//   space-task edit <task:id> [--title "..."] [--prompt "..."]
//   space-task done <task:id> | reopen <task:id> | unschedule <task:id>
//
// Reaches the API with the pane's bridge token (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN); the token is never printed.
import { pathToFileURL } from "node:url";
import { harnessPaneEnvironment } from "../deploy/space-harness-pane-env.mjs";

const tokenHeader = "x-space-cli-browser-token";
const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const time = /^([01]\d|2[0-3]):[0-5]\d$/;

function usage(message) {
  return new Error(`${message}\nUsage: space-task list [--all] | show <task:id> | add --title T --prompt P [--at ISO|--daily HH:MM|--weekly mon,thu@HH:MM|--every 2h|90m] [--tz Zone] | edit <task:id> [--title T] [--prompt P] | done|reopen|unschedule <task:id>`);
}

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) throw usage(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "all") { out.all = true; continue; }
    if (i + 1 >= args.length) throw usage(`--${key} needs a value.`);
    out[key] = args[++i];
  }
  return out;
}

/** The task schedule for the add flags, or null for a task without a time; without a zone the server uses the owner's. */
export function parseSchedule(options, defaultTimeZone) {
  const kinds = ["at", "daily", "weekly", "every"].filter((key) => options[key] !== undefined);
  if (kinds.length > 1) throw usage("Use one of --at, --daily, --weekly, --every.");
  if (!kinds.length) return null;
  const timeZone = options.tz || defaultTimeZone;
  const zoned = (schedule) => timeZone ? { ...schedule, timeZone } : schedule;
  const [kind] = kinds;
  const value = String(options[kind]).trim();
  if (kind === "daily") {
    if (!time.test(value)) throw usage("--daily takes HH:MM.");
    return zoned({ recurrence: { kind: "DAILY", time: value } });
  }
  if (kind === "weekly") {
    const [list, at] = value.split("@");
    const picked = String(list).toLowerCase().split(",").map((day) => days.indexOf(day.trim().slice(0, 3)));
    if (!at || !time.test(at) || picked.some((day) => day < 0)) throw usage("--weekly takes mon,thu@HH:MM.");
    return zoned({ recurrence: { kind: "WEEKLY", days: [...new Set(picked)].sort(), time: at } });
  }
  if (kind === "every") {
    const match = value.match(/^(\d+)\s*(m|min|h|d)$/i);
    if (!match) throw usage("--every takes a duration such as 30m, 2h or 1d.");
    const minutes = Number(match[1]) * ({ m: 1, min: 1, h: 60, d: 1440 })[match[2].toLowerCase()];
    if (minutes < 15 || minutes > 10080) throw usage("--every must be between 15m and 7d.");
    return zoned({ recurrence: { kind: "INTERVAL", minutes } });
  }
  // --at without an offset is wall-clock time in the time zone.
  const local = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (local && !timeZone) throw usage("--at without an offset needs the time zone.");
  const at = local ? zonedToUtc(local.slice(1).map(Number), timeZone) : new Date(value);
  if (Number.isNaN(at.getTime())) throw usage("--at takes 2026-10-16T09:00 (in --tz) or an ISO time with an offset.");
  return zoned({ recurrence: { kind: "ONCE", at: at.toISOString() } });
}

function zonedToUtc([year, month, day, hour, minute], timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000;
  };
  return new Date(guess - offset(guess - offset(guess)));
}

function endpoint(env) {
  // A Harness agent has no pane session in its environment: its harness session names the pane's tokens.
  if (!env.SPACE_BROWSER_ACTION_TOKEN) env = { ...env, ...harnessPaneEnvironment(env.DSH_SESSION_ID) };
  const base = (env.SPACE_BROWSER_COMMAND_ENDPOINT || "").match(/^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/api\/cli\/browser\/commands\/?$/)?.[1];
  if (!base || !env.SPACE_BROWSER_ACTION_TOKEN) throw new Error("space-task runs inside a Space CLI pane (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN).");
  return { url: `${base}/api/cli/task-items`, token: env.SPACE_BROWSER_ACTION_TOKEN };
}

async function call(env, path, init = {}) {
  const { url, token } = endpoint(env);
  const response = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(30_000),
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), [tokenHeader]: token } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `Space answered HTTP ${response.status}.`);
  return payload;
}

function line(task) {
  const schedule = task.schedule;
  const when = !schedule ? "no time" : schedule.nextRunAt ? `next ${schedule.nextRunAt}` : "no next run";
  const how = schedule ? ` · ${schedule.recurrence.kind.toLowerCase()}` : "";
  return `${task.id}  [${task.status}]  ${task.title}  (${when}${how}${task.paneTitle ? ` · ${task.paneTitle}` : ""})${schedule?.lastOutcome ? `\n    last: ${schedule.lastOutcome}` : ""}`;
}

/** Every task, page by page (until 31/10 list showed the first 100). */
async function allTasks(env, filter) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const { items, total } = await call(env, `?page=${page}&pageSize=100${filter}`);
    out.push(...items);
    if (!items.length || out.length >= total) return out;
  }
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === "list") {
    const options = flags(rest);
    const items = await allTasks(env, options.all ? "" : "&status=OPEN");
    return items.length ? items.map(line).join("\n") : "No tasks.";
  }
  if (command === "show") {
    const [id] = rest;
    if (!/^task:[A-Za-z0-9_-]+$/.test(id || "")) throw usage("show needs a task id (task:...).");
    const task = (await allTasks(env, "")).find((item) => item.id === id);
    if (!task) throw new Error(`No task ${id}.`);
    return `${line(task)}\n\n${task.objective}`;
  }
  if (command === "add") {
    const options = flags(rest);
    if (!options.title || !options.prompt) throw usage("add needs --title and --prompt.");
    // A wall-clock --at needs a zone: the owner's working time zone, which the bridge's list answer carries.
    const localAt = options.at && !options.tz && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(String(options.at).trim());
    const schedule = parseSchedule(options, localAt ? (await call(env, "?page=1&pageSize=1")).timeZone : undefined);
    const task = await call(env, "", { method: "POST", body: JSON.stringify({ title: options.title, objective: options.prompt, ...(schedule ? { schedule } : {}) }) });
    return `Added ${line(task)}`;
  }
  if (command === "edit") {
    const [id, ...more] = rest;
    const options = flags(more);
    if (!/^task:[A-Za-z0-9_-]+$/.test(id || "") || (!options.title && !options.prompt)) throw usage("edit needs a task id (task:...) and --title or --prompt.");
    const task = await call(env, `/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ ...(options.title ? { title: options.title } : {}), ...(options.prompt ? { objective: options.prompt } : {}) }) });
    return `Edited ${line(task)}`;
  }
  const changes = { done: { status: "DONE" }, reopen: { status: "OPEN" }, unschedule: { schedule: null } };
  if (changes[command]) {
    const [id] = rest;
    if (!/^task:[A-Za-z0-9_-]+$/.test(id || "")) throw usage(`${command} needs a task id (task:...).`);
    const task = await call(env, `/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes[command]) });
    return line(task);
  }
  throw usage(command ? `Unknown command: ${command}` : "Missing command.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((out) => console.log(out), (error) => { console.error(error.message.replace(/(token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")); process.exit(1); });
}
