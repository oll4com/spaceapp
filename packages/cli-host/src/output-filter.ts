/** Terminal-output filtering shared with remote clients without loading the PTY session registry. */
// Keep wrap/whitespace branches disjoint: nested optional whitespace can
// catastrophically backtrack on PTY padding and block every hosted session.
export const CLI_UPLOAD_WRAPPED_PATH_PATTERN =
  /(?<![ \t\r\n])(?:[ \t\r\n]|\x1b\[[0-9;?]*[ -/]*[@-~])*['"]?(?:\/srv\/space\/var\/artifacts)?\/cli-uploads\/(?:[a-zA-Z0-9_.\/-]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\r\n][ \t]*|(?<![ \t\r\n])[ \t]+(?=[\r\n]))+\.[a-zA-Z0-9]{1,10}['"]?[ \t]*/gi;

const CLI_UPLOAD_MARKER = "/cli-uploads/";
const CLI_UPLOAD_ARTIFACT_ROOT = "/opt/spaceapp/var/artifacts";
const CLI_UPLOAD_FULL_PREFIX = `${CLI_UPLOAD_ARTIFACT_ROOT}${CLI_UPLOAD_MARKER}`;
const CLI_UPLOAD_PATH_MAX_HOLD_CHARS = 1_024;
// Same alternatives as the path body of CLI_UPLOAD_WRAPPED_PATH_PATTERN, plus
// an unfinished trailing CSI or padding: the chunk may stop anywhere inside.
const CLI_UPLOAD_PATH_CONTINUATION_PATTERN =
  /^(?:[a-zA-Z0-9_.\/-]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\r\n][ \t]*|(?<![ \t\r\n])[ \t]+(?=[\r\n]))*(?:\x1b(?:\[[0-9;?]*[ -/]*)?|[ \t]+)?$/;
const CLI_UPLOAD_PATH_SEPARATOR_PATTERN = /(\x1b\[[0-9;?]*[ -/]*[@-~]|[ \t\r\n])/;
const CLI_UPLOAD_PATH_START_PATTERN = /(?=\/srv\/space\/var\/artifacts\/cli-uploads\/)|(?<!\/srv\/space\/var\/artifacts)(?=\/cli-uploads\/)/;
export const CLI_UPLOAD_PATH_HOLD_MS = 150;

function uploadPathLabel(pathText: string): string {
  if (!pathText.includes(CLI_UPLOAD_MARKER)) return " ".repeat(pathText.length);
  const fileName = pathText.replace(/['"]/g, "").split("/").pop() ?? "";
  const originalName = fileName.replace(/^upload_[A-Za-z0-9_-]{12}-/, "") || fileName;
  // "/cli-uploads/" alone is wider than the label decoration, so the label fits.
  return `[upload: ${originalName}]`.slice(0, pathText.length).padEnd(pathText.length, " ");
}

function maskUploadPathMatch(match: string): string {
  const parts = match.split(CLI_UPLOAD_PATH_SEPARATOR_PATTERN);
  let pathText = "";
  for (let index = 0; index < parts.length; index += 2) pathText += parts[index];
  // Consecutive wrapped paths form one regex match; label each path on its own.
  const label = pathText.split(CLI_UPLOAD_PATH_START_PATTERN).map(uploadPathLabel).join("");
  let offset = 0;
  return parts.map((part, index) => {
    if (index % 2 === 1) return part;
    const masked = label.slice(offset, offset + part.length);
    offset += part.length;
    return masked;
  }).join("");
}

/**
 * Hide upload paths in terminal output by overwriting their characters in
 * place, never by removing bytes. TUIs such as Claude Code redraw with
 * relative cursor moves, so a removed newline, escape sequence or cell
 * desynchronises their screen model and later frames land on the wrong rows
 * (an almost blank pane). Every control sequence, newline and whitespace byte
 * is kept and each path cell becomes exactly one ASCII cell.
 */
export function maskUploadPaths(text: string): string {
  if (!text.includes(CLI_UPLOAD_MARKER)) return text;
  return text.replace(CLI_UPLOAD_WRAPPED_PATH_PATTERN, maskUploadPathMatch);
}

/**
 * Index where `text` ends inside a possibly unfinished upload path, so only
 * that path is held until the next chunk; -1 when nothing needs holding.
 */
export function uploadPathHoldStart(text: string): number {
  for (let length = Math.min(text.length, CLI_UPLOAD_FULL_PREFIX.length - 1); length >= 8; length -= 1) {
    if (text.endsWith(CLI_UPLOAD_FULL_PREFIX.slice(0, length))) return text.length - length;
  }
  for (let length = Math.min(text.length, CLI_UPLOAD_MARKER.length - 1); length >= 5; length -= 1) {
    if (text.endsWith(CLI_UPLOAD_MARKER.slice(0, length))) return text.length - length;
  }
  const markerIndex = text.lastIndexOf(CLI_UPLOAD_MARKER);
  if (markerIndex < 0) return -1;
  const remainder = text.slice(markerIndex + CLI_UPLOAD_MARKER.length);
  if (remainder.length > CLI_UPLOAD_PATH_MAX_HOLD_CHARS) return -1;
  if (!CLI_UPLOAD_PATH_CONTINUATION_PATTERN.test(remainder)) return -1;
  let start = markerIndex;
  if (start >= CLI_UPLOAD_ARTIFACT_ROOT.length && text.slice(start - CLI_UPLOAD_ARTIFACT_ROOT.length, start) === CLI_UPLOAD_ARTIFACT_ROOT) {
    start -= CLI_UPLOAD_ARTIFACT_ROOT.length;
  }
  if (start > 0 && (text[start - 1] === "'" || text[start - 1] === '"')) start -= 1;
  return start;
}

/** Split a terminal chunk into masked output and an unfinished upload path to hold for the next chunk. */
export function splitUploadPathOutput(text: string): { visible: string; held: string } {
  const holdStart = uploadPathHoldStart(text);
  if (holdStart < 0) return { visible: maskUploadPaths(text), held: "" };
  return { visible: maskUploadPaths(text.slice(0, holdStart)), held: text.slice(holdStart) };
}

/** Collect the full hidden input and long tokens whose terminal echoes may need suppressing. */
export function hiddenEchoCandidates(data: string): string[] {
  const candidates = new Set<string>();
  if (data) candidates.add(data);
  for (const token of data.split(/\s+/)) {
    if (token.length >= 8) candidates.add(token);
  }
  return [...candidates];
}

/** Remove matching hidden-input echoes while updating unexpired candidates across terminal chunks. */
export function consumeHiddenEcho(
  pendingHiddenEchoes: Array<{ value: string; remaining: string; expiresAtMs: number }>,
  data: string
): string {
  const active = pendingHiddenEchoes.filter((item) => item.remaining && item.expiresAtMs > Date.now());
  pendingHiddenEchoes.splice(0, pendingHiddenEchoes.length, ...active);
  let output = data;
  for (const pending of active) {
    if (!output) break;
    if (pending.value.includes("/cli-uploads/")) continue;
    const exactIndex = output.indexOf(pending.remaining);
    if (exactIndex >= 0) {
      output = `${output.slice(0, exactIndex)}${output.slice(exactIndex + pending.remaining.length)}`;
      pending.remaining = pending.value;
      continue;
    }
    if (pending.remaining.startsWith(output)) {
      pending.remaining = pending.remaining.slice(output.length) || pending.value;
      return "";
    }
    const maximum = Math.min(output.length, pending.remaining.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (!output.endsWith(pending.remaining.slice(0, length))) continue;
      pending.remaining = pending.remaining.slice(length) || pending.value;
      output = output.slice(0, -length);
      break;
    }
  }
  return output;
}
