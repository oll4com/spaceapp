const DEFAULT_WORKSPACE_NAME = "workspace";

export function normalizeWorkspaceName(value) {
  const input = String(value).toLowerCase();
  let normalized = "";
  let insideInvalidRun = false;

  for (const character of input) {
    if (isWorkspaceNameCharacter(character)) {
      normalized += character;
      insideInvalidRun = false;
    } else if (!insideInvalidRun) {
      normalized += "-";
      insideInvalidRun = true;
    }
  }

  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  return normalized.slice(start, end) || DEFAULT_WORKSPACE_NAME;
}

export function stripTrailingLineEndings(value) {
  const input = String(value);
  let end = input.length;
  while (end > 0 && (input[end - 1] === "\r" || input[end - 1] === "\n")) {
    end -= 1;
  }
  return input.slice(0, end);
}

function isWorkspaceNameCharacter(character) {
  if (character === "." || character === "_" || character === "-") return true;
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}
