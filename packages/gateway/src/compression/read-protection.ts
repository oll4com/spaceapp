/**
 * File-read protection, after Headroom `content_router.py` (`_is_read_command`, Apache-2.0, Headroom Contributors):
 * the output of `cat`/`head`/`tail`/`nl`/`bat`/`less`/`more` or `sed -n` is file content an agent patches byte for
 * byte, so it is never compressed lossily. Search, list and test output stays compressible, and so do lockfiles,
 * which tools regenerate. Space Gateway always protects reads (Headroom makes it opt-in, HEADROOM_PROTECT_READS).
 */
const READ_VERBS = new Set(["cat", "head", "tail", "nl", "bat", "less", "more"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const SHELL_WRAPPERS = new Set(["rtk", "sudo", "env", "time", "nice", "ionice", "nohup", "stdbuf", "command", "timeout", "xargs"]);
const LOCKFILE = new RegExp("(^|[\\s/])(bun\\.lock|bun\\.lockb|package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|uv\\.lock|poetry\\.lock|"
  + "Pipfile\\.lock|requirements\\.txt\\.lock|Cargo\\.lock|go\\.sum|Gemfile\\.lock|composer\\.lock|flake\\.lock|Package\\.resolved|gradle\\.lockfile|"
  + "packages\\.lock\\.json)(\\s|$)", "i");
/** Tools whose result is a file read by name (Claude Code's Read, Antigravity's view_file, Gemini CLI's read_file). */
export const READ_TOOL_NAMES = new Set(["Read", "read", "view_file", "read_file"]);

/** Peels `cd <dir> && ` / `cd <dir>; ` prefixes. */
function stripCdPrefix(command: string): string {
  let current = command.trim();
  for (;;) {
    const match = /^cd\s+[^&;|]+(?:&&|;)\s*([\s\S]*)$/.exec(current);
    if (!match) return current;
    current = match[1]!.trim();
  }
}

/** The program (basename, lower case) after env assignments and wrappers such as `sudo` or `timeout 30`, and its arguments. */
function program(command: string): { name: string; rest: string[] } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]!;
    if (token.includes("=") && !token.startsWith("-")) { index += 1; continue; }
    const base = token.slice(token.lastIndexOf("/") + 1).toLowerCase();
    if (SHELL_WRAPPERS.has(base)) {
      index += 1;
      while (index < tokens.length && (tokens[index]!.startsWith("-") || /^\d+(\.\d*)?$|^\.\d+$/.test(tokens[index]!))) index += 1;
      continue;
    }
    return { name: base, rest: tokens.slice(index + 1) };
  }
  return { name: "", rest: [] };
}

const stripQuotes = (text: string) => text.replace(/^['"]+|['"]+$/g, "");

export function isReadCommand(command: string): boolean {
  if (!command) return false;
  const stripped = stripCdPrefix(command);
  // A redirect, tee or heredoc writes a file.
  if (/(^|\s)(>>?|tee\b|<<)/.test(stripped)) return false;
  const { name, rest } = program(stripped);
  if (!name) return false;
  if (SHELLS.has(name) && rest.length > 0) {
    // `bash -lc "cat …"` (Codex): the real command is the -c argument.
    const flag = rest.findIndex((token) => ["-c", "-lc", "-lic", "-ic"].includes(token));
    return flag >= 0 && flag + 1 < rest.length ? isReadCommand(stripQuotes(rest.slice(flag + 1).join(" "))) : false;
  }
  const read = READ_VERBS.has(name) || (name === "sed" && /(^|\s)-n(\s|$)/.test(stripped));
  return read && !LOCKFILE.test(stripped);
}

/**
 * The shell command of a tool call's arguments: Anthropic `input` objects, OpenAI JSON strings, Codex `command` lists,
 * Antigravity `run_command` (`CommandLine`).
 */
export function toolCallCommand(raw: unknown): string {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return ""; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const command = record.command ?? record.cmd ?? record.CommandLine ?? "";
  if (Array.isArray(command)) return command.map(String).join(" ");
  return typeof command === "string" ? command : "";
}

/** `cmd:` string literals (double, single or backtick quoted) in code-mode source. */
const CODE_MODE_CMD = /\bcmd\s*:\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
const JS_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r" };

/**
 * The shell commands of a Codex code-mode `exec` call: its input is JavaScript, not JSON, and runs commands as
 * `exec_command({ cmd: "…" })`. Escapes are decoded so `sed -n '1,80p' file` reads as written.
 */
export function codeModeCommands(source: string): string[] {
  return [...source.matchAll(CODE_MODE_CMD)].map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, (_, char: string) => JS_ESCAPES[char] ?? char));
}
