const uploadMarker = "/cli-uploads/";
const uploadArtifactRoot = "/opt/spaceapp/var/artifacts";
const uploadFullPrefix = `${uploadArtifactRoot}${uploadMarker}`;
const uploadPathMaxHoldChars = 1_024;
const uploadWrappedPathPattern =
  /(?<![ \t\r\n])(?:[ \t\r\n]|\x1b\[[0-9;?]*[ -/]*[@-~])*['"]?(?:\/srv\/space\/var\/artifacts)?\/cli-uploads\/(?:[a-zA-Z0-9_.\/-]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\r\n][ \t]*|(?<![ \t\r\n])[ \t]+(?=[\r\n]))+\.[a-zA-Z0-9]{1,10}['"]?[ \t]*/gi;
const pathContinuationPattern =
  /^(?:[a-zA-Z0-9_.\/-]|\x1b\[[0-9;?]*[ -/]*[@-~]|[\r\n][ \t]*|(?<![ \t\r\n])[ \t]+(?=[\r\n]))*(?:\x1b(?:\[[0-9;?]*[ -/]*)?|[ \t]+)?$/;
const pathSeparatorPattern = /(\x1b\[[0-9;?]*[ -/]*[@-~]|[ \t\r\n])/;
const pathStartPattern = /(?=\/srv\/space\/var\/artifacts\/cli-uploads\/)|(?<!\/srv\/space\/var\/artifacts)(?=\/cli-uploads\/)/;

export const CLI_UPLOAD_PATH_HOLD_MS = 150;

function uploadPathLabel(pathText: string): string {
  if (!pathText.includes(uploadMarker)) return " ".repeat(pathText.length);
  const fileName = pathText.replace(/[\'"]/g, "").split("/").pop() ?? "";
  const originalName = fileName.replace(/^upload_[A-Za-z0-9_-]{12}-/, "") || fileName;
  return `[upload: ${originalName}]`.slice(0, pathText.length).padEnd(pathText.length, " ");
}

function maskUploadPathMatch(match: string): string {
  const parts = match.split(pathSeparatorPattern);
  let pathText = "";
  for (let index = 0; index < parts.length; index += 2) pathText += parts[index];
  const label = pathText.split(pathStartPattern).map(uploadPathLabel).join("");
  let offset = 0;
  return parts.map((part, index) => {
    if (index % 2 === 1) return part;
    const masked = label.slice(offset, offset + part.length);
    offset += part.length;
    return masked;
  }).join("");
}

/** Mask uploaded file paths without changing terminal cursor layout. */
export function maskUploadPaths(text: string): string {
  if (!text.includes(uploadMarker)) return text;
  return text.replace(uploadWrappedPathPattern, maskUploadPathMatch);
}

function uploadPathHoldStart(text: string): number {
  for (let length = Math.min(text.length, uploadFullPrefix.length - 1); length >= 8; length -= 1) {
    if (text.endsWith(uploadFullPrefix.slice(0, length))) return text.length - length;
  }
  for (let length = Math.min(text.length, uploadMarker.length - 1); length >= 5; length -= 1) {
    if (text.endsWith(uploadMarker.slice(0, length))) return text.length - length;
  }
  const markerIndex = text.lastIndexOf(uploadMarker);
  if (markerIndex < 0) return -1;
  const remainder = text.slice(markerIndex + uploadMarker.length);
  if (remainder.length > uploadPathMaxHoldChars || !pathContinuationPattern.test(remainder)) return -1;
  let start = markerIndex;
  if (start >= uploadArtifactRoot.length && text.slice(start - uploadArtifactRoot.length, start) === uploadArtifactRoot) {
    start -= uploadArtifactRoot.length;
  }
  if (start > 0 && (text[start - 1] === "'" || text[start - 1] === '"')) start -= 1;
  return start;
}

/** Hold an unfinished uploaded path until a later PTY chunk completes it. */
export function splitUploadPathOutput(text: string): { visible: string; held: string } {
  const holdStart = uploadPathHoldStart(text);
  if (holdStart < 0) return { visible: maskUploadPaths(text), held: "" };
  return { visible: maskUploadPaths(text.slice(0, holdStart)), held: text.slice(holdStart) };
}
