#!/usr/bin/env node
// space-progress: a pane CLI reports its progress to Nous (operator request 2026-10-17, plan clipboard:ot6-jLKOWDNC), so Nous
// knows what every pane does without reading screens. Space already records the end of every turn on its own.
//
//   space-progress <started|progress|blocked|needs-decision|needs-you|waiting|done|failed> "<one line>"
//     [--plan clipboard:<id>] [--step N] [--percent N] [--ticket q-...] [--next "..."] [--needs "..."] [--report-file <path>]
//     needs-you also takes [--options "A | B | C"] [--recommended "B"]: the operator answers from the Needs you card;
//     [--target thread:<account>:<threadId> | url:https://...] is what Go to pane opens; --checked "A | B" (1-8, required) is what you looked up first.
//
// Reaches the API with the pane's bridge token (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN); the token is never printed.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sharedServerPaneEnvironment } from "../deploy/space-harness-pane-env.mjs";
import { refusalText } from "./space-site-signins-tools.mjs";

const tokenHeader = "x-space-cli-browser-token";
export const STATUSES = ["started", "progress", "blocked", "needs-decision", "needs-you", "waiting", "done", "failed"];
const VALUE_FLAGS = ["plan", "step", "percent", "ticket", "next", "needs", "options", "recommended", "target", "checked", "files", "report-file"];

function usage(message) {
  return new Error(`${message}\nUsage: space-progress <${STATUSES.join("|")}> "<one line>" [--plan clipboard:<id>] [--step N] [--percent N] [--ticket q-...] [--next "..."] [--needs "..."] [--options "A | B"] [--recommended "B"] [--target thread:<account>:<threadId>|url:https://...] [--checked "source: what it showed | ..."] [--files "artifact:<id> | ..."] [--report-file <path>]`);
}

/** The report body the API takes, from the command line (the report file is read by main). */
export function parseArgs(argv) {
  const [status, summary, ...rest] = argv;
  if (!STATUSES.includes(status)) throw usage(status ? `Unknown status: ${status}` : "Missing status.");
  if (!summary?.trim() || summary.startsWith("--")) throw usage("Give a one-line summary.");
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--") || !VALUE_FLAGS.includes(key)) throw usage(`Unexpected argument: ${rest[i]}`);
    if (i + 1 >= rest.length) throw usage(`--${key} needs a value.`);
    flags[key] = rest[++i];
  }
  const number = (key, min, max) => {
    if (flags[key] === undefined) return undefined;
    const value = Number(flags[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw usage(`--${key} takes a whole number from ${min} to ${max}.`);
    return value;
  };
  if (flags.plan !== undefined && !/^clipboard:[A-Za-z0-9_-]{6,64}$/.test(flags.plan)) throw usage("--plan takes a plan id (clipboard:...).");
  if (flags.ticket !== undefined && !/^q-[A-Za-z0-9_-]{4,80}$/.test(flags.ticket)) throw usage("--ticket takes a merge-queue ticket id (q-...).");
  const options = flags.options?.split("|").map((option) => option.trim()).filter(Boolean);
  if (options && (options.length > 6 || options.some((option) => option.length > 80))) throw usage("--options takes up to 6 answers of at most 80 characters, separated by |.");
  const recommended = flags.recommended?.trim();
  if (recommended && !options?.includes(recommended)) throw usage("--recommended must be one of --options.");
  // R20-asks-3: a question with options names the answer you expect, so the operator's answer can be scored.
  if (options?.length && !recommended) throw usage("--options needs --recommended (one of them): every question carries a prediction.");
  // Go to pane opens what the operator must act on: the mail thread, the page (the server checks the same shape).
  const target = flags.target?.trim();
  if (target && !/^(?:browser|activity|setup|[a-z][a-z-]*:\S+)$/.test(target)) throw usage("--target takes what Go to pane opens: thread:<account>:<threadId>, url:https://..., tab:<tabId>.");
  // Ask last (goal ee5a573e, plan clipboard:7L5KyWp3kQsP step 4): an ask names what was checked first, like Nous's cards.
  const checked = flags.checked?.split("|").map((item) => item.trim()).filter(Boolean);
  if (checked && (checked.length > 8 || checked.some((item) => item.length < 3 || item.length > 200))) throw usage("--checked takes 1-8 items of 3-200 characters, separated by |.");
  if (status === "needs-you" && !/^(?:none|nothing|-)$/i.test(flags.needs?.trim() ?? "") && !checked?.length)
    throw usage("needs-you needs --checked \"source: what it showed | ...\": find it yourself first (Space Memory, your copilot's memory, the Vault, mail, files, the web).");
  // nous_msg:0cb8d563: the Agent Files a needs-you is about, shown on the card as chips that open them.
  const files = flags.files?.split("|").map((item) => item.trim()).filter(Boolean);
  if (files?.some((id) => !/^artifact:[A-Za-z0-9_-]{6,80}$/.test(id))) throw usage("--files takes Agent File ids (artifact:<id>), separated by |.");
  // Technical: the summary is the pane board's one line (300); a longer one keeps its start with "…" and leads the report whole.
  const line = summary.replace(/\s+/g, " ").trim();
  const body = { status, summary: line.length > 300 ? `${line.slice(0, 299)}…` : line };
  if (line.length > 300) body.report = summary.trim();
  for (const [key, value] of Object.entries({ plan: flags.plan, step: number("step", 1, 500), percent: number("percent", 0, 100), ticket: flags.ticket,
    next: flags.next?.trim(), needs: flags.needs?.trim(), options: options?.length ? options : undefined, recommended, target, checked: checked?.length ? checked : undefined, files: files?.length ? files : undefined })) if (value !== undefined && value !== "") body[key] = value;
  return { body, reportFile: flags["report-file"] };
}

/** The MCP tool (server space_progress, scripts/space-progress-mcp.mjs; space_browser still accepts it unlisted). */
export const progressReportTool = {
  name: "space_progress_report",
  description: "Report this pane's progress to Nous, the mind that coordinates every pane: at task start, after each finished plan step, when blocked or needing a decision (give the options and your recommendation in needs), when you submit a merge-queue ticket, and when done or failed (what, tests, ticket, next). done is refused while the report leaves decisions or answers to the operator: report needs-you for them and keep the plan open. needs-you only when the operator themselves must act or answer in this pane: needs is then the ONE question they answer from their Needs you card, with options (the answers to pick from), recommended (one of them) and target (the mail thread or page Go to pane opens); their answer comes back as this pane's next prompt (a decision Nous can make is needs-decision). needs-you also needs checked: 1-8 items, each a source you looked at first (Space Memory, your copilot's memory, the Vault, mail, files, the web) and what it showed; ask only what none of them holds. One line in summary; the full report in report. For needs-you, report says why you ask (what it unblocks, any deadline) and the link, never steps for the operator (do them yourself) and never a time of day; needs-you only for a CAPTCHA the internal solver tried on that page and could not pass, or data you cannot get (a card at its field; anything else after the Vault, mail and Space Memory lack it), and never again for what the operator already answered (operator rule 13/11); write summary, needs, options and report in the operator's language (the last line of your AGENTS.md names it). Space records the end of every turn on its own.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUSES },
      summary: { type: "string", minLength: 1, maxLength: 300 },
      plan: { type: "string", pattern: "^clipboard:[A-Za-z0-9_-]{6,64}$" },
      step: { type: "integer", minimum: 1, maximum: 500 },
      percent: { type: "integer", minimum: 0, maximum: 100 },
      ticket: { type: "string", pattern: "^q-[A-Za-z0-9_-]{4,80}$" },
      next: { type: "string" },
      needs: { type: "string" },
      options: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 6 },
      recommended: { type: "string", maxLength: 80 },
      target: { type: "string", maxLength: 500, pattern: "^(?:browser|activity|setup|[a-z][a-z-]*:\\S+)$", description: "needs-you: what Go to pane opens: thread:<gmail account>:<threadId>, url:https://... (a page in this pane's browser), tab:<tabId>." },
      report: { type: "string" },
      checked: { type: "array", items: { type: "string", minLength: 3, maxLength: 200 }, minItems: 1, maxItems: 8, description: "needs-you, and blocked when needs asks for the operator's hands (required): what you looked up before asking, each a source and what it showed." },
      files: { type: "array", items: { type: "string", pattern: "^artifact:[A-Za-z0-9_-]{6,80}$" }, minItems: 1, description: "needs-you: the Agent Files the ask is about (artifact:<id>); the card shows each as a chip that opens it." }
    },
    required: ["status", "summary"],
    additionalProperties: false
  }
};

/** The pane's bridge: the URL of an /api/cli path and the pane's token (space-test-resource shares it). */
export function endpoint(env, path = "/api/cli/progress") {
  // A Harness or shared-OpenCode agent has no pane session in its environment: its harness or OpenCode session names the pane's tokens.
  if (!env.SPACE_BROWSER_ACTION_TOKEN) env = { ...env, ...sharedServerPaneEnvironment(env) };
  const base = (env.SPACE_BROWSER_COMMAND_ENDPOINT || "").match(/^(https?:\/\/[^/?#]+(?:\/[^?#]*?)?)\/api\/cli\/browser\/commands\/?$/)?.[1];
  if (!base || !env.SPACE_BROWSER_ACTION_TOKEN) throw new Error("space-progress runs inside a Space CLI pane (SPACE_BROWSER_COMMAND_ENDPOINT, SPACE_BROWSER_ACTION_TOKEN).");
  return { url: `${base}${path}`, token: env.SPACE_BROWSER_ACTION_TOKEN };
}

export async function main(argv, env = process.env) {
  const { body, reportFile } = parseArgs(argv);
  if (reportFile) {
    const text = (await readFile(reportFile, "utf8")).trim();
    if (text) body.report = body.report ? `${body.report}\n\n${text}` : text;
  }
  const payload = await postProgress(body, env);
  return `Reported ${body.status} to Nous (${payload.id}).`;
}

/** POST one report (the API validates it) with the pane's bridge token; answers the API's JSON. */
export async function postProgress(body, env = process.env, path = undefined) {
  const { url, token } = endpoint(env, path);
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", [tokenHeader]: token } });
  const payload = await response.json().catch(() => null);
  // 14/11: a done whose words leave work to the operator showed only "Invalid request data."; name the field and why.
  if (!response.ok) throw new Error(refusalText(payload, `Space answered HTTP ${response.status}.`));
  return payload;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).then((out) => console.log(out), (error) => { console.error(error.message.replace(/(token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")); process.exit(1); });
}
